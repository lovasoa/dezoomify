import test from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_MAX_SCALE,
  PREVIEW_MIN_SCALE,
  PREVIEW_ZOOM_STEP,
  clampPreviewScale,
  createPreviewControls,
  setCanvasVisible,
} from "../src/preview.ts";

function element(dimensions = {}) {
  return {
    style: { transformOrigin: "", transform: "", display: "", cursor: "" },
    ...dimensions,
    listeners: {},
    textContent: null,
    hidden: false,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    fire(type, event) { this.listeners[type]?.(event); },
  };
}

function doc() {
  const ids = {
    "canvas-wrapper": element({ clientWidth: 800, clientHeight: 600 }),
    "rendering-canvas": element({ width: 1600, height: 1200 }),
    "preview-zoom-in": element(),
    "preview-zoom-out": element(),
    "preview-zoom-fit": element(),
    "preview-zoom-100": element(),
    "preview-zoom-label": element(),
    "preview-controls": element(),
  };
  return { ids, getElementById: (id) => ids[id] ?? null };
}

test("preview scale clamps to the tainted-safe transform range", () => {
  assert.equal(PREVIEW_MIN_SCALE, 0.1);
  assert.equal(PREVIEW_MAX_SCALE, 8);
  assert.equal(PREVIEW_ZOOM_STEP, 1.25);
  assert.equal(clampPreviewScale(1), 1);
  assert.equal(clampPreviewScale(0), PREVIEW_MIN_SCALE);
  assert.equal(clampPreviewScale(100), PREVIEW_MAX_SCALE);
  assert.equal(clampPreviewScale(NaN), 1);
  assert.equal(clampPreviewScale("bad"), 1);
});

test("zoom and fit apply transform-only styles", () => {
  const d = doc();
  const preview = createPreviewControls();
  preview.initControls(d);
  const canvas = d.ids["rendering-canvas"];
  preview.zoomBy(2, d);
  assert.match(canvas.style.transform, /scale\(1\)/);
  assert.equal(d.ids["preview-zoom-label"].textContent, "100%");
  preview.resetTransform(d);
  assert.deepEqual(preview.getTransform(), { scale: 0.5, tx: 0, ty: 0 });
  assert.match(canvas.style.transform, /scale\(0.5\)/);
});

test("fit keeps tall images inside the frame below the manual zoom limit", () => {
  const d = doc();
  d.ids["rendering-canvas"].width = 2000;
  d.ids["rendering-canvas"].height = 20000;
  const preview = createPreviewControls();
  preview.initControls(d);
  d.ids["preview-zoom-fit"].fire("click");
  assert.deepEqual(preview.getTransform(), { scale: 0.03, tx: 0, ty: 0 });
  assert.equal(d.ids["preview-zoom-label"].textContent, "3%");
});

test("controls wire buttons, wheel, and bounded drag without pixel reads", () => {
  const d = doc();
  const preview = createPreviewControls();
  preview.initControls(d);
  const canvas = d.ids["rendering-canvas"];
  d.ids["preview-zoom-in"].fire("click");
  assert.equal(preview.getTransform().scale, 0.625);
  d.ids["preview-zoom-out"].fire("click");
  assert.equal(preview.getTransform().scale, 0.5);
  let stopped = false;
  d.ids["canvas-wrapper"].fire("wheel", {
    deltaY: -100,
    preventDefault: () => {},
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(preview.getTransform().scale, 0.625);
  assert.equal(preview.getTransform().tx, 0);
  assert.equal(preview.getTransform().ty, 0);
  assert.equal(stopped, true);
  d.ids["preview-zoom-fit"].fire("click");
  d.ids["preview-zoom-100"].fire("click");
  canvas.fire("pointerdown", { clientX: 10, clientY: 20, pointerId: 1 });
  canvas.fire("pointermove", { clientX: 1010, clientY: 1020 });
  canvas.fire("pointerup", {});
  const moved = preview.getTransform();
  assert.equal(moved.tx, 400);
  assert.equal(moved.ty, 300);
  d.ids["preview-zoom-fit"].fire("click");
  assert.deepEqual(preview.getTransform(), { scale: 0.5, tx: 0, ty: 0 });
  d.ids["preview-zoom-100"].fire("click");
  assert.equal(preview.getTransform().scale, 1);
});

test("setCanvasVisible toggles wrapper and toolbar only", () => {
  const d = doc();
  setCanvasVisible(d, true);
  assert.equal(d.ids["canvas-wrapper"].style.display, "");
  assert.equal(d.ids["preview-controls"].hidden, false);
  setCanvasVisible(d, false);
  assert.equal(d.ids["canvas-wrapper"].style.display, "none");
  assert.equal(d.ids["preview-controls"].hidden, true);
  setCanvasVisible(null, true);
});
