import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_MIN_SCALE,
  PREVIEW_MAX_SCALE,
  PREVIEW_ZOOM_STEP,
  clampPreviewScale,
} from "../src/main.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

test("website preview wires wheel, drag, and buttons without pixel reads", () => {
  // Todo 2.2: the preview lives in packages/browser-runtime/src/preview.ts;
  // src/main.ts only wires it. Behavioral pins stay identical.
  const mainTs = fs.readFileSync(path.join(rootDir, "src/main.ts"), "utf8");
  assert.ok(mainTs.includes("preview.initControls("), "main.ts must wire the runtime preview controls");
  const src = fs.readFileSync(path.join(rootDir, "packages/browser-runtime/src/preview.ts"), "utf8");
  const start = src.indexOf("Minimal preview pan/zoom");
  assert.ok(start >= 0, "preview block present in packages/browser-runtime/src/preview.ts");
  const block = src.slice(start, start + 8000);
  assert.ok(block.includes("wheel"), "wheel zoom wired");
  assert.ok(block.includes("PREVIEW_WHEEL_STEP_PIXELS"), "wheel zoom uses a continuous sensitivity");
  assert.ok(block.includes("pointerdown"), "drag pan wired");
  assert.ok(block.includes("preview-zoom-in"), "zoom-in button wired");
  assert.ok(block.includes("preview-zoom-out"), "zoom-out button wired");
  assert.ok(block.includes("preview-zoom-reset"), "reset button wired");
  assert.ok(block.includes("preview-zoom-100"), "100% button wired");
  assert.ok(block.includes("style.transform"), "transform scale/translate applied");
  assert.ok(!block.includes("getImageData("), "preview never reads pixels (tainted-safe)");
  assert.ok(!block.includes(".toBlob("), "preview never encodes (tainted-safe)");
  assert.ok(!block.includes("toDataURL("), "preview never encodes (tainted-safe)");
});

test("preview controls exist in the page and theme", () => {
  const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
  for (const id of ["preview-controls", "preview-zoom-in", "preview-zoom-out", "preview-zoom-100", "preview-zoom-reset", "preview-zoom-label"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
  const css = fs.readFileSync(path.join(rootDir, "packages/shared-ui/src/styles/theme.css"), "utf8");
  assert.ok(css.includes(".dz-preview-controls"), "theme styles the preview toolbar");
  assert.ok(css.includes("overflow: hidden"), "preview frame does not natively scroll with zoom");
  assert.ok(css.includes("overflow: visible"), "canvas stack does not create a second scroll surface");
  assert.ok(css.includes("cursor: grab"), "canvas uses a live grab cursor, not dead zoom-in");
  assert.ok(!css.includes("cursor: zoom-in"), "dead cursor:zoom-in removed");
});
