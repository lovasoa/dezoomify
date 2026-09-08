import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const operationsSrc = readFileSync(new URL("../../src/background/source-operations.ts", import.meta.url), "utf8").replace(/^export\s+/gm, "");
const backgroundSrc = `${operationsSrc}\n${readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8").replace(/^import .*source-operations\.js";\s*$/m, "")}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const TAB = { id: 7, url: "https://gallery.example/work" };

function fakeBrowser(session = {}, results = []) {
  const listeners = { click: [], removed: [], updated: [], message: [], permissionsRemoved: [] };
  const calls = { create: [], update: [], execute: [], send: [], icon: [], badge: [], storage: [] };
  let nextTab = 40;
  const api = {
    action: {
      onClicked: { addListener(fn) { listeners.click.push(fn); } },
      setIcon(value) { calls.icon.push(value); return Promise.resolve(); },
      setBadgeText(value) { calls.badge.push(value); return Promise.resolve(); },
    },
    tabs: {
      create(value) { calls.create.push(value); return Promise.resolve({ id: nextTab++ }); },
      update(id, value) { calls.update.push({ id, value }); return Promise.resolve(); },
      sendMessage(tabId, message, options) { calls.send.push({ tabId, message, options }); return Promise.resolve(); },
      onRemoved: { addListener(fn) { listeners.removed.push(fn); } },
      onUpdated: { addListener(fn) { listeners.updated.push(fn); } },
    },
    scripting: {
      executeScript(value) {
        calls.execute.push(value);
        return Promise.resolve(results.shift() ?? [{ frameId: 0, result: { ok: true, documentUrl: TAB.url, urls: ["https://gallery.example/info.json"], overflow: 0 } }]);
      },
    },
    storage: { session: {
      async get(key) { return { [key]: session[key] }; },
      async set(value) { Object.assign(session, value); calls.storage.push(value); },
    } },
    permissions: { onRemoved: { addListener(fn) { listeners.permissionsRemoved.push(fn); } }, request: async () => true },
    runtime: { getURL(path) { return `chrome-extension://test/${path}`; }, onMessage: { addListener(fn) { listeners.message.push(fn); } } },
  };
  return { api, calls, listeners, session };
}

let sequence = 0;
async function load(fake) {
  const browser = globalThis.browser;
  const chrome = globalThis.chrome;
  globalThis.browser = undefined;
  globalThis.chrome = fake.api;
  try {
    sequence += 1;
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(backgroundSrc)}#${sequence}`);
  } finally {
    globalThis.browser = browser;
    globalThis.chrome = chrome;
  }
}

function jobId(fake) { return decodeURIComponent(fake.calls.create[0].url.split("#jobId=")[1]); }
function sourceBinding(fake) { return fake.calls.send.find((call) => call.message.type === "dz.job.binding")?.message; }
async function ready(fake) {
  for (const listener of fake.listeners.message) listener({ type: "dz.job.ready", jobId: jobId(fake), requestId: "job-ready" }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  await tick();
}

test("toolbar opens the dedicated job tab without injection, registration, or reload", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick();
  assert.equal(fake.calls.create.length, 1);
  assert.equal(fake.calls.execute.length, 0, "source work waits for job readiness");
  const background = readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8");
  assert.ok(!background.includes("registerContentScripts"));
  assert.ok(!background.includes("tabs.reload"));
  assert.ok(!background.includes("getBrowserInfo"));
  await ready(fake);
  assert.equal(fake.calls.execute.length, 1);
  assert.deepEqual(fake.calls.execute[0].target, { tabId: TAB.id, frameIds: [0] });
  assert.equal(typeof fake.calls.execute[0].func, "function");
  assert.equal(fake.calls.execute[0].files, undefined);
  assert.ok(fake.calls.send.some((call) => call.message.type === "dz.job.candidates"));
});

test("source fetch returns chunks and completion through the job bridge", async () => {
  const fake = fakeBrowser({}, [
    [{ frameId: 0, result: { ok: true, documentUrl: TAB.url, urls: ["https://gallery.example/info.json"], overflow: 0 } }],
    [{ frameId: 0, result: { ok: true, status: 200, url: "https://gallery.example/info.json", bytes: 3, chunks: [{ sequence: 0, bytes: [1, 2, 3] }] } }],
  ]);
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  for (const listener of fake.listeners.message) listener({ ...binding, type: "dz.job.fetch", requestId: "req:source", url: "https://gallery.example/info.json", method: "GET", headers: [] }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  const forwarded = fake.calls.send.filter((call) => call.message.type === "dz.job.fetch").map((call) => call.message);
  assert.deepEqual(forwarded.map((message) => message.sourceType), ["dz.source.fetch-chunk", "dz.source.fetch-complete"]);
  assert.deepEqual(forwarded[0].bytes, [1, 2, 3]);
  assert.equal(forwarded[1].ok, true);
});

test("source fetch failure preserves a typed engine outcome", async () => {
  const fake = fakeBrowser({}, [
    [{ frameId: 0, result: { ok: true, documentUrl: TAB.url, urls: ["https://gallery.example/info.json"], overflow: 0 } }],
    [{ frameId: 0, result: { ok: false, code: "http-error", status: 403 } }],
  ]);
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  for (const listener of fake.listeners.message) listener({ ...binding, type: "dz.job.fetch", requestId: "req:failure", url: "https://gallery.example/info.json", headers: [] }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  const failure = fake.calls.send.map((call) => call.message).find((message) => message.type === "dz.job.fetch" && message.requestId === "req:failure");
  assert.equal(failure?.sourceType, "dz.source.fetch-complete");
  assert.equal(failure?.code, "http-error");
  assert.equal(failure?.status, 403);
});

test("navigation invalidates the binding and prevents later source operations", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const before = fake.calls.execute.length;
  for (const listener of fake.listeners.updated) listener(TAB.id, { url: "https://gallery.example/next" });
  await tick();
  const binding = sourceBinding(fake);
  for (const listener of fake.listeners.message) listener({ ...binding, type: "dz.job.fetch", requestId: "req:stale", url: "https://gallery.example/info.json", headers: [] }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  assert.equal(fake.calls.execute.length, before);
  assert.ok(fake.calls.send.some((call) => call.message.type === "dz.job.binding" && call.message.sourceValid === false));
});

test("wrong job-tab frames cannot dispatch source operations", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  const before = fake.calls.execute.length;
  for (const listener of fake.listeners.message) listener({ ...binding, type: "dz.job.fetch", requestId: "req:wrong-frame", url: "https://gallery.example/info.json", headers: [] }, { tab: { id: 40 }, frameId: 1 }, () => {});
  await tick();
  assert.equal(fake.calls.execute.length, before);
});

test("job-tab closure clears the binding without a source listener or stop handshake", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick();
  for (const listener of fake.listeners.removed) listener(40);
  await tick();
  assert.equal(fake.session["dezoomify.sourceBindings.v1"].length, 0);
  assert.equal(fake.calls.send.some((call) => call.message.type === "dz.source.stop"), false);
});
