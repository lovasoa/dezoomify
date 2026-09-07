import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MAX,
  HISTORY_KEY_WEBSITE,
  clearHistory,
  historyOriginOf,
  historyPathHash,
  isSensitiveUrl,
  loadHistory,
  loadHistoryOptIn,
  parseHistoryJson,
  pushHistory,
  saveHistory,
  saveHistoryOptIn,
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

test("history redacts origins and flags sensitive URLs", () => {
  assert.equal(historyOriginOf("https://museum.example.org/painting/1?view=2#frag"), "https://museum.example.org");
  assert.equal(historyOriginOf("http://localhost:8080/x"), "http://localhost:8080");
  assert.equal(historyOriginOf("https://museum.example.org:443/x"), "https://museum.example.org");
  assert.equal(historyOriginOf("file:///etc/passwd"), "");
  assert.equal(historyOriginOf("not a url"), "");
  assert.equal(isSensitiveUrl("https://user:pass@example.com/x"), true);
  assert.equal(isSensitiveUrl("https://example.com/x?token=abc"), true);
  assert.equal(isSensitiveUrl("https://example.com/x?session=abc"), true);
  assert.equal(isSensitiveUrl("https://example.com/x?apiKey=abc"), true);
  assert.equal(isSensitiveUrl("https://example.com/x?view=2"), false);
  assert.equal(isSensitiveUrl("https://example.com/painting"), false);
  assert.equal(isSensitiveUrl("not a url"), true);
});

test("history path hashes are stable, short, and distinct", () => {
  const a = historyPathHash("https://example.com/a");
  const b = historyPathHash("https://example.com/b");
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(historyPathHash("https://example.com/a"), a);
  assert.notEqual(a, b);
});

test("history entries keep full URLs only when non-sensitive and opted in", () => {
  const clean = "https://museum.example.org/painting/1";
  const sensitive = "https://example.com/x?token=abc";
  const withUrl = toHistoryEntry(clean, { width: 512, height: 512, format: "png", at: 1700000000000 }, true);
  assert.ok(withUrl);
  assert.equal(withUrl.origin, "https://museum.example.org");
  assert.equal(withUrl.url, clean);
  assert.equal(withUrl.width, 512);
  assert.equal(withUrl.format, "png");
  const noOptIn = toHistoryEntry(clean, { width: 512, height: 512, format: "png", at: 1 }, false);
  assert.ok(noOptIn);
  assert.equal(noOptIn.url, undefined);
  const sensitiveKept = toHistoryEntry(sensitive, { width: 10, height: 10, at: 1 }, true);
  assert.ok(sensitiveKept);
  assert.equal(sensitiveKept.url, undefined);
  assert.equal(sensitiveKept.origin, "https://example.com");
  assert.equal(toHistoryEntry("file:///etc/passwd", {}, true), null);
});

test("history push dedupes by origin plus hash and caps at 20", () => {
  assert.equal(HISTORY_MAX, 20);
  let list = [];
  const first = toHistoryEntry("https://a.example/1", { at: 1 }, true);
  list = pushHistory(list, first);
  assert.equal(list.length, 1);
  const again = toHistoryEntry("https://a.example/1", { at: 2 }, true);
  list = pushHistory(list, again);
  assert.equal(list.length, 1);
  assert.equal(list[0].at, 2);
  for (let i = 0; i < 30; i++) {
    const entry = toHistoryEntry(`https://a.example/${i}`, { at: i }, true);
    list = pushHistory(list, entry);
  }
  assert.equal(list.length, 20);
  assert.equal(list[0].pathHash, historyPathHash("https://a.example/29"));
});

test("history serialize and parse round-trip and reject bad entries", () => {
  const clean = toHistoryEntry("https://museum.example.org/1", { width: 100, height: 80, at: 5 }, true);
  const text = serializeHistory([clean]);
  assert.deepEqual(parseHistoryJson(text), [clean]);
  assert.deepEqual(parseHistoryJson("not json"), []);
  assert.deepEqual(parseHistoryJson(null), []);
  // Sensitive URLs never survive validation, even when hand-crafted.
  const sneaky = JSON.stringify([
    { origin: "https://example.com", pathHash: "12345678", at: 1, url: "https://example.com/x?token=abc" },
    { origin: "https://example.com", pathHash: "bad", at: 1 },
    { origin: "", pathHash: "12345678", at: 1 },
    clean,
  ]);
  const parsed = parseHistoryJson(sneaky);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, clean.url);
});

test("history store load, save, clear, and opt-in are best-effort", () => {
  const store = memoryStore();
  assert.deepEqual(loadHistory(store, HISTORY_KEY_WEBSITE), []);
  assert.equal(loadHistoryOptIn(store, "optin"), false);
  const entry = toHistoryEntry("https://museum.example.org/1", { at: 1 }, true);
  saveHistory(store, HISTORY_KEY_WEBSITE, [entry]);
  assert.deepEqual(loadHistory(store, HISTORY_KEY_WEBSITE), [entry]);
  saveHistoryOptIn(store, "optin", true);
  assert.equal(loadHistoryOptIn(store, "optin"), true);
  saveHistoryOptIn(store, "optin", false);
  assert.equal(loadHistoryOptIn(store, "optin"), false);
  clearHistory(store, HISTORY_KEY_WEBSITE);
  assert.deepEqual(loadHistory(store, HISTORY_KEY_WEBSITE), []);
  assert.deepEqual(loadHistory(null, HISTORY_KEY_WEBSITE), []);
});
