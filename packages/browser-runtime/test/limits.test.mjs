import test from "node:test";
import assert from "node:assert/strict";
import { probeLimits, safeArea } from "../src/limits.ts";

const LIMITS = { maxWidth: 4096, maxHeight: 4096, maxArea: 16_777_216, maxBytes: 64 * 1024 * 1024 };

test("zero dimensions require native", () => {
  for (const req of [{ width: 0, height: 100 }, { width: 100, height: 0 }, { width: 0, height: 0 }]) {
    const d = probeLimits(req, LIMITS);
    assert.equal(d.verdict, "native-required");
  }
});

test("exact boundary is ok, one over requires native", () => {
  const exact = probeLimits({ width: 4096, height: 4096 }, { ...LIMITS, maxArea: 4096 * 4096 });
  assert.equal(exact.verdict, "ok");
  assert.equal(exact.area, 4096 * 4096);
  assert.equal(probeLimits({ width: 4097, height: 10 }, LIMITS).verdict, "native-required");
  assert.equal(probeLimits({ width: 10, height: 4097 }, LIMITS).verdict, "native-required");
  const overArea = probeLimits({ width: 4096, height: 4096 }, { ...LIMITS, maxArea: 4096 * 4096 - 1 });
  assert.equal(overArea.verdict, "native-required");
});

test("gigapixel requires native without overflow", () => {
  const d = probeLimits({ width: 100000, height: 100000 }, LIMITS);
  assert.equal(d.verdict, "native-required");
  assert.equal(safeArea(100000, 100000), 100000 * 100000);
  assert.equal(probeLimits({ width: Number.MAX_SAFE_INTEGER, height: 2 }, LIMITS).verdict, "native-required");
  assert.equal(safeArea(Number.MAX_SAFE_INTEGER, 2), null);
});

test("normal fixture is ok; memory over budget is browser-risk", () => {
  assert.equal(probeLimits({ width: 512, height: 512 }, LIMITS).verdict, "ok");
  const risky = probeLimits({ width: 512, height: 512, estimatedBytes: LIMITS.maxBytes + 1 }, LIMITS);
  assert.equal(risky.verdict, "browser-risk");
});

test("safeArea rejects invalid", () => {
  assert.equal(safeArea(0, 10), null);
  assert.equal(safeArea(-1, 10), null);
  assert.equal(safeArea(NaN, 10), null);
  assert.equal(safeArea(1.5, 10), null);
});
