import assert from "node:assert/strict";
import test from "node:test";
import { actOnDownload, downloadAndWait } from "../../src/job/downloads.ts";

function makeDownloads({ download = async () => 41, search } = {}) {
  const listeners = new Set();
  const calls = { download: [], search: [], open: [], show: [] };
  const api = {
    async download(options) {
      calls.download.push(options);
      return download(options, listeners);
    },
    async search(query) {
      calls.search.push(query);
      return search(query);
    },
    async open(id) {
      calls.open.push(id);
    },
    show(id) {
      calls.show.push(id);
      return true;
    },
    onChanged: {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
    },
  };
  return { api, calls, listeners };
}

test("downloadAndWait returns this job's completed download and requested filename", async () => {
  let state = "in_progress";
  const h = makeDownloads({
    download: async () => 41,
    search: async ({ id }) => [{ id, state, filename: "/downloads/artwork.png" }],
  });
  const pending = downloadAndWait(h.api, "blob:extension/output", "artwork.png");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.download, [{ url: "blob:extension/output", filename: "artwork.png" }]);
  state = "complete";
  for (const listener of h.listeners) listener({ id: 41, state: { current: "complete" } });
  assert.deepEqual(await pending, {
    id: 41,
    state: "complete",
    filename: "/downloads/artwork.png",
  });
  assert.equal(h.calls.download.length, 1, "completion must not start a second save");
  assert.deepEqual(h.calls.search, [{ id: 41 }, { id: 41 }]);
  assert.equal(h.listeners.size, 0);
});

test("downloadAndWait finds a download completed before its first status check", async () => {
  const h = makeDownloads({
    download: async () => 52,
    search: async ({ id }) => [{ id, state: "complete", filename: "/downloads/early.png" }],
  });
  assert.equal(
    (await downloadAndWait(h.api, "blob:extension/output", "early.png")).filename,
    "/downloads/early.png",
  );
  assert.deepEqual(h.calls.search, [{ id: 52 }]);
});

test("downloadAndWait fails clearly and releases its listener on interruption", async () => {
  const h = makeDownloads({
    search: async ({ id }) => [{ id, state: "interrupted", error: "FILE_FAILED" }],
  });
  await assert.rejects(
    downloadAndWait(h.api, "blob:extension/output", "artwork.png"),
    (error) => error.code === "OUTPUT_SAVE_FAILED" && /FILE_FAILED/.test(error.detail),
  );
  assert.equal(h.listeners.size, 0);
});

test("downloadAndWait reports browser save-start failures", async () => {
  const h = makeDownloads({ download: async () => Promise.reject(new Error("denied")) });
  await assert.rejects(
    downloadAndWait(h.api, "blob:extension/output", "artwork.png"),
    (error) => error.code === "OUTPUT_SAVE_FAILED",
  );
  assert.equal(h.listeners.size, 0);
});

test("open and reveal invoke the id returned for this completed download", async () => {
  const h = makeDownloads({
    download: async () => 73,
    search: async ({ id }) => [{ id, state: "complete", filename: "/downloads/artwork.png" }],
  });
  const item = await downloadAndWait(h.api, "blob:extension/output", "artwork.png");
  await actOnDownload(h.api, item.id, "open");
  await actOnDownload(h.api, item.id, "reveal");
  assert.deepEqual(h.calls.open, [73]);
  assert.deepEqual(h.calls.show, [73]);
});

test("open and reveal action failures propagate to the visible error handler", async () => {
  const h = makeDownloads();
  h.api.open = async (id) => {
    h.calls.open.push(id);
    throw new Error("viewer unavailable");
  };
  h.api.show = (id) => {
    h.calls.show.push(id);
    throw new Error("file manager unavailable");
  };
  await assert.rejects(actOnDownload(h.api, 81, "open"), /viewer unavailable/);
  await assert.rejects(actOnDownload(h.api, 81, "reveal"), /file manager unavailable/);
  assert.deepEqual(h.calls.open, [81]);
  assert.deepEqual(h.calls.show, [81]);
});
