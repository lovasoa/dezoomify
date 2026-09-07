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
    "preview-zoom-reset": element(),
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

test("zoom and reset apply transform-only styles", () => {
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

test("controls wire buttons, wheel, and drag without pixel reads", () => {
  const d = doc();
  const preview = createPreviewControls();
  preview.initControls(d);
  const canvas = d.ids["rendering-canvas"];
  d.ids["preview-zoom-in"].fire("click");
  assert.equal(preview.getTransform().scale, 0.625);
  d.ids["preview-zoom-out"].fire("click");
  assert.equal(preview.getTransform().scale, 0.5);
  d.ids["canvas-wrapper"].fire("wheel", { deltaY: -100, preventDefault: () => {} });
  assert.equal(preview.getTransform().scale, 0.625);
  d.ids["preview-zoom-reset"].fire("click");
  canvas.fire("pointerdown", { clientX: 10, clientY: 20, pointerId: 1 });
  canvas.fire("pointermove", { clientX: 15, clientY: 30 });
  canvas.fire("pointerup", {});
  const moved = preview.getTransform();
  assert.equal(moved.tx, 5);
  assert.equal(moved.ty, 10);
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
