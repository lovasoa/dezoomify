import assert from "node:assert/strict";
import test from "node:test";
import { createSourceAccess } from "../../src/job/source-access.ts";
import {
  cancelSourceFetch,
  collectCandidates,
  fetchSource,
  inspectSourceDocument,
} from "../../src/job/source-operations.ts";

const SOURCE_URL = "https://gallery.example/page?view=1";

function fakeBrowser(execute) {
  const listeners = { updated: [], removed: [] };
  const calls = [];
  let url = SOURCE_URL;
  let frames = () => [{ frameId: 0, documentUrl: SOURCE_URL, token: "root", frames: [] }];
  return {
    listeners,
    calls,
    setFrames(value) {
      frames = typeof value === "function" ? value : () => value;
    },
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
          const documents = frames();
          if (injection.func === inspectSourceDocument) {
            return documents
              .filter(
                (frame) =>
                  injection.target.allFrames ||
                  injection.target.frameIds?.includes(frame.frameId) ||
                  injection.target.documentIds?.includes(frame.documentId),
              )
              .map((frame) => ({
                frameId: frame.frameId,
                ...(frame.documentId ? { documentId: frame.documentId } : {}),
                result: {
                  documentUrl: frame.documentUrl,
                  token: frame.token,
                  frames: frame.frames ?? [],
                },
              }));
          }
          calls.push(injection);
          return [{ frameId: injection.target.frameIds[0], result: await execute(injection) }];
        },
      },
    },
  };
}

test("nested frames use existing grants first, then one deferred permission and their own session", async () => {
  const foreign = "https://viewer.example/widget";
  const nested = "https://gallery.example/nested";
  const calls = [];
  const fake = fakeBrowser(async (injection) => {
    const frameId = injection.target.frameIds[0];
    const documentUrl = frameId === 8 ? foreign : nested;
    if (injection.func === fetchSource) {
      calls.push(["fetch", frameId]);
      return {
        ok: true,
        documentUrl,
        status: 200,
        url: injection.args[0].url,
        bytes: 1,
        data: "AQ==",
      };
    }
    if (injection.files) return { ok: true, documentUrl, inputs: [] };
    calls.push(["scan", frameId]);
    return {
      ...snapshot(documentUrl),
      inputs: [{ url: documentUrl, kind: "source", contents: "<html></html>" }],
    };
  });
  const granted = new Set();
  fake.setFrames(() => [
    { frameId: 0, documentUrl: SOURCE_URL, token: "root", frames: [foreign] },
    ...(granted.has("https://viewer.example")
      ? [{ frameId: 8, documentUrl: foreign, token: "viewer" }]
      : []),
    { frameId: 9, documentUrl: nested, token: "nested" },
  ]);
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  const access = {
    hasPermission: async (origin) => granted.has(origin),
    ensurePermission: async (origin) => {
      calls.push(["permission", origin]);
      granted.add(origin);
    },
    scanned: () => {},
    failed: (_frame, error) => {
      throw error;
    },
  };
  const observe = source.observations(access);
  const signal = new AbortController().signal;
  try {
    assert.equal((await observe("forbidden", signal))[0].kind, "observed-document");
    assert.deepEqual(await observe("forbidden", signal), []);
    assert.deepEqual(
      calls,
      [["scan", 9]],
      "a permitted descendant is reachable through an unpermitted parent",
    );
    assert.equal((await observe("allowed", signal))[0].url, foreign);
    await source.fetch({ uri: "https://viewer.example/file.dzi", headers: [] }, signal);
    assert.deepEqual(calls, [
      ["scan", 9],
      ["permission", "https://viewer.example"],
      ["scan", 8],
      ["fetch", 8],
    ]);
    assert.deepEqual(await observe("allowed", signal), []);
    // A new invocation rescans live frames, retaining already-granted access.
    const next = source.observations(access);
    assert.equal((await next("forbidden", signal))[0].url, foreign);
    assert.equal(calls.filter(([kind]) => kind === "permission").length, 1);
  } finally {
    source.dispose();
  }
});

function snapshot(documentUrl = SOURCE_URL) {
  return {
    ok: true,
    documentUrl,
    inputs: [{ url: "https://gallery.example/info.json" }],
    overflow: 0,
  };
}

test("a grant acquired between observation batches reveals the existing viewer", async () => {
  const foreign = "https://viewer.example/widget";
  let granted = false;
  const fake = fakeBrowser(async () => snapshot(foreign));
  fake.setFrames(() => [
    { frameId: 0, documentUrl: SOURCE_URL, token: "root", frames: [foreign] },
    ...(granted ? [{ frameId: 8, documentUrl: foreign, token: "viewer" }] : []),
  ]);
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  const observe = source.observations({
    hasPermission: async () => granted,
    ensurePermission: () => assert.fail("the metadata fetch already obtained permission"),
    scanned: () => {},
    failed: (_frame, error) => {
      throw error;
    },
  });
  try {
    const signal = new AbortController().signal;
    assert.deepEqual(await observe("forbidden", signal), []);
    granted = true;
    assert.ok((await observe("forbidden", signal)).length > 0);
    assert.deepEqual(await observe("allowed", signal), []);
  } finally {
    source.dispose();
  }
});

