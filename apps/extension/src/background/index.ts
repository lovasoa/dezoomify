/**
 * Click-to-monitor background: the toolbar action arms indefinite monitoring
 * on exactly the clicked tab. Nothing runs before that explicit click (no
 * background monitoring, no tab enumeration, no timers, no polling).
 *
 * On click (activeTab grant on the clicked tab only):
 * 1. Privileged pages (chrome://, about:, stores) are rejected before any
 *    observer or reload, mirroring the scan state machine.
 * 2. A bounded webRequest collector (exact tab id, http/https only,
 *    first-seen first window of 100, proxy-forbidden) is armed BEFORE the
 *    single reload; exactly one reload runs.
 * 3. The toolbar icon reports state (grey idle, blue while monitoring, badge
 *    dot) via `action.setIcon`/`setBadgeText`.
 * 4. The in-tab monitor (`content/modal.js` + `content/modal.css`) is
 *    injected via `scripting.executeScript`/`scripting.insertCSS` - the only
 *    use of the `scripting` permission - AFTER the monitored reload
 *    completes. Injecting before the reload would be wiped by it (content
 *    scripts do not survive navigation), so pre-reload injection is
 *    forbidden here; the `tabs.onUpdated` `complete` handler owns injection.
 *
 * The background streams candidate URLs (`dezoomify-monitor-update`) while
 * armed; it never declares detection from URL text. The modal iframe fetches
 * each candidate's bytes tab-side (cookies/auth carried) and confirms via
 * the wasm `DiscoverySession`; on success it reports `dezoomify-byte-confirmed`
 * (collector stops, blue badge kept for the job). The modal closes via
 * `dezoomify-modal-closed` (grey icon restored), and a blocked job iframe
 * falls back to the bound page (`dezoomify-open-panel` opens
 * `page.html?tab=` for exactly that tab).
 *
 * Monitoring is indefinite: no deadline, no polling. It stops collecting on
 * the first terminal signal - tab-side byte confirmation, modal
 * close/fallback, a second click on the armed tab (cancel), tab close, or
 * navigation away. Stopped monitoring never restarts itself, and a worker
 * restart (service-worker suspend / event-page unload) fails closed: the
 * memory-only armed set is gone, so observation is dead by construction.
 *
 * The scan, discovery, fetch, assembly, and save all live tab-side (the
 * modal iframe and `page/page.ts`); format recognition stays the wasm
 * core's job, never URL-text guessing here. Pure detection helpers live in
 * `background/detect.ts` (unit-tested, never shipped).
 *
 * MV3 dual background: Chromium runs this file as a service worker, Firefox
 * as an MV3 event page. Classic script in both: shipped export-free (the
 * store packager strips `export` and gates on `node --check`), import-free
 * (no bundler). Top-level browser wiring is guarded so the file stays
 * loadable with no browser effects under node. No offscreen document:
 * offscreen is Chromium-only and unnecessary for an in-tab modal.
 */

const api = globalThis.browser ?? globalThis.chrome;

const IDLE_ICON = {
  16: "icons/icon16-grey.png",
  48: "icons/icon48-grey.png",
  128: "icons/icon128-grey.png",
};
const ACTIVE_ICON = {
  16: "icons/icon16.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png",
};

// tabId -> { urls, seen, confirmed, url, injected } for armed monitors.
// `url` is the clicked-tab URL at arm time (fragment stripped): the monitor
// survives its OWN reload (same URL reported back by tabs.onUpdated) and
// stops only on navigation to a DIFFERENT page. `injected` gates the
// post-reload modal injection (exactly once). Memory only: never persisted,
// never restored, dropped when the context suspends/unloads (fail closed).
// URL collection alone is NEVER detection: many formats require actual
// response bytes (DiscoverySession) to confirm an image. The background only
// streams candidate URLs; byte confirmation runs tab-side in the modal
// iframe (wasm + tab-origin fetch with cookies/auth) and reports back via
// `dezoomify-byte-confirmed`. Monitoring stops only then (or on cancel /
// close / navigation).
const armed = new Map();

