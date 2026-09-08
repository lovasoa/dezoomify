import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression gates for the toolbar click-to-monitor flow in
// `src/background/index.ts`.
//
// Bug report: clicking the grey icon flashed blue, then immediately back to
// grey, with no modal and no monitoring. Two defects combined to produce it:
//  1. `tabs.onUpdated` disarmed on ANY `changeInfo.url`, including the armed
//     tab's own monitored reload (browsers report the same URL on reload).
//  2. The modal was injected BEFORE `tabs.reload`, so the reload wiped the
//     injected content script / probe iframe even when the monitor survived.
//
// Contract under test (basic functionality must never silently die):
//  - click arms the exact tab (blue + badge dot), exactly one `tabs.reload`;
//  - the monitor SURVIVES its own reload: `onUpdated` with the SAME url
//    (loading + complete) must not disarm, and the modal is injected AFTER
//    reload completes (injection never precedes the reload that would
//    wipe it);
//  - navigation to a DIFFERENT url disarms (grey, no stale results);
//  - injection failure disarms (grey) instead of claiming a monitor;
//  - the whole flow works with activeTab-only capabilities: the fake
//    browser exposes NO `webRequest` and NO host access at all (production
//    truth: a `webRequest` listener without host permissions is deaf, and
//    activeTab does not enable observation). If shipped code ever touches
//    `api.webRequest`, this harness throws and the suite goes red.
//
// The harness drives the real shipped module with a fake browser namespace:
// `globalThis.chrome` is installed before the data: URL import, so the
// module's top-level `const api = globalThis.browser ?? globalThis.chrome`
// picks up the fake and `wire()` registers test-visible listeners.

const backgroundSrc = readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8");

