/**
 * Finite active-tab reload scan state machine (Phase 12).
 *
 * States: idle -> arming -> reloading -> observing -> settling -> stopped.
 *
 * Rules enforced here:
 * - Only explicit `startScan()` leaves `idle`. Extension-page open/focus/
 *   reconnect/restart never reloads or rearms (see `handleExtensionPageEvent`
 *   and `handleWorkerRestart`).
 * - The active tab is queried via injected `queryActiveTab`.
 * - Privileged URLs (chrome://, about:, file://, plus sibling schemes) are
 *   rejected before any observer/reload.
 * - The webRequest observer filtered by exact `tabId` is installed BEFORE
 *   the single reload.
 * - Exactly one reload per scan. Quiet-settle timer + hard deadline are
 *   injected via `scheduler` so tests use fake timers.
 * - Every terminal path removes all listeners and timers.
 *
 * This file intentionally uses only standard JavaScript plus JSDoc so it can
 * be loaded by Node unit tests without a build step. No browser globals are
 * touched directly; all effects go through injected dependencies.
 *
 * @typedef {"idle"|"arming"|"reloading"|"observing"|"settling"|"stopped"} ScanState
 * @typedef {{ id: number, url: string }} ActiveTab
 * @typedef {(tabId: number, url: string) => void} RequestHandler
 */

/** Ordered states, exported for tests. */
export const SCANNER_STATES = Object.freeze([
  "idle",
  "arming",
  "reloading",
  "observing",
  "settling",
  "stopped",
]);

/** Default timing budgets (ms). Overridable per scan. */
export const DEFAULT_QUIET_MS = 1500;
export const DEFAULT_DEADLINE_MS = 20000;
export const DEFAULT_FINALIZE_MS = 50;

/** Privileged schemes that must never be scanned. */
export const PRIVILEGED_SCHEMES = Object.freeze([
  "chrome:",
  "chrome-extension:",
  "about:",
  "file:",
  "edge:",
  "opera:",
  "brave:",
  "moz-extension:",
  "safari-extension:",
  "view-source:",
  "devtools:",
]);

/**
 * Return true when the URL must not be scanned.
 * @param {string} url
 * @returns {boolean}
 */
export function isPrivilegedUrl(url) {
  if (typeof url !== "string" || url.length === 0) return true;
  const lower = url.trim().toLowerCase();
  for (const scheme of PRIVILEGED_SCHEMES) {
    if (lower.startsWith(scheme)) return true;
  }
  // Only http/https are scannable; every other scheme is privileged/unsupported.
  if (lower.startsWith("http://") || lower.startsWith("https://")) return false;
  return true;
}

/**
 * Create a finite scanner with injected browser effects.
 *
 * @param {{
 *   queryActiveTab: () => Promise<ActiveTab>,
 *   addWebRequestListener: (handler: RequestHandler, tabId: number) => void,
 *   removeWebRequestListener: (handler: RequestHandler) => void,
 *   reloadTab: (tabId: number) => Promise<void> | void,
 *   scheduler?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} deps
 */
