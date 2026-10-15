import assert from "node:assert/strict";
import test from "node:test";
import { createWebFetcher, isProxyEligible } from "../packages/browser-runtime/src/web-fetch.ts";
import { createDiagnosticRecorder } from "../packages/shared-ui/src/diagnostics.ts";
import { presentIdle } from "../packages/shared-ui/src/presentation.ts";
import { renderView } from "../packages/shared-ui/src/view.tsx";
import { createProxyRateLimiter, createProxyTransport } from "../src/proxyTransport.ts";
import { handleProxyRequest } from "../src/server/proxy.ts";
import { act } from "./react-dom.mjs";

function okBytes(...values) {
  return new Uint8Array(values).buffer;
}

function request(uri, purpose = "metadata", headers = []) {
  return { uri, purpose, headers };
}

const attemptSignal = new AbortController().signal;

function directImpl(bytes = okBytes(1), status = 200) {
  return {
    calls: 0,
    async fetchImpl() {
      this.calls += 1;
      return new Response(bytes.slice(0), { status });
    },
  };
}

function directCorsFail() {
  return {
    calls: 0,
    async fetchImpl() {
      this.calls += 1;
      throw new Error("Failed to fetch");
    },
  };
}

function proxyImpl(bytes = okBytes(9)) {
  return {
    calls: 0,
    async fetchViaProxy() {
      this.calls += 1;
      return { ok: true, status: 200, bytes: bytes.slice(0), contentType: "application/json" };
    },
  };
}

function webDeps({ direct, proxy }) {
  const attempts = [];
  let started = 0;
  const deps = {
    fetchImpl: (...args) => direct.fetchImpl(...args),
    proxyTransport: { fetchViaProxy: (...args) => proxy.fetchViaProxy(...args) },
    isProxyEligible: (req) => isProxyEligible(req),
    diagnostics: createDiagnosticRecorder({
      id: "fetch",
      now: () => 0,
      sink(record) {
        if (record.event === "request") attempts.push(record.fields);
      },
    }),
    hooks: {
      onRequestStart: () => {
        started += 1;
        return started;
      },
      onRequestEnd() {},
      onLog() {},
      onUpdate() {},
    },
    messages: {
      rateLimitedBySite: "rate limited",
      siteBusy: "busy",
      discoveryFailed: () => "discovery failed",
    },
    sleepFn: async () => {},
    randomFn: () => 0,
  };
  return { deps, attempts };
}

test("direct is always first; proxy not called on direct success", async () => {
  const direct = directImpl();
  const proxy = proxyImpl();
  const { deps, attempts } = webDeps({ direct, proxy });
  const fetcher = createWebFetcher(deps);
  await fetcher.fetchResource(request("https://public.test/image.json"), attemptSignal);
  assert.equal(direct.calls, 1);
  assert.equal(proxy.calls, 0);
  assert.equal(fetcher.getActiveTransport(), "direct");
  assert.deepEqual(
    attempts.map((a) => a.transport),
    ["direct"],
  );
});

test("eligible metadata failure automatically calls proxy without extra user action", async () => {
  const direct = directCorsFail();
  const proxy = proxyImpl();
  const { deps, attempts } = webDeps({ direct, proxy });
  const fetcher = createWebFetcher(deps);
  await fetcher.fetchResource(request("https://public.test/image.json"), attemptSignal);
  assert.equal(direct.calls, 1);
  assert.equal(proxy.calls, 1);
  assert.equal(fetcher.getActiveTransport(), "metadata-proxy");
  assert.deepEqual(
    attempts.map((a) => a.transport),
    ["direct", "metadata-proxy"],
  );
});

test("metadata proxy rate-limit retries once, then succeeds", async () => {
  const direct = directCorsFail();
  const proxy = {
    calls: 0,
    async fetchViaProxy() {
      this.calls += 1;
      if (this.calls === 1)
        return { ok: false, status: 429, code: "PROXY_RATE_LIMITED", retryAfterMs: 0 };
      return { ok: true, status: 200, bytes: okBytes(5), contentType: "application/json" };
    },
  };
  const { deps } = webDeps({ direct, proxy });
  const fetcher = createWebFetcher(deps);
  const res = await fetcher.fetchResource(request("https://public.test/image.json"), attemptSignal);
  assert.equal(proxy.calls, 2);
  assert.ok(res.bytes.byteLength > 0, "retried bytes reach discovery");
});

