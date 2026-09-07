import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MAX,
  HISTORY_KEY_WEBSITE,
  clearHistory,
  historyOriginOf,
  historyPathHash,
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

test("history redacts origins", () => {
  assert.equal(historyOriginOf("https://museum.example.org/painting/1?view=2#frag"), "https://museum.example.org");
  assert.equal(historyOriginOf("http://localhost:8080/x"), "http://localhost:8080");
  assert.equal(historyOriginOf("https://museum.example.org:443/x"), "https://museum.example.org");
  assert.equal(historyOriginOf("file:///etc/passwd"), "");
  assert.equal(historyOriginOf("not a url"), "");
});

test("history path hashes are stable, short, and distinct", () => {
  const a = historyPathHash("https://example.com/a");
  const b = historyPathHash("https://example.com/b");
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(historyPathHash("https://example.com/a"), a);
  assert.notEqual(a, b);
});

test("history entries never retain full URLs", () => {
  const clean = "https://museum.example.org/painting/1";
  const entry = toHistoryEntry(clean, { width: 512, height: 512, format: "png", at: 1700000000000 });
  assert.ok(entry);
  assert.equal(entry.origin, "https://museum.example.org");
  assert.equal(entry.url, undefined);
  assert.equal(entry.width, 512);
  assert.equal(entry.format, "png");
  assert.equal(toHistoryEntry("file:///etc/passwd", {}), null);
});

test("history push dedupes by origin plus hash and caps at 20", () => {
  assert.equal(HISTORY_MAX, 20);
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
  assert.equal(list[0].pathHash, historyPathHash("https://a.example/29"));
});

test("history serialize and parse round-trip and reject bad entries", () => {
  const clean = toHistoryEntry("https://museum.example.org/1", { width: 100, height: 80, at: 5 });
  const text = serializeHistory([clean]);
  assert.deepEqual(parseHistoryJson(text), [clean]);
  assert.deepEqual(parseHistoryJson("not json"), []);
  assert.deepEqual(parseHistoryJson(null), []);
  // Legacy full URLs are ignored when old entries are loaded.
  const sneaky = JSON.stringify([
    { origin: "https://example.com", pathHash: "12345678", at: 1, url: "https://example.com/x?token=abc" },
    { origin: "https://example.com", pathHash: "bad", at: 1 },
    { origin: "", pathHash: "12345678", at: 1 },
    clean,
  ]);
  const parsed = parseHistoryJson(sneaky);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, undefined);
  assert.equal(parsed[1].url, undefined);
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
