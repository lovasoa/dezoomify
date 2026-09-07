// Todo 3.2: proxy ETag-aware revalidation plus per-origin token bucket.
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearProxyOriginBuckets,
  handleProxyRequest,
} from "../src/server/proxy.ts";
import { proxyOriginKey, stripUpstreamHeaders } from "../src/server/security.ts";

function hdr(obj) {
  const lower = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v;
  return { get: (n) => lower[n.toLowerCase()] ?? null };
}

test("conditional headers flow upstream and validators return with no-store", async () => {
  clearProxyOriginBuckets();
  let seenHeaders = null;
  const res = await handleProxyRequest(
    {
      method: "POST",
      targetUrl: "https://public.test/meta.json",
      protocolVersion: 1,
      ifNoneMatch: '"abc123"',
    },
    {
      websiteOrigin: "https://site.test",
      disableOriginBucket: true,
      fetchUpstream: async (url, init) => {
        seenHeaders = init.headers;
        return {
          status: 200,
          headers: hdr({
            "content-type": "application/json",
            etag: '"abc123"',
            "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
          }),
          async arrayBuffer() {
            return new Uint8Array([1]).buffer;
          },
        };
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(seenHeaders["if-none-match"], '"abc123"');
  assert.equal(res.headers["etag"], '"abc123"');
  assert.equal(res.headers["last-modified"], "Wed, 01 Jan 2025 00:00:00 GMT");
  const exposed = res.headers["access-control-expose-headers"] ?? "";
  assert.match(exposed.toLowerCase(), /etag/);
});

test("upstream 304 returns without a body and keeps no-store", async () => {
  clearProxyOriginBuckets();
  const res = await handleProxyRequest(
    {
      method: "POST",
      targetUrl: "https://public.test/meta.json",
      protocolVersion: 1,
      ifNoneMatch: '"abc123"',
    },
    {
      websiteOrigin: "https://site.test",
      disableOriginBucket: true,
      fetchUpstream: async () => ({
        status: 304,
        headers: hdr({ etag: '"abc123"' }),
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      }),
    },
  );
  assert.equal(res.status, 304);
  assert.equal(res.body, undefined);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["etag"], '"abc123"');
});

test("per-origin bucket fails closed with 429 without recording URLs", async () => {
  clearProxyOriginBuckets();
  let now = 1000000;
  const deps = {
    websiteOrigin: "https://site.test",
    nowMs: () => now,
    fetchUpstream: async () => ({
      status: 200,
      headers: hdr({ "content-type": "application/json" }),
      async arrayBuffer() {
        return new Uint8Array([1]).buffer;
      },
    }),
  };
  // Burst is 20: 20 rapid calls to the same origin succeed.
  for (let i = 0; i < 20; i++) {
    const res = await handleProxyRequest(
      { method: "POST", targetUrl: "https://public.test/m.json", protocolVersion: 1 },
      deps,
    );
    assert.equal(res.status, 200, `call ${i} within burst`);
  }
  // 21st rapid call fails closed without touching upstream.
  let upstreamCalls = 0;
  const throttled = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/m.json", protocolVersion: 1 },
    {
      ...deps,
      fetchUpstream: async () => {
        upstreamCalls += 1;
        return {
          status: 200,
          headers: hdr({ "content-type": "application/json" }),
          async arrayBuffer() {
            return new Uint8Array([1]).buffer;
          },
        };
      },
    },
  );
  assert.equal(throttled.status, 429);
  assert.equal(throttled.code, "PROXY_RATE_LIMITED");
  assert.equal(upstreamCalls, 0);
  assert.equal(throttled.headers["cache-control"], "no-store");
  // A different origin keeps its own bucket.
  const other = await handleProxyRequest(
    { method: "POST", targetUrl: "https://other.test/m.json", protocolVersion: 1 },
    deps,
  );
  assert.equal(other.status, 200);
  // Refill 5/s: after 1 s the first origin admits again.
  now += 1000;
  const refilled = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/m.json", protocolVersion: 1 },
    deps,
  );
  assert.equal(refilled.status, 200);
  clearProxyOriginBuckets();
});

test("origin keys are redacted origins only", () => {
  assert.equal(
    proxyOriginKey("https://public.test/a/b?token=secret#frag"),
    "https://public.test",
  );
  assert.equal(proxyOriginKey("https://PUBLIC.test:443/x.json"), "https://public.test");
  assert.equal(proxyOriginKey("http://127.0.0.1:8080/x.json"), "http://127.0.0.1:8080");
  assert.equal(proxyOriginKey("not a url"), null);
  // Paths, queries, fragments, and credentials never enter the key.
  const key = proxyOriginKey("https://public.test/secret?token=1");
  assert.ok(key && !key.includes("secret") && !key.includes("token"));
});
