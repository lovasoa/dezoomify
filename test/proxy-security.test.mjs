import test from "node:test";
import assert from "node:assert/strict";
import {
  parseIPv4,
  isBlockedIPv4Value,
  isBlockedIPv6,
  validateProxyTarget,
  validateUpstreamMethod,
  isAllowedMetadataContentType,
  stripUpstreamHeaders,
  buildProxyCorsHeaders,
  createProxyRequestId,
} from "../functions/security.ts";
import { handleProxyRequest } from "../functions/proxy.ts";

function hdr(obj) {
  const lower = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v;
  return { get: (n) => lower[n.toLowerCase()] ?? null };
}

test("IPv4 notations: decimal/octal/hex loopback all blocked", () => {
  // 127.0.0.1 in various notations.
  const loopbacks = [
    "127.0.0.1",
    "2130706433", // decimal single
    "0x7f000001", // hex single
    "0177.0.0.1", // octal first part
    "0x7f.0.0.1", // hex first part
    "127.1", // short form
    "2130706433",
  ];
  for (const h of loopbacks) {
    const v = parseIPv4(h);
    assert.ok(v !== null, `parse ${h}`);
    assert.equal(isBlockedIPv4Value(v), true, h);
    const r = validateProxyTarget(`http://${h}/x.json`);
    assert.equal(r.ok, false, h);
  }
  // Private + link-local + metadata + multicast.
  for (const h of ["10.0.0.1", "172.16.5.4", "172.31.255.1", "192.168.1.1", "169.254.169.254", "224.0.0.1", "0.0.0.0"]) {
    const v = parseIPv4(h);
    assert.ok(v !== null && isBlockedIPv4Value(v), h);
    assert.equal(validateProxyTarget(`https://${h}/x`).ok, false, h);
  }
  // Public passes literal check.
  assert.equal(validateProxyTarget("https://93.184.216.34/x.json").ok, true);
});

test("172.15 vs 172.32 boundary not blocked as private", () => {
  assert.equal(isBlockedIPv4Value(parseIPv4("172.15.0.1")), false);
  assert.equal(isBlockedIPv4Value(parseIPv4("172.32.0.1")), false);
  assert.equal(isBlockedIPv4Value(parseIPv4("172.16.0.1")), true);
});

