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
    { id: "lvl:0", width: 256, height: 256 },
    { id: "lvl:1", width: 8192, height: 8192 },
    { id: "lvl:2", width: 16384, height: 16384 },
    { id: "lvl:3", width: 32768, height: 32768 },
    { id: "lvl:4", width: 2147483648, height: 2140449280 },
  ];
  assert.deepEqual(pickEngineSelection({ images: [{ id: "img:0", readiness: "ready", levels }] }), { image: "img:0", level: "lvl:2" });
});

test("a level exactly at the bound still fits", () => {
  const levels = [
    { id: "lvl:0", width: 8192, height: 8192 },
    { id: "lvl:1", width: 16384, height: 16384 },
  ];
  assert.deepEqual(pickEngineSelection({ images: [{ id: "img:0", readiness: "ready", levels }] }), { image: "img:0", level: "lvl:1" });
});

test("falls back to the smallest level when nothing fits", () => {
  const levels = [
    { id: "lvl:0", width: 1073741824, height: 1070224896 },
    { id: "lvl:1", width: 2147483648, height: 2140449280 },
  ];
  // Smallest, so the post-plan canvas check fails cheaply with desktop-app
  // guidance instead of planning the gigapixel level.
  assert.deepEqual(pickEngineSelection({ images: [{ id: "img:0", readiness: "ready", levels }] }), { image: "img:0", level: "lvl:0" });
});

test("undeclared levels have no selectable geometry", () => {
  const levels = [{ id: "lvl:0", width: 0, height: 0 }, { id: "lvl:1", width: 0, height: 0 }];
  assert.equal(pickEngineSelection({ images: [{ id: "img:0", readiness: "ready", levels }] }), null);
  assert.equal(pickEngineSelection({ images: [] }), null);
});
