/**
 * Click-to-monitor background: the toolbar action arms indefinite monitoring
 * on exactly the clicked tab. Nothing runs before that explicit click (no
 * background monitoring, no tab enumeration, no timers, no polling).
 *
 * Deliberately, the background observes NO network traffic itself. A
 * `webRequest` listener without host permissions is deaf: the platform only
 * notifies requests the extension has host access to, and the transient
 * activeTab grant does not enable observation (verified: an identical
 * listener with `host_permissions: []` sees zero requests where the same
 * listener with the origin granted sees all of them). Candidate collection
 * therefore lives entirely in the injected tab, via the page's own
 * performance timeline (`content/modal.js`), which needs no permission at
 * all. No permanent host permissions are declared, so there is nothing to
 * warn about and no `webRequest` usage here to go deaf.
 *
 * On click (activeTab grant on the clicked tab only):
 * 1. Privileged pages (chrome://, about:, stores) are rejected before any
 *    reload, mirroring the scan state machine.
 * 2. Exactly one reload of exactly that tab runs.
 * 3. The toolbar icon reports state (grey idle, blue while monitoring, badge
 *    dot) via `action.setIcon`/`setBadgeText`.
 * 4. The in-tab monitor (`content/modal.js` + `content/modal.css`) is
 *    injected via `scripting.executeScript`/`scripting.insertCSS` - the only
 *    use of the `scripting` permission - AFTER the monitored reload
 *    completes. Injecting before the reload would be wiped by it (content
 *    scripts do not survive navigation), so pre-reload injection is
 *    forbidden here; the `tabs.onUpdated` `complete` handler owns injection.
 *
 * The background never declares detection from URL text. The injected modal
 * collects candidate URLs from the tab's own timeline, fetches each
 * candidate's bytes tab-side (cookies/auth carried under the click grant)
 * and confirms via the wasm `DiscoverySession`; on success it reports
 * `dezoomify-byte-confirmed` (blue badge kept for the job). The modal closes
 * via `dezoomify-modal-closed` (grey icon restored). Startup and job errors
 * remain visible in the tab and are marked with an error badge.
 *
 * Monitoring is indefinite: no deadline, no polling. It stops collecting on
 * the first terminal signal - tab-side byte confirmation, modal
 * close, a second click on the armed tab (cancel), tab close, or
 * navigation away. Stopped monitoring never restarts itself, and a worker
 * restart (service-worker suspend / event-page unload) fails closed: the
 * memory-only armed set is gone, so observation is dead by construction.
 *
 * The scan, discovery, fetch, assembly, and save all live tab-side (the
 * modal iframe); format recognition stays the wasm core's job, never URL-text
 * guessing here.
 *
 * MV3 dual background: Chromium runs this file as a service worker, Firefox
 * as an MV3 event page. Classic script in both: shipped export-free (the
 * store packager strips `export` and gates on `node --check`), import-free
 * (no bundler). Top-level browser wiring is guarded so the file stays
 * loadable with no browser effects under node. No offscreen document:
 * offscreen is Chromium-only and unnecessary for an in-tab modal.
 *
 * Logging: structured console logs (`[dezoomify:background] <level> <code>
 * <detail>`) at debug/info/warn/error; debug is gated off by default via
 * `setBackgroundLogLevel("debug")`. User-visible state still travels via
 * the existing tab messages (rendered into the in-tab modal's visible log);
 * console is the diagnosis surface here since the worker has no DOM. Every
 * logged URL is redacted (userinfo, sensitive query values, fragments);
 * failures that previously vanished into empty catches now log at
 * debug/warn/error without changing behavior.
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

// tabId -> { confirmed, failed, url, injected } for armed monitors.
// `url` is the clicked-tab URL at arm time: the monitor survives its OWN
// reload (same page reported back by tabs.onUpdated) and stops only on
// navigation to a DIFFERENT page. `injected` gates the post-reload modal
// injection (exactly once). Memory only: never persisted, never restored,
// dropped when the context suspends/unloads (fail closed). URL collection
// lives in the injected tab (performance timeline, no permission needed);
// byte confirmation runs in the modal iframe (wasm + tab-origin fetch with
// cookies/auth) and reports back via `dezoomify-byte-confirmed`.
const armed = new Map();

// --- Structured background logging (console + tab-streamed UI) ---
//
// Levels: debug (per-URL/per-update noise, gated off by default), info
// (lifecycle milestones: armed, injected, confirmed, closed), warn
// (recoverable: privileged reject, cap reached, injection retry surface),
// error (terminal for this monitor: reload failed, injection failed).
// Console is the primary sink (service worker / event page have no DOM);
// user-visible state still travels via the existing tab messages
// (`dezoomify-monitor-update` / `dezoomify-stop-monitor`), which the in-tab
// modal renders into its visible log. Logging never changes behavior, never
// throws, never persists, and never carries raw URLs, credentials, cookies,
// or fragments: every URL goes through `redactBackgroundUrl` first.
// `export` is used only so node unit tests can load this file via a data:
// URL; `package-store.sh` strips the `export` prefix for the shipped classic
// script (same pattern as the content loader).

/** Log severity, lowest (debug) to highest (error). */
export const BACKGROUND_LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/** Query keys whose values must never appear in logs. Must stay identical
 * to SENSITIVE_QUERY_KEYS in runtime/candidates.ts. */
