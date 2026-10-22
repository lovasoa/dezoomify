import assert from "node:assert/strict";
import test from "node:test";
import { proxyRateLimitDelayMs } from "../src/tile-policy.ts";

test("proxyRateLimitDelayMs honors Retry-After within the UX budget", () => {
  assert.equal(proxyRateLimitDelayMs(2000), 2000);
  assert.equal(proxyRateLimitDelayMs(0), 0);
  assert.equal(proxyRateLimitDelayMs(undefined), 1000);
  assert.equal(proxyRateLimitDelayMs(60000), null);
});
