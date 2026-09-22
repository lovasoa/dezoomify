import assert from "node:assert/strict";
import test from "node:test";
import { collectCandidates, fetchSource } from "../../src/background/source-operations.ts";

// Test-only polyfill: the pinned Node 24 toolchain predates
// Uint8Array.prototype.toBase64 (Baseline 2025), while the extension
// manifest requires browsers that ship it. This exercises fetchSource's
// logic on old Node without touching shipped code.
if (typeof Uint8Array.prototype.toBase64 !== "function") {
  Uint8Array.prototype.toBase64 = function () {
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64");
  };
}

test("candidate snapshot includes the document and retained resources in one batch", () => {
  const oldLocation = globalThis.location;
  const oldPerformance = globalThis.performance;
  globalThis.location = { href: "https://gallery.example/page" };
  globalThis.performance = {
    getEntriesByType: (type) =>
      type === "resource"
        ? [
            { name: "https://cdn.example/viewer.js" },
            { name: "https://gallery.example/info.json" },
            { name: "https://cdn.example/viewer.js" },
          ]
        : [],
  };
  try {
    assert.deepEqual(collectCandidates(), {
      ok: true,
      documentUrl: "https://gallery.example/page",
      inputs: [
        { url: "https://gallery.example/page" },
        { url: "https://cdn.example/viewer.js" },
        { url: "https://gallery.example/info.json" },
      ],
      overflow: 0,
    });
  } finally {
    globalThis.location = oldLocation;
    globalThis.performance = oldPerformance;
  }
});

test("candidate snapshot orders rendered document and readable iframe DOM before URL-only resources", () => {
  const oldLocation = globalThis.location;
  const oldDocument = globalThis.document;
  const oldPerformance = globalThis.performance;
  const child = {
    location: { href: "https://gallery.example/frame" },
    documentElement: { outerHTML: "<html><script>dynamic viewer config</script></html>" },
    querySelectorAll: () => [],
  };
  globalThis.location = { href: "https://gallery.example/page" };
  globalThis.document = {
    documentElement: { outerHTML: "<html><body>rendered page</body></html>" },
    querySelectorAll: () => [
      { contentDocument: child, src: child.location.href },
      {
        get contentDocument() {
          throw new Error("cross-origin");
        },
        src: "https://other.example/frame",
      },
    ],
  };
  globalThis.performance = {
    getEntriesByType: () => [{ name: "https://gallery.example/TileGroup0/1-0-0.jpg" }],
  };
  try {
    assert.deepEqual(collectCandidates().inputs, [
      { url: "https://gallery.example/page", contents: "<html><body>rendered page</body></html>" },
      {
        url: "https://gallery.example/frame",
        contents: "<html><script>dynamic viewer config</script></html>",
      },
      { url: "https://gallery.example/TileGroup0/1-0-0.jpg" },
    ]);
  } finally {
    globalThis.location = oldLocation;
    globalThis.document = oldDocument;
    globalThis.performance = oldPerformance;
  }
});

test("candidate snapshot applies URL and count caps with overflow diagnostics", () => {
  const oldLocation = globalThis.location;
  const oldPerformance = globalThis.performance;
  globalThis.location = { href: "https://gallery.example/page" };
  const entries = Array.from({ length: 105 }, (_, i) => ({
    name: `https://cdn.example/${i}.json`,
  }));
  entries.push({ name: `https://cdn.example/${"x".repeat(2048)}` });
  globalThis.performance = { getEntriesByType: () => entries };
  try {
    const result = collectCandidates();
    assert.equal(result.inputs.length, 100);
    assert.equal(result.inputs[0].url, "https://gallery.example/page");
    assert.equal(result.overflow, 6);
    assert.ok(result.inputs.every((input) => input.url.length <= 2048));
  } finally {
    globalThis.location = oldLocation;
    globalThis.performance = oldPerformance;
  }
});

test("source fetch returns one bounded base64 payload", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      url: "https://gallery.example/info.json",
      headers: { get: () => null },
      body: {
        getReader: () => {
          let done = false;
          return {
            async read() {
              if (done) return { done: true };
              done = true;
              return { done: false, value: new Uint8Array([1, 2, 3]) };
            },
          };
        },
      },
    };
  };
  try {
    const result = await fetchSource({
      url: "https://gallery.example/info.json",
      method: "GET",
      headers: [{ name: "Accept", value: "application/json" }],
    });
    assert.deepEqual([...Buffer.from(result.data, "base64")], [1, 2, 3]);
    assert.equal(result.bytes, 3);
    assert.equal(result.status, 200);
    // Credentials stay unset so the default same-origin policy applies: a
    // cross-origin server answering `Access-Control-Allow-Origin: *` rejects
    // a credentialed CORS request.
    assert.equal(calls[0].init.credentials, undefined);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("source fetch classifies failures without returning response details", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    url: "https://gallery.example/info.json?token=secret",
    headers: {},
    body: null,
  });
  try {
    assert.deepEqual(await fetchSource({ url: "https://gallery.example/info.json", headers: [] }), {
      ok: false,
      code: "http-error",
      status: 403,
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});
