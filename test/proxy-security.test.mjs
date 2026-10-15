import assert from "node:assert/strict";
import test from "node:test";
import { handleProxyRequest } from "../src/server/proxy.ts";
import {
  buildProxyCorsHeaders,
  createProxyRequestId,
  forwardedClientHeaders,
  isAllowedSourceContentType,
  isBlockedIPv4Value,
  isBlockedIPv6,
  parseIPv4,
  stripUpstreamHeaders,
  validateProxyTarget,
} from "../src/server/security.ts";

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
  for (const h of [
    "10.0.0.1",
    "172.16.5.4",
    "172.31.255.1",
    "192.168.1.1",
    "169.254.169.254",
    "224.0.0.1",
    "0.0.0.0",
  ]) {
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
  assert.equal(
    validateProxyTarget("https://public.test/x.json", { resolveHost: resolve }).ok,
    true,
  );
  assert.equal(validateProxyTarget("https://evil.test/x.json", { resolveHost: resolve }).ok, false);
});

test("public source content types", () => {
  for (const type of [
    "application/x-javascript",
    "application/ecmascript; charset=utf-8",
    "TEXT/JAVASCRIPT; charset=UTF-8",
    "image/png",
    "image/jpeg",
    "image/tiff",
    "application/octet-stream",
  ]) {
    assert.equal(isAllowedSourceContentType(type), true, type);
  }
  for (const type of [null, "video/mp4", "application/zip", "application/pdf"]) {
    assert.equal(isAllowedSourceContentType(type), false, type);
  }
});

test("header stripping + restrictive CORS + request ids", () => {
  const stripped = stripUpstreamHeaders({
    Cookie: "a=b",
    Authorization: "Bearer x",
    Connection: "keep-alive",
    Accept: "application/json",
    "X-Custom": "drop",
  });
  assert.ok(
    !("cookie" in stripped) && !("authorization" in stripped) && !("connection" in stripped),
  );
  assert.equal(stripped.accept, "application/json");
  assert.ok(!("x-custom" in stripped));
  assert.equal(forwardedClientHeaders({ Range: "bytes=0-3" }).range, "bytes=0-3");
  assert.equal(
    forwardedClientHeaders({ Range: ["bytes=0-3", "bytes=4-7"] }).range,
    "bytes=0-3,bytes=4-7",
  );
  const cors = buildProxyCorsHeaders("https://site.test", "https://site.test");
  assert.equal(cors["access-control-allow-origin"], "https://site.test");
  assert.deepEqual(buildProxyCorsHeaders("https://site.test", "https://evil.test"), {});
  const id1 = createProxyRequestId();
  const id2 = createProxyRequestId();
  assert.ok(/^[0-9a-f]{32}$/.test(id1));
  assert.notEqual(id1, id2);
  assert.ok(!id1.includes("?") && !id1.includes("="));
});

test("relay: public metadata and image data succeed", async () => {
  const okDeps = {
    fetchUpstream: async () => ({
      status: 200,
      headers: hdr({ "content-type": "text/javascript", "content-length": "10" }),
      body: new Response(new Uint8Array([1, 2])).body,
    }),
    websiteOrigin: "https://site.test",
    disableOriginBucket: true,
  };
  const ok = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/config.js", protocolVersion: 1 },
    okDeps,
  );
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
        body: new Response(new Uint8Array([1])).body,
      }),
    },
  );
  assert.equal(tile.status, 200);
  assert.deepEqual(new Uint8Array(tile.body), new Uint8Array([1]));
});

test("relay: method, private target, redirect-to-private, oversize", async () => {
  const base = { websiteOrigin: "https://site.test", disableOriginBucket: true };
  const badMethod = await handleProxyRequest(
    { method: "GET", targetUrl: "https://public.test/x.json", protocolVersion: 1 },
    {
      ...base,
      fetchUpstream: async () => {
        throw new Error("must not fetch");
      },
    },
  );
  assert.equal(badMethod.status, 405);

  const privateT = await handleProxyRequest(
    { method: "POST", targetUrl: "http://127.0.0.1/x.json", protocolVersion: 1 },
    {
      ...base,
      fetchUpstream: async () => {
        throw new Error("must not fetch");
      },
    },
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
        body: new Response(new Uint8Array(100)).body,
      }),
    },
  );
  assert.equal(oversize.status, 413);
  assert.equal(oversize.code, "PROXY_BUDGET_EXCEEDED");
});

test("relay preserves exact public container ranges through validated redirects", async () => {
  const seen = [];
  let cancelledRedirect = false;
  const result = await handleProxyRequest(
    {
      method: "POST",
      targetUrl: "https://public.test/source.bin",
      protocolVersion: 1,
      headers: { Range: "bytes=10-13", Cookie: "secret", Authorization: "secret" },
    },
    {
      websiteOrigin: "https://site.test",
      disableOriginBucket: true,
      fetchUpstream: async (url, init) => {
        seen.push({ url, ...init });
        if (seen.length === 1)
          return {
            status: 302,
            headers: new Headers({ location: "https://cdn.test/source.bin" }),
            body: new ReadableStream({
              cancel() {
                cancelledRedirect = true;
              },
            }),
          };
        return new Response(new Uint8Array([10, 11, 12, 13]), {
          status: 206,
          headers: {
            "content-type": "image/tiff",
            "content-range": "bytes 10-13/20000000",
            "content-length": "4",
          },
        });
      },
    },
  );
  assert.equal(result.status, 206);
  assert.deepEqual(new Uint8Array(result.body), new Uint8Array([10, 11, 12, 13]));
  assert.equal(result.headers["content-range"], "bytes 10-13/20000000");
  assert.match(result.headers["access-control-expose-headers"], /content-range/);
  assert.equal(result.upstreamUrl, "https://cdn.test/source.bin");
  assert.equal(cancelledRedirect, true);
  assert.equal(seen.length, 2);
  for (const { headers, signal } of seen) {
    assert.equal(headers.range, "bytes=10-13");
    assert.equal(headers.accept, "*/*");
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.ok(signal instanceof AbortSignal);
  }
});

