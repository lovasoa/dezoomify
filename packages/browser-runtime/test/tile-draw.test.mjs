import test from "node:test";
import assert from "node:assert/strict";
import { createTilePainter, createProcessQueue, loadTileImage } from "../src/tile-draw.ts";

function hooks(log = []) {
  let seq = 0;
  return {
    log,
    onRequestStart() { seq += 1; return seq; },
    onRequestEnd() {},
    onLog(line) { log.push(line); },
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

test("drawTile paints readable bytes at the planned extent", async () => {
  const log = [];
  const ctx = ctx2d();
  const painter = createTilePainter({
    fetchTile: async () => ({ bytes: new ArrayBuffer(8) }),
    decode: async () => bitmap(256, 256),
    isOrdinaryImageTile: () => true,
    hooks: hooks(log),
  });
  const tainted = await painter.drawTile(ctx, { uri: "https://a.test/1.png", headers: {}, x: 0, y: 0, w: 256, h: 256, processing: "none" });
  assert.equal(tainted, false);
  assert.equal(ctx.drawn.length, 1);
  assert.deepEqual(ctx.drawn[0], { sw: 256, sh: 256, dx: 0, dy: 0, dw: 256, dh: 256 });
  assert.deepEqual(log, []);
});

test("drawTile trusts the plan and logs size mismatches", async () => {
  const log = [];
  const ctx = ctx2d();
  const painter = createTilePainter({
    fetchTile: async () => ({ bytes: new ArrayBuffer(8) }),
    decode: async () => bitmap(100, 100),
    isOrdinaryImageTile: () => true,
    hooks: hooks(log),
  });
  await painter.drawTile(ctx, { uri: "https://a.test/1.png", headers: {}, x: 256, y: 0, w: 256, h: 256, processing: "none" });
  assert.equal(ctx.drawn.length, 1);
  assert.equal(ctx.drawn[0].dw, 256);
  assert.ok(log.some((line) => line.includes("tile size mismatch")), "mismatch logged");
});

test("drawTile falls back to ordinary display for unprocessed tiles", async () => {
  const ctx = ctx2d();
  let loaded = 0;
  const painter = createTilePainter({
    fetchTile: async () => { throw new Error("no CORS grant"); },
    decode: async () => bitmap(),
    loadImage: async () => { loaded += 1; return { naturalWidth: 256, naturalHeight: 128 }; },
    isOrdinaryImageTile: (p) => p === "none",
    hooks: hooks(),
  });
  const tainted = await painter.drawTile(ctx, { uri: "https://a.test/1.png", headers: {}, x: 0, y: 0, processing: "none" });
  assert.equal(tainted, true);
  assert.equal(loaded, 1);
  assert.equal(ctx.drawn.length, 1);
});

test("drawTile rethrows readable failures for processed tiles", async () => {
  const ctx = ctx2d();
  const failure = new Error("tile fetch: network-error");
  const painter = createTilePainter({
    fetchTile: async () => { throw failure; },
    decode: async () => bitmap(),
    loadImage: async () => ({ naturalWidth: 1, naturalHeight: 1 }),
    isOrdinaryImageTile: (p) => p === "none",
    hooks: hooks(),
  });
  await assert.rejects(
    painter.drawTile(ctx, { uri: "https://a.test/1.png", headers: {}, x: 0, y: 0, processing: "decrypt" }),
    (e) => e === failure,
  );
});

test("drawTile reports the readable failure when display also fails", async () => {
  const ctx = ctx2d();
  const failure = new Error("tile fetch: network-error");
  const painter = createTilePainter({
    fetchTile: async () => { throw failure; },
    decode: async () => bitmap(),
    loadImage: async () => { throw new Error("img 404"); },
    isOrdinaryImageTile: () => true,
    hooks: hooks(),
  });
  await assert.rejects(
    painter.drawTile(ctx, { uri: "https://a.test/1.png", headers: {}, x: 0, y: 0, processing: "none" }),
    (e) => e === failure,
  );
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
