import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER_MAX_CANVAS_AREA } from "../packages/browser-runtime/src/limits.ts";
import { pickEngineSelection } from "../packages/browser-runtime/src/engine-selection.ts";

test("browser canvas bound matches legacy MAX_CANVAS_AREA", () => {
  assert.equal(BROWSER_MAX_CANVAS_AREA, 16384 * 16384);
});

test("picks the largest level that fits the browser canvas", () => {
  // World_Imagery-shaped WMTS levels, normalized ascending: the 2-gigapixel
  // deepest matrix must not win (planning it exhausts worker memory).
  const levels = [
    { width: 256, height: 256 },
    { width: 8192, height: 8192 },
    { width: 16384, height: 16384 },
    { width: 32768, height: 32768 },
    { width: 2147483648, height: 2140449280 },
  ];
  assert.deepEqual(pickEngineSelection({ images: [{ readiness: "ready", levels }] }), { image: 0, level: 2 });
});

test("a level exactly at the bound still fits", () => {
  const levels = [
    { width: 8192, height: 8192 },
    { width: 16384, height: 16384 },
  ];
  assert.deepEqual(pickEngineSelection({ images: [{ readiness: "ready", levels }] }), { image: 0, level: 1 });
});

test("falls back to the smallest level when nothing fits", () => {
  const levels = [
    { width: 1073741824, height: 1070224896 },
    { width: 2147483648, height: 2140449280 },
  ];
  // Smallest, so the post-plan canvas check fails cheaply with desktop-app
  // guidance instead of planning the gigapixel level.
  assert.deepEqual(pickEngineSelection({ images: [{ readiness: "ready", levels }] }), { image: 0, level: 0 });
});

test("undeclared levels have no selectable geometry", () => {
  const levels = [{ width: 0, height: 0 }, { width: 0, height: 0 }];
  assert.equal(pickEngineSelection({ images: [{ readiness: "ready", levels }] }), null);
  assert.equal(pickEngineSelection({ images: [] }), null);
});