// First-window cap for indefinite collection (mirrors MAX_CANDIDATES in
// background/detect.ts and page/candidates.ts).
const MAX_CANDIDATES = 100;
const MAX_URL_LENGTH = 2048;
const PROXY_PATH = "/api/proxy";

function isPrivilegedUrl(url) {
  return typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"));
}

function isCollectableUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  if (raw.includes(PROXY_PATH)) return false;
  return raw.startsWith("http://") || raw.startsWith("https://");
}

/**
 * Compare page URLs ignoring the fragment: zoom viewers routinely rewrite
 * `#zoom=...` in place, which is not a navigation away. A reload reports
 * the same unfragmented URL and must never disarm the monitor it triggered.
 */
function samePage(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.split("#", 1)[0] === b.split("#", 1)[0];
}

function setArmedBadge(tabId, active) {
  try {
    if (api.action && typeof api.action.setIcon === "function") {
      // MV3 returns a promise: a tab that is navigating or already gone
      // rejects with e.g. "Failed to fetch". Icon state is cosmetic only,
      // so swallow the rejection like sendToTab does (try/catch alone
      // cannot catch it: it surfaces as Uncaught (in promise)).
      const iconPending = api.action.setIcon({ tabId, path: active ? ACTIVE_ICON : IDLE_ICON });
      if (iconPending && typeof iconPending.catch === "function") iconPending.catch(() => {});
    }
    if (api.action && typeof api.action.setBadgeText === "function") {
      const badgePending = api.action.setBadgeText({ tabId, text: active ? "•" : "" });
      if (badgePending && typeof badgePending.catch === "function") badgePending.catch(() => {});
    }
  } catch {
    // Icon/badge state is cosmetic only; monitoring never depends on it.
  }
}

function sendToTab(tabId, message) {
  try {
    const pending = api.tabs.sendMessage(tabId, message);
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    // The tab may already be gone; monitor state is unaffected.
  }
}

function reportUpdate(tabId, entry) {
  sendToTab(tabId, { type: "dezoomify-monitor-update", seen: entry.urls.length, urls: [...entry.urls] });
}

function disarm(tabId, notify) {
  if (!armed.has(tabId)) return false;
  armed.delete(tabId);
  setArmedBadge(tabId, false);
  if (notify !== false) sendToTab(tabId, { type: "dezoomify-stop-monitor" });
  return true;
}

async function injectModal(tabId) {
  // Programmatic injection on the clicked tab only (activeTab grant from
  // the action click; no host permissions consumed, no tab enumeration).
  // CSS first so the first paint is already styled.
  await api.scripting.insertCSS({ target: { tabId }, files: ["content/modal.css"] });
  await api.scripting.executeScript({ target: { tabId }, files: ["content/modal.js"] });
}

