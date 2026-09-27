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

test("cancellation retains the Blob URL until the browser acknowledges it", async (t) => {
  const cancellation = Promise.withResolvers();
  const api = downloads();
  api.cancel = () => cancellation.promise;
  const revoke = t.mock.method(URL, "revokeObjectURL");
  const controller = new AbortController();
  const saved = saveExtensionBlob(api, new Blob(["image"]), "image.png", controller.signal);
  const rejected = assert.rejects(saved, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(revoke.mock.callCount(), 0);
  cancellation.resolve();
  await rejected;
  assert.equal(revoke.mock.callCount(), 1);
});

test("an interrupted save rejects with the browser's diagnostic", async () => {
  const api = downloads();
  const saved = saveExtensionBlob(
    api,
    new Blob(["image"]),
    "image.png",
    new AbortController().signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  api.emit({ id: 7, state: { current: "interrupted" }, error: { current: "FILE_NO_SPACE" } });
  await assert.rejects(saved, (error) => {
    assert.equal(error.code, "OUTPUT_FAILED");
    assert.match(error.technical, /FILE_NO_SPACE/);
    return true;
  });
});

test("failed status lookup cancels the unfinished save before releasing its Blob URL", async (t) => {
  const cancellation = Promise.withResolvers();
  const api = downloads();
  api.search = async () => {
    throw new Error("browser status unavailable");
  };
  api.cancel = (id) => {
    api.cancelled.push(id);
    return cancellation.promise;
  };
  const revoke = t.mock.method(URL, "revokeObjectURL");
  const saved = saveExtensionBlob(
    api,
    new Blob(["image"]),
    "image.png",
    new AbortController().signal,
  );
  const rejected = assert.rejects(saved, { code: "OUTPUT_FAILED" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.cancelled, [7]);
  assert.equal(revoke.mock.callCount(), 0);
  cancellation.resolve();
  await rejected;
  assert.equal(revoke.mock.callCount(), 1);
});
