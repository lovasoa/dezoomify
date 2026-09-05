// Wiring tests: the Pages Function adapter must expose the pure relay at /api/proxy.
import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost, onRequestOptions } from "../functions/api/proxy.ts";
import { handleProxyRequest } from "../functions/proxy.ts";

const SITE_URL = "https://ng.dezoomify.pages.dev/api/proxy";

function postRequest(rawBody, extraHeaders = {}) {
  return new Request(SITE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: rawBody,
  });
}

function mockUpstream(upstreamImpl, t) {
  const impl = (url, init) => {
    const result = upstreamImpl(url, init) ?? {};
    return Promise.resolve(
      new Response(result.body ?? null, {
        status: result.status ?? 200,
        headers: result.headers ?? {},
      }),
    );
  };
  return t.mock.method(globalThis, "fetch", impl);
}

test("happy path: relays metadata JSON with CORS and content-type", async (t) => {
  const calls = mockUpstream(
    () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"x":1}' }),
    t,
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/iiif.json","protocolVersion":1}', {
      origin: "https://ng.dezoomify.pages.dev",
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"x":1}');
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("access-control-allow-origin"), "https://ng.dezoomify.pages.dev");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(calls.mock.calls[0].arguments[1].method, "GET");
  // The function must never let fetch follow redirects itself: the relay
  // revalidates every hop against the SSRF policy (see next test).
  assert.equal(calls.mock.calls[0].arguments[1].redirect, "manual");
});

test("redirect hops are revalidated by the relay, not followed by fetch", async (t) => {
  // A plain object instead of `new Response` because the Response headers
  // guard strips `location`, which would hide the redirect from the relay.
  const calls = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve({
      status: 302,
      headers: { get: (name) => (name.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data" : null) },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }),
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/redirect.json","protocolVersion":1}'),
  });
  assert.equal(res.status, 403);
  // The private redirect target was never fetched.
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(calls.mock.calls[0].arguments[1].redirect, "manual");
});

test("cross-origin request gets no CORS grant (browser blocks read)", async (t) => {
  mockUpstream(() => ({ status: 200, headers: { "content-type": "text/plain" }, body: "ok" }), t);
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/x.txt","protocolVersion":1}', {
      origin: "https://evil.example",
    }),
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("malformed JSON body -> 400", async (t) => {
  const res = await onRequestPost({ request: postRequest("{not json") });
  assert.equal(res.status, 400);
});

test("missing fields -> 422", async (t) => {
  const res = await onRequestPost({ request: postRequest('{"protocolVersion":1}') });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "PROXY_POLICY_DENIED");
});

test("blocked loopback target -> 403 without upstream call", async (t) => {
  const calls = mockUpstream(() => ({ status: 200, headers: {}, body: "x" }), t);
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"http://127.0.0.1:8080/x.json","protocolVersion":1}'),
  });
  assert.equal(res.status, 403);
  assert.equal(calls.mock.callCount(), 0);
});

test("oversized declared body -> 413 budget", async (t) => {
  mockUpstream(
    () => ({
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: "{}",
    }),
    t,
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/big.json","protocolVersion":1}'),
  });
  assert.equal(res.status, 413);
});

test("tile-like image content type -> 415 (metadata only)", async (t) => {
  mockUpstream(
    () => ({ status: 200, headers: { "content-type": "image/jpeg" }, body: "jpeg" }),
    t,
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/tile.jpg","protocolVersion":1}'),
  });
  assert.equal(res.status, 415);
});

test("viewer HTML page (e.g. a Google Arts asset page) is relayed as metadata", async (t) => {
  mockUpstream(
    () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<!doctype html><html><body>asset page</body></html>",
    }),
    t,
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/asset","protocolVersion":1}'),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /asset page/);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
});

test("binary non-metadata upstream response -> 415", async (t) => {
  mockUpstream(
    () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: "\x00" }),
    t,
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/blob","protocolVersion":1}'),
  });
  assert.equal(res.status, 415);
});

test("transient upstream 429 is retried once and succeeds", async (t) => {
  let calls = 0;
  const upstream = t.mock.method(globalThis, "fetch", () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({
        status: 429,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    }
    return Promise.resolve(
      new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
    );
  });
  const result = await handleProxyRequest(
    {
      method: "POST",
      targetUrl: "https://public.test/busy.json",
      protocolVersion: 1,
      origin: "https://ng.dezoomify.pages.dev",
    },
    {
      fetchUpstream: (url, init) => upstream(url, init),
      websiteOrigin: "https://ng.dezoomify.pages.dev",
      rateLimitRetryDelayMs: 1,
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.code, undefined);
  assert.equal(upstream.mock.callCount(), 2, "exactly one retry after the 429");
});

test("persistent upstream 429 fails fast after a single retry", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve({
      status: 429,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }),
  );
  const result = await handleProxyRequest(
    {
      method: "POST",
      targetUrl: "https://public.test/busy.json",
      protocolVersion: 1,
      origin: "https://ng.dezoomify.pages.dev",
    },
    {
      fetchUpstream: (url, init) => upstream(url, init),
      websiteOrigin: "https://ng.dezoomify.pages.dev",
      rateLimitRetryDelayMs: 1,
    },
  );
  assert.equal(result.status, 429);
  assert.equal(result.code, "PROXY_RATE_LIMITED");
  assert.equal(upstream.mock.callCount(), 2, "no unbounded retry loop");
});

test("OPTIONS preflight: same origin allowed, cross origin refused", async (t) => {
  const ok = await onRequestOptions({
    request: new Request(SITE_URL, {
      method: "OPTIONS",
      headers: { origin: "https://ng.dezoomify.pages.dev" },
    }),
  });
  assert.equal(ok.status, 204);
  assert.equal(
    ok.headers.get("access-control-allow-origin"),
    "https://ng.dezoomify.pages.dev",
  );
  const denied = await onRequestOptions({
    request: new Request(SITE_URL, { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
  });
  assert.equal(denied.status, 403);
});
