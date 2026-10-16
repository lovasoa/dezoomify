import assert from "node:assert/strict";
import test from "node:test";
import { createLoadedImageFallback } from "../../src/job/loaded-image.ts";

test("fallback keeps original bytes, selects the largest useful image and ignores other failures", async (t) => {
  const oldDecode = globalThis.createImageBitmap;
  const closed = [];
  globalThis.createImageBitmap = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sizes = [
      [512, 512],
      [6000, 400],
      [1800, 1200],
      [3022, 5051],
    ];
    const [width, height] = sizes[bytes[3]];
    return {
      width,
      height,
      close() {
        closed.push(bytes[3]);
      },
    };
  };
  t.after(() => {
    globalThis.createImageBitmap = oldDecode;
  });
  const signal = new AbortController().signal;
  const events = [],
    saved = [];
  const context = {
    signal,
    view: {},
    update() {},
    diagnostics: {
      record(...args) {
        events.push(args);
      },
    },
  };
  const fallback = createLoadedImageFallback(
    context,
    async (request) => {
      assert.notEqual(request.uri.at(-1), "3", "reuse the already-read API response");
      return { kind: "response", response: { bytes: [255, 216, 255, Number(request.uri.at(-1))] } };
    },
    async (blob) => {
      saved.push(blob);
      return "browser-save-ready";
    },
  );
  const inputs = Array.from({ length: 4 }, (_, i) => ({
    url: `https://image.test/${i}`,
    kind: "observed-resource",
  }));
  fallback.observe({ inputs, images: inputs.slice(0, 3).map((i) => i.url) });
  // RSL-style API response: the DOM contains a data URL, but the HTTP bytes
  // were already read during core discovery. Recovery must reuse them.
  fallback.record(
    { uri: inputs[3].url, purpose: "metadata" },
    { kind: "response", response: { bytes: [255, 216, 255, 3] } },
  );
  try {
    for (const kind of ["cancelled", "tile-failed", "write-failed"])
      assert.equal(await fallback.recover({ kind }), undefined);
    assert.equal(saved.length, 0);
    const output = await fallback.recover({ kind: "discovery-failed" });
    assert.deepEqual(output.canvas, { width: 3022, height: 5051 });
    assert.equal(output.format, "jpeg");
    assert.deepEqual([...new Uint8Array(await saved[0].arrayBuffer())], [255, 216, 255, 3]);
    assert.equal(saved[0].type, "image/jpeg");
    assert.equal(closed.length, 4);
    assert.ok(events.some((e) => e[1] === "discovery-fallback"));
    assert.match(context.view.loadedImage.url, /^blob:/);
  } finally {
    fallback.dispose();
  }
});
