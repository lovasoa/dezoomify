import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCrop,
  clampCrop,
  tileIntersectsCrop,
  subsetPlanForCrop,
  cropSizeLabel,
  cropByteEstimate,
  screenRectToLevel,
} from "../packages/browser-runtime/src/crop.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("crop parses x,y,w,h and rejects empty or malformed", () => {
  assert.deepEqual(parseCrop("10,20,300,200"), { x: 10, y: 20, w: 300, h: 200 });
  assert.deepEqual(parseCrop(" 0,0,256,256 "), { x: 0, y: 0, w: 256, h: 256 });
  for (const bad of ["", "10,20,300", "10,20,300,200,5", "a,b,c,d", "10,20,0,5", "10,20,5,0", "+10,20,5,5"]) {
    assert.throws(() => parseCrop(bad), /invalid crop/, `must reject '${bad}'`);
  }
});

test("crop clamps to canvas and rejects out-of-bounds without overflow", () => {
  const canvas = { x: 512, y: 512 };
  assert.deepEqual(clampCrop({ x: 0, y: 0, w: 512, h: 512 }, canvas), { x: 0, y: 0, w: 512, h: 512 });
  assert.deepEqual(clampCrop({ x: 400, y: 400, w: 300, h: 300 }, canvas), { x: 400, y: 400, w: 112, h: 112 });
  assert.equal(clampCrop({ x: 512, y: 0, w: 10, h: 10 }, canvas), null);
  assert.equal(clampCrop({ x: 0, y: 512, w: 10, h: 10 }, canvas), null);
  assert.equal(clampCrop({ x: 0, y: 0, w: 0, h: 10 }, canvas), null);
  // u32::MAX corners must not wrap.
  assert.equal(clampCrop({ x: 4294967295, y: 4294967295, w: 10, h: 10 }, canvas), null);
  assert.equal(cropByteEstimate({ x: 0, y: 0, w: 4294967295, h: 4294967295 }), null);
  assert.equal(cropByteEstimate({ x: 0, y: 0, w: 800, h: 600 }), 800 * 600 * 4);
  assert.equal(cropSizeLabel({ x: 10, y: 20, w: 800, h: 600 }), "800x600");
});

test("crop subset keeps intersecting tiles with shifted destinations", () => {
  const plan = {
    canvas: { x: 512, y: 512 },
    tiles: [
      { uri: "a", headers: {}, x: 0, y: 0, w: 256, h: 256, processing: "none" },
      { uri: "b", headers: {}, x: 256, y: 0, w: 256, h: 256, processing: "none" },
      { uri: "c", headers: {}, x: 0, y: 256, w: 256, h: 256, processing: "none" },
      { uri: "d", headers: {}, x: 256, y: 256, w: 256, h: 256, processing: "none" },
    ],
  };
  assert.ok(tileIntersectsCrop(0, 0, 256, 256, { x: 0, y: 0, w: 256, h: 256 }));
  assert.ok(!tileIntersectsCrop(0, 0, 256, 256, { x: 256, y: 256, w: 256, h: 256 }));
  const cropped = subsetPlanForCrop(plan, { x: 0, y: 0, w: 256, h: 256 });
  assert.deepEqual(cropped.canvas, { x: 256, y: 256 });
  assert.equal(cropped.tiles.length, 1);
  assert.deepEqual([cropped.tiles[0].x, cropped.tiles[0].y], [0, 0]);
  // Straddling crop keeps both halves with shifted destinations.
  const half = subsetPlanForCrop(plan, { x: 128, y: 128, w: 256, h: 256 });
  assert.deepEqual(half.canvas, { x: 256, y: 256 });
  assert.equal(half.tiles.length, 4);
  // Empty or out-of-bounds crops fail before acquisition with a typed error.
  assert.throws(() => subsetPlanForCrop(plan, { x: 600, y: 600, w: 10, h: 10 }), /empty or outside/);
  assert.throws(() => subsetPlanForCrop(plan, { x: 0, y: 0, w: 0, h: 10 }), /empty or outside/);
});

test("screen drag maps through the preview transform without pixel reads", () => {
  const canvas = { x: 512, y: 512 };
  const rect = screenRectToLevel(10, 10, 266, 266, { scale: 1, tx: 0, ty: 0 }, canvas);
  assert.deepEqual(rect, { x: 10, y: 10, w: 256, h: 256 });
  const zoomed = screenRectToLevel(0, 0, 512, 512, { scale: 2, tx: 0, ty: 0 }, canvas);
  assert.deepEqual(zoomed, { x: 0, y: 0, w: 256, h: 256 });
  assert.equal(screenRectToLevel(0, 0, 0, 0, { scale: 1, tx: 0, ty: 0 }, canvas), null);
});

test("website crop wires drag-rect plus inputs without pixel reads", () => {
  const mainTs = fs.readFileSync(path.join(rootDir, "src/main.ts"), "utf8");
  assert.ok(mainTs.includes("preview-crop-toggle"), "Crop button toggles mode");
  assert.ok(mainTs.includes("crop-overlay"), "drag overlay present");
  assert.ok(mainTs.includes("crop-x"), "exact-number inputs present");
  assert.ok(mainTs.includes("crop-apply"), "Apply present");
  assert.ok(mainTs.includes("crop-clear"), "Clear present");
  assert.ok(mainTs.includes("crop-estimate"), "live size estimate present");
  assert.ok(mainTs.includes("subsetPlanForCrop"), "plan subset wired");
  assert.ok(mainTs.includes("screenRectToLevel"), "drag maps through the preview transform");
  assert.ok(mainTs.includes("preview.getTransform"), "uses the 1.2 transform");
  const cropTs = fs.readFileSync(path.join(rootDir, "packages/browser-runtime/src/crop.ts"), "utf8");
  assert.ok(!cropTs.includes("getImageData("), "crop never reads pixels (tainted-safe)");
  assert.ok(!cropTs.includes(".toBlob("), "crop never encodes (tainted-safe)");
  assert.ok(!cropTs.includes("toDataURL("), "crop never encodes (tainted-safe)");
  const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
  for (const id of ["preview-crop-toggle", "crop-panel", "crop-x", "crop-y", "crop-w", "crop-h", "crop-apply", "crop-clear", "crop-estimate", "crop-overlay", "crop-rect"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
  const css = fs.readFileSync(path.join(rootDir, "packages/shared-ui/src/styles/theme.css"), "utf8");
  assert.ok(css.includes(".dz-crop-panel"), "theme styles the crop panel");
  assert.ok(css.includes(".dz-crop-overlay"), "theme styles the drag overlay");
  assert.ok(css.includes(".dz-crop-rect"), "theme styles the drag rect");
});