export const BACKGROUND_SENSITIVE_QUERY_KEYS = Object.freeze([
  "token",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "sid",
  "key",
  "apikey",
  "api_key",
  "secret",
  "password",
  "passwd",
  "code",
  "state",
  "sessiontoken",
]);

/** Max chars per logged detail line (bounded service-worker logging). */
export const BACKGROUND_LOG_MAX_CHARS = 500;

let backgroundLogLevel = BACKGROUND_LOG_LEVELS.info;
let backgroundLogSink = null;

/**
 * Redact a URL for logs: strip userinfo, redact sensitive query values,
 * drop fragments. Never returns raw credentials.
 * @param {unknown} raw
 * @returns {string}
 */
export function redactBackgroundUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "[empty-url]";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "[invalid-url]";
  }
  if (parsed.username || parsed.password) {
    parsed.username = "***";
    try {
      parsed.password = "";
    } catch {
      // ignore
    }
  }
  try {
    for (const key of [...parsed.searchParams.keys()]) {
      if (BACKGROUND_SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, "***");
      }
    }
  } catch {
    // keep the unredacted-query fallback below from leaking: bail out.
    return "[unredactable-url]";
  }
  if (parsed.hash && parsed.hash.length > 1) {
    parsed.hash = "";
  }
  return parsed.toString();
}

/**
 * Override the minimum level logged (`debug` enables per-URL noise).
 * @param {unknown} level one of `debug|info|warn|error` or numeric rank
 */
export function setBackgroundLogLevel(level) {
  if (typeof level === "string" && level in BACKGROUND_LOG_LEVELS) {
    backgroundLogLevel = BACKGROUND_LOG_LEVELS[level];
    return;
  }
  if (typeof level === "number" && Number.isFinite(level)) {
    backgroundLogLevel = level;
  }
}

/**
 * Override the log sink (tests). The sink receives `{ level, code, line }`.
 * Pass null to restore console logging.
 * @param {((entry: { level: string, code: string, line: string }) => void) | null} sink
 */
export function setBackgroundLogSink(sink) {
  backgroundLogSink = typeof sink === "function" ? sink : null;
}

function backgroundLogTarget(level) {
  if (backgroundLogSink) return { write: backgroundLogSink, console: false };
  try {
    const c = globalThis.console;
    if (!c || typeof c[level] !== "function") return null;
    return { write: null, console: true };
  } catch {
    return null;
  }
}

/**
 * Emit one structured background log line. Never throws, never logs raw
 * URLs: callers must redact before calling; this layer truncates only.
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} code stable machine code (`armed`, `reload-failed`, ...)
 * @param {string} [detail] already-redacted human detail
 */
export function backgroundLog(level, code, detail) {
  let rank = BACKGROUND_LOG_LEVELS.info;
  try {
    rank = BACKGROUND_LOG_LEVELS[level] ?? BACKGROUND_LOG_LEVELS.info;
    if (rank < backgroundLogLevel) return;
    const safeCode = typeof code === "string" && code ? code : "event";
    let text = typeof detail === "string" ? detail : detail === undefined ? "" : String(detail ?? "");
    if (text.length > BACKGROUND_LOG_MAX_CHARS) text = text.slice(0, BACKGROUND_LOG_MAX_CHARS) + "…";
    const line = "[dezoomify:background] " + level + " " + safeCode + (text ? " " + text : "");
    const target = backgroundLogTarget(level);
    if (!target) return;
    if (target.console) {
      const c = globalThis.console;
      try {
        c[level](line);
      } catch {
        // Logging must never break monitoring.
      }
      return;
    }
    try {
      target.write({ level, code: safeCode, line });
    } catch {
      // Logging must never break monitoring.
    }
  } catch {
    // Logging must never break monitoring.
  }
}

