import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_MAX_CANVAS_AREA, BROWSER_MAX_CANVAS_SIDE } from "../src/limits.ts";
import {
  CANVAS_TOO_LARGE_MESSAGE,
  canvasAllocationFailure,
  canvasSurfaceFailure,
  canvasTooLargeFailure,
  desktopHandoffLink,
  isLocalFileUrl,
  wantsDesktopHandoff,
} from "../src/plan-gates.ts";

test("desktopHandoffLink encodes the source", () => {
  assert.equal(
    desktopHandoffLink("https://example.test/view?a=b"),
    "dezoomify://open?v=2&src=https%3A%2F%2Fexample.test%2Fview%3Fa%3Db",
  );
});

test("browser canvas bound is 32768 px per side and 16384 squared of area", () => {
  assert.equal(BROWSER_MAX_CANVAS_SIDE, 32768);
  assert.equal(BROWSER_MAX_CANVAS_AREA, 16384 * 16384);
});

test("canvasTooLargeFailure carries both layers", () => {
  const failure = canvasTooLargeFailure(10, 20, "https://a.test/");
  assert.equal(failure.code, "PLAN_INVALID");
  assert.equal(failure.retryable, false);
  assert.match(failure.detail ?? "", /dezoomify:\/\/open/);
  assert.match(failure.technical ?? "", /canvas 10x20/);
});

test("allocation and context failures share the large-canvas report family", () => {
  const allocation = canvasAllocationFailure(40000, 20000, "https://a.test/");
  assert.equal(allocation.code, "OUTPUT_ALLOCATION_FAILED");
  assert.equal(allocation.retryable, false);
  assert.equal(allocation.message, CANVAS_TOO_LARGE_MESSAGE);
  assert.match(allocation.detail ?? "", /dezoomify:\/\/open/);
  assert.match(allocation.technical ?? "", /allocation failed/);
  const surface = canvasSurfaceFailure(40000, 20000, "https://a.test/");
  assert.equal(surface.code, "OUTPUT_SURFACE_UNAVAILABLE");
  assert.equal(surface.retryable, false);
  assert.match(surface.detail ?? "", /dezoomify:\/\/open/);
  assert.match(surface.technical ?? "", /2D context/);
});

test("canvas and size failure codes ask for the desktop-app handoff", () => {
  for (const code of [
    "PLAN_INVALID",
    "OUTPUT_ALLOCATION_FAILED",
    "OUTPUT_SURFACE_UNAVAILABLE",
    "OUTPUT_ENCODE_FAILED",
    "output.canvas-limit",
    "job.resource-limit",
  ]) {
    assert.equal(wantsDesktopHandoff(code), true, code);
  }
  assert.equal(wantsDesktopHandoff("DISCOVERY_FAILED"), false);
  assert.equal(wantsDesktopHandoff(""), false);
});

test("local-file detection distinguishes file URLs", () => {
  assert.equal(isLocalFileUrl("file:///tmp/x"), true);
  assert.equal(isLocalFileUrl("https://a.test/"), false);
});
