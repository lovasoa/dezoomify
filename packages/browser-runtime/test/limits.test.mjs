import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_LIMITS,
  BROWSER_MAX_CANVAS_AREA,
  BROWSER_MAX_CANVAS_SIDE,
  BROWSER_MOBILE_LIMITS,
  browserLimitsFor,
  isMobileClient,
  MAXIMUM_SELECTION_LIMITS,
  probeLimits,
  safeArea,
  selectionLimitsFor,
} from "../src/limits.ts";

const LIMITS = { maxWidth: 4096, maxHeight: 4096, maxArea: 16_777_216, maxBytes: 64 * 1024 * 1024 };

test("zero dimensions require native", () => {
  for (const req of [
    { width: 0, height: 100 },
    { width: 100, height: 0 },
    { width: 0, height: 0 },
  ]) {
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
  const overArea = probeLimits(
    { width: 4096, height: 4096 },
    { ...LIMITS, maxArea: 4096 * 4096 - 1 },
  );
  assert.equal(overArea.verdict, "native-required");
});

test("gigapixel requires native without overflow", () => {
  const d = probeLimits({ width: 100000, height: 100000 }, LIMITS);
  assert.equal(d.verdict, "native-required");
  assert.equal(safeArea(100000, 100000), 100000 * 100000);
  assert.equal(
    probeLimits({ width: Number.MAX_SAFE_INTEGER, height: 2 }, LIMITS).verdict,
    "native-required",
  );
  assert.equal(safeArea(Number.MAX_SAFE_INTEGER, 2), null);
});

test("normal fixture is ok; memory over budget is browser-risk", () => {
  assert.equal(probeLimits({ width: 512, height: 512 }, LIMITS).verdict, "ok");
  const risky = probeLimits(
    { width: 512, height: 512, estimatedBytes: LIMITS.maxBytes + 1 },
    LIMITS,
  );
  assert.equal(risky.verdict, "browser-risk");
});

test("safeArea rejects invalid", () => {
  assert.equal(safeArea(0, 10), null);
  assert.equal(safeArea(-1, 10), null);
  assert.equal(safeArea(NaN, 10), null);
  assert.equal(safeArea(1.5, 10), null);
});

test("client hints pick the mobile tier: hints first, iOS/Android UA fallback", () => {
  assert.equal(isMobileClient({ userAgentData: { mobile: true } }), true);
  assert.equal(isMobileClient({ userAgentData: { mobile: false }, userAgent: "iPhone" }), false);
  assert.equal(isMobileClient({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }), true);
  assert.equal(isMobileClient({ userAgent: "Mozilla/5.0 (iPad; CPU iPad OS 17_0)" }), true);
  assert.equal(isMobileClient({ userAgent: "Mozilla/5.0 (Linux; Android 14)" }), true);
  assert.equal(isMobileClient({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), false);
  assert.equal(isMobileClient(), false);
});

test("automatic selection limits are 32768 side desktop, 8192 side mobile", () => {
  assert.deepEqual(selectionLimitsFor({ userAgentData: { mobile: false } }), {
    maxWidth: 32768,
    maxHeight: 32768,
    maxArea: 268435456,
  });
  assert.deepEqual(selectionLimitsFor({ userAgent: "Android 14" }), {
    maxWidth: 8192,
    maxHeight: 8192,
    maxArea: 67108864,
  });
  assert.equal(browserLimitsFor({ userAgentData: { mobile: false } }), BROWSER_LIMITS);
  assert.equal(browserLimitsFor({ userAgent: "iPad" }), BROWSER_MOBILE_LIMITS);
});

test("maximum selection leaves the cap to the canvas gate", () => {
  assert.ok(MAXIMUM_SELECTION_LIMITS.maxWidth > BROWSER_MAX_CANVAS_SIDE);
  assert.ok(MAXIMUM_SELECTION_LIMITS.maxHeight > BROWSER_MAX_CANVAS_SIDE);
  assert.ok(MAXIMUM_SELECTION_LIMITS.maxArea > BROWSER_MAX_CANVAS_AREA);
});
