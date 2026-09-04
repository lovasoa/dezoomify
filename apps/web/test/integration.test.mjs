import test from "node:test";
import assert from "node:assert/strict";
import { createWebIntegration, isProxyEligible } from "../src/webIntegration.ts";
import { createProxyTransport } from "../src/proxyTransport.ts";
import { DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL } from "../../../packages/browser-runtime/src/types.ts";

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
  assert.equal(isProxyEligible(okReq, { proxyOptOut: false }).eligible, true);
  // Tile never proxied.
  assert.equal(isProxyEligible({ ...okReq, kind: "tile" }, { proxyOptOut: false }).eligible, false);
  // Opt-out suppresses.
  assert.equal(isProxyEligible(okReq, { proxyOptOut: true }).eligible, false);
  // Credential-bearing targets ineligible.
  assert.equal(isProxyEligible({ url: "https://user:pw@public.test/x", kind: "metadata" }, { proxyOptOut: false }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x?token=abc", kind: "metadata" }, { proxyOptOut: false }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", headers: { Cookie: "a=b" } }, { proxyOptOut: false }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", headers: { Authorization: "Bearer x" } }, { proxyOptOut: false }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", requiresCookies: true }, { proxyOptOut: false }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", requiresAuth: true }, { proxyOptOut: false }).eligible, false);
  // Private/local ineligible.
  for (const u of ["http://localhost/x", "http://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x"]) {
    assert.equal(isProxyEligible({ url: u, kind: "metadata" }, { proxyOptOut: false }).eligible, false, u);
  }
});

test("no proxy for http-error, policy-denied, cancelled, opt-out, tile", async () => {
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
  // Opt-out suppresses proxy on network-error.
  {
    const direct = directCorsFail();
    const proxy = proxyOk();
    const web = createWebIntegration({ direct, proxy, onTransport: () => {}, proxyOptOut: true });
    const res = await web.fetchMetadata({ url: "https://public.test/x", kind: "metadata" });
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
