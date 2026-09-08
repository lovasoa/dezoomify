import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backgroundSrc = readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const TAB = { id: 7, url: "https://gallery.example/work" };

function fakeBrowser(session = {}) {
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
    scripting: { executeScript(value) { calls.execute.push(value); return Promise.resolve(); } },
    storage: { session: {
      async get(key) { return { [key]: session[key] }; },
      async set(value) { Object.assign(session, value); calls.storage.push(value); },
    } },
    permissions: {
      onRemoved: { addListener(fn) { listeners.permissionsRemoved.push(fn); } },
      request: async () => true,
    },
    runtime: {
      getURL(path) { return `chrome-extension://test/${path}`; },
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
    },
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

function firstBinding(fake) {
  return fake.calls.send.find((call) => call.message.type === "dz.source.bind")?.message;
}

test("toolbar opens a dedicated job tab then injects only the source collector", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick(); await tick();

  assert.equal(fake.calls.create.length, 1, "the explicit action opens the job tab immediately");
  assert.match(fake.calls.create[0].url, /job\/job.html#jobId=/);
  assert.deepEqual(fake.calls.execute[0], { target: { tabId: TAB.id, allFrames: true }, files: ["content/modal.js"] });
  const binding = firstBinding(fake);
  assert.ok(binding?.jobId && binding.tabId === TAB.id && binding.frameId === 0);
  assert.equal("reload" in fake.calls, false, "inspect-first never reloads during activation");
});

test("repeated activation cancels source discovery and routes job cancellation", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick(); await tick();
  await fake.listeners.click[0](TAB);
  await tick();

  assert.equal(fake.calls.create.length, 1, "second activation does not open a competing job");
  assert.ok(fake.calls.send.some((call) => call.tabId === TAB.id && call.message.type === "dz.source.stop"));
  assert.ok(fake.calls.send.some((call) => call.message.type === "dz.job.cancel"));
});

test("stale navigation generation rejects old source candidates", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick(); await tick();
  const binding = firstBinding(fake);
  for (const listener of fake.listeners.updated) listener(TAB.id, { url: "https://gallery.example/next" });
  await tick();
  assert.ok(fake.calls.send.some((call) => call.message.type === "dz.source.invalidated"), "old document is explicitly invalidated");

  const before = fake.calls.send.length;
  for (const listener of fake.listeners.message) {
    listener({ type: "dz.source.candidates", ...binding, requestId: "old", urls: ["https://gallery.example/info.json"] }, { tab: { id: TAB.id }, frameId: 0 }, () => {});
  }
  assert.equal(fake.calls.send.length, before, "old generation cannot affect the replacement document/job");
});

test("worker restart restores only bindings and reconnects a ready job without auto-start", async () => {
  const session = {};
  const first = fakeBrowser(session);
  await load(first);
  await first.listeners.click[0](TAB);
  await tick(); await tick();
  assert.ok(session["dezoomify.sourceBindings.v1"], "minimal binding is session-persisted");

  const restarted = fakeBrowser(session);
  await load(restarted);
  await tick(); await tick();
  assert.equal(restarted.calls.create.length, 0, "restart never opens or restarts a job");
  assert.equal(restarted.calls.execute.length, 0, "restart never reinjects source discovery");
  const saved = session["dezoomify.sourceBindings.v1"][0];
  for (const listener of restarted.listeners.message) {
    listener({ type: "dz.job.ready", jobId: saved.jobId, tabId: saved.tabId, frameId: saved.frameId, documentGeneration: saved.documentGeneration, requestId: "job-ready" }, { tab: { id: saved.jobTabId }, frameId: 0 }, () => {});
  }
  assert.ok(restarted.calls.send.some((call) => call.message.type === "dz.job.binding" && call.message.sourceValid === false));
});

test("job tab closure removes the binding and stops the source collector", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick(); await tick();
  for (const listener of fake.listeners.removed) listener(40);
  await tick(); await tick();
  assert.ok(fake.calls.send.some((call) => call.message.type === "dz.source.stop"));
  assert.equal(fake.session["dezoomify.sourceBindings.v1"].length, 0, "disconnect cleanup is persisted");
});
