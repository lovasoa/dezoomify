import test from "node:test";
import assert from "node:assert/strict";
import { createCanvasAssembly } from "../src/assembly.ts";

/** Fake decoded bitmap with a 9-arg drawImage recorder. */
function fakeBitmap(width, height) {
  const bitmap = {
    width,
    height,
    closed: false,
    close() { bitmap.closed = true; },
  };
  return bitmap;
}

function fakeCtx() {
  const draws = [];
  return {
    draws,
    drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) { draws.push({ source, sx, sy, sw, sh, dx, dy, dw, dh }); },
  };
}

function harness(overrides = {}) {
  const events = { decoded: [], created: [], encoded: [], saved: [], log: [] };
  const ctx2d = fakeCtx();
  const deps = {
    decode: async (bytes) => {
      const size = new DataView(bytes.buffer ?? bytes).getUint16(0, true);
      events.decoded.push(size);
      return fakeBitmap(size, size);
    },
    createCanvas: (width, height) => {
      events.created.push({ width, height });
      return { width, height, ctx2d };
    },
    encode: async (canvas) => {
      events.encoded.push({ width: canvas.width, height: canvas.height });
      return { blob: true, width: canvas.width, height: canvas.height };
    },
    save: (output, width, height) => { events.saved.push({ output, width, height }); },
    sourceUrl: "https://example.test/image.dzi",
    log: (line) => events.log.push(line),
    ...overrides,
  };
  return { assembly: createCanvasAssembly(deps), events, ctx2d };
}

function placement(x, y, extra = {}) {
  return {
    position: { x, y },
    expected_size: extra.expected_size ?? { width: 16, height: 16 },
    canvas: extra.canvas ?? { width: 32, height: 32 },
    processing: extra.processing ?? "none",
  };
}

test("acquire-decode-encode-publish executes in engine order and closes bitmaps", async () => {
  const { assembly, events, ctx2d } = harness();
  const bytes = (n) => { const b = new ArrayBuffer(2); new DataView(b).setUint16(0, n, true); return b; };
  await assembly.acquireTile("tile:0", placement(0, 0), bytes(16));
  await assembly.acquireTile("tile:1", placement(16, 0), bytes(16));
  assembly.decodePixels("tile:0");
  assembly.decodePixels("tile:1");
  assembly.openEncoder("png", { width: 32, height: 32 });
  await assembly.finalizeEncoder();
  assembly.publishOutput();
  assembly.release();

  assert.deepEqual(events.created, [{ width: 32, height: 32 }]);
  assert.equal(events.encoded.length, 1);
  assert.deepEqual(events.saved, [{ output: { blob: true, width: 32, height: 32 }, width: 32, height: 32 }]);
  assert.equal(ctx2d.draws.length, 2);
  assert.deepEqual(ctx2d.draws[0], { source: ctx2d.draws[0].source, sx: 0, sy: 0, sw: 16, sh: 16, dx: 0, dy: 0, dw: 16, dh: 16 });
  assert.deepEqual(ctx2d.draws[1], { source: ctx2d.draws[1].source, sx: 0, sy: 0, sw: 16, sh: 16, dx: 16, dy: 0, dw: 16, dh: 16 });
  // Deterministic bitmap release after the draw.
  assert.equal(ctx2d.draws.every((draw) => draw.source.closed), true);
});

test("publish is exactly-once and release is idempotent", async () => {
  const { assembly, events } = harness();
  const bytes = new ArrayBuffer(2);
  new DataView(bytes).setUint16(0, 16, true);
  await assembly.acquireTile("tile:0", placement(0, 0), bytes);
  assembly.openEncoder("png", { width: 32, height: 32 });
  await assembly.finalizeEncoder();
  assembly.publishOutput();
  assembly.publishOutput();
  assembly.release();
  assembly.release();
  assert.equal(events.saved.length, 1);
});

test("a decoded size mismatch scales to the planned extent and logs", async () => {
  const { assembly, ctx2d, events } = harness();
  const bytes = new ArrayBuffer(2);
  new DataView(bytes).setUint16(0, 10, true); // decodes 10x10
  await assembly.acquireTile("tile:0", placement(0, 0, { expected_size: { width: 16, height: 16 } }), bytes);
  assembly.openEncoder("png", { width: 32, height: 32 });
  await assembly.finalizeEncoder();
  assert.deepEqual(ctx2d.draws[0], { source: ctx2d.draws[0].source, sx: 0, sy: 0, sw: 10, sh: 10, dx: 0, dy: 0, dw: 16, dh: 16 });
  assert.equal(events.log.length, 1);
  assert.equal(events.log[0], "A tile size differed from the plan; it was scaled to keep the image seamless.");
});

