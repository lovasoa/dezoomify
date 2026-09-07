/**
 * Click-to-monitor detection pipeline (background library).
 *
 * Stages: URL collection -> wasm rank -> confirm -> detected event.
 *
 * - Collection: the background observes webRequest URLs while a monitor is
 *   armed on exactly one tab (explicit toolbar click only). Records are
 *   `{ url }` in memory, first-seen order, first-window cap; format
 *   recognition is never guessed from URL text here.
 * - Rank: one `rankCandidates` batch over the core registry (URL text only,
 *   no fetching, no bytes). Falls back to first-seen order when the wasm
 *   export is missing (same pattern as `rankUrls` in `page/page.ts`).
 * - Confirm: lightweight only (generation + exact-tab correlation, proxy
 *   re-check, current-window membership). Full `DiscoverySession` byte
 *   confirmation is deferred to tab-context/modal: the background service
 *   worker has no DOM and must not run a second permission model, and the
 *   modal already fetches with tab-origin authority.
 * - Detected event: `{ candidateUrl, format, tabId, generation }` delivered
 *   to `onDetected`; the generation mark correlates with the reload
 *   generation marker (`content/reload-marker.ts`), and stale-tab results
 *   are dropped (never emitted).
 *
 * Boundaries: core stays pure; wasm only adapts core/job (`rankCandidates`
 *   takes URL text and returns try-order, nothing else). This module never
 *   fetches, never touches the metadata CORS proxy (proxy URLs are rejected
 *   with `proxy-forbidden`, mirroring `page/fetch.ts`), never persists
 *   (memory only), and never logs raw URLs or credentials: logs and labels
 *   go through the redacted mirror of `redactUrlForLabel`.
 *
 * Import-free classic-compatible plain JavaScript + JSDoc (no TypeScript-only
 * syntax): unit tests load it via a data: URL and the file stays loadable
 * without a build step. `export` is used only for tests; mirrors of
 * `page/candidates.ts`, `page/redaction.ts`, and `page/fetch.ts` constants
 * are asserted identical by `tests/unit/detect.test.mjs`.
 *
 * @typedef {{ url: string }} DetectionCandidate
 * @typedef {{ url: string, format?: string | null }} RankedDetectionCandidate
 * @typedef {{ candidateUrl: string, format: string | null, tabId: number, generation: number }} DetectedEvent
 */

/** Max URL length kept (mirrors `MAX_URL_LENGTH` in page/candidates.ts). */
export const MAX_URL_LENGTH = 2048;

/** First-window cap for indefinite collection (mirrors `MAX_CANDIDATES`). */
export const MAX_CANDIDATES = 100;

/** Proxy path rejected everywhere (mirrors `PROXY_PATH` in page/fetch.ts). */
export const PROXY_PATH = "/api/proxy";

/** Query keys whose values must never appear in labels/logs.
 *  Must stay identical to SENSITIVE_QUERY_KEYS in page/candidates.ts and
 *  page/redaction.ts (tested). */
export const SENSITIVE_QUERY_KEYS = Object.freeze([
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

/**
 * Redact a URL for labels/logs: strip userinfo, redact sensitive query
 * values, drop fragments. Mirrors `redactUrlForLabel` (tested identical).
 * @param {string} url
 * @returns {string}
 */
export function redactUrlForLabel(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "[invalid-url]";
  }
  if (parsed.username || parsed.password) {
    parsed.username = "***";
    parsed.password = "";
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) {
      parsed.searchParams.set(key, "***");
    }
  }
  // Never leak fragments that look like tokens.
  if (parsed.hash && parsed.hash.length > 1) {
    parsed.hash = "";
  }
  return parsed.toString();
}

/**
 * @param {string} url
 * @returns {boolean} true when the URL targets the metadata CORS proxy
 * (mirrors `isProxyUrl` in page/fetch.ts; the extension never uses it).
 */
export function isProxyUrl(url) {
  return typeof url === "string" && url.includes(PROXY_PATH);
}

/**
 * Validate a raw observed URL for detection collection.
 * @param {unknown} raw
 * @returns {{ ok: boolean, code?: string }}
 */
export function validateDetectionUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "empty" };
  }
  if (raw.length > MAX_URL_LENGTH) return { ok: false, code: "too-long" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "unsupported-scheme" };
  }
  if (isProxyUrl(raw)) return { ok: false, code: "proxy-forbidden" };
  return { ok: true };
}

