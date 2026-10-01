import assert from "node:assert/strict";
import test from "node:test";
import * as ext from "../../../../packages/browser-runtime/src/limits.ts";

// The extension imports the canonical browser-runtime limits directly through
// its bundler; there is no vendored mirror to drift. These tests pin the
// policy numbers and tile-plan bound used by the Rust algorithm/runtime.

test("extension limits use the canonical browser-runtime policy", () => {
  // Deliberate policy tripwires: these numbers are compatibility decisions
  // (see packages/browser-runtime/src/limits.ts), never renames.
  assert.equal(ext.BROWSER_MAX_PLAN_TILES, 100_000);
  assert.equal(ext.BROWSER_MAX_CANVAS_SIDE, 32768);
  assert.equal(ext.BROWSER_MAX_CANVAS_AREA, 268435456);
});
