import assert from "node:assert/strict";
import test from "node:test";
import {
  asFetchFailure,
  createExtensionFetcher,
  isProxyUrl,
  PROXY_PATH,
} from "../../src/runtime/fetch.ts";

function bytes(n, fill = 1) {
  return new Uint8Array(n).fill(fill);
}

function makeHarness({ permissions = {}, fetchBehavior } = {}) {
  const calls = [];
  const granted = new Map(Object.entries(permissions));
  return {
    calls,
    deps: {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (fetchBehavior) return fetchBehavior(url, init);
        return {
          status: 200,
          url,
          headers: { "content-type": "image/jpeg" },
          bytes: bytes(10),
          redirectChain: [url],
        };
      },
      hasPermission: (origin) => granted.get(origin) ?? false,
      requestPermission: (origin) => {
        calls.push({ permissionRequest: origin });
        return granted.get(origin) ?? false;
      },
    },
    grant(origin) {
      granted.set(origin, true);
    },
  };
}

test("proxy path constant and detection", () => {
  assert.equal(PROXY_PATH, "/api/proxy");
  assert.equal(isProxyUrl("https://site.example/api/proxy?u=1"), true);
  assert.equal(isProxyUrl("https://a.example/img.jpg"), false);
});

test("explicit intent required; no fetch without it", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  const f = createExtensionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/img.jpg", { userIntent: false }),
    /intent/,
  );
  await assert.rejects(() => f.fetchResource("https://a.example/img.jpg", {}), /intent/);
  assert.equal(h.calls.filter((c) => c.url).length, 0);
});

test("permission denial performs zero fetches", async () => {
  const h = makeHarness(); // nothing granted
  const f = createExtensionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/img.jpg", { userIntent: true }),
    (e) => e.code === "permission-denied",
  );
  assert.equal(h.calls.filter((c) => c.url && !c.permissionRequest).length, 0);
});

test("timeout enforced via durationMs", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  h.deps.fetchImpl = async (url) => ({
    status: 200,
    url,
    headers: { "content-type": "image/jpeg" },
    bytes: bytes(5),
    redirectChain: [url],
    durationMs: 60_000,
  });
  const f = createExtensionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/x.jpg", { userIntent: true, timeoutMs: 1000 }),
    /timeout/,
  );
});

test("oversized body rejected", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  h.deps.fetchImpl = async (url) => ({
    status: 200,
    url,
    headers: { "content-type": "image/jpeg" },
    bytes: bytes(100),
    redirectChain: [url],
  });
  const f = createExtensionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/x.jpg", { userIntent: true, maxBytes: 10 }),
    /oversized/,
  );
});

test("metadata accepts HTML while tiles do not", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  h.deps.fetchImpl = async (url) => ({
    status: 200,
    url,
    headers: { "content-type": "text/html" },
    bytes: bytes(5),
    redirectChain: [url],
  });
  const f = createExtensionFetcher(h.deps);
  const metadata = await f.fetchResource("https://a.example/x", {
    userIntent: true,
    purpose: "metadata",
  });
  assert.equal(metadata.bytes.length, 5);
  await assert.rejects(
    () => f.fetchResource("https://a.example/x", { userIntent: true, purpose: "tile" }),
    /unsupported/,
  );
});

test("metadata accepts IIIF application/ld+json", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  h.deps.fetchImpl = async (url) => ({
    status: 200,
    url,
    headers: {
      "content-type": 'application/ld+json;profile="http://iiif.io/api/image/3/context.json"',
    },
    bytes: bytes(5),
    redirectChain: [url],
  });
  const f = createExtensionFetcher(h.deps);
  const metadata = await f.fetchResource("https://a.example/info.json", {
    userIntent: true,
    purpose: "metadata",
  });
  assert.equal(metadata.bytes.length, 5);
});

test("401/403 classified without automatic handoff", async () => {
  for (const status of [401, 403]) {
    const h = makeHarness();
    h.grant("https://a.example");
    h.deps.fetchImpl = async (url) => ({
      status,
      url,
      headers: { "content-type": "image/jpeg" },
      bytes: bytes(1),
      redirectChain: [url],
    });
    const f = createExtensionFetcher(h.deps);
    // A granted-origin refusal is an upstream verdict, never a missing
    // browser grant: it must not carry the grantable access-required shape,
    // or the job re-prompts for permission in a loop.
    await assert.rejects(
      () => f.fetchResource("https://a.example/protected.jpg", { userIntent: true }),
      (error) => {
        assert.match(error.message, /unauthorized|forbidden/);
        assert.equal(error.category, "forbidden");
        assert.equal(error.code, "forbidden");
        assert.equal(error.status, status);
        assert.deepEqual(error.hosts, ["https://a.example"]);
        const failure = asFetchFailure(error);
        assert.equal(failure.code, "TRANSPORT_HTTP_ERROR");
        assert.equal(failure.blocked_reason, "forbidden");
        assert.equal(failure.retryable, false);
        assert.equal(failure.http, status);
        return true;
      },
    );
  }
});

test("429 preserves HTTP status and Retry-After for engine retry scheduling", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  h.deps.fetchImpl = async (url) => ({
    status: 429,
    url,
    headers: { "content-type": "image/jpeg", "retry-after": "3" },
    bytes: bytes(1),
    redirectChain: [url],
  });
  const f = createExtensionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/tile.jpg", { userIntent: true, purpose: "tile" }),
    (error) => {
      const failure = asFetchFailure(error);
      assert.equal(failure.code, "TRANSPORT_HTTP_ERROR");
      assert.equal(failure.retryable, true);
      assert.equal(failure.http, 429);
      assert.equal(failure.retry_after_ms, 3000);
      assert.equal(failure.transport, "browser-session");
      return true;
    },
  );
});

test("proxy URLs never fetched", async () => {
  const h = makeHarness();
  h.grant("https://site.example");
  const f = createExtensionFetcher(h.deps);
  await assert.rejects(
    () =>
      f.fetchResource("https://site.example/api/proxy?u=https://a.example/x", { userIntent: true }),
    /proxy/,
  );
  assert.equal(h.calls.length, 0);
});

test("unsupported scheme rejected", async () => {
  const h = makeHarness();
  const f = createExtensionFetcher(h.deps);
  await assert.rejects(() => f.fetchResource("file:///etc/passwd", { userIntent: true }), /scheme/);
});
