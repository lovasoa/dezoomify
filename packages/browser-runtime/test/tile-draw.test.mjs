import test from "node:test";
import assert from "node:assert/strict";
import { createProcessQueue, drawPlacedTile, loadTileImage } from "../src/tile-draw.ts";

function hooks() {
  let seq = 0;
  return {
    onRequestStart() { seq += 1; return seq; },
    onRequestEnd() {},
    onLog() {},
    onUpdate() {},
  };
}

function ctx2d(drawn = []) {
  return {
    drawn,
    drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
      drawn.push({ sw, sh, dx, dy, dw, dh });
    },
  };
}

function bitmap(w = 256, h = 256) {
  return { width: w, height: h, closed: false, close() { this.closed = true; } };
}

test("drawPlacedTile paints readable bytes at the planned extent", () => {
  const log = [];
  const ctx = ctx2d();
  drawPlacedTile(ctx, bitmap(256, 256), { x: 0, y: 0, w: 256, h: 256 }, (line) => log.push(line));
  assert.equal(ctx.drawn.length, 1);
  assert.deepEqual(ctx.drawn[0], { sw: 256, sh: 256, dx: 0, dy: 0, dw: 256, dh: 256 });
  assert.deepEqual(log, []);
});

test("drawPlacedTile does not stretch an undersized tile", () => {
  const log = [];
  const ctx = ctx2d();
  drawPlacedTile(ctx, bitmap(100, 100), { x: 256, y: 0, w: 256, h: 256 }, (line) => log.push(line));
  assert.equal(ctx.drawn.length, 1);
  assert.deepEqual(ctx.drawn[0], { sw: 100, sh: 100, dx: 256, dy: 0, dw: 100, dh: 100 });
  assert.ok(log.some((line) => line.includes("A tile size differed from the plan")), "mismatch logged without identifying a tile");
  assert.ok(log.every((line) => !line.includes("a.test") && !line.includes("256,0")), "mismatch log has no tile URL or coordinates");
});

test("drawPlacedTile crops a full-sized padded Google edge tile at 1:1 scale", () => {
  const ctx = ctx2d();
  drawPlacedTile(ctx, bitmap(512, 512), { x: 2560, y: 2048, w: 428, h: 196 });
  assert.deepEqual(ctx.drawn[0], { sw: 428, sh: 196, dx: 2560, dy: 2048, dw: 428, dh: 196 });
});

test("drawPlacedTile measures ordinary image elements by natural size", () => {
  const ctx = ctx2d();
  drawPlacedTile(ctx, { naturalWidth: 256, naturalHeight: 128 }, { x: 0, y: 0, w: 256, h: 256 });
  assert.deepEqual(ctx.drawn[0], { sw: 256, sh: 128, dx: 0, dy: 0, dw: 256, dh: 128 });
});

test("createProcessQueue serializes processing while fetching stays parallel", async () => {
  const order = [];
  const run = createProcessQueue(async (recipe, bytes) => {
    order.push(`start-${bytes.byteLength}`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`end-${bytes.byteLength}`);
    return bytes;
  });
  const [a, b] = await Promise.all([run("r", new ArrayBuffer(1)), run("r", new ArrayBuffer(2))]);
  assert.ok(a instanceof ArrayBuffer && b instanceof ArrayBuffer);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
});

test("loadTileImage resolves on load and rejects on error", async () => {
  const h = hooks();
  class FakeImg {
    constructor() { this.handlers = {}; }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    set src(v) { this.handlers.load?.(); }
  }
  const img = await loadTileImage("https://a.test/1.png", {
    imageCtor: FakeImg,
    setTimeoutFn: () => null,
    clearTimeoutFn: () => {},
    hooks: h,
  });
  assert.ok(img instanceof FakeImg);
  class BrokenImg {
    addEventListener(type, fn) { if (type === "error") queueMicrotask(fn); }
    set src(v) {}
  }
  await assert.rejects(
    loadTileImage("https://a.test/2.png", { imageCtor: BrokenImg, setTimeoutFn: () => null, clearTimeoutFn: () => {}, hooks: h }),
    /failed to load/,
  );
});
