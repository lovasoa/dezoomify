import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebIntegration, isProxyEligible } from "../src/webIntegration.ts";
import { createProxyTransport } from "../src/proxyTransport.ts";
import { DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL } from "../packages/browser-runtime/src/types.ts";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function directOk() {
  return {
    calls: 0,
    async fetchResource(url) {
      this.calls += 1;
      return { outcome: "readable", finalUrl: url, status: 200, headers: {}, bytes: new Uint8Array([1]).buffer };
    },
  };
}

function directCorsFail() {
  return {
    calls: 0,
    async fetchResource(url) {
      this.calls += 1;
      return { outcome: "network-error", reason: "Failed to fetch" };
    },
  };
}

function proxyOk() {
  return {
    calls: 0,
    lastBody: null,
    async fetchViaProxy(targetUrl) {
      this.calls += 1;
      return { ok: true, status: 200, bytes: new Uint8Array([9]).buffer, contentType: "application/json" };
    },
  };
}

test("direct is always first; proxy not called on direct success", async () => {
  const transports = [];
  const direct = directOk();
  const proxy = proxyOk();
  const web = createWebIntegration({ direct, proxy, onTransport: (t) => transports.push(t) });
  const res = await web.fetchMetadata({ url: "https://public.test/image.json", kind: "metadata" });
  assert.equal(res.via, "direct");
  assert.equal(direct.calls, 1);
  assert.equal(proxy.calls, 0);
  assert.deepEqual(transports, [DIRECT_TRANSPORT_LABEL]);
});

test("eligible metadata failure automatically calls proxy without extra user action", async () => {
  const transports = [];
  const direct = directCorsFail();
  const proxy = proxyOk();
  const web = createWebIntegration({ direct, proxy, onTransport: (t) => transports.push(t) });
  const res = await web.fetchMetadata({ url: "https://public.test/image.json", kind: "metadata" });
  assert.equal(res.via, "proxy");
  assert.equal(direct.calls, 1);
  assert.equal(proxy.calls, 1);
  assert.deepEqual(transports, [DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL]);
});

test("proxy eligibility matrix", () => {
  const okReq = { url: "https://public.test/image.json", kind: "metadata" };
  assert.equal(isProxyEligible(okReq).eligible, true);
  // Tile never proxied.
  assert.equal(isProxyEligible({ ...okReq, kind: "tile" }).eligible, false);
  // Credential-bearing targets ineligible.
  assert.equal(isProxyEligible({ url: "https://user:pw@public.test/x", kind: "metadata" }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x?token=abc", kind: "metadata" }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", headers: { Cookie: "a=b" } }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", headers: { Authorization: "Bearer x" } }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", requiresCookies: true }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", requiresAuth: true }).eligible, false);
  // Private/local ineligible.
  for (const u of ["http://localhost/x", "http://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x"]) {
    assert.equal(isProxyEligible({ url: u, kind: "metadata" }).eligible, false, u);
  }
});

test("no proxy for http-error, policy-denied, cancelled, tile", async () => {
  for (const outcome of [
    { outcome: "http-error", finalUrl: "https://public.test/x", status: 404, headers: {} },
    { outcome: "policy-denied", reason: "x", code: "TRANSPORT_POLICY_DENIED" },
    { outcome: "cancelled", reason: "aborted" },
  ]) {
    const direct = { calls: 0, async fetchResource() { this.calls += 1; return outcome; } };
    const proxy = proxyOk();
    const web = createWebIntegration({ direct, proxy, onTransport: () => {} });
    const res = await web.fetchMetadata({ url: "https://public.test/x", kind: "metadata" });
    assert.equal(res.via, "direct", JSON.stringify(outcome));
    assert.equal(proxy.calls, 0);
  }
  // Tile path never proxies even on network-error.
  {
    const direct = directCorsFail();
    const proxy = proxyOk();
    const web = createWebIntegration({ direct, proxy, onTransport: () => {} });
    const res = await web.fetchTile({ url: "https://public.test/0_0.jpg", kind: "tile" });
    assert.equal(res.via, "direct");
    assert.equal(proxy.calls, 0);
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
    return {
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
      async arrayBuffer() {
        return new Uint8Array([1, 2]).buffer;
      },
    };
  };
  const pt = createProxyTransport(fetchImpl, { protocolVersion: 1, maxBytes: 1024 });
  const r = await pt.fetchViaProxy("https://public.test/x.json");
  assert.equal(r.ok, true);
  assert.equal(seen.init.headers["content-type"], "application/json");
  // Credential-bearing target rejected before request.
  let called = 0;
  const pt2 = createProxyTransport(async () => { called += 1; throw new Error("nope"); }, { protocolVersion: 1, maxBytes: 1024 });
  const denied = await pt2.fetchViaProxy("https://user:pw@public.test/x");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "PROXY_POLICY_DENIED");
  assert.equal(called, 0);
  // Oversize mapped to budget code.
  const pt3 = createProxyTransport(async () => ({
    status: 200,
    headers: { get: () => null },
    async arrayBuffer() {
      return new Uint8Array(2048).buffer;
    },
  }), { protocolVersion: 1, maxBytes: 1024 });
  const big = await pt3.fetchViaProxy("https://public.test/x.json");
  assert.equal(big.code, "PROXY_BUDGET_EXCEEDED");
  // Cancellation.
  const ctrl = new AbortController();
  ctrl.abort();
  const cancelled = await pt.fetchViaProxy("https://public.test/x.json", { signal: ctrl.signal });
  assert.equal(cancelled.code, "TRANSPORT_CANCELLED");
});

