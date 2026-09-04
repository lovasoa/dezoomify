import test from "node:test";
import assert from "node:assert/strict";
import {
  createDirectTransport,
  isClassifiedCorsOrNetworkFailure,
  allowedFallbacksFor,
} from "../src/transport.ts";

function headersMap(obj) {
  return {
    forEach(cb) {
      for (const [k, v] of Object.entries(obj)) cb(v, k);
    },
  };
}

function okFetch(expectedUrl, optsCapture) {
  return async (url, init) => {
    Object.assign(optsCapture, { url, init });
    return {
      url: expectedUrl ?? url,
      status: 200,
      headers: headersMap({ "content-type": "application/json" }),
      async arrayBuffer() {
        return new Uint8Array([1, 2, 3]).buffer;
      },
    };
  };
}

test("direct transport sends redirect follow + credentials omit + signal", async () => {
  const captured = {};
  const t = createDirectTransport(okFetch("https://x.test/meta.json", captured));
  const ctrl = new AbortController();
  const res = await t.fetchResource("https://x.test/meta.json", { signal: ctrl.signal });
  assert.equal(res.outcome, "readable");
  assert.equal(captured.init.redirect, "follow");
  assert.equal(captured.init.credentials, "omit");
  assert.equal(captured.init.signal, ctrl.signal);
  assert.equal(res.finalUrl, "https://x.test/meta.json");
  assert.equal(res.status, 200);
  assert.ok(res.bytes instanceof ArrayBuffer);
});

test("rejects Cookie and Authorization inputs without calling fetch", async () => {
  let called = 0;
  const t = createDirectTransport(async () => {
    called += 1;
    throw new Error("should not be called");
  });
  for (const h of [{ Cookie: "a=b" }, { authorization: "Bearer x" }, { "Proxy-Authorization": "x" }]) {
    const r = await t.fetchResource("https://x.test/m", { headers: h });
    assert.equal(r.outcome, "policy-denied");
    assert.match(r.reason, /credential-header-rejected/);
  }
  assert.equal(called, 0);
});

test("rejects url userinfo without calling fetch", async () => {
  let called = 0;
  const t = createDirectTransport(async () => {
    called += 1;
    throw new Error("nope");
  });
  const r = await t.fetchResource("https://user:pass@x.test/m");
  assert.equal(r.outcome, "policy-denied");
  assert.equal(called, 0);
});

test("classifies fetch rejection as network-error (not http-error)", async () => {
  const t = createDirectTransport(async () => {
    throw new TypeError("Failed to fetch");
  });
  const r = await t.fetchResource("https://x.test/m");
  assert.equal(r.outcome, "network-error");
  assert.equal(isClassifiedCorsOrNetworkFailure(r), true);
});

test("http-error is not a CORS/network failure and carries status", async () => {
  const t = createDirectTransport(async () => ({
    url: "https://x.test/m",
    status: 404,
    headers: headersMap({}),
    async arrayBuffer() {
      throw new Error("should not read body for http-error");
    },
  }));
  const r = await t.fetchResource("https://x.test/m");
  assert.equal(r.outcome, "http-error");
  assert.equal(r.status, 404);
  assert.equal(isClassifiedCorsOrNetworkFailure(r), false);
});

test("aborted signal yields cancelled", async () => {
  const t = createDirectTransport(okFetch(undefined, {}));
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await t.fetchResource("https://x.test/m", { signal: ctrl.signal });
  assert.equal(r.outcome, "cancelled");
});

test("fallback policy: only network-error yields host transports", async () => {
  const host = ["ordinary-image-display", "metadata-proxy"];
  assert.deepEqual(allowedFallbacksFor({ outcome: "network-error", reason: "x" }, host), host);
  assert.deepEqual(allowedFallbacksFor({ outcome: "http-error", finalUrl: "u", status: 500, headers: {} }, host), []);
  assert.deepEqual(allowedFallbacksFor({ outcome: "readable", finalUrl: "u", status: 200, headers: {}, bytes: new ArrayBuffer(1) }, host), []);
  assert.deepEqual(allowedFallbacksFor({ outcome: "cancelled", reason: "x" }, host), []);
  assert.deepEqual(allowedFallbacksFor({ outcome: "policy-denied", reason: "x", code: "TRANSPORT_POLICY_DENIED" }, host), []);
  // Never embeds URLs: only capability ids returned.
  for (const id of allowedFallbacksFor({ outcome: "network-error", reason: "x" }, host)) {
    assert.ok(!id.includes("http") && !id.includes("/"));
  }
});
