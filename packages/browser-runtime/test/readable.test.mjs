import test from "node:test";
import assert from "node:assert/strict";
import { createReadableCanvasSurface } from "../src/readable-canvas-surface.ts";
import { SAVE_REQUIRES_READABLE_BYTES } from "../src/types.ts";

function solidDecode(color) {
  return async (bytes) => {
    void bytes;
    const pixels = new Uint8ClampedArray([color[0], color[1], color[2], 255]);
    return { width: 1, height: 1, pixels };
  };
}

test("deterministic row-major composite produces expected pixels", async () => {
  const s = createReadableCanvasSurface({
    width: 2,
    height: 2,
    decode: async (bytes) => {
      const v = new Uint8Array(bytes)[0] ?? 0;
      return { width: 1, height: 1, pixels: new Uint8ClampedArray([v, 0, 0, 255]) };
    },
  });
  assert.equal(s.originClean, true);
  await s.compositeTile(new Uint8Array([10]).buffer, 0, 0);
  await s.compositeTile(new Uint8Array([20]).buffer, 1, 0);
  await s.compositeTile(new Uint8Array([30]).buffer, 0, 1);
  await s.compositeTile(new Uint8Array([40]).buffer, 1, 1);
  const px = s.readPixels();
  assert.deepEqual([...px], [10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255]);
  assert.equal(typeof s.hashPixels(), "string");
  s.dispose();
});

test("cleanup hooks counted on composite + dispose, decode errors still revoke", async () => {
  let revoked = 0;
  let closed = 0;
  let created = 0;
  const hooks = {
    createObjectURL: () => `blob:test-${(created += 1)}`,
    revokeObjectURL: () => {
      revoked += 1;
    },
    closeBitmap: () => {
      closed += 1;
    },
  };
  const s = createReadableCanvasSurface({ width: 2, height: 2, decode: solidDecode([1, 2, 3]), hooks });
  await s.compositeTile(new Uint8Array([9]).buffer, 0, 0);
  assert.equal(created, 1);
  assert.ok(revoked >= 1);
  assert.ok(closed >= 1);
  const revokedBefore = revoked;
  // Decode error still revokes.
  const bad = createReadableCanvasSurface({
    width: 1,
    height: 1,
    decode: async () => {
      throw new Error("decode boom");
    },
    hooks,
  });
  await assert.rejects(() => bad.compositeTile(new Uint8Array([1]).buffer, 0, 0), /decode boom/);
  assert.ok(revoked > revokedBefore);
  s.dispose();
  bad.dispose();
});

test("every read/process/hash fails closed when tainted", async () => {
  const s = createReadableCanvasSurface({ width: 1, height: 1, decode: solidDecode([5, 6, 7]) });
  await s.compositeTile(new Uint8Array([1]).buffer, 0, 0);
  s.markTainted();
  assert.equal(s.originClean, false);
  for (const op of [
    () => s.readPixels(),
    () => s.processPixels(() => {}),
    () => s.hashPixels(),
  ]) {
    assert.throws(op, (e) => e.code === SAVE_REQUIRES_READABLE_BYTES);
  }
  await assert.rejects(() => s.compositeTile(new Uint8Array([1]).buffer, 0, 0), (e) => e.code === SAVE_REQUIRES_READABLE_BYTES);
  s.dispose();
});