/**
 * Rank observed URLs in one core batch (`rankCandidates` over the core
 * registry: known formats first in builtin order, unknowns last with
 * `format: null`, never dropped). Falls back to first-seen order when the
 * wasm export is missing, throws, or returns a malformed shape (same
 * pattern as `rankUrls` in `page/page.ts`).
 * @param {string[]} urls first-seen ordered observed URLs
 * @param {{ rankCandidates?: (urlsJson: string) => string }} [wasmExports]
 * @returns {RankedDetectionCandidate[]}
 */
export function rankDetectionUrls(urls, wasmExports) {
  const list = Array.isArray(urls) ? urls : [];
  const fallback = () => list.map((url) => ({ url, format: null }));
  const rankFn = wasmExports ? wasmExports.rankCandidates : undefined;
  if (typeof rankFn !== "function") return fallback();
  try {
    const ranked = JSON.parse(rankFn.call(wasmExports, JSON.stringify(list)));
    if (Array.isArray(ranked) && ranked.every((entry) => entry && typeof entry.url === "string")) {
      return ranked;
    }
  } catch {
    // Fall through to first-seen order below.
  }
  return fallback();
}

/**
 * Generation mark for one monitor generation. Compatible with the reload
 * generation marker (`content/reload-marker.ts`: `[a-zA-Z0-9-]{1,64}`) so
 * the tab-context/modal can correlate a detected event with the reload
 * that produced its candidates.
 * @param {number} generation
 * @returns {string}
 */
export function generationMarkFor(generation) {
  return "gen-" + String(generation);
}

/**
 * Create an indefinite click-to-monitor detection pipeline with injected
 * host effects (wasm export, event sink, log sink) for deterministic tests.
 *
 * Only `startMonitoring` (explicit toolbar click) arms collection on
 * exactly one tab. Ranking is explicit via `rankNow` (the host batches on
 * its own cadence); every terminal signal stops with cleanup and drops
 * stale results.
 *
 * @param {{
 *   wasmExports?: { rankCandidates?: (urlsJson: string) => string },
 *   rankBatch?: (urls: string[]) => RankedDetectionCandidate[] | Promise<RankedDetectionCandidate[]>,
 *   onDetected?: (event: DetectedEvent) => void,
 *   log?: (line: string) => void,
 * }} [deps]
 */