test("handoff suggestions come from capabilities; ordinary display always offered", () => {
  const web = createWebIntegration({ direct: directOk(), proxy: proxyOk(), capabilities: {} });
  assert.deepEqual(web.getHandoffSuggestions(), ["ordinary-image-display"]);
  const web2 = createWebIntegration({ direct: directOk(), proxy: proxyOk(), capabilities: { extensionAvailable: true, nativeAvailable: true } });
  assert.deepEqual(web2.getHandoffSuggestions(), ["ordinary-image-display", "extension", "native"]);
});

test("shipped webapp uses the shared proxy policy (no inline duplicate)", () => {
  const mainTs = fs.readFileSync(path.join(REPO_ROOT, "src", "main.ts"), "utf8");
  for (const dup of [
    "function isProxyEligible(",
    "function hasSignedQuery(",
    "function isPrivateOrLocalHostname(",
    '"/api/proxy"',
  ]) {
    assert.ok(!mainTs.includes(dup), `src/main.ts must not carry the inline duplicate ${dup}`);
  }
  assert.ok(mainTs.includes('from "./webIntegration.ts"'), "main.ts must import the shared eligibility policy");
  assert.ok(mainTs.includes('from "./proxyTransport.ts"'), "main.ts must import the shared proxy transport");
  assert.ok(mainTs.includes("isProxyEligible({"), "main.ts must call the shared policy with a request object");
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, "src", "main.js"), "utf8");
  assert.ok(mainJs.includes("./webIntegration.js"), "generated main.js must import the shared policy mirror");
  assert.ok(mainJs.includes("./proxyTransport.js"), "generated main.js must import the shared transport mirror");
});

test("proxy fallback is unconditional; no opt-out UI remains; 250 ms direct timeout", () => {
  const viewTs = fs.readFileSync(
    path.join(REPO_ROOT, "packages", "shared-ui", "src", "view.ts"),
    "utf8",
  );
  assert.ok(!viewTs.includes("dz-proxy-optin"), "idle view must not render the proxy toggle");
  assert.ok(!viewTs.includes("onToggleProxyOptOut"), "view must not report toggle changes");
  const mainTs = fs.readFileSync(path.join(REPO_ROOT, "src", "main.ts"), "utf8");
  assert.ok(!mainTs.includes("onToggleProxyOptOut"), "webapp must not handle the toggle");
  assert.ok(!mainTs.includes("proxyOptOut"), "webapp must not keep session opt-out state");
  assert.ok(
    mainTs.includes("DIRECT_METADATA_TIMEOUT_MS = 250"),
    "direct metadata fetch uses a 250 ms timeout before the proxy takes over",
  );
  assert.ok(
    mainTs.includes("fetchDirect(url, headers, undefined, DIRECT_METADATA_TIMEOUT_MS)"),
    "metadata discovery applies the 250 ms direct timeout",
  );
});

test("served browser import graph resolves to committed files", () => {
  const roots = ["src/main.js", "src/worker.js"];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    // wasm/ holds ignored build artifacts (verified by `cargo xtask build web`).
    if (rel.startsWith("wasm/")) continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const specifiers = [
      ...text.matchAll(/(?:import|export)[^'"]*?from\s*["'](\.[^"']+)["']/g),
      ...text.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      assert.ok(
        spec.endsWith(".js"),
        `${rel} imports non-JS specifier ${spec} (browsers need generated .js mirrors)`,
      );
      queue.push(path.normalize(path.join(path.dirname(rel), spec)));
    }
  }
  for (const expected of [
    "src/webIntegration.js",
    "src/proxyTransport.js",
    "packages/browser-runtime/src/types.js",
    "packages/browser-runtime/src/session.js",
  ]) {
    assert.ok(seen.has(expected), `browser graph must include ${expected}`);
  }
});
