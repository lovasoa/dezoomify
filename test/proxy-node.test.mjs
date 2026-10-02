// Node adapter wiring: the local dev server's /api/proxy drives the same
// pure relay as the Cloudflare Pages Function (`src/server/proxy.ts`). The
// relay's policy is tested once in test/proxy-function.test.mjs and
// test/proxy-policy.test.mjs; these tests cover only the Node
// IncomingMessage/ServerResponse adapter shape around it.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
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

test("the adapter relays through the shared policy and maps the response", async (t) => {
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
    nodeRequest({
      method: "OPTIONS",
      headers: { ...SAME_ORIGIN_HEADERS, origin: "http://evil.example" },
    }),
    denied,
  );
  assert.equal(denied.status, 403);
});

test("non-POST method -> 405", async () => {
  const res = captureResponse();
  await handleNodeProxyRequest(nodeRequest({ method: "GET", headers: SAME_ORIGIN_HEADERS }), res);
  assert.equal(res.status, 405);
});
