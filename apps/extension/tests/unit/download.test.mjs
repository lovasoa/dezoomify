import assert from "node:assert/strict";
import test from "node:test";
import { saveExtensionBlob } from "../../src/job/download.ts";

function downloads(start = async () => 7) {
  let changed;
  const cancelled = [];
  return {
    cancelled,
    emit: (delta) => changed?.(delta),
    download: start,
    search: async () => [{ state: "in_progress" }],
    cancel: async (id) => cancelled.push(id),
    onChanged: {
      addListener: (listener) => (changed = listener),
      removeListener: () => (changed = undefined),
    },
  };
}

test("extension job completes only after the browser confirms the saved file", async () => {
  const api = downloads();
  const signal = new AbortController().signal;
  let settled = false;
  const saved = saveExtensionBlob(api, new Blob(["image"]), "image.png", signal).then((id) => {
    settled = true;
    return id;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  api.emit({ id: 7, state: { current: "complete" } });
  assert.equal(await saved, 7);
});

test("cancelling before the browser replies cancels its late download", async () => {
  let reply;
  const api = downloads(() => new Promise((resolve) => (reply = resolve)));
  const controller = new AbortController();
  const saved = saveExtensionBlob(api, new Blob(["image"]), "image.png", controller.signal);
  const cancelled = assert.rejects(saved, { name: "AbortError" });
  controller.abort();
  reply(7);
  await cancelled;
  assert.deepEqual(api.cancelled, [7]);
});
