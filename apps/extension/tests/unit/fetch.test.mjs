import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const { createSessionFetcher, ensureOriginAccess, isProxyUrl, parseBoundOrigin, PROXY_PATH } = await loadTs("../../src/page/fetch.ts");

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

// --- ensureOriginAccess: one-time observation grant (bound scan) ------------
//
// A `webRequest` listener without host access is deaf, so the bound scan
// must earn exactly the bound tab's origin BEFORE listening. Matrix:
// granted-already passes silently; user approval passes once; refusal (or a
// missing permissions API, e.g. production activeTab-only shape) fails
// closed so the scan errors honestly instead of observing nothing.

function permsFake({ containsValue = false, requestValue = false, calls = null, throws = null } = {}) {
  return {
    calls: calls ?? [],
    contains: async (pattern) => {
      (calls ?? []).push({ contains: pattern });
      if (throws === "contains") throw new Error("denied");
      return containsValue;
    },
    request: async (pattern) => {
      (calls ?? []).push({ request: pattern });
      if (throws === "request") throw new Error("dismissed");
      return requestValue;
    },
  };
}

test("ensureOriginAccess passes silently when already granted", async () => {
  const calls = [];
  const ok = await ensureOriginAccess(
    { permissions: permsFake({ containsValue: true, calls }) },
    "https://gallery.example",
  );
  assert.equal(ok, true);
  assert.ok(calls.every((c) => c.contains !== undefined), "approved origins must never re-prompt");
});

test("ensureOriginAccess prompts once for exactly the bound origin", async () => {
  const calls = [];
  const ok = await ensureOriginAccess(
    { permissions: permsFake({ containsValue: false, requestValue: true, calls }) },
    "https://gallery.example:8443",
  );
  assert.equal(ok, true);
  const asked = calls.filter((c) => c.request !== undefined);
  assert.equal(asked.length, 1, "exactly one prompt");
  assert.deepEqual(asked[0].request, { origins: ["https://gallery.example:8443/*"] });
});

test("ensureOriginAccess fails closed on refusal, dismissal, or missing API", async () => {
  assert.equal(
    await ensureOriginAccess({ permissions: permsFake({ requestValue: false }) }, "https://a.example"),
    false,
    "refusal must fail closed (honest denial, never silent deaf scan)",
  );
  assert.equal(
    await ensureOriginAccess({ permissions: permsFake({ throws: "request" }) }, "https://a.example"),
    false,
    "dismissed prompt must fail closed",
  );
  assert.equal(
    await ensureOriginAccess({ permissions: permsFake({ throws: "contains" }) }, "https://a.example"),
    false,
    "contains failure must fail closed",
  );
  assert.equal(await ensureOriginAccess({}, "https://a.example"), false, "missing permissions API must fail closed");
  assert.equal(await ensureOriginAccess({ permissions: {} }, "https://a.example"), false);
  assert.equal(await ensureOriginAccess({ permissions: permsFake({}) }, ""), false, "empty origin never prompts");
});

// --- parseBoundOrigin: click-time origin handover ---------------------------
//
// The background threads the clicked tab's origin through
// `page.html?tab=<id>&origin=<...>`. Only exact canonical http(s) origins
// are accepted; everything else yields "" (caller falls back to the tab
// URL, then to an honest failure, never to a guess).

test("parseBoundOrigin accepts exact canonical origins", () => {
  assert.equal(parseBoundOrigin("?tab=7&origin=" + encodeURIComponent("https://gallery.example")), "https://gallery.example");
  assert.equal(parseBoundOrigin("?tab=7&origin=" + encodeURIComponent("http://127.0.0.1:44177")), "http://127.0.0.1:44177");
  assert.equal(parseBoundOrigin("origin=" + encodeURIComponent("https://a.example")), "https://a.example");
});

test("parseBoundOrigin rejects everything but exact origins", () => {
  assert.equal(parseBoundOrigin("?tab=7"), "", "absent param");
  assert.equal(parseBoundOrigin(""), "", "empty query");
  assert.equal(parseBoundOrigin(null), "", "non-string query");
  assert.equal(parseBoundOrigin("?origin="), "", "empty value");
  assert.equal(parseBoundOrigin("?origin=" + encodeURIComponent("chrome://settings")), "", "privileged scheme");
  assert.equal(parseBoundOrigin("?origin=" + encodeURIComponent("https://user:pass@a.example")), "", "userinfo smuggling");
  assert.equal(parseBoundOrigin("?origin=" + encodeURIComponent("https://a.example/gallery")), "", "path smuggling");
  assert.equal(parseBoundOrigin("?origin=" + encodeURIComponent("https://a.example/?token=1")), "", "query smuggling");
  assert.equal(parseBoundOrigin("?origin=" + encodeURIComponent("https://a.example/#frag")), "", "fragment smuggling");
  assert.equal(parseBoundOrigin("?origin=" + encodeURIComponent("HTTPS://A.EXAMPLE")), "", "non-canonical case rejected");
  assert.equal(parseBoundOrigin("?origin=not-a-url"), "", "garbage rejected");
});
