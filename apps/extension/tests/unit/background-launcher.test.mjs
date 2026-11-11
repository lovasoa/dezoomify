import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundLauncher } from "../../src/background/launcher.ts";

const tick = () => new Promise(setImmediate);
const source = { id: 7, url: "https://gallery.example/work" };

function browser() {
  const tabs = new Map([[source.id, { ...source, active: true }]]);
  let click,
    removed,
    nextId = 40;
  function activate(tab) {
    if (tab.active) for (const other of tabs.values()) if (other !== tab) other.active = false;
    return tab;
  }
  const api = {
    action: {
      onClicked: {
        addListener(listener) {
          click = listener;
        },
      },
    },
    tabs: {
      async create(details) {
        const tab = { id: nextId++, ...details };
        tabs.set(tab.id, tab);
        return activate(tab);
      },
      get: async (id) => tabs.get(id),
      async update(id, details) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("tab closed");
        return activate(Object.assign(tab, details));
      },
      onRemoved: {
        addListener(listener) {
          removed = listener;
        },
      },
    },
    runtime: {
      getURL: (path) => `moz-extension://test${path}`,
      sendMessage: async () => {},
      onMessage: { addListener() {} },
    },
  };
  createBackgroundLauncher({ browserApi: api }).startBackground();
  return {
    jobs: () => [...tabs.values()].filter((tab) => tab.url.startsWith("moz-extension://")),
    async click() {
      click(source);
      await tick();
    },
    close(id) {
      tabs.delete(id);
      removed(id);
    },
  };
}

test("toolbar opens the job for the selected source tab", async () => {
  const ui = browser();
  await ui.click();
  const [job] = ui.jobs();
  assert.equal(ui.jobs().length, 1);
  assert.equal(job.active, true);
  const address = new URL(job.url);
  assert.equal(address.pathname, "/job.html");
  assert.equal(new URLSearchParams(address.hash.slice(1)).get("sourceTabId"), String(source.id));
});

test("another toolbar click focuses the existing job instead of opening a duplicate", async () => {
  const ui = browser();
  await ui.click();
  const [job] = ui.jobs();
  job.active = false;
  await ui.click();
  assert.equal(ui.jobs().length, 1);
  assert.equal(ui.jobs()[0].id, job.id);
  assert.equal(ui.jobs()[0].active, true);
});

test("closing a job lets the next click open a working replacement", async () => {
  const ui = browser();
  await ui.click();
  const [closed] = ui.jobs();
  ui.close(closed.id);
  await ui.click();
  assert.equal(ui.jobs().length, 1);
  assert.notEqual(ui.jobs()[0].id, closed.id);
  assert.equal(ui.jobs()[0].active, true);
});
