import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/background/source-operations.ts", import.meta.url), "utf8");
const { collectCandidates, fetchSource } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

test("candidate snapshot includes the document and retained resources in one batch", () => {
  const oldLocation = globalThis.location;
  const oldPerformance = globalThis.performance;
  globalThis.location = { href: "https://gallery.example/page" };
  globalThis.performance = { getEntriesByType: (type) => type === "resource" ? [
    { name: "https://cdn.example/viewer.js" },
    { name: "https://gallery.example/info.json" },
    { name: "https://cdn.example/viewer.js" },
  ] : [] };
  try {
    assert.deepEqual(collectCandidates(), {
      ok: true,
      documentUrl: "https://gallery.example/page",
      urls: ["https://gallery.example/page", "https://cdn.example/viewer.js", "https://gallery.example/info.json"],
      overflow: 0,
    });
  } finally {
    globalThis.location = oldLocation;
    globalThis.performance = oldPerformance;
  }
});

test("candidate snapshot applies URL and count caps with overflow diagnostics", () => {
  const oldLocation = globalThis.location;
  const oldPerformance = globalThis.performance;
  globalThis.location = { href: "https://gallery.example/page" };
  const entries = Array.from({ length: 105 }, (_, i) => ({ name: `https://cdn.example/${i}.json` }));
  entries.push({ name: `https://cdn.example/${"x".repeat(2048)}` });
  globalThis.performance = { getEntriesByType: () => entries };
  try {
    const result = collectCandidates();
    assert.equal(result.urls.length, 100);
    assert.equal(result.urls[0], "https://gallery.example/page");
    assert.equal(result.overflow, 6);
    assert.ok(result.urls.every((url) => url.length <= 2048));
  } finally {
    globalThis.location = oldLocation;
    globalThis.performance = oldPerformance;
  }
});

test("source fetch returns bounded chunks and a completion result", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: "https://gallery.example/info.json",
    headers: { get: () => null },
    body: { getReader: () => {
      let done = false;
      return { async read() { if (done) return { done: true }; done = true; return { done: false, value: new Uint8Array([1, 2, 3]) }; } };
    } },
  });
  try {
    const result = await fetchSource({ url: "https://gallery.example/info.json", method: "GET", headers: [{ name: "Accept", value: "application/json" }] });
    assert.deepEqual(result.chunks, [{ sequence: 0, bytes: [1, 2, 3] }]);
    assert.equal(result.bytes, 3);
    assert.equal(result.status, 200);
  } finally { globalThis.fetch = oldFetch; }
});

test("source fetch classifies failures without returning response details", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, url: "https://gallery.example/info.json?token=secret", headers: {}, body: null });
  try {
    assert.deepEqual(await fetchSource({ url: "https://gallery.example/info.json", headers: [] }), { ok: false, code: "http-error", status: 403 });
  } finally { globalThis.fetch = oldFetch; }
});
