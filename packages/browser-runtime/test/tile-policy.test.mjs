import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_CAPABILITY_MAX_CONCURRENCY,
  DIRECT_METADATA_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  TILE_CONCURRENCY_CAP,
  TILE_CONCURRENCY_FLOOR,
  TILE_CONCURRENCY_MAX,
  TILE_CONCURRENCY_MIN,
  TILE_MAX_REQUESTS_PER_SECOND,
  TILE_MAX_RETRIES,
  TILE_MIN_INTERVAL_MS,
  TILE_RETRY_BASE_MS,
  createTileThrottle,
  hostOf,
  pickTileConcurrency,
  proxyRateLimitDelayMs,
  shortUrl,
  tileFailedError,
  tileRetryDelayMs,
  websiteTileConcurrency,
} from "../src/tile-policy.ts";

test("tile tuning constants keep legacy parity", () => {
  assert.equal(REQUEST_TIMEOUT_MS, 30000);
  assert.equal(DIRECT_METADATA_TIMEOUT_MS, 1500);
  assert.equal(TILE_MAX_REQUESTS_PER_SECOND, 5);
  assert.equal(TILE_MIN_INTERVAL_MS, 200);
  assert.equal(TILE_MAX_RETRIES, 2);
  assert.equal(TILE_RETRY_BASE_MS, 250);
  assert.equal(TILE_CONCURRENCY_FLOOR, 4);
  assert.equal(TILE_CONCURRENCY_MIN, 6);
  assert.equal(TILE_CONCURRENCY_MAX, 12);
  assert.equal(TILE_CONCURRENCY_CAP, 12);
});

test("pickTileConcurrency adapts to cores and RTT within 6-12 plus floor", () => {
  assert.equal(pickTileConcurrency({ hardwareConcurrency: 2 }), 6);
  assert.equal(pickTileConcurrency({ hardwareConcurrency: 4 }), 8);
  assert.equal(pickTileConcurrency({ hardwareConcurrency: 8 }), 10);
  assert.equal(pickTileConcurrency({ hardwareConcurrency: 64 }), 12);
  assert.equal(pickTileConcurrency({ hardwareConcurrency: 8, rttMs: 400 }), 9);
  assert.equal(pickTileConcurrency({ hardwareConcurrency: 8, rttMs: 800 }), 8);
  assert.equal(pickTileConcurrency({ hardwareConcurrency: 64, capabilityCap: 4 }), 4);
  assert.equal(pickTileConcurrency({}), 8);
});

test("websiteTileConcurrency negotiates to the browser capability baseline 6", () => {
  assert.equal(BROWSER_CAPABILITY_MAX_CONCURRENCY, 6);
  // Adaptive picker stays 6-12 for future caps, but the live website path is
  // capped at the browser baseline so website 6, extension 6, native 16 stay
  // on the capability-negotiated policy.
  assert.equal(websiteTileConcurrency({ hardwareConcurrency: 2 }), 6);
  assert.equal(websiteTileConcurrency({ hardwareConcurrency: 16, connection: { rtt: 900 } }), 6);
  assert.equal(websiteTileConcurrency({}), 6);
  assert.equal(websiteTileConcurrency({ hardwareConcurrency: 64 }), 6);
});

test("tileRetryDelayMs backs off exponentially with jitter", () => {
  assert.equal(tileRetryDelayMs(0, () => 0), 250);
  assert.equal(tileRetryDelayMs(1, () => 0), 500);
  assert.equal(tileRetryDelayMs(2, () => 0), 1000);
  const jittered = tileRetryDelayMs(0, () => 1);
  assert.ok(jittered >= 250 && jittered <= 350, `jitter in range: ${jittered}`);
});

test("proxyRateLimitDelayMs honors Retry-After within the UX budget", () => {
  assert.equal(proxyRateLimitDelayMs(2000), 2000);
  assert.equal(proxyRateLimitDelayMs(0), 0);
  assert.equal(proxyRateLimitDelayMs(undefined), 1000);
  assert.equal(proxyRateLimitDelayMs(60000), null);
});

test("createTileThrottle staggers starts per host", async () => {
  let at = 1000;
  const slept = [];
  const throttle = createTileThrottle({ now: () => at, sleep: async (ms) => { slept.push(ms); at += ms; } });
  await throttle.throttle("https://a.test/1.png");
  assert.deepEqual(slept, []);
  await throttle.throttle("https://a.test/2.png");
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 190 && slept[0] <= 200, `gap enforced: ${slept[0]}`);
  // Other hosts keep their own clock.
  await throttle.throttle("https://b.test/1.png");
  assert.equal(slept.length, 1);
  throttle.reset();
  await throttle.throttle("https://a.test/3.png");
  assert.equal(slept.length, 1);
});

test("shortUrl and hostOf stay readable", () => {
  assert.equal(hostOf("https://example.test/x"), "example.test");
  assert.equal(hostOf("bogus"), "the server");
  assert.ok(shortUrl("https://example.test/a-very-long-path-name-that-keeps-going-forever-and-ever/x.png").startsWith("example.test"));
  assert.equal(shortUrl("bogus"), "bogus");
});

test("tileFailedError maps exhaustion to TILE_FAILED", () => {
  const error = tileFailedError("network-error", undefined, "https://a.test/1.png");
  assert.equal(error.code, "TILE_FAILED");
  assert.equal(error.retryable, true);
  assert.match(error.technical ?? "", /3 attempts/);
});
