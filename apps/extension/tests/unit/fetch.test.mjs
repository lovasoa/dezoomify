import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const { createSessionFetcher, isProxyUrl, PROXY_PATH } = await loadTs("../../src/background/fetch.ts");

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
        return { status: 200, url, headers: { "content-type": "image/jpeg" }, bytes: bytes(10), redirectChain: [url] };
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

test("authenticated success uses credentials include under granted origin", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  const f = createSessionFetcher(h.deps);
  const res = await f.fetchResource("https://a.example/img.jpg", { userIntent: true });
  assert.equal(res.bytes.length, 10);
  assert.equal(h.calls[0].init.credentials, "include");
  assert.equal(h.calls.filter((c) => c.url && c.url.includes("/api/proxy")).length, 0);
});

test("explicit intent required; no fetch without it", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  const f = createSessionFetcher(h.deps);
  await assert.rejects(() => f.fetchResource("https://a.example/img.jpg", { userIntent: false }), /intent/);
  await assert.rejects(() => f.fetchResource("https://a.example/img.jpg", {}), /intent/);
  assert.equal(h.calls.filter((c) => c.url).length, 0);
});

test("permission denial performs zero fetches", async () => {
  const h = makeHarness(); // nothing granted
  const f = createSessionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/img.jpg", { userIntent: true }),
    (e) => e.code === "permission-denied"
  );
  assert.equal(h.calls.filter((c) => c.url && !c.permissionRequest).length, 0);
});

test("cross-origin redirect requires separate permission", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  h.deps.fetchImpl = async (url, init) => {
    h.calls.push({ url, init });
    return {
      status: 200,
      url: "https://evil.example/img.jpg",
      headers: { "content-type": "image/jpeg" },
      bytes: bytes(5),
      redirectChain: ["https://a.example/start", "https://evil.example/img.jpg"],
    };
  };
  const f = createSessionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/start", { userIntent: true }),
    /redirect.*permission/i
  );
  // granting the second origin fixes it
  h.grant("https://evil.example");
  const res = await f.fetchResource("https://a.example/start", { userIntent: true });
  assert.equal(res.bytes.length, 5);
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
  const f = createSessionFetcher(h.deps);
  await assert.rejects(() => f.fetchResource("https://a.example/x.jpg", { userIntent: true, timeoutMs: 1000 }), /timeout/);
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
  const f = createSessionFetcher(h.deps);
  await assert.rejects(() => f.fetchResource("https://a.example/x.jpg", { userIntent: true, maxBytes: 10 }), /oversized/);
});

test("unsupported content type rejected", async () => {
  const h = makeHarness();
  h.grant("https://a.example");
  h.deps.fetchImpl = async (url) => ({
    status: 200,
    url,
    headers: { "content-type": "text/html" },
    bytes: bytes(5),
    redirectChain: [url],
  });
  const f = createSessionFetcher(h.deps);
  await assert.rejects(
    () => f.fetchResource("https://a.example/x", { userIntent: true, allowedMimes: ["image/"] }),
    /unsupported/
  );
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
    const f = createSessionFetcher(h.deps);
    await assert.rejects(() => f.fetchResource("https://a.example/protected.jpg", { userIntent: true }), /unauthorized|forbidden/);
  }
});

test("proxy URLs never fetched", async () => {
  const h = makeHarness();
  h.grant("https://site.example");
  const f = createSessionFetcher(h.deps);
  await assert.rejects(() => f.fetchResource("https://site.example/api/proxy?u=https://a.example/x", { userIntent: true }), /proxy/);
  assert.equal(h.calls.length, 0);
});

test("unsupported scheme rejected", async () => {
  const h = makeHarness();
  const f = createSessionFetcher(h.deps);
  await assert.rejects(() => f.fetchResource("file:///etc/passwd", { userIntent: true }), /scheme/);
});
