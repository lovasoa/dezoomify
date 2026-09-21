import test from "node:test";
import assert from "node:assert/strict";
import { classifyProxyFailure, createWebFetcher } from "../src/web-fetch.ts";

function hooks(log = []) {
  let seq = 0;
  const starts = [];
  const ends = [];
  let updates = 0;
  return {
    log,
    starts,
    ends,
    get updates() { return updates; },
    onRequestStart(label) { seq += 1; starts.push(label); return seq; },
    onRequestEnd(id, ok) { ends.push([id, ok]); },
    onLog(line) { log.push(line); },
    onUpdate() { updates += 1; },
  };
}

const messages = {
  rateLimitedBySite: "RATE_LIMITED",
  siteBusy: "SITE_BUSY",
  discoveryFailed: (via) => `DISCOVERY_FAILED_VIA_${via}`,
};

test("a proxy refusal retains its canonical fetch code and classified sentence", () => {
  for (const status of [403, 406]) {
    const failure = classifyProxyFailure({ status, code: "TRANSPORT_HTTP_ERROR" });
    assert.equal(failure.code, "TRANSPORT_HTTP_ERROR");
    assert.equal(failure.retryable, false);
    assert.equal(
      failure.message,
      `The site refused to share this file (HTTP ${status}). It may block shared servers; the browser extension or the desktop app may still work.`,
    );
  }
});

function okBytesFetch(bytes = new Uint8Array([1, 2]).buffer, url = "https://a.test/final.json") {
  return async () => ({
    url,
    status: 200,
    headers: { get: (k) => (k === "content-type" ? "application/json" : null) },
    arrayBuffer: async () => bytes,
  });
}

test("fetchDirect reports readable bodies with content type", async () => {
  const h = hooks();
  const fetcher = createWebFetcher({
    fetchImpl: okBytesFetch(),
    isProxyEligible: () => ({ eligible: false, reason: "test" }),
    hooks: h,
    messages,
  });
  const res = await fetcher.fetchDirect("https://a.test/x.json");
  assert.equal(res.outcome, "readable");
  assert.equal(res.contentType, "application/json");
  assert.deepEqual(h.starts, ["direct"]);
  assert.deepEqual(h.ends, [[1, true]]);
});

test("fetchDirect maps HTTP errors and rejections", async () => {
  const h = hooks();
  const fetcher = createWebFetcher({
    fetchImpl: async () => ({ url: "https://a.test/x", status: 404, headers: {}, arrayBuffer: async () => new ArrayBuffer(0) }),
    isProxyEligible: () => ({ eligible: false, reason: "test" }),
    hooks: h,
    messages,
  });
  const http = await fetcher.fetchDirect("https://a.test/x");
  assert.equal(http.outcome, "http-error");
  assert.equal(http.status, 404);
  const failing = createWebFetcher({
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    isProxyEligible: () => ({ eligible: false, reason: "test" }),
    hooks: h,
    messages,
  });
  const net = await failing.fetchDirect("https://a.test/x");
  assert.equal(net.outcome, "network-error");
});