test("a same-URL reload during MAIN-world scanning invalidates the document token", async () => {
  let token = "original";
  const fake = fakeBrowser(async () => {
    token = "replacement";
    return snapshot();
  });
  fake.setFrames(() => [{ frameId: 0, documentUrl: SOURCE_URL, token }]);
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  try {
    await assert.rejects(source.scan(), {
      kind: "policy-denied",
      blocked_reason: "source-document-lost",
    });
    assert.equal(fake.calls.length, 1, "replacement document is never scanned as the original");
  } finally {
    source.dispose();
  }
});

test("a lost frame-inventory reply remains bounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeBrowser(() => assert.fail("no full scan should run"));
  const execute = fake.api.scripting.executeScript;
  fake.api.scripting.executeScript = (injection) =>
    injection.target.allFrames ? new Promise(() => {}) : execute(injection);
  const source = createSourceAccess(
    fake.api,
    { tabId: 9, documentUrl: SOURCE_URL },
    { timeoutMs: 30 },
  );
  const observe = source.observations({
    hasPermission: async () => false,
    ensurePermission: () => assert.fail("no permission request"),
    scanned: () => {},
    failed: () => {},
  });
  try {
    const checked = assert.rejects(observe("forbidden", new AbortController().signal), {
      kind: "timeout",
    });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30);
    await checked;
  } finally {
    source.dispose();
  }
});

test("MAIN-world observations are independently validated and preserve document evidence", async () => {
  const observation = {
    url: `${SOURCE_URL}#dezoomify-openseadragon-0`,
    kind: "observed-metadata",
    contents:
      '<Image TileSize="256" Overlap="0" Format="png"><Size Width="512" Height="512"/></Image>',
  };
  const fake = fakeBrowser(async (injection) => {
    if (injection.files) {
      assert.deepEqual(injection.files, ["/openseadragon-scanner.js"]);
      assert.equal(injection.world, "MAIN");
      assert.equal(injection.func, undefined);
      assert.equal(injection.args, undefined);
      return {
        ok: true,
        documentUrl: SOURCE_URL,
        inputs: [
          { ...observation, extra: "discard this" },
          { ...observation, contents: {} },
          { ...observation, url: "javascript:bad" },
        ],
        diagnostics: { rejected: 0, truncated: false },
      };
    }
    assert.equal(injection.world ?? "ISOLATED", "ISOLATED");
    return snapshot();
  });
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  try {
    const scan = await source.scan();
    assert.deepEqual(scan.inputs, [...snapshot().inputs, observation]);
    assert.deepEqual(scan.memory, { rejected: 0, truncated: false });
  } finally {
    source.dispose();
  }
});

test("memory injection failure preserves its cause and falls back to document discovery", async () => {
  const fake = fakeBrowser(async ({ func }) => {
    if (!func) throw new Error("page MAIN world unavailable");
    return snapshot();
  });
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  try {
    const scan = await source.scan();
    assert.deepEqual(scan.inputs, snapshot().inputs);
    assert.equal(scan.memory.unavailable, true);
    assert.equal(scan.memory.detail, "page MAIN world unavailable");
  } finally {
    source.dispose();
  }
});

