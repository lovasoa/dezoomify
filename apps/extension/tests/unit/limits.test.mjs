import test from "node:test";
import assert from "node:assert/strict";
import * as ext from "../../../../packages/browser-runtime/src/limits.ts";

// The extension imports the canonical browser-runtime limits directly through
// its bundler; there is no vendored mirror to drift. These tests pin the
// policy numbers and tile-plan bound used by the engine/runtime.

test("extension limits use the canonical browser-runtime policy", () => {
  assert.equal(ext.BROWSER_MAX_PLAN_TILES, 100_000);
  assert.ok(ext.BROWSER_MAX_CANVAS_SIDE > 0);
  assert.ok(ext.BROWSER_MAX_CANVAS_AREA > 0);
  assert.equal(ext.BROWSER_LIMITS.maxArea, ext.BROWSER_MAX_CANVAS_AREA);
  assert.equal(ext.BROWSER_LIMITS.maxWidth, ext.BROWSER_MAX_CANVAS_SIDE);
});
