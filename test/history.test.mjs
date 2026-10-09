import assert from "node:assert/strict";
import test from "node:test";
import {
  clearHistory,
  createHistory,
  HISTORY_KEY_WEBSITE,
  historyOriginOf,
  loadHistory,
  parseHistoryJson,
  pushHistory,
  saveHistory,
  serializeHistory,
  toHistoryEntry,
} from "../packages/shared-ui/src/history.ts";

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

test("history derives origins", () => {
  assert.equal(
    historyOriginOf("https://museum.example.org/painting/1?view=2#frag"),
    "https://museum.example.org",
  );
  assert.equal(historyOriginOf("http://localhost:8080/x"), "http://localhost:8080");
  assert.equal(historyOriginOf("https://museum.example.org:443/x"), "https://museum.example.org");
  assert.equal(historyOriginOf("file:///etc/passwd"), "");
  assert.equal(historyOriginOf("not a url"), "");
});

test("history entries keep the full address", () => {
  const clean = "https://museum.example.org/painting/1";
  const entry = toHistoryEntry(clean, {
    width: 512,
    height: 512,
    format: "png",
    at: 1700000000000,
  });
  assert.ok(entry);
  assert.equal(entry.origin, "https://museum.example.org");
  assert.equal(entry.url, clean);
  assert.equal(entry.width, 512);
  assert.equal(entry.format, "png");
  assert.equal(entry.at, 1700000000000);
  assert.equal(toHistoryEntry("file:///etc/passwd", { at: 0 }), null);
  assert.equal(toHistoryEntry("not a url", { at: 0 }), null);
});

test("history push dedupes by full address and caps at 20", () => {
  let list = [];
  const first = toHistoryEntry("https://a.example/1", { at: 1 });
  list = pushHistory(list, first);
  assert.equal(list.length, 1);
  const again = toHistoryEntry("https://a.example/1", { at: 2 });
  list = pushHistory(list, again);
  assert.equal(list.length, 1);
  assert.equal(list[0].at, 2);
  for (let i = 0; i < 30; i++) {
    const entry = toHistoryEntry(`https://a.example/${i}`, { at: i });
    list = pushHistory(list, entry);
  }
  assert.equal(list.length, 20);
  assert.equal(list[0].url, "https://a.example/29");
});

test("history serialize and parse round-trip and reject bad entries", () => {
  const clean = toHistoryEntry("https://museum.example.org/1", { width: 100, height: 80, at: 5 });
  const text = serializeHistory([clean]);
  assert.deepEqual(parseHistoryJson(text), [clean]);
  assert.deepEqual(parseHistoryJson("not json"), []);
  assert.deepEqual(parseHistoryJson(null), []);
  // Entries without a usable address are ignored when old entries are loaded.
  const sneaky = JSON.stringify([
    { origin: "https://example.com", url: "https://example.com/x?token=abc", at: 1 },
    { origin: "https://example.com", url: "", at: 1 },
    { origin: "", url: "https://example.com/x", at: 1 },
    clean,
  ]);
  const parsed = parseHistoryJson(sneaky);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, "https://example.com/x?token=abc");
  assert.equal(parsed[1].url, clean.url);
});

test("history store load, save, and clear are best-effort", () => {
  const store = memoryStore();
  assert.deepEqual(loadHistory(store, HISTORY_KEY_WEBSITE), []);
  const entry = toHistoryEntry("https://museum.example.org/1", { at: 1 });
  saveHistory(store, HISTORY_KEY_WEBSITE, [entry]);
  assert.deepEqual(loadHistory(store, HISTORY_KEY_WEBSITE), [entry]);
  clearHistory(store, HISTORY_KEY_WEBSITE);
  assert.deepEqual(loadHistory(store, HISTORY_KEY_WEBSITE), []);
  assert.deepEqual(loadHistory(null, HISTORY_KEY_WEBSITE), []);
});

test("started jobs persist immediately, metadata survives failure and reload, and progress avoids redundant writes", () => {
  const store = memoryStore();
  let writes = 0;
  const countingStore = {
    ...store,
    setItem(key, value) {
      writes++;
      store.setItem(key, value);
    },
  };
  const history = createHistory(countingStore, HISTORY_KEY_WEBSITE, () => 123);
  const entry = history.start("https://museum.example/image");
  assert.equal(loadHistory(store, HISTORY_KEY_WEBSITE)[0].status, "started");
  assert.equal(writes, 1);
  const progress = { title: " A painting ", selected: { width: 1200, height: 800 } };
  history.progress(entry, progress);
  history.progress(entry, { ...progress, completed: 2 });
  assert.equal(writes, 2);
  history.update(entry, { status: "failed" });
  const loaded = createHistory(store, HISTORY_KEY_WEBSITE, () => 999).entries()[0];
  assert.equal(loaded.title, "A painting");
  assert.equal(loaded.width, 1200);
  assert.equal(loaded.height, 800);
  assert.equal(loaded.status, "failed");
  assert.equal(loaded.at, 123);
});