function observeRequests(details) {
  const entry = armed.get(details.tabId);
  // After tab-side byte confirmation the collector stops (job takes over);
  // before that, every new URL is only a candidate, never a detection.
  if (!entry || entry.confirmed) return;
  // Exact-tab correlation only; first-seen wins, the first window is kept,
  // overflow is rejected (never evicts: deterministic for the rank batch).
  if (!isCollectableUrl(details.url)) return;
  if (entry.seen.has(details.url)) return;
  if (entry.urls.length >= MAX_CANDIDATES) return;
  entry.seen.add(details.url);
  entry.urls.push(details.url);
  reportUpdate(details.tabId, entry);
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  try {
    if (api.webRequest && api.webRequest.onBeforeRequest) {
      api.webRequest.onBeforeRequest.addListener(observeRequests, { urls: ["http://*/*", "https://*/*"] });
    }
  } catch {
    // Observation is best-effort; the in-tab modal still collects its own
    // performance-timeline candidates.
  }

  api.action.onClicked.addListener(async (tab) => {
    const tabId = tab && tab.id;
    if (typeof tabId !== "number") return;
    // Second click on the armed tab cancels monitoring (replace and cancel).
    if (disarm(tabId, true)) return;
    // Single-tab read for the privileged-URL guard only, never enumeration.
    let url = tab.url;
    try {
      if (typeof url !== "string" || !url) {
        const fresh = await api.tabs.get(tabId);
        url = fresh && fresh.url;
      }
    } catch {
      // Keep the event URL; the guard below fails closed on unknown URLs.
    }
    if (isPrivilegedUrl(url)) {
      setArmedBadge(tabId, false);
      return;
    }
    // Arm BEFORE the single reload so pre-reload traffic is observed.
    // Injection happens after the reload completes (see the tabs.onUpdated
    // handler): anything injected now would be wiped by the reload.
    armed.set(tabId, { urls: [], seen: new Set(), confirmed: false, url, injected: false });
    setArmedBadge(tabId, true);
    try {
      // Exactly one reload of exactly that tab.
      await api.tabs.reload(tabId);
    } catch {
      // Reload can fail (tab gone): disarm so the icon never lies.
      disarm(tabId, false);
    }
  });

  // Tab close drops a known armed id only; never enumerates tabs.
  api.tabs.onRemoved.addListener((tabId) => {
    disarm(tabId, false);
  });

  // Tab updates while armed (no tab enumeration: only known armed ids):
  // - navigation to a DIFFERENT page stops monitoring (no stale-tab
  //   results); changeInfo.url is visible without any tabs permission.
  //   The armed tab's own reload (same page, fragment ignored) NEVER
  //   disarms: disarming on it was the blue-then-instantly-grey bug.
  // - the monitored reload completing injects the modal exactly once (a
  //   pre-reload injection would have been wiped by the reload itself).
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const entry = armed.get(tabId);
    if (!entry) return;
    if (changeInfo && typeof changeInfo.url === "string" && !samePage(changeInfo.url, entry.url)) {
      disarm(tabId, false);
      return;
    }
    if (changeInfo && changeInfo.status === "complete" && !entry.injected) {
      entry.injected = true;
      injectModal(tabId).then(() => {
        // Deliver the pre-reload traffic to the fresh content script.
        reportUpdate(tabId, entry);
      }, () => {
        // Injection can fail (navigated away, privileged target): disarm so
        // the icon never claims a monitor that has no modal.
        disarm(tabId, false);
      });
    }
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!message || typeof message.type !== "string" || typeof tabId !== "number") return;
    if (message.type === "dezoomify-byte-confirmed") {
      // Tab-side DiscoverySession confirmed an image from bytes. Stop the
      // URL collector (job takes over) but keep the blue badge until the
      // modal closes.
      const entry = armed.get(tabId);
      if (entry) entry.confirmed = true;
      try {
        sendResponse({ confirmed: true });
      } catch {
        // The sender may be gone; state is already updated.
      }
      return true;
    }
    if (message.type === "dezoomify-modal-closed") {
      // Modal close disposes the monitor and restores the grey icon.
      disarm(tabId, false);
      try {
        sendResponse({ stopped: true });
      } catch {
        // The sender may be gone; state is already updated.
      }
      return true;
    }
    if (message.type === "dezoomify-open-panel") {
      // Blocked job iframe fallback: open the bound page flow for exactly
      // this tab instead of stranding the user.
      disarm(tabId, false);
      try {
        api.tabs.create({ url: api.runtime.getURL("page/page.html?tab=" + tabId) });
      } catch {
        // Tab creation failure strands nothing: monitoring already stopped.
      }
      return;
    }
  });

  api.runtime.onInstalled.addListener(() => {
    api.tabs.create({ url: api.runtime.getURL("page/page.html") });
  });
}

// Guarded wiring: a real browser namespace wires listeners on load; node
// imports get the pure collectors above with no browser effects (`api` is
// undefined without a browser namespace, so `wire()` never runs there).
try {
  if (typeof api !== "undefined" && api && api.action && api.action.onClicked) {
    wire();
  }
} catch {
  // Wiring must never throw (node imports, hostile contexts).
}
