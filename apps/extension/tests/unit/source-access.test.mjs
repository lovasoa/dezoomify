import assert from "node:assert/strict";
import test from "node:test";
import { createSourceAccess } from "../../src/job/source-access.ts";
import { collectCandidates, fetchSource } from "../../src/job/source-operations.ts";

const SOURCE_URL = "https://gallery.example/page?view=1";

function fakeBrowser(execute) {
  const listeners = { updated: [], removed: [] };
  const calls = [];
  let url = SOURCE_URL;
  return {
    listeners,
    calls,
    setUrl(value) {
      url = value;
    },
    api: {
      tabs: {
        get: async (tabId) => ({ id: tabId, url }),
        onUpdated: {
          addListener(fn) {
            listeners.updated.push(fn);
          },
          removeListener(fn) {
            listeners.updated = listeners.updated.filter((candidate) => candidate !== fn);
          },
        },
        onRemoved: {
          addListener(fn) {
            listeners.removed.push(fn);
          },
          removeListener(fn) {
            listeners.removed = listeners.removed.filter((candidate) => candidate !== fn);
          },
        },
      },
      scripting: {
        async executeScript(injection) {
          calls.push(injection);
          return [{ frameId: 0, result: await execute(injection) }];
        },
      },
    },
  };
}

function snapshot(documentUrl = SOURCE_URL) {
  return {
    ok: true,
    documentUrl,
    inputs: [{ url: "https://gallery.example/info.json" }],
    overflow: 0,
  };
}

test("job-page source access calls injected scan and fetch with inferred argument shapes", async () => {
  const fake = fakeBrowser(async ({ func, args }) => {
    if (func === collectCandidates) return snapshot();
    assert.equal(func, fetchSource);
    assert.equal(args[0].url, "https://gallery.example/info.json");
    assert.equal(args[0].method, "GET");
    assert.deepEqual(args[0].headers, [{ name: "Accept", value: "application/json" }]);
    assert.equal(typeof args[0].operationId, "string");
    return {
      ok: true,
      status: 200,
      url: "https://gallery.example/info.json",
      bytes: 3,
      data: "AQID",
      documentUrl: SOURCE_URL,
    };
  });
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  try {
    assert.deepEqual(await source.scan(), snapshot());
    const result = await source.fetch(
      {
        uri: "https://gallery.example/info.json",
        headers: [{ name: "Accept", value: "application/json" }],
      },
      new AbortController().signal,
    );
    assert.deepEqual([...result.bytes], [1, 2, 3]);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(
      fake.calls.map((call) => call.target),
      [
        { tabId: 9, frameIds: [0] },
        { tabId: 9, frameIds: [0] },
      ],
    );
  } finally {
    source.dispose();
  }
});

test("source scan rejects a malformed boundary result", async () => {
  const fake = fakeBrowser(async () => ({
    ...snapshot(),
    inputs: [{ url: "javascript:alert(1)" }],
  }));
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  await assert.rejects(source.scan(), { code: "malformed" });
  source.dispose();
});

test("navigation invalidates access and discards an in-flight scan result", async () => {
  let finish;
  const fake = fakeBrowser(() => new Promise((resolve) => (finish = resolve)));
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  const pending = source.scan();
  await new Promise((resolve) => setImmediate(resolve));
  fake.listeners.updated[0](9, { status: "loading", url: SOURCE_URL });
  finish(snapshot());
  await assert.rejects(pending, { code: "source-document-lost" });
  await assert.rejects(source.scan(), { code: "source-document-lost" });
  source.dispose();
});

test("source fetch treats HTTP refusals as definitive and leaves fallback decisions typed", async () => {
  const fake = fakeBrowser(async () => ({
    ok: false,
    code: "http-error",
    status: 403,
    documentUrl: SOURCE_URL,
  }));
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  await assert.rejects(
    source.fetch(
      { uri: "https://gallery.example/private.xml", headers: [] },
      new AbortController().signal,
    ),
    { code: "http-error", status: 403, sourceDefinitive: true },
  );
  source.dispose();
});

test("source access refuses a tab whose URL no longer matches its bound document", async () => {
  const fake = fakeBrowser(async () => snapshot());
  fake.setUrl("https://gallery.example/other-page");
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  await assert.rejects(source.scan(), { code: "source-document-lost" });
  assert.equal(fake.calls.length, 0);
  source.dispose();
});
