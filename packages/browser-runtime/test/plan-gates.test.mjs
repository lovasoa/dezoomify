import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDeclaredSizeFitsBrowser,
  assertPlanFitsBrowser,
  canvasTooLargeFailure,
  categoryFor,
  desktopHandoffLink,
  isAllowedSourceUrl,
  isLocalFileUrl,
  levelFitsBrowser,
  mapWorkerLimitExceeded,
  phaseFor,
} from "../src/plan-gates.ts";

test("desktopHandoffLink encodes the source", () => {
  assert.equal(
    desktopHandoffLink("https://example.test/view?a=b"),
    "dezoomify://open?v=2&src=https%3A%2F%2Fexample.test%2Fview%3Fa%3Db",
  );
});

test("declared sizes fail fast with a desktop handoff", () => {
  assert.equal(assertDeclaredSizeFitsBrowser(undefined, "https://a.test/"), null);
  assert.equal(assertDeclaredSizeFitsBrowser({ x: 800, y: 600 }, "https://a.test/"), null);
  const huge = assertDeclaredSizeFitsBrowser({ x: 100000, y: 100000 }, "https://a.test/x");
  assert.equal(huge?.code, "PLAN_INVALID");
  assert.match(huge?.detail ?? "", /dezoomify:\/\/open/);
  const manyTiles = assertDeclaredSizeFitsBrowser({ x: 16384, y: 16384 }, "https://a.test/x");
  assert.equal(manyTiles, null);
});

test("post-plan gate rejects invalid, oversized, and tile-heavy plans", () => {
  assert.equal(assertPlanFitsBrowser(800, 600, 12, "https://a.test/")?.code ?? null, null);
  assert.equal(assertPlanFitsBrowser(0, 600, 0, "https://a.test/")?.code, "PLAN_INVALID");
  assert.equal(assertPlanFitsBrowser(100000, 100, 10, "https://a.test/")?.code, "PLAN_INVALID");
  const heavy = assertPlanFitsBrowser(800, 600, 100001, "https://a.test/");
  assert.equal(heavy?.code, "PLAN_INVALID");
  assert.match(heavy?.technical ?? "", /tile plan|tiles exceeds/);
});

test("worker limit-exceeded maps to the desktop handoff", () => {
  const mapped = mapWorkerLimitExceeded({ code: "X", detail: "plan limit-exceeded guard" }, 0, 0, "https://a.test/");
  assert.equal(mapped?.code, "PLAN_INVALID");
  assert.equal(mapWorkerLimitExceeded(new Error("boom"), 0, 0, "https://a.test/"), null);
});

test("canvasTooLargeFailure carries both layers", () => {
  const failure = canvasTooLargeFailure(10, 20, "https://a.test/");
  assert.equal(failure.code, "PLAN_INVALID");
  assert.equal(failure.retryable, false);
  assert.match(failure.detail ?? "", /dezoomify:\/\/open/);
  assert.match(failure.technical ?? "", /canvas 10x20/);
});

test("levelFitsBrowser respects canvas plus tile caps", () => {
  assert.equal(levelFitsBrowser(800, 600), true);
  assert.equal(levelFitsBrowser(100000, 100000), false);
});

test("source URL validators accept http(s) and flag local files", () => {
  assert.equal(isAllowedSourceUrl("https://a.test/"), true);
  assert.equal(isAllowedSourceUrl("http://a.test/"), true);
  assert.equal(isAllowedSourceUrl("file:///tmp/x"), false);
  assert.equal(isAllowedSourceUrl("bogus"), false);
  assert.equal(isLocalFileUrl("file:///tmp/x"), true);
  assert.equal(isLocalFileUrl("https://a.test/"), false);
});

test("error classification derives from codes, never text", () => {
  assert.equal(categoryFor("NO_IMAGE_FOUND"), "discovery");
  assert.equal(categoryFor("INVALID_URL"), "validation");
  assert.equal(categoryFor("OUTPUT_ENCODE_FAILED"), "output");
  assert.equal(categoryFor("PLAN_INVALID"), "internal");
  assert.equal(categoryFor("TILE_FAILED"), "transport");
  assert.equal(categoryFor({ code: "OUTPUT_ENCODE_FAILED" }), "transport");
  assert.equal(categoryFor(null), "transport");
  assert.equal(phaseFor("NO_IMAGE_FOUND"), "discovery");
  assert.equal(phaseFor("OUTPUT_DENIED"), "output");
  assert.equal(phaseFor("TILE_FAILED"), "acquisition");
  assert.equal(phaseFor({ code: "OUTPUT_DENIED" }), "acquisition");
});
