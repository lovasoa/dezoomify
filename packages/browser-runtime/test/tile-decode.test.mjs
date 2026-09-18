import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTileDecoder } from "../src/tile-decode.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function bitmap(w = 4, h = 5) {
  return { width: w, height: h, closed: false, close() { this.closed = true; } };
}

test("decode offload is a packaged worker module, never a string-built Blob URL", () => {
  const workerSource = fs.readFileSync(path.join(HERE, "..", "src", "tile-decode-worker.ts"), "utf8");
  assert.match(workerSource, /createImageBitmap/);
  assert.match(workerSource, /OffscreenCanvas/);
  assert.match(workerSource, /transferToImageBitmap/);
  const hostSource = fs.readFileSync(path.join(HERE, "..", "src", "tile-decode.ts"), "utf8");
  assert.doesNotMatch(hostSource, /tileDecodeWorkerCode/);
  assert.doesNotMatch(hostSource, /createObjectURL/);
  assert.doesNotMatch(hostSource, /Blob\(\[.*"text\/javascript"/s);
  assert.match(hostSource, /tile-decode-worker/);
});

test("decoder falls back to main-thread decode without a worker host", async () => {
  const seen = [];
  const decoder = createTileDecoder({
    createImageBitmap: async (blob) => { seen.push(blob); return bitmap(); },
    blobCtor: class { constructor(parts) { this.parts = parts; } },
  });
  const out = await decoder.decode(new ArrayBuffer(16));
  assert.equal(out.width, 4);
  assert.equal(seen.length, 1);
  assert.equal(decoder.workered, false);
  decoder.dispose();
});

test("decoder uses the worker when one is available", async () => {
  let worker = null;
  class FakeWorker {
    constructor(url) { this.url = String(url); worker = this; }
    postMessage(msg) {
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, bitmap: bitmap(7, 8) } }));
    }
    terminate() {}
  }
  const decoder = createTileDecoder({
    workerCtor: FakeWorker,
    workerUrl: "packaged-tile-decode-worker",
    offscreenCanvasAvailable: true,
  });
  const out = await decoder.decode(new ArrayBuffer(4));
  assert.equal(out.width, 7);
  assert.match(worker.url, /tile-decode-worker/);
  assert.equal(decoder.workered, true);
  decoder.dispose();
  assert.equal(decoder.workered, false);
});

test("worker errors reject pending decodes and fall back afterwards", async () => {
  let worker = null;
  class FlakyWorker {
    constructor() { worker = this; }
    postMessage() {
      queueMicrotask(() => this.onerror?.({ message: "boom" }));
    }
    terminate() {}
  }
  const decoder = createTileDecoder({
    workerCtor: FlakyWorker,
    workerUrl: "packaged-tile-decode-worker",
    offscreenCanvasAvailable: true,
    createImageBitmap: async () => bitmap(2, 2),
  });
  const out = await decoder.decode(new ArrayBuffer(4));
  assert.equal(out.width, 2);
  assert.equal(decoder.workered, false);
  decoder.dispose();
});
