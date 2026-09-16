import test from "node:test";
import assert from "node:assert/strict";
import { pickEngineSelection } from "../src/engine-selection.ts";
import { BROWSER_MAX_CANVAS_SIDE } from "../src/limits.ts";

function level(width, height) {
  return { label: "level", width, height };
}

function image(levels, readiness = "ready") {
  return { readiness, levels };
}

test("picks the largest declared level and preserves the core title", () => {
  const catalog = {
    images: [
      image([level(128, 128), level(64, 64)]),
      { ...image([level(512, 512), level(256, 256)]), title: "Cover" },
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: 1, level: 0, title: "Cover" });
});

test("skips deferred images and images without levels", () => {
  const catalog = {
    images: [
      image([level(1024, 1024)], "deferred"),
      image([]),
      image([level(64, 64)]),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: 2, level: 0 });
});

test("levels beyond the browser canvas fall back to the smallest declared level", () => {
  const huge = BROWSER_MAX_CANVAS_SIDE * 2;
  const catalog = {
    images: [image([level(huge, huge), level(64, 64)])],
  };
  // The smallest declared level wins so the plan gate fails fast.
  assert.deepEqual(pickEngineSelection(catalog), { image: 0, level: 1 });
});

test("krpano Eiffel pyramid selects the largest browser-safe level", () => {
  const catalog = {
    images: [image([
      level(512, 512),
      level(844, 1152),
      level(1898, 2176),
      level(3586, 4352),
      level(7172, 8832),
      level(14554, 8832),
      level(29110, 17664),
      level(58220, 35328),
    ])],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: 0, level: 5 });
});

test("ties keep the later image and later level", () => {
  const catalog = {
    images: [
      image([level(64, 64)]),
      image([level(64, 64)]),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: 1, level: 0 });
});

test("no selectable image yields null, never a guess", () => {
  assert.equal(pickEngineSelection({ images: [] }), null);
  assert.equal(pickEngineSelection({ images: [image([])] }), null);
  assert.equal(pickEngineSelection({}), null);
  assert.equal(pickEngineSelection(undefined), null);
});
