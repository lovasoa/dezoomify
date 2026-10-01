import assert from "node:assert/strict";
import test from "node:test";
import { createTileThrottle, proxyRateLimitDelayMs } from "../src/tile-policy.ts";

test("proxyRateLimitDelayMs honors Retry-After within the UX budget", () => {
  assert.equal(proxyRateLimitDelayMs(2000), 2000);
  assert.equal(proxyRateLimitDelayMs(0), 0);
  assert.equal(proxyRateLimitDelayMs(undefined), 1000);
  assert.equal(proxyRateLimitDelayMs(60000), null);
});

test("createTileThrottle staggers starts per host", async () => {
  let at = 1000;
  const slept = [];
  const throttle = createTileThrottle({
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
  });
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
