import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Gates for structured background logging in `src/background/index.ts`:
// leveled, redacted, bounded console logs plus the existing tab messages
// (which carry user-visible state into the in-tab modal's log).
//
// The harness drives the real shipped module with a fake browser namespace,
// like `background-click.test.mjs`.

const backgroundSrc = readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8");

function createFakeBrowser() {
  const listeners = { onClicked: [], onRemoved: [], onUpdated: [], onMessage: [], onInstalled: [] };
  const calls = {
    setIcon: [], setBadgeText: [], reload: [], insertCSS: [], executeScript: [],
    sendMessage: [], tabsGet: [], tabsCreate: [],
  };
  // No webRequest here either: the background must work with activeTab-only
  // capabilities (see background-click.test.mjs).
  const api = {
    action: {
      onClicked: { addListener(fn) { listeners.onClicked.push(fn); } },
      setIcon(args) { calls.setIcon.push(args); return Promise.resolve(); },
      setBadgeText(args) { calls.setBadgeText.push(args); return Promise.resolve(); },
    },
    tabs: {
      get(tabId) { calls.tabsGet.push(tabId); return Promise.resolve({ id: tabId, url: "https://gallery.example/work" }); },
      reload(tabId) { calls.reload.push(tabId); return Promise.resolve(); },
      sendMessage(tabId, message) { calls.sendMessage.push({ tabId, message }); return Promise.resolve(); },
      create(args) { calls.tabsCreate.push(args); return Promise.resolve({}); },
      onRemoved: { addListener(fn) { listeners.onRemoved.push(fn); } },
      onUpdated: { addListener(fn) { listeners.onUpdated.push(fn); } },
    },
    scripting: {
      insertCSS(args) { calls.insertCSS.push(args); return Promise.resolve(); },
      executeScript(args) { calls.executeScript.push(args); return Promise.resolve(); },
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.onMessage.push(fn); } },
      onInstalled: { addListener(fn) { listeners.onInstalled.push(fn); } },
      getURL(path) { return "chrome-extension://fake/" + path; },
    },
  };
  return { api, listeners, calls };
}

