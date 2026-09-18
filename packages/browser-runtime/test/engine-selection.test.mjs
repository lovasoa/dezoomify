import test from "node:test";
import assert from "node:assert/strict";
import { pickDeferredUri, pickEngineSelection } from "../src/engine-selection.ts";
import { BROWSER_MAX_CANVAS_SIDE } from "../src/limits.ts";

function level(width, height) {
  return { label: "level", width, height };
}

function image(levels, extra = {}) {
  return { kind: "image", levels, ...extra };
}

function request(uri) {
  return { kind: "image-request", uri };
}

test("picks the largest declared level and preserves the core title", () => {
  const catalog = {
    entries: [
      image([level(128, 128), level(64, 64)]),
      image([level(512, 512), level(256, 256)], { title: "Cover" }),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: 1, level: 0, title: "Cover" });
});

test("skips deferred entries and images without levels, and surfaces the request uri", () => {
  const catalog = {
    entries: [
      request("https://fixtures.test/iiif/image/info.json"),
      image([]),
      image([level(64, 64)]),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: 2, level: 0 });
  assert.equal(pickDeferredUri(catalog), "https://fixtures.test/iiif/image/info.json");
});

test("pickDeferredUri returns null when every entry is a resolved image", () => {
  assert.equal(pickDeferredUri({ entries: [image([level(64, 64)])] }), null);
  assert.equal(pickDeferredUri({ entries: [request("")] }), null);
  assert.equal(pickDeferredUri({ entries: [] }), null);
  assert.equal(pickDeferredUri(undefined), null);
});

test("levels beyond the browser canvas fall back to the smallest declared level", () => {
  const huge = BROWSER_MAX_CANVAS_SIDE * 2;
  const catalog = {
    entries: [image([level(huge, huge), level(64, 64)])],
  };
  // The smallest declared level wins so the plan gate fails fast.
  assert.deepEqual(pickEngineSelection(catalog), { image: 0, level: 1 });
});

test("krpano Eiffel pyramid selects the largest browser-safe level", () => {
  const catalog = {
    entries: [image([
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
    entries: [
      image([level(64, 64)]),
      image([level(64, 64)]),
    ],
  };
  assert.deepEqual(pickEngineSelection(catalog), { image: 1, level: 0 });
});

test("no selectable image yields null, never a guess", () => {
  assert.equal(pickEngineSelection({ entries: [] }), null);
  assert.equal(pickEngineSelection({ entries: [image([])] }), null);
  assert.equal(pickEngineSelection({}), null);
  assert.equal(pickEngineSelection(undefined), null);
});
