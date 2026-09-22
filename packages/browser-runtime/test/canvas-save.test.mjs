import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SAVE_COLOR_WARNING,
  canvasToPngBlob,
  isCanvasTaintError,
  saveBlobViaAnchor,
} from "../src/canvas-save.ts";
import { stableErrorCode } from "../src/failure.ts";

test("canvasToPngBlob resolves the encoded blob", async () => {
  const blob = await canvasToPngBlob({ toBlob: (cb) => cb({ kind: "png" }) });
  assert.deepEqual(blob, { kind: "png" });
});

test("canvasToPngBlob maps null and throws to OUTPUT_ENCODE_FAILED", async () => {
  await assert.rejects(
    () => canvasToPngBlob({ toBlob: (cb) => cb(null) }),
    (e) => {
      assert.equal(e.code, "OUTPUT_ENCODE_FAILED");
      return true;
    },
  );
  await assert.rejects(
    () =>
      canvasToPngBlob({
        toBlob: () => {
          throw new Error("tainted");
        },
      }),
    (e) => {
      assert.equal(e.code, "OUTPUT_ENCODE_FAILED");
      return true;
    },
  );
});

test("canvasToPngBlob preserves a taint SecurityError for display-only fallback", async () => {
  const taint = Object.assign(new Error("tainted"), { name: "SecurityError", code: 18 });
  await assert.rejects(
    () =>
      canvasToPngBlob({
        toBlob: () => {
          throw taint;
        },
      }),
    (e) => e === taint,
  );
  assert.equal(isCanvasTaintError(taint), true);
});

test("stableErrorCode ignores browser exception numeric codes", () => {
  assert.equal(stableErrorCode({ code: 18, name: "SecurityError" }), "DISCOVERY_FAILED");
  assert.equal(stableErrorCode({ code: "TILE_FAILED" }), "TILE_FAILED");
  assert.equal(stableErrorCode(null), "DISCOVERY_FAILED");
});

test("saveBlobViaAnchor downloads the core title or suggested WxH fallback", () => {
  const appended = [];
  const anchor = {
    href: "",
    download: "",
    clicked: false,
    click() {
      this.clicked = true;
    },
    remove() {},
  };
  const doc = { createElement: () => anchor, body: { appendChild: (el) => appended.push(el) } };
  saveBlobViaAnchor(doc, "blob:abc", 800, 600, "An image");
  assert.equal(anchor.href, "blob:abc");
  assert.equal(anchor.download, "An image.png");
  assert.equal(anchor.clicked, true);
  assert.equal(appended.length, 1);
});

test("browser saves warn about the stripped color profile", () => {
  assert.match(BROWSER_SAVE_COLOR_WARNING, /Colors may shift/);
});
