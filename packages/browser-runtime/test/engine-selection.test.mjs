import test from "node:test";
import assert from "node:assert/strict";
import { pickEngineSelection } from "../src/engine-selection.ts";
import { BROWSER_MAX_CANVAS_SIDE } from "../src/limits.ts";

function level(id, width, height) {
  return { id, width, height };
}

function image(id, levels, readiness = "ready") {
  return { id, readiness, levels };
}

test("picks the largest declared level of the largest ready image", () => {
  const catalog = {
    images: [
      image("img:0", [level("lvl:a", 128, 128), level("lvl:b", 64, 64)]),
      image("img:1", [level("lvl:c", 512, 512), level("lvl:d", 256, 256)]),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: "img:1", level: "lvl:c" });
});

test("skips deferred images and images without levels", () => {
  const catalog = {
    images: [
      image("img:deferred", [level("lvl:x", 1024, 1024)], "deferred"),
      image("img:empty", []),
      image("img:ok", [level("lvl:y", 64, 64)]),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: "img:ok", level: "lvl:y" });
});

test("levels beyond the browser canvas fall back to the smallest declared level", () => {
  const huge = BROWSER_MAX_CANVAS_SIDE * 2;
  const catalog = {
    images: [image("img:0", [level("lvl:big", huge, huge), level("lvl:small", 64, 64)])],
  };
  // The smallest declared level wins so the plan gate fails fast.
  assert.deepEqual(pickEngineSelection(catalog), { image: "img:0", level: "lvl:small" });
});

test("ties keep the later image and later level", () => {
  const catalog = {
    images: [
      image("img:0", [level("lvl:0", 64, 64)]),
      image("img:1", [level("lvl:1", 64, 64)]),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: "img:1", level: "lvl:1" });
});

test("no selectable image yields null, never a guess", () => {
  assert.equal(pickEngineSelection({ images: [] }), null);
  assert.equal(pickEngineSelection({ images: [image("img:0", [])] }), null);
  assert.equal(pickEngineSelection({}), null);
  assert.equal(pickEngineSelection(undefined), null);
});