function createFakeBrowser() {
  const listeners = { onClicked: [], onRemoved: [], onUpdated: [], onMessage: [], onInstalled: [] };
  const calls = {
    setIcon: [], setBadgeText: [], reload: [], insertCSS: [], executeScript: [],
    sendMessage: [], tabsGet: [], tabsCreate: [],
  };
  // No webRequest, no permissions, no host access: the activeTab-only
  // production shape. The click flow must complete to injection anyway;
  // candidates come from the injected tab's own timeline.
  const api = {
    action: {
      onClicked: { addListener(fn) { listeners.onClicked.push(fn); } },
      setIcon(args) { calls.setIcon.push(args); },
      setBadgeText(args) { calls.setBadgeText.push(args); },
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
    // Unique fragment per import: data: URL modules cache by URL, and the
    // shipped module wires listeners exactly once per evaluation.
    backgroundImportSeq += 1;
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(backgroundSrc)}//#${backgroundImportSeq}`);
  } finally {
    globalThis.browser = prevBrowser;
    globalThis.chrome = prevChrome;
  }
  return fake;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const TAB = { id: 7, url: "https://gallery.example/work" };

test("click survives its own reload: stays blue, injects after complete", async () => {
  const fake = createFakeBrowser();
  await loadBackground(fake);
  const { listeners, calls } = fake;

  assert.equal(listeners.onClicked.length, 1, "background must listen for the toolbar click");
  await listeners.onClicked[0]({ ...TAB });
  await tick(); await tick();

  // Armed: blue icon + badge dot, exactly one reload of the clicked tab.
  assert.equal(calls.reload.length, 1, "exactly one reload of exactly the clicked tab");
  assert.equal(calls.reload[0], TAB.id);
  const lastIcon = calls.setIcon.at(-1);
  assert.ok(lastIcon && lastIcon.tabId === TAB.id, "icon swap targets the clicked tab");

  // The modal must NOT be injected before the reload that would wipe it.
  assert.equal(calls.executeScript.length, 0, "no injection before reload completes (reload wipes content scripts)");

  // The browser reports the armed tab's OWN reload (same URL): loading...
  for (const fn of listeners.onUpdated) fn(TAB.id, { status: "loading", url: TAB.url });
  await tick();
  // ...and complete. Neither may disarm the monitor.
  for (const fn of listeners.onUpdated) fn(TAB.id, { status: "complete", url: TAB.url });
  await tick(); await tick();

  // Injection happens AFTER reload completes, and the icon stays blue.
  assert.equal(calls.executeScript.length, 1, "modal injected once, after reload completes");
  assert.deepEqual(calls.executeScript[0], { target: { tabId: TAB.id }, files: ["content/modal.js"] });
  const iconAfter = calls.setIcon.at(-1);
  const badgeAfter = calls.setBadgeText.at(-1);
  assert.ok(iconAfter && iconAfter.path["16"] === "icons/icon16.png", "icon stays blue through its own reload (not grey)");
  assert.ok(badgeAfter && badgeAfter.text === "•", "badge dot stays while monitoring");

  // The fresh content script gets an armed snapshot (it seeds its own
  // candidates from the tab timeline, which needs no permission).
  const updates = calls.sendMessage.filter((c) => c.message && c.message.type === "dezoomify-monitor-update");
  assert.ok(updates.length > 0, "fresh content script must be told monitoring is armed");
});

test("navigation to a different url disarms (grey, no stale results)", async () => {
  const fake = createFakeBrowser();
  await loadBackground(fake);
  const { listeners, calls } = fake;

  await listeners.onClicked[0]({ ...TAB });
  await tick(); await tick();
  for (const fn of listeners.onUpdated) fn(TAB.id, { status: "complete", url: TAB.url });
  await tick(); await tick();
  assert.equal(calls.executeScript.length, 1);

  for (const fn of listeners.onUpdated) fn(TAB.id, { url: "https://other.example/" });
  await tick();
  const lastIcon = calls.setIcon.at(-1);
  assert.ok(lastIcon && lastIcon.path["16"] === "icons/icon16-grey.png", "navigation away restores the grey icon");

  // Post-navigation traffic from the tab is ignored (stale listener, if any).
  const before = calls.sendMessage.length;
  for (const fn of listeners.onUpdated) fn(TAB.id, { url: "https://other.example/" });
  await tick();
  assert.equal(calls.sendMessage.length, before, "no updates after navigation away");
});

test("injection failure remains visible instead of silently returning to idle", async () => {
  const fake = createFakeBrowser();
  fake.api.scripting.executeScript = (args) => {
    fake.calls.executeScript.push(args);
    return Promise.reject(new Error("cannot access page"));
  };
  await loadBackground(fake);
  const { listeners, calls } = fake;

  await listeners.onClicked[0]({ ...TAB });
  await tick(); await tick();
  for (const fn of listeners.onUpdated) fn(TAB.id, { status: "complete", url: TAB.url });
  await tick(); await tick();

  const lastIcon = calls.setIcon.at(-1);
  const lastBadge = calls.setBadgeText.at(-1);
  assert.ok(lastIcon && lastIcon.path["16"] === "icons/icon16.png", "failed injection keeps an actionable error state");
  assert.equal(lastBadge?.text, "!", "failed injection shows an error badge");
  assert.equal(calls.reload.length, 1, "the single reload still ran once");
});

test("modal failure keeps the action visibly failed until a second click", async () => {
  const fake = createFakeBrowser();
  await loadBackground(fake);
  const { listeners, calls } = fake;
  await listeners.onClicked[0]({ ...TAB });
  await tick(); await tick();
  for (const fn of listeners.onUpdated) fn(TAB.id, { status: "complete", url: TAB.url });
  await tick(); await tick();
  for (const fn of listeners.onMessage) {
    fn({ type: "dezoomify-modal-failed", code: "modal-start-failed" }, { tab: { id: TAB.id } }, () => {});
  }
  assert.equal(calls.setBadgeText.at(-1).text, "!", "modal failure shows an error badge");
  await listeners.onClicked[0]({ ...TAB });
  assert.equal(calls.setBadgeText.at(-1).text, "", "second click dismisses the failed monitor");
});

test("rejecting setIcon/setBadgeText never surfaces (cosmetic only)", async () => {
  // Regression gate: MV3 setIcon/setBadgeText return promises that reject
  // (e.g. "Failed to fetch" for a navigating/gone tab). The background's
  // try/catch cannot catch those; without an explicit .catch they escape as
  // Uncaught (in promise) and spam the console on every arm/disarm.
  const fake = createFakeBrowser();
  fake.api.action.setIcon = (args) => {
    fake.calls.setIcon.push(args);
    return Promise.reject(new Error("Failed to fetch"));
  };
  fake.api.action.setBadgeText = (args) => {
    fake.calls.setBadgeText.push(args);
    return Promise.reject(new Error("Failed to fetch"));
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await loadBackground(fake);
    const { listeners } = fake;

    await listeners.onClicked[0]({ ...TAB });
    await tick(); await tick();
    for (const fn of listeners.onUpdated) fn(TAB.id, { status: "complete", url: TAB.url });
    await tick(); await tick();
    // Disarm path (navigation away) also swaps the icon: must not reject.
    for (const fn of listeners.onUpdated) fn(TAB.id, { url: "https://other.example/" });
    await tick(); await tick();
    await tick();
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }

  assert.equal(unhandled.length, 0, "rejected icon/badge updates must be swallowed, never unhandled");
  assert.equal(fake.calls.reload.length, 1, "monitoring still arms despite icon failures");
  assert.ok(fake.calls.setIcon.length > 0, "icon swaps were still attempted");
});