test("proxy eligibility matrix", () => {
  const okReq = request("https://public.test/image.json");
  assert.equal(isProxyEligible(okReq).eligible, true);
  for (const purpose of ["metadata", "tile", "probe"]) {
    assert.equal(isProxyEligible({ ...okReq, purpose }).eligible, true);
  }
  // Credential-bearing targets ineligible.
  assert.equal(isProxyEligible(request("https://user:pw@public.test/x")).eligible, false);
  assert.equal(isProxyEligible(request("https://public.test/x?token=abc")).eligible, false);
  assert.equal(
    isProxyEligible(
      request("https://public.test/x", "metadata", [{ name: "Cookie", value: "a=b" }]),
    ).eligible,
    false,
  );
  assert.equal(
    isProxyEligible(
      request("https://public.test/x", "metadata", [{ name: "Authorization", value: "Bearer x" }]),
    ).eligible,
    false,
  );
  assert.equal(
    isProxyEligible(
      request("https://public.test/x", "metadata", [{ name: "x-custom", value: "value" }]),
    ).eligible,
    true,
  );
  // Private/local ineligible.
  for (const u of [
    "http://localhost/x",
    "http://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
  ]) {
    assert.equal(isProxyEligible(request(u)).eligible, false, u);
  }
});

test("no proxy for http-error, ineligible targets, or cancelled requests", async () => {
  // HTTP refusals never fall back: the failure is authoritative, not a CORS gap.
  {
    const direct = directImpl(okBytes(7), 404);
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    await assert.rejects(
      fetcher.fetchResource(request("https://public.test/x"), attemptSignal),
      (error) => error.kind === "http-error" && error.status === 404,
    );
    assert.equal(proxy.calls, 0);
  }
  // Credential-bearing targets are ineligible: no proxy attempt is made.
  {
    const direct = directCorsFail();
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    await assert.rejects(
      fetcher.fetchResource(request("https://user:pw@public.test/x"), attemptSignal),
      (error) => error.kind === "network-failure",
    );
    assert.equal(proxy.calls, 0);
  }
  // A retired job never falls back to the proxy.
  {
    const direct = directCorsFail();
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      fetcher.fetchResource(request("https://public.test/x"), ctrl.signal),
      (error) => error.kind === "cancelled",
    );
    assert.equal(proxy.calls, 0);
  }
});

test("public tile and probe reads use proxy fallback after a network failure", async () => {
  for (const purpose of ["tile", "probe"]) {
    const direct = directCorsFail();
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    const result = await fetcher.fetchResource(
      request("https://public.test/0_0.jpg", purpose),
      attemptSignal,
    );
    assert.deepEqual([...result.bytes], [9]);
    assert.equal(proxy.calls, 1);
  }
});

test("proxyTransport posts only targetUrl+protocolVersion, credentials omit, size guard", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    assert.equal(url, "/api/proxy");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ["protocolVersion", "targetUrl"]);
    assert.ok(!("cookie" in (init.headers ?? {})));
    return new Response(new Uint8Array([1, 2]), {
      headers: { "content-type": "application/json" },
    });
  };
  const pt = createProxyTransport(fetchImpl, { protocolVersion: 1, maxBytes: 1024 });
  const r = await pt.fetchViaProxy(request("https://public.test/x.json"));
  assert.equal(r.ok, true);
  assert.equal(seen.init.headers["content-type"], "application/json");
  const withAccept = await pt.fetchViaProxy(
    request("https://public.test/x.json", "metadata", [
      { name: "Accept", value: "application/json" },
    ]),
  );
  assert.equal(withAccept.ok, true);
  assert.equal(seen.init.headers.accept, "application/json");
  // Credential-bearing target rejected before request.
  let called = 0;
  const pt2 = createProxyTransport(
    async () => {
      called += 1;
      throw new Error("nope");
    },
    { protocolVersion: 1, maxBytes: 1024 },
  );
  const denied = await pt2.fetchViaProxy(request("https://user:pw@public.test/x"));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "PROXY_POLICY_DENIED");
  assert.equal(called, 0);
  // Oversize mapped to budget code.
  const pt3 = createProxyTransport(async () => new Response(new Uint8Array(2048)), {
    protocolVersion: 1,
    maxBytes: 1024,
  });
  const big = await pt3.fetchViaProxy(request("https://public.test/x.json"));
  assert.equal(big.code, "PROXY_BUDGET_EXCEEDED");
  // Cancellation.
  const ctrl = new AbortController();
  ctrl.abort();
  const cancelled = await pt.fetchViaProxy(request("https://public.test/x.json"), {
    signal: ctrl.signal,
  });
  assert.equal(cancelled.code, "TRANSPORT_CANCELLED");
});

