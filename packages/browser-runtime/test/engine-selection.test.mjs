import test from "node:test";
import assert from "node:assert/strict";
import { createSelectionDriver, pickDeferredUri, pickEngineSelection, planSelectionDrive } from "../src/engine-selection.ts";
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

function snapshot(selection) {
  return {
    revision: 1,
    lifecycle: "Discovering",
    paused: false,
    progress: { completed: 0, total: undefined },
    selection: {
      image: undefined, level: undefined, level_count: 0, catalog: undefined, deferred: [],
      ...selection,
    },
    decision: undefined,
    terminal: undefined,
    output: undefined,
  };
}

test("planSelectionDrive selects once from the catalog, then stays quiet", () => {
  const catalog = { entries: [image([level(64, 64)]), image([level(512, 512)])] };
  assert.deepEqual(planSelectionDrive(snapshot({ catalog })), { action: "select", image: 1, level: 0 });
  assert.deepEqual(
    planSelectionDrive(snapshot({ image: 1, level: 0, catalog })),
    { action: "selected" },
  );
});

test("planSelectionDrive follows deferred entries in the same job", () => {
  const viaCatalog = { entries: [request("https://fixtures.test/iiif/image/info.json")] };
  assert.deepEqual(planSelectionDrive(snapshot({ catalog: viaCatalog })), {
    action: "follow-deferred",
    position: 0,
  });
  assert.deepEqual(
    planSelectionDrive(snapshot({ deferred: [{ position: 2, uri: "https://fixtures.test/other/info.json" }] })),
    { action: "follow-deferred", position: 2 },
  );
});

test("planSelectionDrive waits while discovering and fails closed on empty catalogs", () => {
  assert.deepEqual(planSelectionDrive(snapshot({})), { action: "waiting" });
  assert.deepEqual(planSelectionDrive(snapshot({ catalog: { entries: [] } })), { action: "unselectable" });
  assert.deepEqual(planSelectionDrive(snapshot({ catalog: { entries: [image([])] } })), { action: "unselectable" });
});

test("the selection driver sends each deferred follow once per job", () => {
  const viaCatalog = { entries: [request("https://fixtures.test/iiif/image/info.json")] };
  const driver = createSelectionDriver();
  assert.deepEqual(driver.drive(snapshot({ catalog: viaCatalog })), {
    action: "follow-deferred",
    position: 0,
  });
  // The follow command's own answer snapshot still carries the old catalog
  // while the fetch is in flight: replaying it must not resend the follow.
  assert.deepEqual(driver.drive(snapshot({ catalog: viaCatalog })), { action: "already-driven" });
  // A replaced catalog may legitimately defer again, even at position 0.
  const replaced = { entries: [request("https://fixtures.test/iiif/other/info.json")] };
  assert.deepEqual(driver.drive(snapshot({ catalog: replaced })), {
    action: "follow-deferred",
    position: 0,
  });
  driver.reset();
  assert.deepEqual(driver.drive(snapshot({ catalog: viaCatalog })), {
    action: "follow-deferred",
    position: 0,
  });
});