export function createScanner(deps) {
  const scheduler = deps.scheduler ?? { setTimeout, clearTimeout };
  /** @type {ScanState} */
  let state = "idle";
  /** @type {ActiveTab | null} */
  let activeTab = null;
  /** @type {string|null} */
  let stopReason = null;
  /** @type {number} */
  let reloadCount = 0;
  /** @type {boolean} */
  let observerInstalledBeforeReload = false;
  /** @type {number} */
  let observedForActiveTab = 0;
  /** @type {number} */
  let observedForOtherTab = 0;
  /** @type {any} */
  let quietTimer = null;
  /** @type {any} */
  let deadlineTimer = null;
  /** @type {any} */
  let finalizeTimer = null;
  /** @type {boolean} */
  let webRequestAttached = false;
  /** @type {number} */
  let quietMs = DEFAULT_QUIET_MS;
  /** @type {number} */
  let deadlineMs = DEFAULT_DEADLINE_MS;
  /** @type {number} */
  let finalizeMs = DEFAULT_FINALIZE_MS;
  /** @type {number} */
  let generation = 0;

  /** @type {RequestHandler} */
  const internalHandler = (tabId, url) => {
    handleRequest(tabId, url);
  };

  function clearTimer(handle) {
    if (handle !== null && handle !== undefined) {
      try {
        scheduler.clearTimeout(handle);
      } catch {
        // ignore double-clear in fake schedulers
      }
    }
  }

  function clearAllTimers() {
    clearTimer(quietTimer);
    clearTimer(deadlineTimer);
    clearTimer(finalizeTimer);
    quietTimer = null;
    deadlineTimer = null;
    finalizeTimer = null;
  }

  function detachListeners() {
    if (webRequestAttached) {
      try {
        deps.removeWebRequestListener(internalHandler);
      } catch {
        // ignore
      }
      webRequestAttached = false;
    }
  }

  function armQuietTimer() {
    clearTimer(quietTimer);
    quietTimer = scheduler.setTimeout(onQuietTimeout, quietMs);
  }

  function onQuietTimeout() {
    if (state !== "observing") return;
    state = "settling";
    clearTimer(quietTimer);
    quietTimer = null;
    clearTimer(finalizeTimer);
    finalizeTimer = scheduler.setTimeout(() => {
      terminate("settled");
    }, finalizeMs);
  }

  function onDeadline() {
    if (state === "idle" || state === "stopped") return;
    terminate("deadline");
  }

  /**
   * Move to terminal `stopped`, removing every listener/timer first.
   * @param {string} reason
   */
  function terminate(reason) {
    detachListeners();
    clearAllTimers();
    state = "stopped";
    stopReason = reason;
  }

  /**
   * Start a scan. Only an explicit extension action may call it.
   * Allowed from `idle` (first scan) or `stopped` (re-click starts a new
   * generation). A re-click while a scan is active replaces it: the old
   * generation is terminated with cleanup first ("replaced").
   * @param {{ quietMs?: number, deadlineMs?: number, finalizeMs?: number }} [opts]
   */
  async function startScan(opts = {}) {
    if (state !== "idle" && state !== "stopped") {
      // Replacement: explicit re-click supersedes the active generation.
      terminate("replaced");
    }
    // Reset per-scan evidence for the new generation (generation stays cumulative).
    detachListeners();
    clearAllTimers();
    activeTab = null;
    stopReason = null;
    reloadCount = 0;
    observerInstalledBeforeReload = false;
    observedForActiveTab = 0;
    observedForOtherTab = 0;
    quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    finalizeMs = opts.finalizeMs ?? DEFAULT_FINALIZE_MS;

    state = "arming";
    generation += 1;
    const tab = await deps.queryActiveTab();
    if (!tab || typeof tab.id !== "number" || typeof tab.url !== "string") {
      terminate("no-active-tab");
      throw Object.assign(new Error("no active tab"), { code: "no-active-tab" });
    }
    if (isPrivilegedUrl(tab.url)) {
      terminate("privileged-url");
      throw Object.assign(new Error(`privileged URL rejected: ${tab.url}`), {
        code: "privileged-url",
      });
    }
    activeTab = tab;
    // Install the exact-tabId observer BEFORE reload (ordering is asserted).
    deps.addWebRequestListener(internalHandler, tab.id);
    webRequestAttached = true;
    observerInstalledBeforeReload = true;
    // Finite hard deadline starts at arm.
    clearTimer(deadlineTimer);
    deadlineTimer = scheduler.setTimeout(onDeadline, deadlineMs);
    // Exactly one reload of exactly that tab.
    await deps.reloadTab(tab.id);
    reloadCount += 1;
    if (state === "arming") {
      state = "reloading";
      // Quiet-settle timer arms after reload; re-armed on completion/activity.
      armQuietTimer();
    }
    return { generation, tabId: tab.id, url: tab.url };
  }

  /**
   * Called when the reloaded tab finishes loading (or first activity).
   * Moves reloading -> observing.
   */
  function notifyReloadComplete() {
    if (state !== "reloading") return false;
    state = "observing";
    armQuietTimer();
    return true;
  }

  /**
   * Route an observed request. Only the exact active tabId counts.
   * @param {number} tabId
   * @param {string} _url
   */
  function handleRequest(tabId, _url) {
    if (state !== "reloading" && state !== "observing") return false;
    if (activeTab && tabId === activeTab.id) {
      observedForActiveTab += 1;
      if (state === "reloading") {
        state = "observing";
      }
      armQuietTimer();
      return true;
    }
    observedForOtherTab += 1;
    return false;
  }

  /**
   * Tab closed during a scan: stop without opening results.
   * @param {number} tabId
   */
  function handleTabRemoved(tabId) {
    if (state === "idle" || state === "stopped") return false;
    if (activeTab && tabId === activeTab.id) {
      terminate("tab-closed");
      return true;
    }
    return false;
  }

  /**
   * Tab navigated away during a scan: stop (no stale results).
   * @param {number} tabId
   */
  function handleTabUpdated(tabId) {
    if (state === "idle" || state === "stopped") return false;
    if (activeTab && tabId === activeTab.id) {
      terminate("tab-navigated");
      return true;
    }
    return false;
  }

  /**
   * Extension-page open/focus/reconnect/navigation. Must never reload/rearm.
   * @param {string} _kind e.g. "open"|"focus"|"reconnect"|"navigate"
   */
  function handleExtensionPageEvent(_kind) {
    return { reloaded: false, rearmed: false, state };
  }

  /**
   * Worker restart: fail closed to idle with no observers attached.
   * Never restores monitoring automatically.
   */
  function handleWorkerRestart() {
    detachListeners();
    clearAllTimers();
    state = "idle";
    activeTab = null;
    stopReason = null;
    // reloadCount/ordering flags are per-scan evidence; reset for next scan.
    reloadCount = 0;
    observerInstalledBeforeReload = false;
    observedForActiveTab = 0;
    observedForOtherTab = 0;
    return { state, reloaded: false, rearmed: false };
  }

  /** Terminal cleanup (also used by tests). */
  function dispose(reason = "disposed") {
    if (state === "stopped") return getSnapshot();
    if (state === "idle") {
      detachListeners();
      clearAllTimers();
      return getSnapshot();
    }
    terminate(reason);
    return getSnapshot();
  }

  function getListenerCounts() {
    let timers = 0;
    if (quietTimer !== null) timers += 1;
    if (deadlineTimer !== null) timers += 1;
    if (finalizeTimer !== null) timers += 1;
    return {
      webRequest: webRequestAttached ? 1 : 0,
      tab: webRequestAttached ? 1 : 0,
      timers,
    };
  }

  function getSnapshot() {
    return {
      state,
      stopReason,
      tabId: activeTab ? activeTab.id : null,
      reloadCount,
      observerInstalledBeforeReload,
      observedForActiveTab,
      observedForOtherTab,
      listeners: getListenerCounts(),
      generation,
    };
  }

  return {
    getState: () => state,
    getStopReason: () => stopReason,
    getActiveTab: () => activeTab,
    getListenerCounts,
    getSnapshot,
    startScan,
    notifyReloadComplete,
    handleRequest,
    handleTabRemoved,
    handleTabUpdated,
    handleExtensionPageEvent,
    handleWorkerRestart,
    dispose,
    // Test-only hooks (not browser effects):
    _onQuietTimeout: onQuietTimeout,
    _onDeadline: onDeadline,
  };
}