test("proxyTransport surfaces Retry-After on 429 so callers can back off once", async () => {
  const withHint = createProxyTransport(
    async () => new Response(new Uint8Array([1]), { status: 429, headers: { "retry-after": "2" } }),
    { protocolVersion: 1, maxBytes: 1024 },
  );
  const hinted = await withHint.fetchViaProxy(request("https://public.test/busy.json"));
  assert.equal(hinted.ok, false);
  assert.equal(hinted.code, "PROXY_RATE_LIMITED");
  assert.equal(hinted.retryAfterMs, 2000);
  const bare = createProxyTransport(
    async () => new Response(new Uint8Array([1]), { status: 429 }),
    { protocolVersion: 1, maxBytes: 1024 },
  );
  const unhinted = await bare.fetchViaProxy(request("https://public.test/busy.json"));
  assert.equal(unhinted.code, "PROXY_RATE_LIMITED");
  assert.equal(unhinted.retryAfterMs, undefined);
});

test("proxyTransport caps proxy load at 4 inflight and 4 starts per second", async () => {
  // Isolated limiter so this burst never borrows quota from other tests.
  const limiter = createProxyRateLimiter();
  let inflight = 0;
  let maxInflight = 0;
  const fetchImpl = async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight -= 1;
    return new Response(new Uint8Array([1]));
  };
  const pt = createProxyTransport(fetchImpl, {
    protocolVersion: 1,
    maxBytes: 1024,
    rateLimiter: limiter,
  });
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      pt.fetchViaProxy(
        request(`https://public.test/burst-${i}.json`, ["metadata", "tile", "probe"][i % 3]),
      ),
    ),
  );
  const elapsed = Date.now() - started;
  assert.ok(
    results.every((r) => r.ok),
    "every limited request still succeeds",
  );
  assert.ok(maxInflight <= 4, `at most 4 proxy requests in flight (saw ${maxInflight})`);
  // 8 starts at 4/s need a second window: the tail must wait out the window.
  assert.ok(elapsed >= 900, `8 starts at 4/s take >= ~1s (took ${elapsed}ms)`);
});

test("proxyTransport surfaces the upstream URL so proxied metadata keeps its tile base", async () => {
  const fetchImpl = async () =>
    new Response(new Uint8Array([1]), {
      headers: {
        "content-type": "application/xml",
        "x-proxy-upstream-url": "https://public.test/galleria_04.xml",
      },
    });
  const pt = createProxyTransport(fetchImpl, { protocolVersion: 1, maxBytes: 1024 });
  const r = await pt.fetchViaProxy(request("https://public.test/galleria_04.xml"));
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, "https://public.test/galleria_04.xml");
  // Missing header: no finalUrl, callers fall back to the requested URL.
  const bare = createProxyTransport(async () => new Response(new Uint8Array([1])), {
    protocolVersion: 1,
    maxBytes: 1024,
  });
  const r2 = await bare.fetchViaProxy(request("https://public.test/galleria_04.xml"));
  assert.equal(r2.ok, true);
  assert.equal(r2.finalUrl, undefined);
});

test("proxy fallback is unconditional: no opt-out UI", () => {
  const el = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(el);
  act(() =>
    renderView(el, presentIdle(), {
      onSubmitUrl: () => {},
      onCancel: () => {},
      onReset: () => {},
      onSave: () => {},
    }),
  );
  assert.equal(el.querySelector("#dz-proxy-optin"), null, "idle view renders no proxy toggle");
});

test("proxy client relays public image data for every resource purpose with exact response bytes", async () => {
  const expected = new Uint8Array([10, 11, 12, 13]);
  const transport = createProxyTransport(
    async (_path, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ["protocolVersion", "targetUrl"]);
      assert.equal(init.headers.referer, undefined);
      assert.equal(init.headers["x-custom"], undefined);
      const result = await handleProxyRequest(
        { ...body, method: init.method, headers: Object.fromEntries(new Headers(init.headers)) },
        {
          websiteOrigin: "https://site.test",
          resolveHost: () => ["8.8.8.8"],
          disableOriginBucket: true,
          fetchUpstream: async (uri, upstream) => {
            assert.equal(uri, "https://public.test/image.zif");
            assert.equal(upstream.headers.range, "bytes=10-13");
            assert.equal(upstream.headers.referer, uri);
            assert.equal(upstream.headers["x-custom"], undefined);
            return new Response(expected.slice(), {
              status: 206,
              headers: { "content-type": "image/tiff", "content-range": "bytes 10-13/100" },
            });
          },
        },
      );
      return new Response(
        result.body ?? JSON.stringify({ code: result.code, reason: result.reason }),
        { status: result.status, headers: result.headers },
      );
    },
    { protocolVersion: 1, maxBytes: 2 * 1024 * 1024, rateLimiter: createProxyRateLimiter() },
  );
  for (const purpose of ["metadata", "tile", "probe"]) {
    const result = await transport.fetchViaProxy(
      request("https://public.test/image.zif", purpose, [
        { name: "Range", value: "bytes=10-13" },
        { name: "Referer", value: "https://public.test/viewer" },
        { name: "X-Custom", value: "must-not-leave" },
      ]),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 206);
    assert.equal(result.contentType, "image/tiff");
    assert.equal(result.finalUrl, "https://public.test/image.zif");
    assert.deepEqual(new Uint8Array(result.bytes), expected);
  }
});