test("IPv6 vectors blocked", () => {
  assert.equal(isBlockedIPv6("::1"), true);
  assert.equal(isBlockedIPv6("::"), true);
  assert.equal(isBlockedIPv6("fe80::1"), true);
  assert.equal(isBlockedIPv6("fc00::1"), true);
  assert.equal(isBlockedIPv6("ff02::1"), true);
  assert.equal(isBlockedIPv6("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIPv6("::ffff:10.0.0.1"), true);
  assert.equal(validateProxyTarget("http://[::1]/x.json").ok, false);
  assert.equal(validateProxyTarget("http://[fe80::1]/x.json").ok, false);
  // Public IPv6 passes.
  assert.equal(isBlockedIPv6("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("userinfo, ports, scheme, signed query rejected", () => {
  assert.equal(validateProxyTarget("https://user:pass@public.test/x.json").ok, false);
  assert.equal(validateProxyTarget("https://user@public.test/x.json").ok, false);
  assert.equal(validateProxyTarget("https://public.test:8443/x.json").ok, false);
  assert.equal(validateProxyTarget("ftp://public.test/x").ok, false);
  assert.equal(validateProxyTarget("https://public.test/x?token=abc").ok, false);
  assert.equal(validateProxyTarget("https://public.test/x?SIG=1").ok, false);
  assert.equal(validateProxyTarget("https://public.test/x?ok=1").ok, true);
  assert.equal(validateProxyTarget("not a url").ok, false);
  assert.equal(validateProxyTarget("https://localhost/x.json").ok, false);
});

test("DNS rebinding double-check blocks private resolution", () => {
  const resolve = (h) => (h === "public.test" ? ["93.184.216.34"] : ["127.0.0.1"]);
  assert.equal(validateProxyTarget("https://public.test/x.json", { resolveHost: resolve }).ok, true);
  assert.equal(validateProxyTarget("https://evil.test/x.json", { resolveHost: resolve }).ok, false);
});

test("methods and content types", () => {
  assert.equal(validateUpstreamMethod("GET"), true);
  assert.equal(validateUpstreamMethod("HEAD"), true);
  assert.equal(validateUpstreamMethod("POST"), false);
  assert.equal(validateUpstreamMethod("PUT"), false);
  assert.equal(isAllowedMetadataContentType("application/json"), true);
  assert.equal(isAllowedMetadataContentType("application/json; charset=utf-8"), true);
  assert.equal(isAllowedMetadataContentType("text/xml"), true);
  assert.equal(isAllowedMetadataContentType("image/png"), false);
  assert.equal(isAllowedMetadataContentType("image/jpeg"), false);
  assert.equal(isAllowedMetadataContentType(null), false);
});

test("header stripping + restrictive CORS + request ids", () => {
  const stripped = stripUpstreamHeaders({
    Cookie: "a=b",
    Authorization: "Bearer x",
    Connection: "keep-alive",
    Accept: "application/json",
    "X-Custom": "drop",
  });
  assert.ok(!("cookie" in stripped) && !("authorization" in stripped) && !("connection" in stripped));
  assert.equal(stripped.accept, "application/json");
  assert.ok(!("x-custom" in stripped));
  const cors = buildProxyCorsHeaders("https://site.test", "https://site.test");
  assert.equal(cors["access-control-allow-origin"], "https://site.test");
  assert.deepEqual(buildProxyCorsHeaders("https://site.test", "https://evil.test"), {});
  const id1 = createProxyRequestId();
  const id2 = createProxyRequestId();
  assert.ok(/^[0-9a-f]{32}$/.test(id1));
  assert.notEqual(id1, id2);
  assert.ok(!id1.includes("?") && !id1.includes("="));
});

test("relay: valid public metadata succeeds; tiles rejected by content-type", async () => {
  const okDeps = {
    fetchUpstream: async () => ({
      status: 200,
      headers: hdr({ "content-type": "application/json", "content-length": "10" }),
      async arrayBuffer() {
        return new Uint8Array([1, 2]).buffer;
      },
    }),
    websiteOrigin: "https://site.test",
  };
  const ok = await handleProxyRequest({ method: "POST", targetUrl: "https://public.test/x.json", protocolVersion: 1 }, okDeps);
  assert.equal(ok.status, 200);
  assert.ok(ok.body instanceof ArrayBuffer);
  assert.equal(ok.headers["access-control-allow-origin"], "https://site.test");
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.ok(!JSON.stringify(ok).includes("token"));

  const tile = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/tile.jpg", protocolVersion: 1 },
    {
      ...okDeps,
      fetchUpstream: async () => ({
        status: 200,
        headers: hdr({ "content-type": "image/jpeg" }),
        async arrayBuffer() {
          return new Uint8Array([1]).buffer;
        },
      }),
    },
  );
  assert.equal(tile.status, 415);
});

test("relay: method, private target, redirect-to-private, oversize", async () => {
  const base = { websiteOrigin: "https://site.test" };
  const badMethod = await handleProxyRequest(
    { method: "GET", targetUrl: "https://public.test/x.json", protocolVersion: 1 },
    { ...base, fetchUpstream: async () => { throw new Error("must not fetch"); } },
  );
  assert.equal(badMethod.status, 405);

  const privateT = await handleProxyRequest(
    { method: "POST", targetUrl: "http://127.0.0.1/x.json", protocolVersion: 1 },
    { ...base, fetchUpstream: async () => { throw new Error("must not fetch"); } },
  );
  assert.equal(privateT.status, 403);

  const redirPrivate = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/x.json", protocolVersion: 1 },
    {
      ...base,
      fetchUpstream: async () => ({
        status: 302,
        headers: hdr({ location: "http://169.254.169.254/latest/meta-data/" }),
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      }),
    },
  );
  assert.equal(redirPrivate.status, 403);

  const oversize = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/x.json", protocolVersion: 1 },
    {
      ...base,
      maxBytes: 4,
      fetchUpstream: async () => ({
        status: 200,
        headers: hdr({ "content-type": "application/json" }),
        async arrayBuffer() {
          return new Uint8Array(100).buffer;
        },
      }),
    },
  );
  assert.equal(oversize.status, 413);
  assert.equal(oversize.code, "PROXY_BUDGET_EXCEEDED");
});