test("fetchDirect honors caller cancellation", async () => {
  const h = hooks();
  const fetcher = createWebFetcher({
    fetchImpl: async (input, init) => {
      const signal = init?.signal ?? null;
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return { url: "https://a.test/x", status: 200, headers: {}, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    isProxyEligible: () => ({ eligible: false, reason: "test" }),
    hooks: h,
    messages,
  });
  const ctrl = new AbortController();
  ctrl.abort();
  const res = await fetcher.fetchDirect("https://a.test/x", {}, ctrl.signal);
  assert.equal(res.outcome, "cancelled");
});

test("fetchMetadataFor serves direct bytes without the proxy", async () => {
  const h = hooks();
  const attempts = [];
  h.onMetadataAttempt = (attempt) => attempts.push(attempt);
  let proxyCalls = 0;
  const fetcher = createWebFetcher({
    fetchImpl: okBytesFetch(),
    proxyTransport: { fetchViaProxy: async () => { proxyCalls += 1; return { ok: true, status: 200 }; } },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
  });
  const res = await fetcher.fetchMetadataFor("https://a.test/x.json", {});
  assert.equal(res.via, "direct");
  assert.equal(proxyCalls, 0);
  assert.equal(fetcher.getActiveTransport(), "direct");
  assert.deepEqual(attempts.map(({ transport, outcome, bytes }) => ({ transport, outcome, bytes })), [
    { transport: "direct", outcome: "readable", bytes: 2 },
  ]);
});

test("fetchMetadataFor falls back to the eligible proxy after a network failure", async () => {
  const h = hooks();
  const fetcher = createWebFetcher({
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    proxyTransport: {
      fetchViaProxy: async () => ({ ok: true, status: 200, bytes: new Uint8Array([9]).buffer, finalUrl: "https://a.test/upstream.json" }),
    },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
  });
  const res = await fetcher.fetchMetadataFor("https://a.test/x.json", {});
  assert.equal(res.via, "proxy");
  assert.equal(res.finalUri, "https://a.test/upstream.json");
  assert.equal(fetcher.getActiveTransport(), "metadata-proxy");
});

test("fetchMetadataFor never proxies HTTP errors or ineligible targets", async () => {
  const h = hooks();
  let proxyCalls = 0;
  const fetcher = createWebFetcher({
    fetchImpl: async () => ({ url: "https://a.test/x", status: 500, headers: {}, arrayBuffer: async () => new ArrayBuffer(0) }),
    proxyTransport: { fetchViaProxy: async () => { proxyCalls += 1; return { ok: true, status: 200 }; } },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
  });
  await assert.rejects(() => fetcher.fetchMetadataFor("https://a.test/x", {}), (e) => {
    assert.equal(e.code, "DISCOVERY_HTTP_ERROR");
    return true;
  });
  assert.equal(proxyCalls, 0);
  const direct429 = createWebFetcher({
    fetchImpl: async () => ({ url: "https://a.test/x", status: 429, headers: {}, arrayBuffer: async () => new ArrayBuffer(0) }),
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
  });
  await assert.rejects(() => direct429.fetchMetadataFor("https://a.test/x", {}), (e) => {
    assert.equal(e.code, "UPSTREAM_RATE_LIMITED");
    assert.equal(e.message, "SITE_BUSY");
    return true;
  });
});

test("metadata failures carry their typed cause plus the structured details context", async () => {
  const h = hooks();
  // Direct HTTP refusal: cause names the status and transport; the full
  // request URL and the bounded server signal ride alongside.
  const direct403 = createWebFetcher({
    fetchImpl: async () => ({
      url: "https://a.test/x?query=1",
      status: 403,
      headers: {},
      arrayBuffer: async () => new TextEncoder().encode("<html>denied</html>").buffer,
    }),
    isProxyEligible: () => ({ eligible: false, reason: "test" }),
    hooks: h,
    messages,
  });
  await assert.rejects(() => direct403.fetchMetadataFor("https://a.test/x?query=1", {}), (e) => {
    assert.equal(e.code, "DISCOVERY_HTTP_ERROR");
    assert.deepEqual(e.cause, { code: "DISCOVERY_HTTP_ERROR", http: 403, transport: "direct" });
    assert.equal(e.url, "https://a.test/x?query=1");
    assert.equal(e.http, 403);
    // The bounded server signal is markup-stripped to one line.
    assert.equal(e.preview, "denied");
    assert.equal(e.retryable, false);
    return true;
  });

  // Proxy policy denial: the relay reason travels inside the cause.
  const policy = createWebFetcher({
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    proxyTransport: { fetchViaProxy: async () => ({ ok: false, status: 403, code: "PROXY_POLICY_DENIED", reason: "signed-query" }) },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
  });
  await assert.rejects(() => policy.fetchMetadataFor("https://a.test/x?sig=1", {}), (e) => {
    assert.equal(e.code, "TRANSPORT_POLICY_DENIED");
    assert.deepEqual(e.cause, {
      code: "TRANSPORT_POLICY_DENIED",
      http: 403,
      transport: "metadata-proxy",
      reason: "signed-query",
    });
    assert.equal(e.url, "https://a.test/x?sig=1");
    return true;
  });

  // Upstream HTTP refusal through the proxy.
  const proxy404 = createWebFetcher({
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    proxyTransport: { fetchViaProxy: async () => ({ ok: false, status: 404, code: "TRANSPORT_HTTP_ERROR" }) },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
  });
  await assert.rejects(() => proxy404.fetchMetadataFor("https://a.test/missing", {}), (e) => {
    assert.equal(e.code, "TRANSPORT_HTTP_ERROR");
    assert.deepEqual(e.cause, { code: "TRANSPORT_HTTP_ERROR", http: 404, transport: "metadata-proxy" });
    return true;
  });

  // No readable response at all: plain network failure, no HTTP status.
  const network = createWebFetcher({
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    isProxyEligible: () => ({ eligible: false, reason: "test" }),
    hooks: h,
    messages,
  });
  await assert.rejects(() => network.fetchMetadataFor("https://a.test/x", {}), (e) => {
    assert.equal(e.code, "DISCOVERY_FAILED");
    assert.deepEqual(e.cause, { code: "DISCOVERY_FAILED", transport: "direct" });
    assert.equal(e.http, undefined);
    return true;
  });
});

test("fetchMetadataFor retries a transient proxy throttle once", async () => {
  const h = hooks();
  let calls = 0;
  const fetcher = createWebFetcher({
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    proxyTransport: {
      fetchViaProxy: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 429, code: "PROXY_RATE_LIMITED", retryAfterMs: 10 };
        return { ok: true, status: 200, bytes: new Uint8Array([7]).buffer };
      },
    },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
    sleepFn: async () => {},
  });
  const res = await fetcher.fetchMetadataFor("https://a.test/x.json", {});
  assert.equal(calls, 2);
  assert.equal(res.via, "proxy");
  const persistent = createWebFetcher({
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    proxyTransport: { fetchViaProxy: async () => ({ ok: false, status: 429, code: "PROXY_RATE_LIMITED" }) },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
    hooks: h,
    messages,
    sleepFn: async () => {},
  });
  await assert.rejects(() => persistent.fetchMetadataFor("https://a.test/x.json", {}), (e) => {
    assert.equal(e.code, "UPSTREAM_RATE_LIMITED");
    assert.equal(e.message, "RATE_LIMITED");
    return true;
  });
});

