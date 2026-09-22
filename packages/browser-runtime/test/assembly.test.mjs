import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasAssembly } from "../src/assembly.ts";

/** Fake decoded bitmap with a 9-arg drawImage recorder. */
function fakeBitmap(width, height) {
  const bitmap = {
    width,
    height,
    closed: false,
    close() {
      bitmap.closed = true;
    },
  };
  return bitmap;
}

function fakeCtx() {
  const draws = [];
  return {
    draws,
    drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
      draws.push({ source, sx, sy, sw, sh, dx, dy, dw, dh });
    },
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
    save: (output, width, height) => {
      events.saved.push({ output, width, height });
      return overrides.saveDisposition ?? "browser-save-ready";
    },
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

function bytes16(n) {
  const b = new ArrayBuffer(2);
  new DataView(b).setUint16(0, n, true);
  return b;
}

test("declared output paints progressively before finalization, then encodes and saves once", async () => {
  const { assembly, events, ctx2d } = harness();
  assembly.prepare({ width: 32, height: 32 });
  assert.deepEqual(events.created, [{ width: 32, height: 32 }]);
  await assembly.acquireTile(0, placement(0, 0), bytes16(16));
  assert.equal(ctx2d.draws.length, 1, "the first tile is visible while acquisition continues");
  await assembly.acquireTile(1, placement(16, 0), bytes16(16));
  assert.equal(ctx2d.draws.length, 2, "each acquired tile paints immediately");
  const disposition = await assembly.finalizeOutput(false, "png", { width: 32, height: 32 });
  assembly.release();

  assert.equal(disposition, "browser-save-ready");
  assert.deepEqual(events.created, [{ width: 32, height: 32 }]);
  assert.equal(events.encoded.length, 1);
  assert.deepEqual(events.saved, [
    { output: { blob: true, width: 32, height: 32 }, width: 32, height: 32 },
  ]);
  assert.equal(ctx2d.draws.length, 2);
  assert.deepEqual(ctx2d.draws[0], {
    source: ctx2d.draws[0].source,
    sx: 0,
    sy: 0,
    sw: 16,
    sh: 16,
    dx: 0,
    dy: 0,
    dw: 16,
    dh: 16,
  });
  assert.deepEqual(ctx2d.draws[1], {
    source: ctx2d.draws[1].source,
    sx: 0,
    sy: 0,
    sw: 16,
    sh: 16,
    dx: 16,
    dy: 0,
    dw: 16,
    dh: 16,
  });
  // Deterministic bitmap release after the draw.
  assert.equal(
    ctx2d.draws.every((draw) => draw.source.closed),
    true,
  );
});

test("finalize-output returns the disposition supplied by the product save operation", async () => {
  const { assembly } = harness({ saveDisposition: "browser-save-initiated" });
  const disposition = await assembly.finalizeOutput(false, "png", { width: 32, height: 32 });
  assert.equal(disposition, "browser-save-initiated");
});

test("a probe held before canvas allocation is painted when the canvas appears", async () => {
  const { assembly, events, ctx2d } = harness();
  await assembly.acquireTile(0, placement(0, 0, { canvas: null }), bytes16(16));
  assert.equal(ctx2d.draws.length, 0, "the probe waits for the resolved canvas");
  assembly.prepare({ width: 32, height: 32 });
  assert.deepEqual(events.created, [{ width: 32, height: 32 }]);
  assert.equal(ctx2d.draws.length, 1, "the retained first tile becomes visible immediately");
  await assembly.finalizeOutput(false, "png", { width: 32, height: 32 });
  assert.equal(ctx2d.draws.length, 1, "the retained tile is not painted twice");
});

test("finalize-output rejects a second call and release is idempotent", async () => {
  const { assembly, events } = harness();
  await assembly.acquireTile(0, placement(0, 0), bytes16(16));
  await assembly.finalizeOutput(false, "png", { width: 32, height: 32 });
  await assert.rejects(
    assembly.finalizeOutput(false, "png", { width: 32, height: 32 }),
    (error) => error.code === "OUTPUT_STATE",
  );
  assembly.release();
  assembly.release();
  assert.equal(events.saved.length, 1);
});

test("a decoded padded edge tile is cropped to the planned extent and logs", async () => {
  const { assembly, ctx2d, events } = harness();
  await assembly.acquireTile(
    0,
    placement(2560, 2048, {
      expected_size: { width: 428, height: 196 },
      canvas: { width: 2988, height: 2244 },
    }),
    bytes16(512),
  );
  await assembly.finalizeOutput(false, "png", { width: 2988, height: 2244 });
  assert.deepEqual(ctx2d.draws[0], {
    source: ctx2d.draws[0].source,
    sx: 0,
    sy: 0,
    sw: 428,
    sh: 196,
    dx: 2560,
    dy: 2048,
    dw: 428,
    dh: 196,
  });
  assert.equal(events.log.length, 1);
  assert.equal(
    events.log[0],
    "A tile size differed from the plan; only its planned pixel extent was drawn.",
  );
});

test("undeclared canvas derives the output size from placements", async () => {
  const { assembly, events } = harness();
  await assembly.acquireTile(0, placement(0, 0, { canvas: null }), bytes16(16));
  await assembly.acquireTile(
    1,
    placement(16, 16, { canvas: null, expected_size: null }),
    bytes16(16),
  );
  await assembly.finalizeOutput(false, "png", null);
  // tile:1 has no planned extent: its decoded 16x16 at (16,16) sets the size.
  assert.deepEqual(events.created, [{ width: 32, height: 32 }]);
});

test("canvas limits are validated before allocation", async () => {
  const { assembly, events } = harness();
  assert.throws(
    () => assembly.prepare({ width: 40000, height: 40000 }),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.deepEqual(events.created, []);
});

test("processing recipes run through the injected processor", async () => {
  const processed = [];
  const { assembly, events } = harness({
    processTile: async (recipe, bytes) => {
      processed.push(recipe);
      return bytes;
    },
  });
  await assembly.acquireTile(
    0,
    placement(0, 0, { processing: "google-arts-decrypt" }),
    bytes16(16),
  );
  assert.deepEqual(processed, ["google-arts-decrypt"]);
  assert.equal(events.decoded.length, 1);
});

test("processing recipes without an executor fail typed instead of dropping the recipe", async () => {
  const { assembly } = harness();
  await assert.rejects(
    assembly.acquireTile(0, placement(0, 0, { processing: "google-arts-decrypt" }), bytes16(16)),
    (error) => {
      assert.equal(error.code, "TILE_PROCESSING_UNAVAILABLE");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("decode failures propagate so acquisition outcomes stay honest", async () => {
  const { assembly } = harness({
    decode: async () => {
      throw new Error("corrupt tile");
    },
  });
  await assert.rejects(assembly.acquireTile(0, placement(0, 0), bytes16(16)), /corrupt tile/);
});

test("an empty output plan fails before allocating a canvas", async () => {
  const fresh = harness();
  await assert.rejects(
    fresh.assembly.finalizeOutput(false, "png", { width: 0, height: 0 }),
    (error) => error.code === "PLAN_INVALID",
  );
  assert.deepEqual(fresh.events.created, []);
});

test("partial output leaves missing regions empty without failing assembly", async () => {
  const { assembly, ctx2d } = harness();
  assembly.prepare({ width: 32, height: 32 });
  await assembly.acquireTile(0, placement(0, 0), bytes16(16));
  // tile:1 never arrived (failed acquisition): only tile:0 draws.
  await assembly.finalizeOutput(true, "png", { width: 32, height: 32 });
  assert.equal(ctx2d.draws.length, 1);
});

test("display-only output draws ordinary images and skips encoding", async () => {
  let displayOnly = 0;
  const ctx2d = fakeCtx();
  const encoded = [];
  const saved = [];
  const local = createCanvasAssembly({
    decode: async () => fakeBitmap(16, 16),
    createCanvas: (w, h) => ({ width: w, height: h, ctx2d }),
    encode: async (canvas) => {
      encoded.push(canvas);
      return {};
    },
    save: () => {
      saved.push(true);
    },
    onDisplayOnly: () => {
      displayOnly += 1;
    },
  });
  local.prepare({ width: 32, height: 32 });
  local.acquireDisplayTile(0, placement(0, 0), { naturalWidth: 16, naturalHeight: 16 });
  assert.equal(local.isTainted(), true);
  assert.equal(displayOnly, 1);
  assert.equal(ctx2d.draws.length, 1, "display-only tiles paint during acquisition");
  const disposition = await local.finalizeOutput(false, "png", { width: 32, height: 32 });
  assert.equal(ctx2d.draws.length, 1);
  assert.equal(encoded.length, 0, "a tainted canvas is never encoded");
  assert.equal(saved.length, 0, "a tainted canvas is never saved");
  assert.equal(disposition, "display-only");
});

test("release closes retained bitmaps deterministically", async () => {
  const held = [];
  const local = createCanvasAssembly({
    decode: async () => {
      const b = fakeBitmap(16, 16);
      held.push(b);
      return b;
    },
    createCanvas: (width, height) => ({ width, height, ctx2d: fakeCtx() }),
    encode: async () => ({}),
    save: () => {},
  });
  await local.acquireTile(0, placement(0, 0), bytes16(16));
  await local.acquireTile(1, placement(16, 0), bytes16(16));
  local.release();
  assert.equal(
    held.every((bitmap) => bitmap.closed),
    true,
  );
});