test("history completion and removal preserve other entries and never resurrect removed jobs", () => {
  const store = memoryStore();
  let now = 0;
  const history = createHistory(store, HISTORY_KEY_WEBSITE, () => ++now);
  const first = history.start("https://museum.example/first");
  const second = history.start("https://museum.example/second");
  const output = {
    disposition: "browser-save-ready",
    format: "png",
    canvas: { width: 100, height: 80 },
  };
  history.complete(second, output);
  assert.equal(history.entries()[0].status, "completed");
  history.remove(first);
  history.complete(first, output);
  assert.deepEqual(
    history.entries().map((item) => item.url),
    [second.url],
  );
  history.clear();
  history.complete(second, output);
  assert.deepEqual(loadHistory(store, HISTORY_KEY_WEBSITE), []);
});

const savedOutput = { id: "saved:test", filename: "A painting.png" };
const diskOutput = {
  disposition: "native-publication",
  format: "png",
  canvas: { width: 100, height: 80 },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("saved references reload, disk checks are bounded, and removed rows ignore late checks", async () => {
  const store = memoryStore();
  const pending = [];
  const forgotten = [];
  const history = createHistory(store, HISTORY_KEY_WEBSITE, () => 1, {
    inspect(saved) {
      const deferred = Promise.withResolvers();
      pending.push({ saved, ...deferred });
      return deferred.promise;
    },
    open: async () => {},
    forget: async (saved) => {
      forgotten.push(saved.id);
    },
    onChange: () => {},
  });
  for (let i = 0; i < 3; i++) {
    const entry = history.start(`https://museum.example/${i}`);
    history.complete(entry, diskOutput, { ...savedOutput, id: `saved:${i}` });
  }
  assert.equal(
    loadHistory(store, HISTORY_KEY_WEBSITE)[0].savedOutput.filename,
    savedOutput.filename,
  );
  const stored = store.getItem(HISTORY_KEY_WEBSITE);
  const refresh = history.refresh();
  assert.equal(history.refresh(), refresh, "concurrent refreshes share the pending work");
  assert.equal(pending.length, 2, "only two inspections run at once");
  assert.equal(history.entries().length, 3, "rows are available before disk responds");
  const removed = history.entries()[0];
  history.remove(removed);
  pending[0].resolve("deleted");
  await tick();
  assert.equal(pending.length, 3);
  pending[1].resolve("available");
  pending[2].resolve("available");
  await refresh;
  assert.equal(history.entries().length, 2);
  assert.deepEqual(forgotten, [removed.savedOutput.id]);
  assert.ok(history.entries().every((entry) => entry.outputState === "available"));
  assert.ok(!store.getItem(HISTORY_KEY_WEBSITE).includes("outputState"));
  assert.equal(JSON.parse(stored).length, 3);
});

test("file access errors stay distinct from deletion and restored files can be opened", async () => {
  let inspection = "available";
  let failure;
  const history = createHistory(memoryStore(), HISTORY_KEY_WEBSITE, () => 1, {
    inspect: async () => {
      if (failure) throw failure;
      return inspection;
    },
    open: async () => {
      if (failure) throw failure;
    },
    forget: async () => {},
    onChange: () => {},
  });
  const entry = history.start("https://museum.example/painting");
  history.complete(entry, diskOutput, savedOutput);
  failure = { kind: "output-unavailable", detail: "permission denied" };
  await history.refresh();
  assert.equal(history.entries()[0].outputState, "unavailable");
  assert.deepEqual(history.entries()[0].outputError, failure);
  failure = { kind: "output-not-found" };
  await history.open(history.entries()[0]);
  assert.equal(history.entries()[0].outputState, "deleted");
  assert.equal(history.entries()[0].status, "completed");
  failure = undefined;
  inspection = "available";
  await history.refresh();
  assert.equal(history.entries()[0].outputState, "available");
  await history.open(history.entries()[0]);
  assert.equal(history.entries()[0].opening, undefined);
});

test("opening is not duplicated and an older disk check cannot overwrite its failure result", async () => {
  for (const [failure, expected] of [
    [{ kind: "output-not-found" }, "deleted"],
    [{ kind: "launch-failed", detail: "no viewer installed" }, "unavailable"],
  ]) {
    const check = Promise.withResolvers();
    const opening = Promise.withResolvers();
    let opens = 0;
    const history = createHistory(memoryStore(), HISTORY_KEY_WEBSITE, () => 1, {
      inspect: () => check.promise,
      open: () => {
        opens++;
        return opening.promise;
      },
      forget: async () => {},
      onChange: () => {},
    });
    const entry = history.start("https://museum.example/painting");
    history.complete(entry, diskOutput, savedOutput);
    const refresh = history.refresh();
    const row = history.entries()[0];
    const first = history.open(row);
    await history.open(row);
    assert.equal(opens, 1);
    opening.reject(failure);
    await first;
    check.resolve("available");
    await refresh;
    assert.equal(history.entries()[0].outputState, expected);
    assert.ok(!history.entries()[0].opening);
  }
});
