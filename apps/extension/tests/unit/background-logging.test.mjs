import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8");

function browser() {
  const listeners = { click: [] };
  return {
    listeners,
    api: {
      action: { onClicked: { addListener(fn) { listeners.click.push(fn); } }, setIcon: () => Promise.resolve(), setBadgeText: () => Promise.resolve() },
      tabs: {
        create: async () => ({ id: 2 }), sendMessage: () => Promise.resolve(),
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      },
      scripting: { executeScript: () => Promise.resolve() },
      storage: { session: { get: async () => ({}), set: async () => {} } },
      permissions: { onRemoved: { addListener() {} } },
      runtime: { getURL: (path) => `chrome-extension://test/${path}`, onMessage: { addListener() {} } },
    },
  };
}

let sequence = 0;
async function load(fake) {
  const previous = globalThis.chrome;
  globalThis.chrome = fake.api;
  try {
    sequence += 1;
    return await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(text)}#log-${sequence}`);
  } finally { globalThis.chrome = previous; }
}

test("coordinator logs lifecycle without leaking source credentials", async () => {
  const fake = browser();
  const mod = await load(fake);
  const entries = [];
  mod.setBackgroundLogSink((entry) => entries.push(entry));
  await fake.listeners.click[0]({ id: 7, url: "https://user:password@gallery.example/work?token=secret&view=1#fragment" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(entries.some((entry) => entry.code === "job-created"));
  const redacted = mod.redactBackgroundUrl("https://user:password@gallery.example/work?token=secret&view=1#fragment");
  assert.ok(!redacted.includes("password") && !redacted.includes("secret") && !redacted.includes("#"));
  assert.ok(redacted.includes("view=1") && redacted.includes("***"));
});

test("logging is bounded and a throwing sink cannot interrupt coordinator work", async () => {
  const fake = browser();
  const mod = await load(fake);
  mod.setBackgroundLogSink(() => { throw new Error("sink failed"); });
  mod.backgroundLog("info", "test", "x".repeat(5000));
  await fake.listeners.click[0]({ id: 7, url: "https://gallery.example/work" });
  assert.equal(fake.listeners.click.length, 1);
  const seen = [];
  mod.setBackgroundLogSink((entry) => seen.push(entry));
  mod.backgroundLog("info", "test", "x".repeat(5000));
  assert.ok(seen[0].line.length <= "[dezoomify:background] info test ".length + mod.BACKGROUND_LOG_MAX_CHARS + 1);
});

test("classic packaged copy remains parseable after export stripping", async () => {
  const fake = browser();
  const previous = globalThis.chrome;
  globalThis.chrome = fake.api;
  try {
    sequence += 1;
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(text.replace(/^export\s+/gm, ""))}#classic-${sequence}`);
  } finally { globalThis.chrome = previous; }
});