test("proxy client rejects ignored, mismatched, truncated and oversized successful responses", async () => {
  for (const [response, expectedCode, expectedCause] of [
    [new Response("whole file"), "TRANSPORT_NETWORK_ERROR", /expected HTTP 206/],
    [
      new Response("data", { status: 206, headers: { "content-range": "bytes 0-3/100" } }),
      "TRANSPORT_NETWORK_ERROR",
      /Content-Range/,
    ],
    [
      new Response("abc", { status: 206, headers: { "content-range": "bytes 10-13/100" } }),
      "TRANSPORT_NETWORK_ERROR",
      /expected 4 bytes/,
    ],
    [
      new Response("oversized", { status: 206, headers: { "content-range": "bytes 10-13/100" } }),
      "PROXY_BUDGET_EXCEEDED",
      undefined,
    ],
  ]) {
    let released = 0;
    const transport = createProxyTransport(async () => response, {
      protocolVersion: 1,
      maxBytes: 4,
      rateLimiter: {
        acquire: async () => () => {
          released++;
        },
        reset() {},
      },
    });
    const result = await transport.fetchViaProxy(
      request("https://public.test/image.zif", "tile", [{ name: "Range", value: "bytes=10-13" }]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, expectedCode);
    if (expectedCause) assert.match(result.preview, expectedCause);
    assert.equal(released, 1);
  }
});

test("proxy client rejects invalid request headers and over-budget requests before admission", async () => {
  const transport = createProxyTransport(() => assert.fail("invalid requests cannot be sent"), {
    protocolVersion: 1,
    maxBytes: 4,
    rateLimiter: {
      acquire: () => assert.fail("invalid requests cannot consume relay quota"),
      reset() {},
    },
  });
  for (const headers of [
    [{ name: "Range", value: "bytes=-4" }],
    [{ name: "Range", value: "bytes=0-1,3-4" }],
    [
      { name: "Range", value: "bytes=0-1" },
      { name: "range", value: "bytes=0-1" },
    ],
    [{ name: "Authorization", value: "Bearer secret" }],
    [{ name: "Cookie", value: "session=secret" }],
    [{ name: "Proxy-Authorization", value: "Bearer secret" }],
  ]) {
    const result = await transport.fetchViaProxy(
      request("https://public.test/image.zif", "probe", headers),
    );
    assert.equal(result.code, "PROXY_POLICY_DENIED");
  }
  for (const target of [
    "https://public.test/image.zif?token=secret",
    "https://user:secret@public.test/image.zif",
    "http://127.0.0.1/image.zif",
  ]) {
    const result = await transport.fetchViaProxy(request(target, "tile"));
    assert.equal(result.code, "PROXY_POLICY_DENIED");
  }
  const large = await transport.fetchViaProxy(
    request("https://public.test/image.zif", "metadata", [{ name: "Range", value: "bytes=0-4" }]),
  );
  assert.equal(large.code, "PROXY_BUDGET_EXCEEDED");
});

test("proxy client preserves HTTP refusals, throttles and bounded relay error previews", async () => {
  for (const [status, body, code] of [
    [416, "range refused", "TRANSPORT_HTTP_ERROR"],
    [429, "slow down", "PROXY_RATE_LIMITED"],
    [413, "too big", "PROXY_BUDGET_EXCEEDED"],
    [
      502,
      JSON.stringify({ code: "TRANSPORT_NETWORK_ERROR", preview: "original upstream failure" }),
      "TRANSPORT_NETWORK_ERROR",
    ],
  ]) {
    const transport = createProxyTransport(
      async () => new Response(body, { status, headers: { "retry-after": "2" } }),
      {
        protocolVersion: 1,
        maxBytes: 4,
        rateLimiter: { acquire: async () => () => {}, reset() {} },
      },
    );
    const result = await transport.fetchViaProxy(
      request("https://public.test/image.zif", "probe", [{ name: "Range", value: "bytes=10-13" }]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.code, code);
    if (status === 429) assert.equal(result.retryAfterMs, 2000);
    if (status === 502) assert.equal(result.preview, "original upstream failure");
  }
});
