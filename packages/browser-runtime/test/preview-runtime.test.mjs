import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewControls, setCanvasVisible } from "../src/preview.ts";

function element(dimensions = {}) {
  return {
    style: { transformOrigin: "", transform: "", display: "", cursor: "" },
    ...dimensions,
    listeners: {},
    textContent: null,
    hidden: false,
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    fire(type, event) {
      this.listeners[type]?.(event);
    },
  };
}

function doc() {
  const ids = {
    "canvas-wrapper": element({
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 100, top: 200, width: 800, height: 600 }),
    }),
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

test("zoom stays between fit and the image's natural scale", () => {
  const d = doc();
  d.ids["rendering-canvas"].width = 2000;
  d.ids["rendering-canvas"].height = 20000;
  const preview = createPreviewControls();
  preview.initControls(d);
  assert.deepEqual(preview.getTransform(), { scale: 0.03, tx: 0, ty: 0 });
  assert.equal(d.ids["preview-zoom-label"].textContent, "3%");
  preview.zoomBy(100, d);
  assert.equal(preview.getTransform().scale, 1);
  preview.zoomBy(0.01, d);
  assert.equal(preview.getTransform().scale, 0.03);
});

test("wheel zoom follows the pointer after panning; toolbar zoom uses the viewport center", () => {
  const d = doc();
  const preview = createPreviewControls();
  preview.initControls(d);
  const wrapper = d.ids["canvas-wrapper"];
  wrapper.fire("wheel", { deltaY: -100, clientX: 700, clientY: 350 });
  assert.deepEqual(preview.getTransform(), { scale: 0.625, tx: -50, ty: 37.5 });

  const canvas = d.ids["rendering-canvas"];
  canvas.fire("pointerdown", { clientX: 700, clientY: 350, pointerId: 1 });
  canvas.fire("pointermove", { clientX: 740, clientY: 370 });
  canvas.fire("pointerup", {});
  wrapper.fire("wheel", { deltaY: -100, clientX: 400, clientY: 550, ctrlKey: true });
  assert.deepEqual(preview.getTransform(), { scale: 0.78125, tx: 12.5, ty: 59.375 });

  wrapper.fire("wheel", { deltaY: 100, clientX: 400, clientY: 550, ctrlKey: true });
  assert.deepEqual(preview.getTransform(), { scale: 0.625, tx: -10, ty: 57.5 });

  d.ids["preview-zoom-in"].fire("click");
  assert.deepEqual(preview.getTransform(), { scale: 0.78125, tx: -12.5, ty: 71.875 });
});

test("pointer zoom uses the bounded scale and recenters at fit", () => {
  const d = doc();
  const preview = createPreviewControls();
  preview.initControls(d);
  preview.setScale(0.9, d);
  const wrapper = d.ids["canvas-wrapper"];
  const pointer = { clientX: 725, clientY: 635 };
  wrapper.fire("wheel", { deltaY: -100, ...pointer });
  assert.deepEqual(preview.getTransform(), { scale: 1, tx: -25, ty: -15 });
  wrapper.fire("wheel", { deltaY: -100, ...pointer });
  assert.deepEqual(preview.getTransform(), { scale: 1, tx: -25, ty: -15 });

  for (let i = 0; i < 4; i++) wrapper.fire("wheel", { deltaY: 100, ...pointer });
  assert.deepEqual(preview.getTransform(), { scale: 0.5, tx: 0, ty: 0 });
});

test("pointer zoom keeps a letterboxed axis centered", () => {
  const d = doc();
  d.ids["rendering-canvas"].width = 400;
  const preview = createPreviewControls();
  preview.initControls(d);
  d.ids["canvas-wrapper"].fire("wheel", { deltaY: -100, clientX: 600, clientY: 350 });
  const { scale, tx, ty } = preview.getTransform();
  assert.equal(scale, 0.625);
  assert.equal(Math.abs(tx), 0);
  assert.equal(ty, 37.5);
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
    stopPropagation: () => {
      stopped = true;
    },
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
