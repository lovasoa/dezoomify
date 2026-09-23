import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewControls } from "../packages/browser-runtime/src/preview.ts";

function fakeElement() {
  const listeners = new Map();
  return {
    style: { transform: "", transformOrigin: "", display: "", cursor: "" },
    width: 800,
    height: 600,
    clientWidth: 400,
    clientHeight: 300,
    textContent: null,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    // Pixel reads and encodes must never happen: trap them so any call throws.
    getImageData() {
      throw new Error("preview must not read pixels");
    },
    toBlob() {
      throw new Error("preview must not encode");
    },
    toDataURL() {
      throw new Error("preview must not encode");
    },
  };
}

function fakeDoc() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  return {
    element,
    getElementById: (id) => elements.get(id) ?? null,
  };
}

function wheelEvent(deltaY) {
  return { deltaY, preventDefault() {}, stopPropagation() {} };
}

test("website preview wires wheel, drag, and buttons without pixel reads", () => {
  const doc = fakeDoc();
  for (const id of [
    "canvas-wrapper",
    "rendering-canvas",
    "preview-zoom-in",
    "preview-zoom-out",
    "preview-zoom-fit",
    "preview-zoom-100",
    "preview-zoom-label",
  ]) {
    doc.element(id);
  }
  const preview = createPreviewControls();
  preview.initControls(doc);
  const canvas = doc.element("rendering-canvas");
  // Fit scale for an 800x600 canvas in a 400x300 viewport.
  assert.equal(preview.getTransform().scale, 0.5);

  doc.element("preview-zoom-in").fire("click", {});
  assert.equal(preview.getTransform().scale, 0.625);

  doc.element("canvas-wrapper").fire("wheel", wheelEvent(-100));
  assert.ok(preview.getTransform().scale > 0.625, "wheel zoom widens the scale");

  const before = preview.getTransform();
  canvas.fire("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 });
  canvas.fire("pointermove", { clientX: 30, clientY: 40 });
  canvas.fire("pointerup", {});
  const after = preview.getTransform();
  assert.ok(after.tx !== before.tx && after.ty !== before.ty, "drag pans the transform");
  assert.ok(canvas.style.transform.includes("translate("), "transform applied to the canvas");
  assert.ok(canvas.style.transform.includes("scale("), "scale applied to the canvas");
  assert.equal(doc.element("preview-zoom-label").textContent, `${Math.round(after.scale * 100)}%`);

  doc.element("preview-zoom-fit").fire("click", {});
  assert.deepEqual(preview.getTransform(), { scale: 0.5, tx: 0, ty: 0 });
  doc.element("preview-zoom-100").fire("click", {});
  assert.equal(preview.getTransform().scale, 1);
});
