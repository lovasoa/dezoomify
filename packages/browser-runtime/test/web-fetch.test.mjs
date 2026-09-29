import assert from "node:assert/strict";
import test from "node:test";
import { classifyProxyFailure, createWebFetcher } from "../src/web-fetch.ts";

const messages = {
  rateLimitedBySite: "RATE_LIMITED",
  siteBusy: "SITE_BUSY",
  discoveryFailed: (via) => `DISCOVERY_FAILED_VIA_${via}`,
};

function request(uri, purpose = "metadata", headers = []) {
  return { uri, purpose, headers };
}

const signal = new AbortController().signal;

function makeFetcher(fetchImpl, extra = {}) {
  const events = [];
  const fetcher = createWebFetcher({
    fetchImpl,
    isProxyEligible: () => ({ eligible: false, reason: "test" }),
    hooks: {
      onRequestStart(label) {
        events.push(label);
        return events.length;
      },
      onRequestEnd: (_id, ok) => events.push(ok ? "ok" : "failed"),
      onLog: () => {},
      onUpdate: () => {},
    },
    messages,
    ...extra,
  });
  return { fetcher, events };
}

test("direct metadata keeps the final URI and readable bytes", async () => {
  const response = new Response(new Uint8Array([1, 2]), {
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: "https://a.test/final.json" });
  const { fetcher, events } = makeFetcher(async (_url, init) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "follow");
    assert.equal(init.headers["x-test"], "yes");
    return response;
  });
  const result = await fetcher.fetchResource(
    request("https://a.test/start", "metadata", [{ name: "x-test", value: "yes" }]),
    signal,
  );
  assert.equal(result.finalUri, "https://a.test/final.json");
  assert.deepEqual([...result.bytes], [1, 2]);
  assert.deepEqual(events, ["direct", "ok"]);
});

test("direct metadata never proxies an upstream refusal and bounds its preview", async () => {
  let proxyCalls = 0;
  const { fetcher } = makeFetcher(
    async () => new Response("<html><body>Forbidden x</body></html>", { status: 403 }),
    {
      isProxyEligible: () => ({ eligible: true, reason: "public" }),
      proxyTransport: {
        fetchViaProxy: async () => {
          proxyCalls += 1;
          throw new Error("unexpected proxy request");
        },
      },
    },
  );
  await assert.rejects(fetcher.fetchResource(request("https://a.test/x"), signal), (error) => {
    assert.equal(error.code, "DISCOVERY_HTTP_ERROR");
    assert.match(error.preview, /Forbidden x/);
    assert.ok(error.preview.length <= 300);
    return true;
  });
  assert.equal(proxyCalls, 0);
});

test("a stalled error preview preserves the HTTP refusal without proxy fallback", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  let proxyCalls = 0;
  let cancelled = false;
  const { fetcher } = makeFetcher(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 403 },
      ),
    {
      isProxyEligible: () => ({ eligible: true, reason: "public" }),
      proxyTransport: {
        fetchViaProxy: async () => {
          proxyCalls += 1;
          return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
        },
      },
    },
  );
  const pending = fetcher.fetchResource(request("https://a.test/x"), signal);
  await new Promise((resolve) => setImmediate(resolve));
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "DISCOVERY_HTTP_ERROR");
    assert.equal(error.http, 403);
    return true;
  });
  assert.equal(proxyCalls, 0);
  assert.equal(cancelled, true);
});

test("a proxy deadline reports a network failure rather than job cancellation", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const { fetcher } = makeFetcher(
    async () => {
      throw new TypeError("CORS");
    },
    {
      isProxyEligible: () => ({ eligible: true, reason: "public" }),
      proxyTransport: {
        fetchViaProxy: (_request, { signal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () =>
              resolve({ ok: false, status: 0, code: "TRANSPORT_CANCELLED" }),
            );
          }),
      },
    },
  );
  const pending = fetcher.fetchResource(request("https://a.test/x"), signal);
  await new Promise((resolve) => setImmediate(resolve));
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "PROXY_ERROR");
    assert.equal(error.transport, "metadata-proxy");
    return true;
  });
});

test("metadata proxy follows one bounded retry and reports its redirect URI", async () => {
  let calls = 0;
  const { fetcher } = makeFetcher(
    async () => {
      throw new TypeError("CORS");
    },
    {
      isProxyEligible: () => ({ eligible: true, reason: "public" }),
      sleepFn: async () => {},
      proxyTransport: {
        fetchViaProxy: async (received) => {
          assert.equal(received, resourceRequest);
          calls += 1;
          return calls === 1
            ? { ok: false, status: 429, code: "PROXY_RATE_LIMITED", retryAfterMs: 1 }
            : {
                ok: true,
                status: 200,
                bytes: new Uint8Array([7]).buffer,
                finalUrl: "https://a.test/final/info.json",
              };
        },
      },
    },
  );
  const resourceRequest = request("https://a.test/info.json");
  const result = await fetcher.fetchResource(resourceRequest, signal);
  assert.equal(result.finalUri, "https://a.test/final/info.json");
  assert.equal(calls, 2);
});

test("tiles make one request and return retry hints to the Rust algorithm", async () => {
  let calls = 0;
  const { fetcher } = makeFetcher(async () => {
    calls += 1;
    return new Response("busy", { status: 429, headers: { "retry-after": "3" } });
  });
  await assert.rejects(
    fetcher.fetchResource(request("https://a.test/0.png", "tile"), signal),
    (error) => {
      assert.equal(error.retry_after_ms, 3000);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("tile and probe redirects retain the final URI", async () => {
  const { fetcher } = makeFetcher(async () => {
    const response = new Response(new Uint8Array([4]));
    Object.defineProperty(response, "url", { value: "https://a.test/final/0.png" });
    return response;
  });
  for (const purpose of ["tile", "probe"]) {
    const result = await fetcher.fetchResource(request("https://a.test/0.png", purpose), signal);
    assert.equal(result.finalUri, "https://a.test/final/0.png");
  }
});

test("oversized direct streams stop before buffering the full response", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(5 * 1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { fetcher } = makeFetcher(async () => new Response(stream));
  await assert.rejects(fetcher.fetchResource(request("https://a.test/large"), signal), {
    code: "TRANSPORT_SIZE_LIMIT",
  });
  assert.equal(cancelled, true);
});

test("an aborted metadata request makes no proxy request", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const { fetcher } = makeFetcher(async () => {
    called = true;
    throw new Error("unexpected fetch");
  });
  await assert.rejects(fetcher.fetchResource(request("https://a.test/x"), controller.signal), {
    code: "TRANSPORT_CANCELLED",
  });
  assert.equal(called, false);
});

test("proxy policy denials stay distinct from upstream refusals", () => {
  const policy = classifyProxyFailure({ status: 403, code: "PROXY_POLICY_DENIED" });
  const upstream = classifyProxyFailure({ status: 403, code: "TRANSPORT_HTTP_ERROR" });
  assert.equal(policy.code, "TRANSPORT_POLICY_DENIED");
  assert.equal(upstream.code, "TRANSPORT_HTTP_ERROR");
  assert.equal(policy.http, 403);
  assert.equal(upstream.http, 403);
});