export function createDetectionMonitor(deps = {}) {
  /** @type {Map<string, DetectionCandidate>} first-seen window */
  const byUrl = new Map();
  /** @type {number | null} */
  let tabId = null;
  /** @type {number} */
  let generation = 0;
  /** @type {"idle" | "monitoring" | "stopped"} */
  let state = "idle";
  /** @type {string | null} */
  let stopReason = null;

  /**
   * @param {string} line already-redacted log line (never raw URLs)
   */
  function logLine(line) {
    try {
      if (deps && typeof deps.log === "function") deps.log(line);
    } catch {
      // Logging must never break monitoring.
    }
  }

  /**
   * Arm monitoring on exactly the clicked tab. Explicit action only.
   * @param {number} nextTabId
   * @returns {{ tabId: number, generation: number, generationMark: string }}
   */
  function startMonitoring(nextTabId) {
    if (!Number.isInteger(nextTabId)) throw new Error("bad tab id");
    byUrl.clear();
    stopReason = null;
    tabId = nextTabId;
    generation += 1;
    state = "monitoring";
    const generationMark = generationMarkFor(generation);
    logLine("monitoring tab " + tabId + " " + generationMark);
    return { tabId, generation, generationMark };
  }

  /**
   * Collect one observed request URL. Only the exact armed tab counts;
   * first-seen wins, the first window of MAX_CANDIDATES is kept, overflow
   * is rejected (never evicts: deterministic for the core rank batch).
   * @param {number} observedTabId
   * @param {string} url
   * @returns {boolean} true when the URL was collected
   */
  function handleRequest(observedTabId, url) {
    if (state !== "monitoring" || tabId === null) return false;
    if (observedTabId !== tabId) return false;
    if (!validateDetectionUrl(url).ok) return false;
    if (byUrl.has(url)) return false;
    if (byUrl.size >= MAX_CANDIDATES) return false;
    byUrl.set(url, { url });
    return true;
  }

  /**
   * Rank the collected window and confirm the top candidate, then emit
   * the detected event. Confirm is lightweight: the candidate must still
   * belong to the current window, pass validation (proxy re-check), and
   * match the exact tab + generation seen at batch start; a generation
   * bump, stop, or tab switch while the batch was in flight drops the
   * whole batch as stale (no event, no stale-tab results). Unknown formats
   * (`format: null`) still emit: dropping them would lose candidates the
   * tab-context byte confirmation (`DiscoverySession`) could still find.
   * @returns {Promise<DetectedEvent | null>}
   */
  async function rankNow() {
    if (state !== "monitoring" || tabId === null) return null;
    const seenGeneration = generation;
    const seenTabId = tabId;
    const urls = [...byUrl.keys()];
    if (urls.length === 0) return null;
    /** @type {RankedDetectionCandidate[] | null} */
    let ranked = null;
    try {
      if (deps && typeof deps.rankBatch === "function") {
        const out = await deps.rankBatch(urls);
        ranked = Array.isArray(out) ? out : null;
      } else {
        ranked = rankDetectionUrls(urls, deps ? deps.wasmExports : undefined);
      }
    } catch {
      ranked = null;
    }
    if (ranked === null) {
      ranked = urls.map((url) => ({ url, format: null }));
    }
    // Confirm: stale generation/tab invalidates the whole batch.
    if (state !== "monitoring" || generation !== seenGeneration || tabId !== seenTabId) {
      logLine("dropped stale rank batch for tab " + seenTabId + " " + generationMarkFor(seenGeneration));
      return null;
    }
    for (const entry of ranked) {
      if (!entry || typeof entry.url !== "string") continue;
      if (!byUrl.has(entry.url)) continue;
      if (!validateDetectionUrl(entry.url).ok) continue;
      const format = typeof entry.format === "string" ? entry.format : null;
      /** @type {DetectedEvent} */
      const event = { candidateUrl: entry.url, format, tabId: seenTabId, generation: seenGeneration };
      try {
        if (deps && typeof deps.onDetected === "function") deps.onDetected(event);
      } catch {
        // A listener must never break monitoring.
      }
      logLine(
        "detected " + redactUrlForLabel(entry.url) +
          (format ? " (" + format + ")" : "") +
          " tab " + seenTabId + " " + generationMarkFor(seenGeneration),
      );
      return event;
    }
    return null;
  }

  /**
   * @param {number} closedTabId
   * @returns {boolean} true when the armed tab closed (stopped, no results)
   */
  function handleTabRemoved(closedTabId) {
    if (state !== "monitoring" || tabId === null) return false;
    if (closedTabId !== tabId) return false;
    stop("tab-closed");
    return true;
  }

  /**
   * @param {number} navigatedTabId
   * @returns {boolean} true when the armed tab navigated away (stopped, no stale results)
   */
  function handleTabUpdated(navigatedTabId) {
    if (state !== "monitoring" || tabId === null) return false;
    if (navigatedTabId !== tabId) return false;
    stop("tab-navigated");
    return true;
  }

  /**
   * Stop monitoring with cleanup (memory cleared: service-worker bounded).
   * @param {string} [reason]
   */
  function stop(reason = "stopped") {
    byUrl.clear();
    tabId = null;
    stopReason = reason;
    state = "stopped";
  }

  /** Terminal cleanup (also used by tests). */
  function dispose(reason = "disposed") {
    if (state === "monitoring") stop(reason);
    return getSnapshot();
  }

  /**
   * Correlate a stored reload generation mark with the armed generation
   * (the tab-context/modal reads the mark via `readReloadMark` and passes
   * it here with the detected event's generation).
   * @param {unknown} mark
   * @returns {boolean}
   */
  function correlateReloadMark(mark) {
    return state === "monitoring" && typeof mark === "string" && mark === generationMarkFor(generation);
  }

  /** Redacted labels only (never raw URLs): safe for modal/badge surfaces. */
  function labels() {
    return [...byUrl.keys()].map((url) => redactUrlForLabel(url));
  }

  /** First-seen ordered raw URLs (memory only, for the rank batch). */
  function urls() {
    return [...byUrl.keys()];
  }

  function getSnapshot() {
    return {
      state,
      tabId,
      generation,
      generationMark: generationMarkFor(generation),
      size: byUrl.size,
      stopReason,
    };
  }

  return {
    startMonitoring,
    handleRequest,
    rankNow,
    handleTabRemoved,
    handleTabUpdated,
    correlateReloadMark,
    labels,
    urls,
    stop,
    dispose,
    getSnapshot,
    getState: () => state,
  };
}
