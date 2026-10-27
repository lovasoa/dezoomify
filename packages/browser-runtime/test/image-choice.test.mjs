import assert from "node:assert/strict";
import test from "node:test";
import { chooseCatalogImage } from "../src/image-choice.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tile = {
  source: { kind: "resource", uri: "https://images.test/preview", headers: [], purpose: "tile" },
};
const image = { kind: "image", title: "Same title", levels: [], preview: tile };

test("the picker presents distinct slots, tolerates preview failure, and releases previews after choice", async () => {
  const controller = new AbortController();
  const changes = [],
    failures = [],
    released = [];
  let calls = 0;
  const catalog = {
    entries: [
      image,
      { kind: "image-request", uri: "https://images.test/second/info.json", preview: tile },
      { kind: "image-request", uri: "https://images.test/info.json" },
    ],
  };
  const pending = chooseCatalogImage(catalog, {
    signal: controller.signal,
    changed: (value) => changes.push(value),
    failed: (tile, error) => failures.push({ tile, error }),
    async preview() {
      if (calls++ === 0) throw new Error("unavailable");
      return { url: "blob:second", dispose: () => released.push("blob:second") };
    },
  });
  await tick();
  const choice = changes[0];
  assert.equal(choice.catalog, catalog);
  assert.deepEqual([...choice.previews], [[1, "blob:second"]]);
  assert.equal(calls, 2, "deferred metadata is never loaded for previews");
  assert.equal(failures.length, 1);
  choice.choose(1);
  assert.equal(await pending, 1);
  assert.equal(changes.at(-1), undefined);
  assert.deepEqual(released, ["blob:second"]);
});

test("cancellation closes the picker and discards a late preview without starting another", async () => {
  const controller = new AbortController();
  const changes = [],
    released = [];
  let finish,
    previewSignal,
    calls = 0;
  const pending = chooseCatalogImage(
    { entries: [image, image] },
    {
      signal: controller.signal,
      changed: (value) => changes.push(value),
      failed() {
        assert.fail("cancellation is not a preview failure");
      },
      preview(_tile, signal) {
        calls++;
        previewSignal = signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  controller.abort();
  await tick();
  assert.equal(previewSignal.aborted, true);
  assert.equal(changes.at(-1), undefined);
  changes[0].choose(1);
  finish({ url: "blob:late", dispose: () => released.push("blob:late") });
  await assert.rejects(pending, { kind: "cancelled" });
  assert.equal(calls, 1);
  assert.deepEqual(released, ["blob:late"]);
  assert.equal(changes.length, 2);
});
