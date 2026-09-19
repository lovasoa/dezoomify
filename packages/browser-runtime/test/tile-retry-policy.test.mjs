import test from "node:test";
import assert from "node:assert/strict";
import { createWebFetcher } from "../src/web-fetch.ts";

function hooks() {
  let seq = 0;
  return {
    onRequestStart(label) { seq += 1; return seq; },
    onRequestEnd() {},
    onLog() {},
    onUpdate() {},
  };
}

const messages = {
  rateLimitedBySite: "RATE_LIMITED",
  siteBusy: "SITE_BUSY",
  discoveryFailed: (via) => `DISCOVERY_FAILED_VIA_${via}`,
};

function baseDeps(overrides = {}) {
  return {
    isProxyEligible: () => ({ eligible: false, reason: "tile" }),
    hooks: hooks(),
    messages,
    sleepFn: async () => {},
    throttle: async () => {},
    ...overrides,
  };
}

function httpErrorFetch(status) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      url: "https://tiles.test/0/0.png",
      status,
      headers: {},
      arrayBuffer: async () => new TextEncoder().encode("denied").buffer,
    };
  };
  return { fetchImpl, calls: () => calls };
}

test("a refused tile (HTTP 403) costs exactly one direct attempt; the engine owns retries", async () => {
  const { fetchImpl, calls } = httpErrorFetch(403);
  const fetcher = createWebFetcher(baseDeps({ fetchImpl }));
  await assert.rejects(() => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}), (error) => {
    assert.equal(error.code, "TILE_FAILED");
    return true;
  });
  assert.equal(calls(), 1, `403 retried at the route: ${calls()} direct attempts`);
});

test("a missing tile (HTTP 404) costs exactly one direct attempt", async () => {
  const { fetchImpl, calls } = httpErrorFetch(404);
  const fetcher = createWebFetcher(baseDeps({ fetchImpl }));
  await assert.rejects(() => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}));
  assert.equal(calls(), 1, `404 retried at the route: ${calls()} direct attempts`);
});

test("an upstream failure (HTTP 503) costs exactly one direct attempt; the engine owns the retry budget", async () => {
  const { fetchImpl, calls } = httpErrorFetch(503);
  const fetcher = createWebFetcher(baseDeps({ fetchImpl }));
  await assert.rejects(() => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}));
  assert.equal(calls(), 1, `503 retried at the route: ${calls()} direct attempts`);
});

test("a throttled tile (HTTP 429) costs exactly one direct attempt", async () => {
  const { fetchImpl, calls } = httpErrorFetch(429);
  const fetcher = createWebFetcher(baseDeps({ fetchImpl }));
  await assert.rejects(() => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}));
  assert.equal(calls(), 1, `429 retried at the route: ${calls()} direct attempts`);
});

test("a tile Retry-After hint survives the one-attempt fetch for engine scheduling", async () => {
  let calls = 0;
  const fetcher = createWebFetcher(baseDeps({
    nowFn: () => 1000,
    fetchImpl: async () => {
      calls += 1;
      return {
        url: "https://tiles.test/0/0.png",
        status: 429,
        headers: { get: (name) => name === "retry-after" ? "3" : null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
  }));
  await assert.rejects(() => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}), (error) => {
    assert.equal(error.retry_after_ms, 3000);
    return true;
  });
  assert.equal(calls, 1);
});

test("a transient network failure costs one direct attempt; the engine owns retries", async () => {
  let calls = 0;
  const fetcher = createWebFetcher(baseDeps({
    fetchImpl: async () => { calls += 1; throw new Error("connection reset"); },
  }));
  await assert.rejects(() => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}), (error) => {
    assert.equal(error.code, "TILE_FAILED");
    return true;
  });
  assert.equal(calls, 1);
});

test("a transient failure is returned to the engine for retry", async () => {
  let calls = 0;
  const fetcher = createWebFetcher(baseDeps({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("flaky");
      return {
        url: "https://tiles.test/0/0.png",
        status: 200,
        headers: {},
        arrayBuffer: async () => new Uint8Array([7]).buffer,
      };
    },
  }));
  await assert.rejects(() => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}), (error) => {
    assert.equal(error.code, "TILE_FAILED");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(calls, 1);
});

test("a pre-aborted job signal prevents a tile attempt", async () => {
  let calls = 0;
  const fetcher = createWebFetcher(baseDeps({
    fetchImpl: async () => { calls += 1; throw new Error("flaky"); },
  }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => fetcher.fetchTileFor("https://tiles.test/0/0.png", {}, controller.signal),
    (error) => {
      assert.equal(error.code, "TRANSPORT_CANCELLED");
      return true;
    },
  );
  assert.equal(calls, 0, `pre-aborted job fetched a tile: ${calls} direct attempts`);
});

test("a pre-aborted job signal performs no metadata fetch", async () => {
  let calls = 0;
  const fetcher = createWebFetcher(baseDeps({
    fetchImpl: async () => {
      calls += 1;
      return {
        url: "https://meta.test/info.json",
        status: 200,
        headers: {},
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      };
    },
  }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => fetcher.fetchMetadataFor("https://meta.test/info.json", {}, controller.signal),
    (error) => {
      assert.equal(error.code, "TRANSPORT_CANCELLED");
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("a metadata fetch aborted mid-flight never falls back to the proxy", async () => {
  let proxyCalls = 0;
  const fetcher = createWebFetcher(baseDeps({
    fetchImpl: async (input, init) => {
      init?.signal?.addEventListener?.("abort", () => {}, { once: true });
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
    proxyTransport: {
      fetchViaProxy: async () => { proxyCalls += 1; return { ok: true, status: 200, bytes: new ArrayBuffer(2) }; },
    },
    isProxyEligible: () => ({ eligible: true, reason: "public" }),
  }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => fetcher.fetchMetadataFor("https://meta.test/info.json", {}, controller.signal),
    (error) => {
      assert.equal(error.code, "TRANSPORT_CANCELLED");
      return true;
    },
  );
  assert.equal(proxyCalls, 0, "aborted metadata fell through to the proxy");
});
