import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER_MAX_CANVAS_AREA, pickLevel } from "../src/main.ts";

test("browser canvas bound matches legacy MAX_CANVAS_AREA", () => {
  assert.equal(BROWSER_MAX_CANVAS_AREA, 16384 * 16384);
});

test("picks the largest level that fits the browser canvas", () => {
  // World_Imagery-shaped WMTS levels, normalized ascending: the 2-gigapixel
  // deepest matrix must not win (planning it exhausts worker memory).
  const levels = [
    { index: 0, imageSize: { x: 256, y: 256 } },
    { index: 1, imageSize: { x: 8192, y: 8192 } },
    { index: 2, imageSize: { x: 16384, y: 16384 } },
    { index: 3, imageSize: { x: 32768, y: 32768 } },
    { index: 4, imageSize: { x: 2147483648, y: 2140449280 } },
  ];
  assert.deepEqual(pickLevel({ levels }), { index: 2 });
});

test("a level exactly at the bound still fits", () => {
  const levels = [
    { index: 0, imageSize: { x: 8192, y: 8192 } },
    { index: 1, imageSize: { x: 16384, y: 16384 } },
  ];
  assert.deepEqual(pickLevel({ levels }), { index: 1 });
});

test("falls back to the smallest level when nothing fits", () => {
  const levels = [
    { index: 0, imageSize: { x: 1073741824, y: 1070224896 } },
    { index: 1, imageSize: { x: 2147483648, y: 2140449280 } },
  ];
  // Smallest, so the post-plan canvas check fails cheaply with desktop-app
  // guidance instead of planning the gigapixel level.
  assert.deepEqual(pickLevel({ levels }), { index: 0 });
});

test("levels without a declared size keep the last one", () => {
  const levels = [{ index: 0 }, { index: 1 }, { index: 2 }];
  assert.deepEqual(pickLevel({ levels }), { index: 2 });
  assert.deepEqual(pickLevel({ levels: [] }), { index: 0 });
});
