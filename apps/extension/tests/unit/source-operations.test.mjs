import assert from "node:assert/strict";
import test from "node:test";
import { cancelSourceFetch, fetchSource } from "../../src/job/source-operations.ts";
import {
  collectCandidates as collectSnapshot,
  sourceSnapshotLimits,
} from "../../src/job/source-snapshot.ts";

const collectCandidates = () => collectSnapshot(sourceSnapshotLimits);

// Test-only polyfill: the pinned Node toolchain predates
// Uint8Array.prototype.toBase64 (Baseline 2025), while the extension
// manifest requires browsers that ship it. This exercises fetchSource's
// logic on old Node without touching shipped code.
if (typeof Uint8Array.prototype.toBase64 !== "function") {
  Uint8Array.prototype.toBase64 = function () {
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64");
  };
}

const documentToken = "source-document";
test.beforeEach(() => {
  globalThis.__dezoomifyDocumentToken = documentToken;
});
function sourceRequest(overrides = {}) {
  return {
    url: "https://gallery.example/info.json",
    headers: [],
    operationId: crypto.randomUUID(),
    deadlineAt: Date.now() + 30000,
    documentToken,
    ...overrides,
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
    });
  } finally {
    globalThis.location = oldLocation;
    globalThis.performance = oldPerformance;
  }
});

test("candidate snapshot reads one document; frame traversal belongs to source access", () => {
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
      { url: "https://gallery.example/TileGroup0/1-0-0.jpg", kind: "observed-resource" },
    ]);
  } finally {
    globalThis.location = oldLocation;
    globalThis.document = oldDocument;
    globalThis.performance = oldPerformance;
  }
});

test("standalone image tabs keep their wrapper and image without probing browser favicons", () => {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    performance: globalThis.performance,
  };
  const url = "https://gallery.example/full.jpg";
  globalThis.location = { href: url };
  globalThis.document = {
    contentType: "image/jpeg",
    documentElement: { outerHTML: `<html><img src="${url}"></html>` },
    images: [{ complete: true, naturalWidth: 3000, naturalHeight: 4000, currentSrc: url }],
  };
  globalThis.performance = {
    getEntriesByType: () => assert.fail("image tabs need no resource inventory"),
  };
  try {
    const { inputs } = collectCandidates();
    assert.equal(inputs[0].contents, globalThis.document.documentElement.outerHTML);
    assert.deepEqual(
      inputs.map((input) => input.kind),
      ["source"],
    );
  } finally {
    Object.assign(globalThis, previous);
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

test("candidate snapshot retains late image resources after a busy page's assets", () => {
  const oldLocation = globalThis.location;
  const oldPerformance = globalThis.performance;
  globalThis.location = { href: "https://gallery.example/page" };
  const entries = Array.from({ length: 5000 }, (_, i) => ({
    name: `https://cdn.example/${i}.js?${"x".repeat(256)}`,
  }));
  const tile = "https://gallery.example/proxy?filename=painting_files/9/0_0.jpg";
  entries.push({ name: tile }, { name: tile });
  entries.push({ name: `https://cdn.example/${"x".repeat(sourceSnapshotLimits.urlLength)}` });
  globalThis.performance = { getEntriesByType: () => entries };
  try {
    const result = collectCandidates();
    assert.equal(result.inputs[0].url, "https://gallery.example/page");
    assert.deepEqual(
      result.inputs.slice(1).map((input) => input.url),
      [...entries.slice(0, 5000).map((entry) => entry.name), tile],
    );
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
    const request = sourceRequest({
      operationId: "queued",
    });
    await cancelSourceFetch(request.operationId, request.deadlineAt, documentToken);
    assert.equal((await fetchSource(request)).error.kind, "cancelled");
    assert.equal(
      (await fetchSource({ ...request, operationId: "expired", deadlineAt: Date.now() - 1 })).error
        .kind,
      "timeout",
    );
    await cancelSourceFetch("never-started", Date.now() + 10, documentToken);
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
    const pending = fetchSource(sourceRequest({ operationId: "running", deadlineAt }));
    let acknowledged = false;
    const cancellation = cancelSourceFetch("running", deadlineAt, documentToken).then(() => {
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
    const result = await fetchSource(
      sourceRequest({ headers: [{ name: "Accept", value: "application/json" }] }),
    );
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

test("missing or stale document tokens prevent fetches and cancellation markers", async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = globalThis.__dezoomifyDocumentToken;
  const oldRequests = globalThis.__dezoomifySourceFetches;
  globalThis.__dezoomifyDocumentToken = "replacement";
  globalThis.__dezoomifySourceFetches = new Map();
  globalThis.fetch = () => assert.fail("a replacement document must not fetch");
  try {
    for (const token of [undefined, "", "original"]) {
      assert.equal(
        (await fetchSource(sourceRequest({ documentToken: token }))).error.blocked_reason,
        "source-document-lost",
      );
      await cancelSourceFetch("never-started", Date.now() + 30000, token);
    }
    assert.equal(globalThis.__dezoomifySourceFetches.size, 0);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__dezoomifyDocumentToken = oldToken;
    globalThis.__dezoomifySourceFetches = oldRequests;
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
    assert.deepEqual(await fetchSource(sourceRequest()), {
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

test("source range fetch rejects ignored ranges before reading and bounds partial bodies", async () => {
  const oldFetch = globalThis.fetch;
  const request = sourceRequest({
    url: "https://gallery.example/image.zif",
    headers: [{ name: "Range", value: "bytes=10-13" }],
    rangeBytes: 4,
  });
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.Range, "bytes=10-13");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader() {
            assert.fail("ignored ranges must not be read");
          },
        },
      };
    };
    assert.equal((await fetchSource(request)).error.kind, "bad-url");
    globalThis.fetch = async () =>
      new Response("data", {
        status: 206,
        headers: { "content-range": "bytes 10-13/100", "content-length": "4" },
      });
    const result = await fetchSource(request);
    assert.equal(result.ok, true);
    assert.equal(result.contentRange, "bytes 10-13/100");
    assert.equal(result.bytes, 4);
    globalThis.fetch = async () => new Response("oversized", { status: 206 });
    assert.deepEqual((await fetchSource(request)).error, { kind: "size-limit", max_bytes: 4 });
  } finally {
    globalThis.fetch = oldFetch;
  }
});
