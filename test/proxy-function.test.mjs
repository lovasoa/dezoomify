// Wiring tests: the Pages Function adapter must expose the pure relay at /api/proxy.
import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost, onRequestOptions } from "../functions/api/proxy.ts";

const SITE_URL = "https://ng.dezoomify.pages.dev/api/proxy";

function postRequest(rawBody, extraHeaders = {}) {
  return new Request(SITE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: rawBody,
  });
}

function mockUpstream(upstreamImpl, t) {
  const impl = (url, init) =>
    Promise.resolve(
      new Response(upstreamImpl(url, init)?.body ?? null, {
        status: upstreamImpl(url, init)?.status ?? 200,
        headers: upstreamImpl(url, init)?.headers ?? {},
      }),
    );
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
  let fetchCalls = 0;
  const calls = mockUpstream(
    (url) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } };
      }
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    },
    t,
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/redirect.json","protocolVersion":1}'),
  });
  assert.equal(res.status, 403);
  // The private redirect target was never fetched.
  assert.equal(fetchCalls, 1);
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

test("non-JSON upstream response -> 415", async (t) => {
  mockUpstream(
    () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>" }),
    t,
  );
  const res = await onRequestPost({
    request: postRequest('{"targetUrl":"https://public.test/page","protocolVersion":1}'),
  });
  assert.equal(res.status, 415);
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
