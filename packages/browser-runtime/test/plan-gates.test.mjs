import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_MAX_CANVAS_AREA, BROWSER_MAX_CANVAS_SIDE } from "../src/limits.ts";
import {
  canvasAllocationFailure,
  canvasSurfaceFailure,
  canvasTooLargeFailure,
} from "../src/plan-gates.ts";

test("browser canvas bound is 32768 px per side and 16384 squared of area", () => {
  assert.equal(BROWSER_MAX_CANVAS_SIDE, 32768);
  assert.equal(BROWSER_MAX_CANVAS_AREA, 16384 * 16384);
});

test("canvasTooLargeFailure retains canvas size and source", () => {
  const failure = canvasTooLargeFailure(10, 20, "https://a.test/");
  assert.equal(failure.kind, "plan-invalid");
  assert.match(failure.detail ?? "", /canvas 10x20/);
  assert.match(failure.detail ?? "", /exceeds the browser limit/);
  assert.match(failure.detail ?? "", /a\.test/);
});

test("allocation and context failures share the large-canvas report family", () => {
  const allocation = canvasAllocationFailure(40000, 20000, "https://a.test/");
  assert.equal(allocation.kind, "output-unavailable");
  assert.match(allocation.detail ?? "", /canvas 40000x20000/);
  assert.match(allocation.detail ?? "", /allocation failed/);
  const surface = canvasSurfaceFailure(40000, 20000, "https://a.test/");
  assert.equal(surface.kind, "output-unavailable");
  assert.match(surface.detail ?? "", /2D context/);
});
