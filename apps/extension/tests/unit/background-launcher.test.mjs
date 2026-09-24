import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundLauncher } from "../../src/background/launcher.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const SOURCE = { id: 7, url: "https://gallery.example/work" };

function fakeBrowser() {
  const listeners = { click: [], removed: [], message: [] };
  const calls = { create: [], update: [], send: [] };
  const tabs = new Map([[SOURCE.id, SOURCE]]);
  let nextTabId = 40;
  const api = {
    action: {
      onClicked: { addListener: (listener) => listeners.click.push(listener) },
    },
    tabs: {
      async create(details) {
        calls.create.push(details);
        const tab = { id: nextTabId++, url: details.url };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (tabId) => tabs.get(tabId),
      update: async (tabId, details) => {
        calls.update.push({ tabId, details });
        if (!tabs.has(tabId)) throw new Error("tab missing");
        return tabs.get(tabId);
      },
      onRemoved: { addListener: (listener) => listeners.removed.push(listener) },
    },
    runtime: {
      getURL: (path) => `moz-extension://test${path}`,
      sendMessage: async (message) => {
        calls.send.push(message);
      },
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
    },
  };
  return { api, calls, listeners, tabs };
}

test("toolbar click opens one job page with only the source tab id", async () => {
  const fake = fakeBrowser();
  createBackgroundLauncher({ browserApi: fake.api }).startBackground();
  fake.listeners.click[0](SOURCE);
  await tick();
  assert.equal(fake.calls.create.length, 1);
  assert.equal(fake.calls.create[0].url, "moz-extension://test/job.html#sourceTabId=7");
  assert.equal(fake.calls.create[0].active, true);
  assert.equal(fake.calls.send.length, 0);
});

test("repeated toolbar clicks focus the existing job and forward one local decision", async () => {
  const fake = fakeBrowser();
  createBackgroundLauncher({ browserApi: fake.api }).startBackground();
  fake.listeners.click[0](SOURCE);
  await tick();
  fake.listeners.click[0](SOURCE);
  await tick();
  assert.equal(fake.calls.create.length, 1);
  assert.deepEqual(fake.calls.update, [{ tabId: 40, details: { active: true } }]);
  assert.deepEqual(fake.calls.send, [{ type: "dz.toolbar-click", sourceTabId: SOURCE.id }]);
});

test("closing either tab removes its source-to-job directory entry", async () => {
  const fake = fakeBrowser();
  createBackgroundLauncher({ browserApi: fake.api }).startBackground();
  fake.listeners.click[0](SOURCE);
  await tick();
  fake.listeners.removed[0](40);
  fake.listeners.click[0](SOURCE);
  await tick();
  assert.equal(fake.calls.create.length, 2);
});

test("the testing driver uses the same launcher after checking the current tab URL", async () => {
  const fake = fakeBrowser();
  createBackgroundLauncher({ browserApi: fake.api, testing: true }).startBackground();
  const respond = (message) =>
    new Promise((resolve) => fake.listeners.message[0](message, {}, resolve));
  assert.deepEqual(
    await respond({ type: "dezoomify-test-start-job", tabId: SOURCE.id, url: SOURCE.url }),
    { ok: true },
  );
  assert.deepEqual(await respond({ type: "dezoomify-test-wake-background" }), { ok: true });
  assert.equal(fake.calls.create.length, 1);
  assert.deepEqual(
    await respond({
      type: "dezoomify-test-start-job",
      tabId: SOURCE.id,
      url: "https://other.example/",
    }),
    { ok: false },
  );
});
