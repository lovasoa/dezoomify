import test from "node:test";
import assert from "node:assert/strict";
import { saveReadable, defaultEncode } from "../src/save.ts";
import { SAVE_REQUIRES_READABLE_BYTES } from "../src/types.ts";

function surface2x2(pixels) {
  return {
    originClean: true,
    width: 2,
    height: 2,
    readCalls: 0,
    readPixels() {
      this.readCalls += 1;
      return new Uint8ClampedArray(pixels);
    },
  };
}

test("deterministic 2x2 save: pixels, dimensions, mime", async () => {
  const pixels = [
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ];
  const s = surface2x2(pixels);
  const res = await saveReadable(s, "png");
  assert.equal(res.mime, "image/png");
  assert.equal(res.width, 2);
  assert.equal(res.height, 2);
  assert.ok(res.filename.includes("2x2"));
  // Deterministic: same input -> same bytes.
  const again = await saveReadable(surface2x2(pixels), "png");
  assert.deepEqual([...res.bytes], [...again.bytes]);
  // Header encodes dimensions.
  assert.equal(res.bytes[0], 2);
  assert.equal(res.bytes[2], 2);
  // Default encode is deterministic across calls.
  const manual = defaultEncode(new Uint8ClampedArray(pixels), 2, 2, "png");
  assert.deepEqual([...res.bytes], [...manual]);
});

test("taint guard throws before any canvas API", async () => {
  let reads = 0;
  let encodes = 0;
  const tainted = {
    originClean: false,
    width: 2,
    height: 2,
    readPixels() {
      reads += 1;
      return new Uint8ClampedArray(16);
    },
  };
  await assert.rejects(
    () => saveReadable(tainted, "png", { encode: () => { encodes += 1; return new Uint8Array([1]); } }),
    (e) => e.code === SAVE_REQUIRES_READABLE_BYTES,
  );
  assert.equal(reads, 0);
  assert.equal(encodes, 0);
});

test("jpeg mime + unsupported format", async () => {
  const s = surface2x2(new Array(16).fill(0));
  const res = await saveReadable(s, "jpeg");
  assert.equal(res.mime, "image/jpeg");
  await assert.rejects(() => saveReadable(s, "webp"));
});