function isPrivilegedUrl(url) {
  return typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"));
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

function setArmedBadge(tabId, state) {
  const active = state === true || state === "error";
  const failed = state === "error";
  try {
    if (api.action && typeof api.action.setIcon === "function") {
      // MV3 returns a promise: a tab that is navigating or already gone
      // rejects with e.g. "Failed to fetch". Icon state is cosmetic only,
      // so swallow the rejection like sendToTab does (try/catch alone
      // cannot catch it: it surfaces as Uncaught (in promise)).
      const iconPending = api.action.setIcon({ tabId, path: active ? ACTIVE_ICON : IDLE_ICON });
      if (iconPending && typeof iconPending.catch === "function") {
        iconPending.catch((e) => {
          backgroundLog("debug", "icon-rejected", "tab " + tabId + " " + ((e && e.message) || e));
        });
      }
    }
    if (api.action && typeof api.action.setBadgeText === "function") {
      const badgePending = api.action.setBadgeText({ tabId, text: active ? (failed ? "!" : "•") : "" });
      if (badgePending && typeof badgePending.catch === "function") {
        badgePending.catch((e) => {
          backgroundLog("debug", "badge-rejected", "tab " + tabId + " " + ((e && e.message) || e));
        });
      }
    }
    if (api.action && typeof api.action.setTitle === "function") {
      const titlePending = api.action.setTitle({
        tabId,
        title: failed ? "Dezoomify: error (click to dismiss)" : "Dezoomify",
      });
      if (titlePending && typeof titlePending.catch === "function") {
        titlePending.catch((e) => {
          backgroundLog("debug", "title-rejected", "tab " + tabId + " " + ((e && e.message) || e));
        });
      }
    }
  } catch (e) {
    // Icon/badge state is cosmetic only; monitoring never depends on it.
    backgroundLog("debug", "icon-failed", "tab " + tabId + " " + ((e && e.message) || e));
  }
}

function sendToTab(tabId, message) {
  try {
    const pending = api.tabs.sendMessage(tabId, message);
    if (pending && typeof pending.catch === "function") {
      pending.catch((e) => {
        backgroundLog("debug", "send-to-tab-rejected", "tab " + tabId + " " + ((e && e.message) || e));
      });
    }
  } catch (e) {
    // The tab may already be gone; monitor state is unaffected.
    backgroundLog("debug", "send-to-tab-failed", "tab " + tabId + " " + ((e && e.message) || e));
  }
}

/**
 * Tell the fresh content script monitoring is armed. The loader seeds its
 * own candidates from the tab's performance timeline (no permission needed),
 * so this snapshot carries no URLs; it exists so the card can confirm the
 * background is still watching (protocol compat with the loader handshake).
 */
function reportUpdate(tabId) {
  sendToTab(tabId, { type: "dezoomify-monitor-update", seen: 0, urls: [] });
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

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  // No webRequest listener here, ever: without host permissions the
  // platform never delivers request events (activeTab does not enable
  // observation), so a background collector would be silently deaf in
  // production while passing every test that grants loopback hosts. The
  // injected tab collects its own candidates permission-free.

  api.action.onClicked.addListener(async (tab) => {
    const tabId = tab && tab.id;
    if (typeof tabId !== "number") {
      backgroundLog("debug", "click-ignored", "no tab id");
      return;
    }
    // Second click on the armed tab cancels monitoring (replace and cancel).
    if (disarm(tabId, true)) {
      backgroundLog("info", "cancelled", "tab " + tabId + " second click");
      return;
    }
    // Single-tab read for the privileged-URL guard only, never enumeration.
    let url = tab.url;
    try {
      if (typeof url !== "string" || !url) {
        const fresh = await api.tabs.get(tabId);
        url = fresh && fresh.url;
      }
    } catch (e) {
      // Keep the event URL; the guard below fails closed on unknown URLs.
      backgroundLog("debug", "tabs-get-failed", "tab " + tabId + " " + ((e && e.message) || e));
    }
    if (isPrivilegedUrl(url)) {
      backgroundLog("warn", "privileged-rejected", "tab " + tabId + " " + redactBackgroundUrl(url));
      setArmedBadge(tabId, false);
      return;
    }
    // Arm BEFORE the single reload; injection happens after the reload
    // completes (see the tabs.onUpdated handler): anything injected now
    // would be wiped by the reload.
    armed.set(tabId, { confirmed: false, failed: false, url, injected: false });
    backgroundLog("info", "armed", "tab " + tabId + " " + redactBackgroundUrl(url));
    setArmedBadge(tabId, true);
    try {
      // Exactly one reload of exactly that tab.
      await api.tabs.reload(tabId);
      backgroundLog("debug", "reloaded", "tab " + tabId);
    } catch (e) {
      // Keep a visible error state so a failed reload is not an unexplained
      // blue-to-grey transition. A second click still dismisses it.
      backgroundLog("error", "reload-failed", "tab " + tabId + " " + ((e && e.message) || e));
      const entry = armed.get(tabId);
      if (entry) {
        entry.failed = true;
        setArmedBadge(tabId, "error");
      }
    }
  });

  // Tab close drops a known armed id only; never enumerates tabs.
  api.tabs.onRemoved.addListener((tabId) => {
    if (disarm(tabId, false)) {
      backgroundLog("info", "tab-closed", "tab " + tabId);
    }
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
      backgroundLog("info", "navigated-away", "tab " + tabId);
      return;
    }
    if (changeInfo && changeInfo.status === "complete" && !entry.injected) {
      entry.injected = true;
      backgroundLog("debug", "reload-complete", "tab " + tabId + " injecting modal");
      injectModal(tabId).then(() => {
        // Confirm to the fresh content script that monitoring is armed; it
        // seeds its own candidates from the tab timeline.
        backgroundLog("info", "injected", "tab " + tabId);
        reportUpdate(tabId);
      }, (e) => {
        // Keep the failure visible in the action state; a second click
        // dismisses it instead of silently returning to idle.
        backgroundLog("error", "injection-failed", "tab " + tabId + " " + ((e && e.message) || e));
        const failedEntry = armed.get(tabId);
        if (failedEntry) {
          failedEntry.failed = true;
          setArmedBadge(tabId, "error");
        }
      });
    }
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!message || typeof message.type !== "string" || typeof tabId !== "number") return;
    if (message.type === "dezoomify-byte-confirmed") {
      // Tab-side DiscoverySession confirmed an image from bytes. The job
      // takes over in the tab; keep the blue badge until the modal closes.
      const entry = armed.get(tabId);
      if (entry) entry.confirmed = true;
      backgroundLog("info", "byte-confirmed", "tab " + tabId);
      try {
        sendResponse({ confirmed: true });
      } catch (e) {
        // The sender may be gone; state is already updated.
        backgroundLog("debug", "respond-failed", "tab " + tabId + " " + ((e && e.message) || e));
      }
      return true;
    }
    if (message.type === "dezoomify-modal-closed") {
      // Modal close disposes the monitor and restores the grey icon.
      disarm(tabId, false);
      backgroundLog("info", "modal-closed", "tab " + tabId);
      try {
        sendResponse({ stopped: true });
      } catch (e) {
        // The sender may be gone; state is already updated.
        backgroundLog("debug", "respond-failed", "tab " + tabId + " " + ((e && e.message) || e));
      }
      return true;
    }
    if (message.type === "dezoomify-modal-failed") {
      const entry = armed.get(tabId);
      if (entry) {
        entry.failed = true;
        setArmedBadge(tabId, "error");
      }
      backgroundLog("error", "modal-failed", "tab " + tabId + " " + String(message.code || "job-failed"));
      try {
        sendResponse({ failed: true });
      } catch (e) {
        backgroundLog("debug", "respond-failed", "tab " + tabId + " " + ((e && e.message) || e));
      }
      return;
    }
  });

}

// Guarded wiring: a real browser namespace wires listeners on load; node
// imports get the pure collectors above with no browser effects (`api` is
// undefined without a browser namespace, so `wire()` never runs there).
try {
  if (typeof api !== "undefined" && api && api.action && api.action.onClicked) {
    wire();
  }
} catch (e) {
  // Wiring must never throw (node imports, hostile contexts).
  backgroundLog("error", "wire-failed", String((e && e.message) || e));
}
