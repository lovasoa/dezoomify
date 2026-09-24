import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundCoordinator } from "../../src/background/coordinator.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const TAB = { id: 7, url: "https://gallery.example/work" };

function fakeBrowser(results = []) {
  const listeners = { click: [], removed: [], updated: [], message: [], permissionsRemoved: [] };
  const calls = { create: [], update: [], execute: [], send: [], icon: [], badge: [] };
  let nextTab = 40;
  const api = {
    action: {
      onClicked: {
        addListener(fn) {
          listeners.click.push(fn);
        },
      },
      setIcon(value) {
        calls.icon.push(value);
        return Promise.resolve();
      },
      setBadgeText(value) {
        calls.badge.push(value);
        return Promise.resolve();
      },
    },
    tabs: {
      create(value) {
        calls.create.push(value);
        return Promise.resolve({ id: nextTab++ });
      },
      update(id, value) {
        calls.update.push({ id, value });
        return Promise.resolve();
      },
      sendMessage(tabId, message, options) {
        calls.send.push({ tabId, message, options });
        return Promise.resolve();
      },
      onRemoved: {
        addListener(fn) {
          listeners.removed.push(fn);
        },
      },
      onUpdated: {
        addListener(fn) {
          listeners.updated.push(fn);
        },
      },
    },
    scripting: {
      executeScript(value) {
        calls.execute.push(value);
        return Promise.resolve(
          results.shift() ?? [
            {
              frameId: 0,
              result: {
                ok: true,
                documentUrl: TAB.url,
                inputs: [{ url: "https://gallery.example/info.json" }],
                overflow: 0,
              },
            },
          ],
        );
      },
    },
    permissions: {
      contains: async () => false,
      onRemoved: {
        addListener(fn) {
          listeners.permissionsRemoved.push(fn);
        },
      },
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
      onMessage: {
        addListener(fn) {
          listeners.message.push(fn);
        },
      },
    },
  };
  return { api, calls, listeners };
}

async function load(fake) {
  const mod = createBackgroundCoordinator({ browserApi: fake.api });
  mod.startBackground();
}

function jobId(fake) {
  return decodeURIComponent(fake.calls.create[0].url.split("#jobId=")[1]);
}
function sourceBinding(fake) {
  return fake.binding;
}
function runtimeMessage(fake, message, sender) {
  return new Promise((resolve) => fake.listeners.message[0](message, sender, resolve));
}
async function ready(fake) {
  fake.binding = await runtimeMessage(
    fake,
    { type: "dz.job.ready", jobId: jobId(fake) },
    { tab: { id: 40 }, frameId: 0 },
  );
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
  await ready(fake);
  assert.equal(fake.calls.execute.length, 1);
  assert.deepEqual(fake.calls.execute[0].target, { tabId: TAB.id, frameIds: [0] });
  assert.equal(typeof fake.calls.execute[0].func, "function");
  assert.equal(fake.calls.execute[0].files, undefined);
  assert.equal(
    fake.calls.send.some((call) => call.message.type === "dz.job.binding"),
    false,
  );
  assert.ok(fake.calls.send.some((call) => call.message.type === "dz.job.candidates"));
});

test("source fetch returns one payload through the runtime message response", async () => {
  const fake = fakeBrowser([
    [
      {
        frameId: 0,
        result: {
          ok: true,
          documentUrl: TAB.url,
          inputs: [{ url: "https://gallery.example/info.json" }],
          overflow: 0,
        },
      },
    ],
    [
      {
        frameId: 0,
        result: {
          ok: true,
          status: 200,
          url: "https://gallery.example/info.json",
          bytes: 3,
          data: "AQID",
        },
      },
    ],
  ]);
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  const reply = await runtimeMessage(
    fake,
    {
      ...binding,
      type: "dz.job.fetch",
      url: "https://gallery.example/info.json",
      method: "GET",
      headers: [],
    },
    { tab: { id: 40 }, frameId: 0 },
  );
  await tick();
  assert.equal(reply.ok, true);
  assert.equal(reply.data, "AQID");
  assert.equal(
    fake.calls.send.some((call) => call.message.type === "dz.job.fetch"),
    false,
  );
  assert.equal(reply.bytes, 3);
});

