import assert from "node:assert/strict";
import test from "node:test";
import { createProbeSize } from "../src/probe.ts";

test("probe decodes fetched bytes to dimensions", async () => {
  const bytes = new ArrayBuffer(8);
  const probe = createProbeSize({
    fetchResource: async () => ({ bytes: new Uint8Array(bytes) }),
    decode: async () => ({ width: 256, height: 128, close: () => {} }),
  });
  assert.deepEqual(
    await probe(
      { id: 1, uri: "https://cdn.test/0.jpg", headers: [], purpose: "probe" },
      new AbortController().signal,
    ),
    {
      status: "available",
      width: 256,
      height: 128,
      bytes,
    },
  );
});

test("probe falls back to image dimensions without readable bytes", async () => {
  const probe = createProbeSize({
    fetchResource: async () => {
      throw new Error("cors");
    },
    decode: async () => {
      throw new Error("unreachable");
    },
    loadImage: async () => ({ width: 64, height: 64 }),
  });
  assert.deepEqual(
    await probe(
      { id: 1, uri: "https://cdn.test/0.jpg", headers: [], purpose: "probe" },
      new AbortController().signal,
    ),
    {
      status: "available",
      width: 64,
      height: 64,
    },
  );
});

test("probe reports missing when every route fails", async () => {
  const probe = createProbeSize({
    fetchResource: async () => {
      throw new Error("denied");
    },
    decode: async () => {
      throw new Error("unreachable");
    },
  });
  assert.deepEqual(
    await probe(
      { id: 1, uri: "https://cdn.test/0.jpg", headers: [], purpose: "probe" },
      new AbortController().signal,
    ),
    { status: "missing" },
  );
});

test("probe rethrows missing-grant errors for permission pauses", async () => {
  const probe = createProbeSize({
    fetchResource: async () => {
      throw Object.assign(new Error("grant"), { code: "permission-denied" });
    },
    decode: async () => {
      throw new Error("unreachable");
    },
    loadImage: async () => ({ width: 1, height: 1 }),
  });
  await assert.rejects(
    () =>
      probe(
        { id: 1, uri: "https://cdn.test/0.jpg", headers: [], purpose: "probe" },
        new AbortController().signal,
      ),
    /grant/,
  );
});