test("relay rejects malformed, duplicate, and oversized ranges before fetching", async () => {
  const deps = {
    websiteOrigin: "https://site.test",
    disableOriginBucket: true,
    fetchUpstream: () => assert.fail("must not fetch"),
  };
  for (const headers of [
    { Range: "bytes=0-" },
    { Range: "bytes=3-1" },
    { Range: "bytes=0-1,4-5" },
    { Range: "bytes=0-9007199254740992" },
    { Range: "bytes=0-1", range: "bytes=0-1" },
  ]) {
    const result = await handleProxyRequest(
      { method: "POST", targetUrl: "https://public.test/image", protocolVersion: 1, headers },
      deps,
    );
    assert.equal(result.status, 422);
    assert.equal(result.code, "PROXY_POLICY_DENIED");
  }
  const oversize = await handleProxyRequest(
    {
      method: "POST",
      targetUrl: "https://public.test/image",
      protocolVersion: 1,
      headers: { Range: "bytes=0-2097152" },
    },
    deps,
  );
  assert.equal(oversize.status, 413);
  assert.equal(oversize.code, "PROXY_BUDGET_EXCEEDED");
});

test("relay cancels ignored and malformed range responses without buffering the container", async () => {
  for (const [status, contentRange, length] of [
    [200, null, "20000000"],
    [206, null, "4"],
    [206, "bytes 0-3/20", "4"],
    [206, "bytes 4-7/*", "4"],
    [206, "bytes 4-7/20", "20000000"],
  ]) {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await handleProxyRequest(
      {
        method: "POST",
        targetUrl: "https://public.test/container",
        protocolVersion: 1,
        headers: { Range: "bytes=4-7" },
      },
      {
        websiteOrigin: "https://site.test",
        disableOriginBucket: true,
        fetchUpstream: async () => ({
          status,
          headers: new Headers({
            "content-type": "image/tiff",
            "content-length": length,
            ...(contentRange ? { "content-range": contentRange } : {}),
          }),
          body,
        }),
      },
    );
    assert.equal(result.status, 502);
    assert.equal(result.code, "TRANSPORT_NETWORK_ERROR");
    assert.match(result.preview, /invalid byte-range response:/);
    assert.ok(result.preview.length <= 300);
    assert.equal(cancelled, true);
    assert.ok(reads <= 1, `read ${reads} chunks from invalid range`);
  }
});

test("relay bounds streamed image bytes and rejects incomplete container ranges", async () => {
  for (const [range, length, expectedStatus] of [
    [undefined, 9, 413],
    ["bytes=4-7", 3, 502],
    ["bytes=4-7", 5, 502],
  ]) {
    let cancelled = false;
    const result = await handleProxyRequest(
      {
        method: "POST",
        targetUrl: "https://public.test/image",
        protocolVersion: 1,
        headers: range ? { Range: range } : {},
      },
      {
        websiteOrigin: "https://site.test",
        disableOriginBucket: true,
        maxBytes: 8,
        fetchUpstream: async () => ({
          status: range ? 206 : 200,
          headers: new Headers({
            "content-type": "application/octet-stream",
            ...(range ? { "content-range": "bytes 4-7/20" } : {}),
          }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(length));
              if (length === 3) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      },
    );
    assert.equal(result.status, expectedStatus);
    if (expectedStatus === 502) assert.match(result.preview, /invalid byte-range response:/);
    if (length !== 3) assert.equal(cancelled, true);
  }
});

test("relay shares cancellation and deadline across upstream headers and body", async () => {
  // AbortSignal.timeout does not itself keep Node alive; real fetch sockets do.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    for (const stalledBody of [false, true]) {
      for (const cancel of [false, true]) {
        const controller = new AbortController();
        let cancelledBody = false;
        let fetchSignal;
        const pending = handleProxyRequest(
          { method: "POST", targetUrl: "https://public.test/image", protocolVersion: 1 },
          {
            websiteOrigin: "https://site.test",
            disableOriginBucket: true,
            timeoutMs: 10,
            signal: controller.signal,
            fetchUpstream: async (_url, init) => {
              fetchSignal = init.signal;
              if (!stalledBody) return new Promise(() => {});
              return {
                status: 200,
                headers: new Headers({ "content-type": "image/png" }),
                body: new ReadableStream({
                  cancel() {
                    cancelledBody = true;
                  },
                }),
              };
            },
          },
        );
        if (cancel) setTimeout(() => controller.abort(), 1);
        const result = await pending;
        assert.equal(result.status, cancel ? 499 : 504);
        assert.equal(result.code, cancel ? "TRANSPORT_CANCELLED" : "TRANSPORT_NETWORK_ERROR");
        assert.equal(fetchSignal.aborted, true);
        if (stalledBody) assert.equal(cancelledBody, true);
      }
    }
  } finally {
    clearTimeout(keepAlive);
  }
});
