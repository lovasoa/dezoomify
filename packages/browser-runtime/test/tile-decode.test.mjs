import assert from "node:assert/strict";
import test from "node:test";
import { createTileDecoder } from "../src/tile-decode.ts";

function bitmap() {
  return {
    width: 4,
    height: 5,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}
test("browser decoder returns the decoded dimensions", async () => {
  const decoder = createTileDecoder({
    createImageBitmap: async (blob) => {
      assert.equal(blob.size, 16);
      return bitmap();
    },
  });
  const out = await decoder.decode(new ArrayBuffer(16));
  assert.equal(out.width, 4);
  assert.equal(out.height, 5);
  decoder.dispose();
});
test("decoder rejection preserves typed causes and bounds unexpected error details", async () => {
  for (const original of [
    new Error("invalid bytes".repeat(200)),
    { kind: "decode-failed", detail: "bad image" },
  ]) {
    const decoder = createTileDecoder({
      createImageBitmap: async () => {
        throw original;
      },
    });
    await assert.rejects(decoder.decode(new ArrayBuffer(4)), (error) => {
      if (original.kind) assert.equal(error, original);
      else
        assert.deepEqual(error, { kind: "decode-failed", detail: String(original).slice(0, 2048) });
      return true;
    });
    await decoder.settle();
    decoder.dispose();
  }
});
for (const action of ["cancel", "dispose"])
  test(`${action} closes a late decoded bitmap and prevents publication`, async () => {
    let finish;
    const decoder = createTileDecoder({
      createImageBitmap: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const controller = new AbortController();
    const pending = decoder.decode(new ArrayBuffer(4), controller.signal);
    await Promise.resolve();
    if (action === "cancel") controller.abort();
    else decoder.dispose();
    await assert.rejects(pending, { kind: "cancelled" });
    decoder.dispose();
    let settled = false;
    const settling = decoder.settle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "settlement waits for the native decoding operation");
    const late = bitmap();
    finish(late);
    await settling;
    assert.equal(late.closed, true);
    decoder.dispose();
    await assert.rejects(decoder.decode(new ArrayBuffer(4)));
  });