test("fetchTileFor performs one attempt and returns retryable failures to the engine", async () => {
  const h = hooks();
  const attempts = [];
  h.onTileAttempt = () => attempts.push("attempt");
  let calls = 0;
  const fetcher = createWebFetcher({
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return { url: "https://a.test/1.png", status: 200, headers: {}, arrayBuffer: async () => new Uint8Array([5]).buffer };
    },
    isProxyEligible: () => ({ eligible: false, reason: "tile" }),
    hooks: h,
    messages,
    sleepFn: async () => {},
    throttle: async () => {},
  });
  await assert.rejects(() => fetcher.fetchTileFor("https://a.test/1.png", {}), (e) => {
    assert.equal(e.code, "TILE_FAILED");
    assert.equal(e.retryable, true);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(attempts, ["attempt"]);
  const failing = createWebFetcher({
    fetchImpl: async () => { throw new Error("down"); },
    isProxyEligible: () => ({ eligible: false, reason: "tile" }),
    hooks: h,
    messages,
    sleepFn: async () => {},
    throttle: async () => {},
  });
  await assert.rejects(() => failing.fetchTileFor("https://a.test/1.png", {}), (e) => {
    assert.equal(e.code, "TILE_FAILED");
    return true;
  });
  calls = 0;
  const once = createWebFetcher({
    fetchImpl: async () => { calls += 1; throw new Error("down"); },
    isProxyEligible: () => ({ eligible: false, reason: "tile" }),
    hooks: h,
    messages,
    sleepFn: async () => {},
  });
  await assert.rejects(() => once.fetchTileFor("https://a.test/1.png", {}), /could not be saved/);
  assert.equal(calls, 1, "origin classification performs exactly one readable attempt");
});