let backgroundImportSeq = 0;
async function loadBackground(fake) {
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  globalThis.browser = undefined;
  globalThis.chrome = fake.api;
  try {
    backgroundImportSeq += 1;
    return await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(backgroundSrc)}//#log${backgroundImportSeq}`);
  } finally {
    globalThis.browser = prevBrowser;
    globalThis.chrome = prevChrome;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const TAB = { id: 7, url: "https://gallery.example/work" };

test("redactBackgroundUrl strips userinfo, sensitive query, fragments", async () => {
  const fake = createFakeBrowser();
  const mod = await loadBackground(fake);
  const out = mod.redactBackgroundUrl("https://user:secret@gallery.example/work?token=ABC&view=1#frag");
  assert.ok(!out.includes("user"), "userinfo leak");
  assert.ok(!out.includes("ABC"), "query secret leak");
  assert.ok(out.includes("***"), "redaction marker missing");
  assert.ok(out.includes("view=1"), "safe param lost");
  assert.ok(!out.includes("#"), "fragment leak");
  assert.equal(mod.redactBackgroundUrl("not a url"), "[invalid-url]");
  assert.equal(mod.redactBackgroundUrl(""), "[empty-url]");
});

test("lifecycle logs stable codes via sink; debug gated by default", async () => {
  const fake = createFakeBrowser();
  const mod = await loadBackground(fake);
  const { listeners } = fake;
  const entries = [];
  mod.setBackgroundLogSink((e) => void entries.push(e));

  await listeners.onClicked[0]({ ...TAB });
  await tick(); await tick();
  for (const fn of listeners.onUpdated) fn(TAB.id, { status: "complete", url: TAB.url });
  await tick(); await tick();

  const codes = entries.map((e) => e.code);
  assert.ok(codes.includes("armed"), "arm must log `armed`");
  assert.ok(codes.includes("injected"), "post-reload inject must log `injected`");
  // No per-URL collection lives here anymore (in-tab timeline instead), so
  // no `candidate` code may ever appear at any level.
  assert.ok(!codes.includes("candidate"), "background must not log collected URLs (nothing to collect)");
  for (const e of entries) {
    assert.match(e.line, /^\[dezoomify:background\] (debug|info|warn|error) \S+/, "structured prefix");
  }

  // Debug opt-in still redacts the armed tab URL (page addresses routinely
  // carry tokens): arm on a secret-bearing URL and check every line.
  entries.length = 0;
  mod.setBackgroundLogLevel("debug");
  const secret = "tok-SECRET-99";
  const leakTab = { id: 11, url: `https://user:pass@gallery.example/work?token=${secret}&view=1#frag` };
  await listeners.onClicked[0]({ ...leakTab });
  await tick(); await tick();
  const debugLine = entries.map((e) => e.line).join("\n");
  for (const leak of ["pass", secret, "#frag"]) {
    assert.ok(!debugLine.includes(leak), `credential/fragment leak in logs: ${leak}`);
  }
  assert.ok(debugLine.includes("***") && debugLine.includes("view=1"), "redacted tab URL expected");
});

test("terminal and user-visible transitions log at info/warn/error", async () => {
  const fake = createFakeBrowser();
  const mod = await loadBackground(fake);
  const { listeners } = fake;
  const entries = [];
  mod.setBackgroundLogSink((e) => void entries.push(e));

  await listeners.onClicked[0]({ ...TAB });
  await tick(); await tick();
  for (const fn of listeners.onUpdated) fn(TAB.id, { status: "complete", url: TAB.url });
  await tick(); await tick();
  for (const fn of listeners.onMessage) fn({ type: "dezoomify-byte-confirmed" }, { tab: { id: TAB.id } }, () => {});
  for (const fn of listeners.onMessage) fn({ type: "dezoomify-modal-closed" }, { tab: { id: TAB.id } }, () => {});
  const codes = entries.map((e) => e.code);
  assert.ok(codes.includes("byte-confirmed"), "confirmation must log");
  assert.ok(codes.includes("modal-closed"), "close must log");

  entries.length = 0;
  await listeners.onClicked[0]({ ...TAB, url: "chrome://settings" });
  await tick();
  assert.ok(entries.some((e) => e.code === "privileged-rejected" && e.level === "warn"), "privileged reject must warn");

  entries.length = 0;
  fake.api.scripting.executeScript = (args) => {
    fake.calls.executeScript.push(args);
    return Promise.reject(new Error("cannot access page"));
  };
  await listeners.onClicked[0]({ id: 9, url: "https://gallery.example/other" });
  await tick(); await tick();
  for (const fn of listeners.onUpdated) fn(9, { status: "complete", url: "https://gallery.example/other" });
  await tick(); await tick();
  assert.ok(entries.some((e) => e.code === "injection-failed" && e.level === "error"), "injection failure must error-log");
});

test("logging never throws and never breaks monitoring", async () => {
  const fake = createFakeBrowser();
  const mod = await loadBackground(fake);
  const { listeners } = fake;
  mod.setBackgroundLogSink(() => { throw new Error("sink boom"); });
  mod.setBackgroundLogLevel("debug");
  await listeners.onClicked[0]({ ...TAB });
  await tick(); await tick();
  assert.equal(fake.calls.reload.length, 1, "monitoring arms even when the sink throws");
  // Truncation keeps lines bounded.
  const seen = [];
  mod.setBackgroundLogSink((e) => void seen.push(e));
  mod.backgroundLog("info", "armed", "x".repeat(5000));
  assert.ok(seen[0].line.length <= "[dezoomify:background] info armed ".length + mod.BACKGROUND_LOG_MAX_CHARS + 1);
});

test("shipped classic copy (export-stripped) still parses", async () => {
  const stripped = backgroundSrc.replace(/^export\s+/gm, "");
  assert.ok(!/^export\s/m.test(stripped), "all top-level exports must strip for the classic worker");
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  globalThis.browser = undefined;
  globalThis.chrome = createFakeBrowser().api;
  try {
    backgroundImportSeq += 1;
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(stripped)}//#classic${backgroundImportSeq}`);
  } finally {
    globalThis.browser = prevBrowser;
    globalThis.chrome = prevChrome;
  }
});