test("source fetch failure preserves a typed engine outcome", async () => {
  const fake = fakeBrowser([
    [
      {
        frameId: 0,
        result: {
          ok: true,
          documentUrl: TAB.url,
          inputs: [{ url: "https://gallery.example/info.json" }],
          overflow: 0,
        },
      },
    ],
    [{ frameId: 0, result: { ok: false, code: "http-error", status: 403 } }],
  ]);
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  const failure = await runtimeMessage(
    fake,
    {
      ...binding,
      type: "dz.job.fetch",
      url: "https://gallery.example/info.json",
      headers: [],
    },
    { tab: { id: 40 }, frameId: 0 },
  );
  await tick();
  assert.equal(failure?.code, "http-error");
  assert.equal(failure?.status, 403);
});

test("permission checks return directly to the job tab", async () => {
  const fake = fakeBrowser();
  fake.api.permissions.contains = async ({ origins }) => {
    assert.deepEqual(origins, ["https://gallery.example/*"]);
    return true;
  };
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  const reply = await runtimeMessage(
    fake,
    {
      ...binding,
      type: "dz.job.permission-required",
      origins: ["https://gallery.example"],
    },
    { tab: { id: 40 }, frameId: 0 },
  );
  assert.deepEqual(reply, {
    type: "dz.job.permission-required",
    jobId: binding.jobId,
    tabId: binding.tabId,
    frameId: binding.frameId,
    documentGeneration: binding.documentGeneration,
    granted: true,
    origins: ["https://gallery.example"],
  });
  assert.equal(
    fake.calls.send.some((call) => call.message.type === "dz.job.permission-required"),
    false,
  );
});

test("navigation invalidates the binding and prevents later source operations", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const before = fake.calls.execute.length;
  for (const listener of fake.listeners.updated)
    listener(TAB.id, { url: "https://gallery.example/next" });
  await tick();
  const binding = sourceBinding(fake);
  for (const listener of fake.listeners.message)
    listener(
      {
        ...binding,
        type: "dz.job.fetch",
        url: "https://gallery.example/info.json",
        headers: [],
      },
      { tab: { id: 40 }, frameId: 0 },
      () => {},
    );
  await tick();
  assert.equal(fake.calls.execute.length, before);
});

test("wrong job-tab frames cannot dispatch source operations", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  const before = fake.calls.execute.length;
  for (const listener of fake.listeners.message)
    listener(
      {
        ...binding,
        type: "dz.job.fetch",
        url: "https://gallery.example/info.json",
        headers: [],
      },
      { tab: { id: 40 }, frameId: 1 },
      () => {},
    );
  await tick();
  assert.equal(fake.calls.execute.length, before);
});

test("job-tab closure clears the binding without a source listener or stop handshake", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick();
  const job = jobId(fake);
  for (const listener of fake.listeners.removed) listener(40);
  await tick();
  for (const listener of fake.listeners.message)
    listener({ type: "dz.job.ready", jobId: job }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  assert.equal(
    fake.calls.execute.length,
    0,
    "closed job has no in-memory binding to resume source work",
  );
  assert.equal(
    fake.calls.send.some((call) => call.message.type === "dz.source.stop"),
    false,
  );
});

test("source-tab closure removes the in-memory job and source binding", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await tick();
  const job = jobId(fake);
  for (const listener of fake.listeners.removed) listener(TAB.id);
  for (const listener of fake.listeners.message)
    listener({ type: "dz.job.ready", jobId: job }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  assert.equal(
    fake.calls.execute.length,
    0,
    "closed source has no in-memory binding to resume source work",
  );
});

test("explicit retry takes a fresh snapshot and re-sends the already-seen candidate", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  assert.equal(fake.calls.execute.length, 1, "ready triggers one discovery snapshot");
  assert.equal(
    fake.calls.send.filter((call) => call.message.type === "dz.job.candidates").length,
    1,
  );

  for (const listener of fake.listeners.message)
    listener({ ...binding, type: "dz.job.retry" }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  await tick();
  assert.equal(fake.calls.execute.length, 2, "retry takes a fresh bounded snapshot");
  assert.equal(
    fake.calls.send.filter((call) => call.message.type === "dz.job.candidates").length,
    2,
    "the candidate dedup is per attempt, so a retry re-sends the page's candidates",
  );
});

test("retry is rejected once the source binding is invalidated", async () => {
  const fake = fakeBrowser();
  await load(fake);
  await fake.listeners.click[0](TAB);
  await ready(fake);
  const binding = sourceBinding(fake);
  for (const listener of fake.listeners.updated)
    listener(TAB.id, { url: "https://gallery.example/next" });
  await tick();
  const before = fake.calls.execute.length;
  for (const listener of fake.listeners.message)
    listener({ ...binding, type: "dz.job.retry" }, { tab: { id: 40 }, frameId: 0 }, () => {});
  await tick();
  assert.equal(fake.calls.execute.length, before, "an invalidated source is never rearmed");
});
