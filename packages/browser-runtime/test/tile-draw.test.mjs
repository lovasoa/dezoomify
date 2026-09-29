import assert from "node:assert/strict";
import test from "node:test";
import { drawPlacedTile, loadTileImage } from "../src/tile-draw.ts";

function hooks() {
  let seq = 0;
  return {
    onRequestStart() {
      seq += 1;
      return seq;
    },
    onRequestEnd() {},
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
  return {
    width: w,
    height: h,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

test("drawPlacedTile paints readable bytes at the planned extent", () => {
  const ctx = ctx2d();
  drawPlacedTile(ctx, bitmap(256, 256), { x: 0, y: 0, w: 256, h: 256 });
  assert.equal(ctx.drawn.length, 1);
  assert.deepEqual(ctx.drawn[0], { sw: 256, sh: 256, dx: 0, dy: 0, dw: 256, dh: 256 });
});

test("drawPlacedTile does not stretch an undersized tile", () => {
  const ctx = ctx2d();
  drawPlacedTile(ctx, bitmap(100, 100), { x: 256, y: 0, w: 256, h: 256 });
  assert.equal(ctx.drawn.length, 1);
  assert.deepEqual(ctx.drawn[0], { sw: 100, sh: 100, dx: 256, dy: 0, dw: 100, dh: 100 });
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

test("image timeout settles once even when clearing src fires an error", async () => {
  let timeout;
  let completions = 0;
  class Image {
    handlers = {};
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    }
    set src(value) {
      if (value === "") this.handlers.error();
    }
  }
  const pending = loadTileImage("https://a.test/slow.jpg", {
    imageCtor: Image,
    ms: 100,
    setTimeoutFn: (fn) => {
      timeout = fn;
      return 1;
    },
    clearTimeoutFn: () => {},
    hooks: {
      ...hooks(),
      onRequestEnd: () => {
        completions += 1;
      },
    },
  });
  timeout();
  await assert.rejects(pending, /timed out/);
  assert.equal(completions, 1);
});

test("loadTileImage resolves on load and rejects on error", async () => {
  const h = hooks();
  class FakeImg {
    constructor() {
      this.handlers = {};
    }
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    }
    set src(v) {
      this.handlers.load?.();
    }
  }
  const img = await loadTileImage("https://a.test/1.png", {
    imageCtor: FakeImg,
    setTimeoutFn: () => null,
    clearTimeoutFn: () => {},
    hooks: h,
  });
  assert.ok(img instanceof FakeImg);
  class BrokenImg {
    addEventListener(type, fn) {
      if (type === "error") queueMicrotask(fn);
    }
    set src(v) {}
  }
  await assert.rejects(
    loadTileImage("https://a.test/2.png", {
      imageCtor: BrokenImg,
      setTimeoutFn: () => null,
      clearTimeoutFn: () => {},
      hooks: h,
    }),
    /failed to load/,
  );
});