test("undeclared canvas derives the output size from placements", async () => {
  const { assembly, events } = harness();
  const bytes = (n) => { const b = new ArrayBuffer(2); new DataView(b).setUint16(0, n, true); return b; };
  await assembly.acquireTile("tile:0", placement(0, 0, { canvas: null }), bytes(16));
  await assembly.acquireTile("tile:1", placement(16, 16, { canvas: null, expected_size: null }), bytes(16));
  assembly.openEncoder("png", null);
  await assembly.finalizeEncoder();
  // tile:1 has no planned extent: its decoded 16x16 at (16,16) sets the size.
  assert.deepEqual(events.created, [{ width: 32, height: 32 }]);
});

test("canvas limits are validated before allocation", async () => {
  const { assembly, events } = harness();
  const bytes = new ArrayBuffer(2);
  new DataView(bytes).setUint16(0, 16, true);
  await assembly.acquireTile("tile:0", placement(0, 0, { canvas: { width: 40000, height: 40000 } }), bytes);
  assert.throws(() => assembly.openEncoder("png", { width: 40000, height: 40000 }), (error) => {
    assert.equal(error.code, "PLAN_INVALID");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(events.created, []);
});

test("processing recipes beyond none fail typed instead of dropping the recipe", async () => {
  const { assembly } = harness();
  const bytes = new ArrayBuffer(2);
  new DataView(bytes).setUint16(0, 16, true);
  await assert.rejects(
    assembly.acquireTile("tile:0", placement(0, 0, { processing: "gas-encryption" }), bytes),
    (error) => {
      assert.equal(error.code, "TILE_PROCESSING_UNAVAILABLE");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("decode failures propagate so acquisition outcomes stay honest", async () => {
  const { assembly } = harness({
    decode: async () => { throw new Error("corrupt tile"); },
  });
  const bytes = new ArrayBuffer(2);
  new DataView(bytes).setUint16(0, 16, true);
  await assert.rejects(assembly.acquireTile("tile:0", placement(0, 0), bytes), /corrupt tile/);
});

test("invalid placements and state misuse fail typed", async () => {
  const { assembly } = harness();
  assert.throws(() => assembly.recordPlacement("tile:0", placement(-1, 0)), (error) => error.code === "PLAN_INVALID");
  assert.throws(() => assembly.decodePixels("tile:missing"), (error) => error.code === "OUTPUT_STATE");
  assert.throws(() => assembly.publishOutput(), (error) => error.code === "OUTPUT_STATE");
  await assert.rejects(assembly.finalizeEncoder(), (error) => error.code === "OUTPUT_STATE");
  const fresh = harness();
  assert.throws(() => fresh.assembly.openEncoder("jpeg", { width: 32, height: 32 }), (error) => error.code === "OUTPUT_FORMAT_UNSUPPORTED");
  assert.deepEqual(fresh.events.created, []);
});

test("partial output leaves missing regions empty without failing assembly", async () => {
  const { assembly, ctx2d } = harness();
  const bytes = new ArrayBuffer(2);
  new DataView(bytes).setUint16(0, 16, true);
  await assembly.acquireTile("tile:0", placement(0, 0), bytes);
  // tile:1 never arrived (failed acquisition): only tile:0 draws.
  assembly.openEncoder("png", { width: 32, height: 32 });
  await assembly.finalizeEncoder();
  assembly.publishOutput();
  assert.equal(ctx2d.draws.length, 1);
});

test("release closes retained bitmaps deterministically", async () => {
  const { assembly } = harness();
  const held = [];
  const bytes = new ArrayBuffer(2);
  new DataView(bytes).setUint16(0, 16, true);
  const deps = {
    decode: async () => { const b = fakeBitmap(16, 16); held.push(b); return b; },
    createCanvas: (width, height) => ({ width, height, ctx2d: fakeCtx() }),
    encode: async () => ({}),
    save: () => {},
  };
  const local = createCanvasAssembly(deps);
  await local.acquireTile("tile:0", placement(0, 0), bytes);
  await local.acquireTile("tile:1", placement(16, 0), bytes);
  local.release();
  assert.equal(held.every((bitmap) => bitmap.closed), true);
  void assembly;
});
