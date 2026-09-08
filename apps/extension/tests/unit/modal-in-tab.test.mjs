import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sourceText = readFileSync(new URL("../../src/content/modal.js", import.meta.url), "utf8");
const source = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(sourceText)}#unit`);

function runtime() {
  const listeners = new Set();
  const sent = [];
  return {
    sent, listeners,
    runtime: {
      sendMessage(message) { sent.push(message); return Promise.resolve({}); },
      onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    },
  };
}

function collector({ resources = [], href = "https://source.example/page" } = {}) {
  const chromeApi = runtime();
  let observer;
  const win = { location: { href }, crypto: { randomUUID: () => "fixed" } };
  const instance = source.createSourceCollector({
    window: win, chromeApi,
    performance: { getEntriesByType: () => resources },
    PerformanceObserver: function (callback) { observer = { callback, observe() {}, disconnect() { observer.disconnected = true; } }; return observer; },
  });
  instance.mount();
  const binding = { jobId: "job-1", tabId: 9, frameId: 0, documentGeneration: 3, requestId: "bind-1" };
  instance.onMessage({ type: "dz.source.bind", ...binding });
  return { instance, chromeApi, binding, observer: () => observer };
}

function candidateMessages(ctx) { return ctx.chromeApi.sent.filter((message) => message.type === "dz.source.candidates"); }

test("actual content entrypoint mounts once: its only guard does not pre-block mount", async () => {
  const previous = { chrome: globalThis.chrome, browser: globalThis.browser, document: globalThis.document, window: globalThis.window, mounted: globalThis.__dezoomifySourceMounted };
  const chromeApi = runtime();
  globalThis.chrome = chromeApi;
  globalThis.browser = undefined;
  globalThis.document = {};
  globalThis.window = { location: { href: "https://source.example/page" }, performance: { getEntriesByType: () => [] }, crypto: { randomUUID: () => "entry" } };
  delete globalThis.__dezoomifySourceMounted;
  try {
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(sourceText)}#entry-${Date.now()}`);
    assert.equal(chromeApi.listeners.size, 1, "the shipped entrypoint registers its receiver");
    assert.ok(globalThis.__dezoomifySourceMounted?.mounted, "the entrypoint mounted a live collector");
  } finally {
    globalThis.chrome = previous.chrome;
    globalThis.browser = previous.browser;
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    if (previous.mounted === undefined) delete globalThis.__dezoomifySourceMounted;
    else globalThis.__dezoomifySourceMounted = previous.mounted;
  }
});

test("late performance observer entries are emitted as acknowledged chunks", () => {
  const ctx = collector();
  const initial = candidateMessages(ctx)[0];
  ctx.instance.onMessage({ type: "dz.source.candidates-ack", ...ctx.binding, requestId: initial.requestId, urls: initial.urls });
  ctx.chromeApi.sent.length = 0;
  ctx.observer().callback({ getEntries: () => [{ name: "https://cdn.example/iiif/info.json" }] });
  const message = candidateMessages(ctx)[0];
  assert.deepEqual(message.urls, ["https://cdn.example/iiif/info.json"]);
  assert.ok(message.requestId && message.documentGeneration === ctx.binding.documentGeneration);
  ctx.instance.onMessage({ type: "dz.source.candidates-ack", ...ctx.binding, requestId: message.requestId, urls: message.urls });
  assert.equal(ctx.instance.pendingCount, 0, "the acknowledged chunk drains the bounded queue");
});

test(">100 resource timings drain without permanent blindness", () => {
  const resources = Array.from({ length: 140 }, (_, index) => ({ name: `https://cdn.example/resource-${index}.json` }));
  const ctx = collector({ resources });
  const received = new Set();
  for (let turns = 0; turns < 20; turns += 1) {
    const message = candidateMessages(ctx).at(-1);
    if (!message || received.has(message.requestId)) break;
    for (const url of message.urls) received.add(url);
    ctx.instance.onMessage({ type: "dz.source.candidates-ack", ...ctx.binding, requestId: message.requestId, urls: message.urls });
  }
  assert.equal(received.size, 141, "document input plus every retained timing URL is eventually offered");
  assert.ok(ctx.chromeApi.sent.some((message) => message.type === "dz.source.candidates" && message.overflow > 0), "overflow is observable rather than silently disabling later URLs");
});

test("invalidated binding rejects late acknowledgement and stops observation", () => {
  const ctx = collector({ resources: [{ name: "https://cdn.example/info.json" }] });
  const original = candidateMessages(ctx)[0];
  ctx.instance.onMessage({ type: "dz.source.invalidated", ...ctx.binding, requestId: "invalidate" });
  assert.equal(ctx.observer().disconnected, true);
  ctx.instance.onMessage({ type: "dz.source.candidates-ack", ...ctx.binding, requestId: original.requestId });
  assert.equal(ctx.instance.pendingCount, 0, "late replies cannot revive an invalidated source context");
});

test("a stopped singleton accepts a fresh explicit binding in the same document", () => {
  const ctx = collector();
  ctx.instance.onMessage({ type: "dz.source.stop", ...ctx.binding, requestId: "stop" });
  const next = { ...ctx.binding, jobId: "job-2", requestId: "bind-2" };
  ctx.instance.onMessage({ type: "dz.source.bind", ...next });
  assert.equal(ctx.instance.binding.jobId, "job-2");
  assert.ok(ctx.chromeApi.sent.some((message) => message.type === "dz.source.ready" && message.jobId === "job-2"));
});
