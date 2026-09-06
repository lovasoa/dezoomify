// Node adapter wiring: the local dev server's /api/proxy must drive the
// exact same pure relay as the Cloudflare Pages Function. These tests mirror
// test/proxy-function.test.mjs but go through handleNodeProxyRequest with
// Node IncomingMessage/ServerResponse doubles instead of Request/Response.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleNodeProxyRequest } from "../src/server/proxy-node.ts";

function nodeRequest({ method = "POST", headers = {}, body = "" } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.headers = headers;
  req.destroyed = false;
  return req;
}

function captureResponse() {
  const res = { status: 0, headers: {}, body: Buffer.alloc(0) };
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = { ...headers };
  };
  res.end = (body) => {
    if (body !== undefined) {
      res.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    }
  };
  return res;
}

const SAME_ORIGIN_HEADERS = {
  host: "dezoomify.test",
  origin: "http://dezoomify.test",
  "content-type": "application/json",
};

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
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({
      headers: SAME_ORIGIN_HEADERS,
      body: '{"targetUrl":"https://public.test/iiif.json","protocolVersion":1}',
    }),
    res,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '{"x":1}');
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["access-control-allow-origin"], "http://dezoomify.test");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(calls.mock.calls[0].arguments[1].method, "GET");
  // The adapter must never let fetch follow redirects itself.
  assert.equal(calls.mock.calls[0].arguments[1].redirect, "manual");
});

test("redirect hops are revalidated by the relay, not followed by fetch", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve({
      status: 302,
      headers: { get: (name) => (name.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data" : null) },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }),
  );
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({
      headers: SAME_ORIGIN_HEADERS,
      body: '{"targetUrl":"https://public.test/redirect.json","protocolVersion":1}',
    }),
    res,
  );
  assert.equal(res.status, 403);
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(calls.mock.calls[0].arguments[1].redirect, "manual");
});

test("cross-origin request gets no CORS grant (browser blocks read)", async (t) => {
  mockUpstream(() => ({ status: 200, headers: { "content-type": "text/plain" }, body: "ok" }), t);
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({
      headers: { ...SAME_ORIGIN_HEADERS, origin: "http://evil.example" },
      body: '{"targetUrl":"https://public.test/x.txt","protocolVersion":1}',
    }),
    res,
  );
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("malformed JSON body -> 400", async () => {
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({ headers: SAME_ORIGIN_HEADERS, body: "{not json" }),
    res,
  );
  assert.equal(res.status, 400);
});

test("missing fields -> 422", async () => {
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({ headers: SAME_ORIGIN_HEADERS, body: '{"protocolVersion":1}' }),
    res,
  );
  assert.equal(res.status, 422);
  assert.equal(JSON.parse(res.body.toString()).code, "PROXY_POLICY_DENIED");
});

test("blocked loopback target -> 403 without upstream call", async (t) => {
  const calls = mockUpstream(() => ({ status: 200, headers: {}, body: "x" }), t);
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({
      headers: SAME_ORIGIN_HEADERS,
      body: '{"targetUrl":"http://127.0.0.1:8080/x.json","protocolVersion":1}',
    }),
    res,
  );
  assert.equal(res.status, 403);
  assert.equal(calls.mock.callCount(), 0);
});

test("tile-like image content type -> 415 (metadata only)", async (t) => {
  mockUpstream(
    () => ({ status: 200, headers: { "content-type": "image/jpeg" }, body: "jpeg" }),
    t,
  );
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({
      headers: SAME_ORIGIN_HEADERS,
      body: '{"targetUrl":"https://public.test/tile.jpg","protocolVersion":1}',
    }),
    res,
  );
  assert.equal(res.status, 415);
});

test("relay exposes the post-redirect upstream URL for relative tile bases", async (t) => {
  mockUpstream(
    () => ({ status: 200, headers: { "content-type": "application/xml" }, body: "<krpano/>" }),
    t,
  );
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({
      headers: SAME_ORIGIN_HEADERS,
      body: '{"targetUrl":"https://public.test/galleria_04.xml","protocolVersion":1}',
    }),
    res,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-proxy-upstream-url"], "https://public.test/galleria_04.xml");
  const exposed = res.headers["access-control-expose-headers"] ?? "";
  assert.match(exposed.toLowerCase(), /x-proxy-upstream-url/);
});

test("OPTIONS preflight: same origin allowed, cross origin refused", async () => {
  const ok = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({ method: "OPTIONS", headers: SAME_ORIGIN_HEADERS }),
    ok,
  );
  assert.equal(ok.status, 204);
  assert.equal(ok.headers["access-control-allow-origin"], "http://dezoomify.test");
  assert.equal(ok.headers["access-control-allow-methods"], "POST");

  const denied = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({ method: "OPTIONS", headers: { ...SAME_ORIGIN_HEADERS, origin: "http://evil.example" } }),
    denied,
  );
  assert.equal(denied.status, 403);
});

test("non-POST method -> 405", async () => {
  const res = captureResponse();
  await handleNodeProxyRequest(
    nodeRequest({ method: "GET", headers: SAME_ORIGIN_HEADERS }),
    res,
  );
  assert.equal(res.status, 405);
});
