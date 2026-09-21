import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundCoordinator } from "../../src/background/coordinator.ts";

function browser() {
  const listeners = { click: [], message: [] };
  return {
    listeners,
    api: {
      action: { onClicked: { addListener(fn) { listeners.click.push(fn); } }, setIcon: () => Promise.resolve(), setBadgeText: () => Promise.resolve() },
      tabs: {
        create: async () => ({ id: 2 }), sendMessage: () => Promise.resolve(),
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      },
      scripting: { executeScript: () => Promise.resolve() },
      permissions: { onRemoved: { addListener() {} } },
      runtime: { getURL: (path) => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { listeners.message.push(fn); } } },
    },
  };
}

function load(fake) {
  const mod = createBackgroundCoordinator({ browserApi: fake.api });
  mod.startBackground();
  return mod;
}

test("coordinator logs the full source URL on lifecycle entries", async () => {
  const fake = browser();
  const mod = load(fake);
  const entries = [];
  mod.setBackgroundLogSink((entry) => entries.push(entry));
  const sourceUrl = "https://user:password@gallery.example/work?token=secret&view=1#fragment";
  await fake.listeners.click[0]({ id: 7, url: sourceUrl });
  await new Promise((resolve) => setImmediate(resolve));

  const created = entries.find((entry) => entry.code === "job-created");
  assert.ok(created);
  assert.ok(created.detail.includes(sourceUrl));
});

test("logging is bounded and a throwing sink cannot interrupt coordinator work", async () => {
  const fake = browser();
  const mod = load(fake);
  mod.setBackgroundLogSink(() => { throw new Error("sink failed"); });
  mod.backgroundLog("info", "test", "x".repeat(5000));
  await fake.listeners.click[0]({ id: 7, url: "https://gallery.example/work" });
  assert.equal(fake.listeners.click.length, 1);
  const seen = [];
  mod.setBackgroundLogSink((entry) => seen.push(entry));
  mod.backgroundLog("info", "test", "x".repeat(5000));
  assert.ok(seen[0].line.length <= "test ".length + mod.BACKGROUND_LOG_MAX_CHARS + 1);
});

test("coordinator logs active-tab and job-bus interactions", async () => {
  const fake = browser();
  const mod = load(fake);
  const entries = [];
  mod.setBackgroundLogSink((entry) => entries.push(entry));
  mod.setBackgroundLogLevel("debug");
  const executed = [];
  fake.api.scripting.executeScript = async (details) => {
    executed.push(details);
    return [{ frameId: 0, result: { ok: true, documentUrl: "https://gallery.example/work", inputs: [{ url: "https://gallery.example/tiles/a.jpg" }], overflow: 0 } }];
  };
  await fake.listeners.click[0]({ id: 7, url: "https://gallery.example/work" });
  await new Promise((resolve) => setImmediate(resolve));
  const created = entries.find((entry) => entry.code === "job-created");
  assert.ok(created, "job was created");
  const jobId = created.detail.match(/jobId=(\S+)/)[1];
  fake.listeners.message[0]({ type: "dz.job.ready", jobId, requestId: "job-ready-test" }, { tab: { id: 2 }, frameId: 0 }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const codes = entries.map((entry) => entry.code);
  assert.ok(codes.includes("toolbar-click"));
  assert.ok(codes.includes("job-message-received"));
  assert.ok(codes.includes("binding-ready"));
  assert.ok(codes.includes("active-tab-op-start"));
  assert.ok(codes.includes("active-tab-op-result"));
  assert.equal(executed.length, 1);
  assert.match(entries.find((entry) => entry.code === "active-tab-op-result").detail, /candidates=1/);
});
