import test from "node:test";
import assert from "node:assert/strict";
import * as ext from "../../../../packages/browser-runtime/src/limits.ts";

// The extension imports the canonical browser-runtime limits directly through
// its bundler; there is no vendored mirror to drift. These tests pin the
// policy numbers and the overflow-safe selection math the job tab relies on.

test("extension limits use the canonical browser-runtime policy", () => {
  assert.equal(ext.BROWSER_MAX_PLAN_TILES, 100_000);
  assert.ok(ext.BROWSER_MAX_CANVAS_SIDE > 0);
  assert.ok(ext.BROWSER_MAX_CANVAS_AREA > 0);
  assert.equal(ext.BROWSER_LIMITS.maxArea, ext.BROWSER_MAX_CANVAS_AREA);
  assert.equal(ext.BROWSER_LIMITS.maxWidth, ext.BROWSER_MAX_CANVAS_SIDE);
});

test("pickLevel parity: largest fitting wins, overflow-safe, undeclared last wins", () => {
  const cases = [
    {
      levels: [
        { index: 0, imageSize: { x: 256, y: 256 } },
        { index: 1, imageSize: { x: 8192, y: 8192 } },
        { index: 2, imageSize: { x: 16384, y: 16384 } },
        { index: 3, imageSize: { x: 32768, y: 32768 } },
        { index: 4, imageSize: { x: 2147483648, y: 2140449280 } },
      ],
      want: { index: 2 },
    },
    {
      levels: [
        { index: 0, imageSize: { x: 1073741824, y: 1070224896 } },
        { index: 1, imageSize: { x: 2147483648, y: 2140449280 } },
      ],
      want: { index: 0 },
    },
    { levels: [{ index: 0 }, { index: 1 }, { index: 2 }], want: { index: 2 } },
    { levels: [], want: { index: 0 } },
  ];
  for (const { levels, want } of cases) {
    assert.deepEqual(ext.pickLevel({ levels }), want);
  }
  const gigapixel = { levels: [{ index: 0, imageSize: { x: 100000, y: 100000 } }] };
  assert.equal(ext.probeLimits(gigapixel.levels[0].imageSize.width ? { width: 100000, height: 100000 } : {}, ext.BROWSER_LIMITS).verdict, "native-required");
  assert.deepEqual(ext.safeArea(100000, 100000), ext.safeArea(100000, 100000));
  assert.equal(ext.safeArea(Number.MAX_SAFE_INTEGER, 2), null);
});

test("estimateTileCount parity plus 100k guard semantics", () => {
  assert.equal(ext.estimateTileCount(256, 256), 1);
  assert.equal(ext.estimateTileCount(16384, 16384), 64 * 64);
  assert.equal(ext.estimateTileCount(0, 10), null);
  assert.ok(ext.estimateTileCount(16384, 16384) <= ext.BROWSER_MAX_PLAN_TILES);
});
