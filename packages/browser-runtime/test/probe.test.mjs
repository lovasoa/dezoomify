import test from "node:test";
import assert from "node:assert/strict";
import { createProbeSize } from "../src/probe.ts";

test("probe decodes fetched bytes to dimensions", async () => {
  const bytes = new ArrayBuffer(8);
  const probe = createProbeSize({
    fetchTile: async () => ({ bytes }),
    decode: async () => ({ width: 256, height: 128, close: () => {} }),
  });
  assert.deepEqual(await probe("https://cdn.test/0.jpg", {}), { status: "available", width: 256, height: 128, bytes });
});

test("probe falls back to image dimensions without readable bytes", async () => {
  const probe = createProbeSize({
    fetchTile: async () => { throw new Error("cors"); },
    decode: async () => { throw new Error("unreachable"); },
    loadImage: async () => ({ width: 64, height: 64 }),
  });
  assert.deepEqual(await probe("https://cdn.test/0.jpg", {}), { status: "available", width: 64, height: 64 });
});

test("probe reports missing when every route fails", async () => {
  const probe = createProbeSize({
    fetchTile: async () => { throw new Error("denied"); },
    decode: async () => { throw new Error("unreachable"); },
  });
  assert.deepEqual(await probe("https://cdn.test/0.jpg", {}), { status: "missing" });
});

test("probe rethrows missing-grant errors for permission pauses", async () => {
  const probe = createProbeSize({
    fetchTile: async () => { throw Object.assign(new Error("grant"), { code: "permission-denied" }); },
    decode: async () => { throw new Error("unreachable"); },
    loadImage: async () => ({ width: 1, height: 1 }),
  });
  await assert.rejects(() => probe("https://cdn.test/0.jpg", {}), /grant/);
});