test("job-page source access calls injected scan and fetch with inferred argument shapes", async () => {
  const fake = fakeBrowser(async ({ func, args }) => {
    if (!func) return { ...snapshot(), inputs: [] };
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
      contentType: "text/html",
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
    assert.equal(result.contentType, "text/html");
    assert.equal(result.http, 200);
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(
      fake.calls.map((call) => call.target),
      [
        { tabId: 9, frameIds: [0] },
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
  await assert.rejects(source.scan(), { kind: "bad-url" });
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
  await assert.rejects(pending, {
    kind: "policy-denied",
    blocked_reason: "source-document-lost",
  });
  await assert.rejects(source.scan(), {
    kind: "policy-denied",
    blocked_reason: "source-document-lost",
  });
  source.dispose();
});

test("source scan rejects unknown observation kinds", async () => {
  const fake = fakeBrowser(async () => ({
    ...snapshot(),
    inputs: [{ url: SOURCE_URL, kind: "trusted-image" }],
  }));
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  await assert.rejects(source.scan(), { kind: "bad-url" });
  source.dispose();
});

test("source fetch treats HTTP refusals as definitive and leaves fallback decisions typed", async () => {
  const fake = fakeBrowser(async () => ({
    ok: false,
    error: {
      kind: "http-error",
      status: 403,
      transport: "browser-session",
      detail: "Refused",
    },
    documentUrl: SOURCE_URL,
  }));
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  await assert.rejects(
    source.fetch(
      { uri: "https://gallery.example/private.xml", headers: [] },
      new AbortController().signal,
    ),
    { kind: "http-error", status: 403 },
  );
  source.dispose();
});

test("source access refuses a tab whose URL no longer matches its bound document", async () => {
  const fake = fakeBrowser(async () => snapshot());
  fake.setUrl("https://gallery.example/other-page");
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  await assert.rejects(source.scan(), {
    kind: "policy-denied",
    blocked_reason: "source-document-lost",
  });
  assert.equal(fake.calls.length, 0);
  source.dispose();
});

test("source injection errors retain the browser's cause", async () => {
  const cause = new Error("Missing host permission");
  const fake = fakeBrowser(async () => {
    throw cause;
  });
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  await assert.rejects(source.scan(), { kind: "network-failure", detail: cause.message });
  source.dispose();
});

test("generated failure facts survive source validation unchanged", async () => {
  const error = {
    kind: "http-error",
    status: 429,
    transport: "browser-session",
    retry_after_ms: 3000,
    preview: "Try later",
    detail: "original diagnostic",
  };
  const fake = fakeBrowser(async () => ({ ok: false, error, documentUrl: SOURCE_URL }));
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  try {
    await assert.rejects(
      source.fetch(
        { uri: "https://gallery.example/tile.jpg", headers: [] },
        new AbortController().signal,
      ),
      (caught) => {
        assert.equal(caught, error);
        return true;
      },
    );
  } finally {
    source.dispose();
  }
});

test("a lost browser reply is bounded and returns a typed timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeBrowser(() => new Promise(() => {}));
  const source = createSourceAccess(
    fake.api,
    { tabId: 9, documentUrl: SOURCE_URL },
    { timeoutMs: 30 },
  );
  const pending = source.fetch(
    { uri: "https://gallery.example/tile.jpg", headers: [] },
    new AbortController().signal,
  );
  const checked = assert.rejects(pending, { kind: "timeout" });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(30);
  await checked;
  source.dispose();
});

test("source cancellation waits for acknowledgement that the page fetch has stopped", async () => {
  let acknowledge;
  const fake = fakeBrowser(
    ({ func }) =>
      new Promise((resolve) => {
        if (func === cancelSourceFetch) acknowledge = resolve;
      }),
  );
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  const controller = new AbortController();
  let settled = false;
  const checked = assert
    .rejects(
      source.fetch({ uri: "https://gallery.example/tile.jpg", headers: [] }, controller.signal),
      { kind: "cancelled" },
    )
    .then(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const request = fake.calls[0].args[0];
  assert.deepEqual(fake.calls[1].args, [request.operationId, request.deadlineAt, "root"]);
  acknowledge();
  await checked;
  source.dispose();
});

test("a rejected cancellation injection still waits for the original source operation", async () => {
  let complete;
  const fake = fakeBrowser(({ func }) => {
    if (func === cancelSourceFetch) return Promise.reject(new Error("Injection failed"));
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  const controller = new AbortController();
  let settled = false;
  const checked = assert
    .rejects(
      source.fetch({ uri: "https://gallery.example/tile.jpg", headers: [] }, controller.signal),
      { kind: "cancelled" },
    )
    .then(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  complete({ documentUrl: SOURCE_URL });
  await checked;
  source.dispose();
});

test("cancellation before source injection creates no page work or cancellation marker", async () => {
  let checkedTab;
  const fake = fakeBrowser(() => assert.fail("No source script should execute"));
  fake.api.tabs.get = () =>
    new Promise((resolve) => {
      checkedTab = resolve;
    });
  const source = createSourceAccess(fake.api, { tabId: 9, documentUrl: SOURCE_URL });
  const controller = new AbortController();
  const checked = assert.rejects(
    source.fetch({ uri: "https://gallery.example/tile.jpg", headers: [] }, controller.signal),
    { kind: "cancelled" },
  );
  controller.abort();
  await checked;
  checkedTab({ id: 9, url: SOURCE_URL });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.length, 0);
  source.dispose();
});

test("cancellation and disposal remain bounded when source and cancellation replies disappear", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["cancel", "dispose", "navigate"]) {
    const fake = fakeBrowser(() => new Promise(() => {}));
    const source = createSourceAccess(
      fake.api,
      { tabId: 9, documentUrl: SOURCE_URL },
      { timeoutMs: 30 },
    );
    const controller = new AbortController();
    const pending = source.fetch(
      { uri: "https://gallery.example/tile.jpg", headers: [] },
      controller.signal,
    );
    const checked = assert.rejects(pending, {
      kind: action === "cancel" ? "cancelled" : "policy-denied",
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (action === "cancel") controller.abort();
    else if (action === "dispose") source.dispose();
    else fake.listeners.updated[0](9, { status: "loading" });
    t.mock.timers.tick(30);
    await checked;
    source.dispose();
  }
});
