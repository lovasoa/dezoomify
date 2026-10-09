import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelSourceFetch,
  collectCandidates,
  fetchSource,
} from "../../src/job/source-operations.ts";

// Test-only polyfill: the pinned Node toolchain predates
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
        { url: "https://gallery.example/page", kind: "source" },
        { url: "https://cdn.example/viewer.js", kind: "observed-resource" },
        { url: "https://gallery.example/info.json", kind: "observed-resource" },
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
    contentType: "application/xhtml+xml",
    documentElement: { outerHTML: "<html><script>dynamic viewer config</script></html>" },
    querySelectorAll: () => [],
  };
  globalThis.location = { href: "https://gallery.example/page" };
  globalThis.document = {
    contentType: "text/html",
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
      {
        url: "https://gallery.example/page",
        kind: "source",
        contents: "<html><body>rendered page</body></html>",
      },
      {
        url: "https://gallery.example/frame",
        kind: "observed-document",
        contents: "<html><script>dynamic viewer config</script></html>",
      },
      { url: "https://gallery.example/TileGroup0/1-0-0.jpg", kind: "observed-resource" },
    ]);
  } finally {
    globalThis.location = oldLocation;
    globalThis.document = oldDocument;
    globalThis.performance = oldPerformance;
  }
});

test("metadata documents retain their URL without supplying the browser's rendered viewer", () => {
  const oldLocation = globalThis.location;
  const oldDocument = globalThis.document;
  const oldPerformance = globalThis.performance;
  globalThis.location = { href: "https://gallery.example/image.dzi" };
  globalThis.performance = { getEntriesByType: () => [] };
  try {
    for (const contentType of ["application/xml", "text/xml", "application/json", "text/plain"]) {
      globalThis.document = {
        contentType,
        documentElement: { outerHTML: "<html><body>browser metadata viewer</body></html>" },
        querySelectorAll: () => [],
      };
      assert.deepEqual(collectCandidates().inputs, [
        { url: "https://gallery.example/image.dzi", kind: "source" },
      ]);
    }
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

test("a queued source request cannot start after cancellation or its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("cancelled or expired work cannot fetch");
  try {
    const request = {
      url: "https://gallery.example/info.json",
      headers: [],
      operationId: "queued",
      deadlineAt: Date.now() + 30000,
    };
    await cancelSourceFetch(request.operationId, request.deadlineAt);
    assert.equal((await fetchSource(request)).error.kind, "cancelled");
    assert.equal(
      (await fetchSource({ ...request, operationId: "expired", deadlineAt: Date.now() - 1 })).error
        .kind,
      "timeout",
    );
    await cancelSourceFetch("never-started", Date.now() + 10);
    assert.equal(globalThis.__dezoomifySourceFetches.has("never-started"), true);
    t.mock.timers.tick(10);
    assert.equal(globalThis.__dezoomifySourceFetches.has("never-started"), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("source cancellation acknowledges only after its fetch settles", async () => {
  const oldFetch = globalThis.fetch;
  let rejectFetch, signal;
  globalThis.fetch = (_url, init) =>
    new Promise((_, reject) => {
      signal = init.signal;
      rejectFetch = reject;
    });
  try {
    const deadlineAt = Date.now() + 30000;
    const pending = fetchSource({
      url: "https://gallery.example/info.json",
      headers: [],
      operationId: "running",
      deadlineAt,
    });
    let acknowledged = false;
    const cancellation = cancelSourceFetch("running", deadlineAt).then(() => {
      acknowledged = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(acknowledged, false);
    rejectFetch(new DOMException("Cancelled", "AbortError"));
    assert.equal((await pending).error.kind, "cancelled");
    await cancellation;
    assert.equal(acknowledged, true);
  } finally {
    globalThis.fetch = oldFetch;
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
      headers: { get: (key) => (key === "content-type" ? "text/html" : null) },
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
    assert.equal(result.contentType, "text/html", "HTML served as info.json remains diagnosable");
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
      error: {
        kind: "http-error",
        status: 403,
        request: "https://gallery.example/info.json",
        transport: "browser-session",
      },
      documentUrl: "",
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});
