// Web application entry point (single source of truth; `./main.js` is
// generated from this file by `scripts/sync-web-js.mjs`, never hand-edited).
// Real pipeline: worker-hosted wasm core discovery -> direct-first transport
// with automatic eligible metadata-proxy fallback -> tile acquisition -> canvas
// assembly -> real PNG save. Nothing here fabricates progress or completion.
import { createController } from "../packages/shared-ui/src/controller.ts";
import {
  HISTORY_KEY_WEBSITE,
  clearHistory as clearHistoryStore,
  loadHistory as loadHistoryStore,
  pushHistory,
  saveHistory as saveHistoryStore,
  toHistoryEntry,
} from "../packages/shared-ui/src/history.ts";
import type { HistoryEntry } from "../packages/shared-ui/src/history.ts";
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../packages/shared-ui/src/view.ts";
import type { ViewContext } from "../packages/shared-ui/src/view.ts";
import { suggestedNameFor } from "../packages/shared-ui/src/saveName.ts";
import {
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
  classifyReadableBytes,
  discoveryFailedError,
} from "./discovery.ts";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.ts";
import { errorTransportFor, isOrdinaryImageTile, isProxyEligible } from "./webIntegration.ts";
import { createProxyTransport, PROXY_METADATA_MAX_BYTES } from "./proxyTransport.ts";
import {
  createDiscoveryClient,
  failure,
  type DiscoveryClient,
  type PlanTile,
  type WebCatalog,
} from "../packages/browser-runtime/src/session.ts";
import { probeLimits, safeArea } from "../packages/browser-runtime/src/limits.ts";
import type { BrowserLimits } from "../packages/browser-runtime/src/types.ts";
import {
  cancelAllWeb,
  createWebQueue,
  enqueueWebQueue,
  finishActiveWebEntry,
  isWebQueueAvailable,
  summarizeWebQueue,
} from "../packages/browser-runtime/src/queue.ts";
import {
  createPreviewControls,
} from "../packages/browser-runtime/src/preview.ts";
import {
  PREVIEW_MAX_SCALE,
  PREVIEW_MIN_SCALE,
  PREVIEW_ZOOM_STEP,
  clampPreviewScale,
} from "../packages/browser-runtime/src/preview.ts";

// Re-export the shared browser limits plus the preview transform helpers for
// existing website test imports (`test/pick-level.test.mjs` and
// `test/preview.test.mjs` import from `src/main.ts`).
export {
  PREVIEW_MAX_SCALE,
  PREVIEW_MIN_SCALE,
  PREVIEW_ZOOM_STEP,
  clampPreviewScale,
};

const preview = createPreviewControls();

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;
let activeTransport: string | null = null;
let client: DiscoveryClient | null = null;
let jobToken = 0;
let resultBlobUrl: string | null = null;
// Pause v1 (todo 5.7, suspend-acquisition): the website stops scheduling new
// tiles while paused, finishes in-flight work, retains the canvas, and
// re-drives on resume. Integration-layer only; the engine pause lives in
// `dezoomify-job` for native hosts.
let jobPaused = false;

// Recent-jobs history (todo 5.2): local-only ledger, newest first, at most
// 20 entries. Each entry keeps its full source address.
const memoryHistoryFallback = new Map<string, string>();
const webHistoryStore = {
  getItem(key: string): string | null {
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
        return localStorage.getItem(key);
      }
    } catch {
      // Storage unavailable; fall through to the memory fallback.
    }
    return memoryHistoryFallback.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
        localStorage.setItem(key, value);
        return;
      }
    } catch {
      // Storage unavailable; fall through to the memory fallback.
    }
    memoryHistoryFallback.set(key, value);
  },
  removeItem(key: string): void {
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.removeItem === "function") {
        localStorage.removeItem(key);
      }
    } catch {
      // Removal must never throw.
    }
    memoryHistoryFallback.delete(key);
  },
};
let webHistory: Array<HistoryEntry> = loadHistoryStore(webHistoryStore, HISTORY_KEY_WEBSITE);

function recordWebHistory(url: string, width: number, height: number, format: string): void {
  const entry = toHistoryEntry(url, { width, height, format, at: Date.now() });
  if (!entry) return;
  webHistory = pushHistory(webHistory, entry);
  saveHistoryStore(webHistoryStore, HISTORY_KEY_WEBSITE, webHistory);
  viewCtx.history = [...webHistory];
}

// Website single-queue (todo 5.3): enqueue while a job runs, sequential. The
// engine stays single-job; this queue lives in the integration layer (here),
// never in the engine. One active job at a time; further submits wait FIFO.
// A failed entry never stops the rest. Hash writes stay active-only: only the
// running job owns `window.location.hash`, queued URLs never do.
let webQueue = createWebQueue();
// Negotiated queue availability: the website baseline offers the queue
// (`bulk_supported` true); an N-1 peer without it falls back to the legacy
// cancel-previous behavior.
const WEB_QUEUE_CAPS = { bulkSupported: true };
function webQueueEnabled(): boolean {
  return isWebQueueAvailable(WEB_QUEUE_CAPS);
}

/** Per-request timeout applied to every individual HTTP request (30 s). */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Largest canvas a browser tab can hold (16384 x 16384, legacy
 * MAX_CANVAS_AREA parity). Level picking never plans above this: gigapixel
 * services (e.g. the 2-gigapixel deepest WMTS matrix of global imagery)
 * would otherwise exhaust worker memory while serializing trillions of
 * tiles and trap the engine. The pre-plan declared-size check below fails
 * fast without calling `client.plan`; the post-plan canvas check enforces
 * the same bound (via `probeLimits`) for levels without declared sizes.
 */
export const BROWSER_MAX_CANVAS_AREA = 268435456;

/**
 * Browser canvas limits (todo 5.3, overflow-safe). `probeLimits` is the
 * single canvas check: pickLevel, the pre-plan declared-size gate, and the
 * post-plan canvas gate all call it instead of duplicating `width * height`
 * arithmetic (which overflows past MAX_SAFE_INTEGER for gigapixel sizes).
 * No policy widening: 16384 px per side with the legacy area bound.
 */
export const BROWSER_MAX_CANVAS_SIDE = 16384;
export const BROWSER_LIMITS: BrowserLimits = {
  maxWidth: BROWSER_MAX_CANVAS_SIDE,
  maxHeight: BROWSER_MAX_CANVAS_SIDE,
  maxArea: BROWSER_MAX_CANVAS_AREA,
  maxBytes: BROWSER_MAX_CANVAS_AREA * 4,
};

/**
 * Upper bound on tiles materialized into one website plan (todo 5.3).
 * Mirrors the wasm `MAX_PLAN_TILES` allocation guard: the worker rejects
 * larger plans with `limit-exceeded` before serializing them, and the
 * website's pre-plan estimate plus post-plan cap fail with the same
 * desktop-app guidance. Allocation protection only, not a canvas policy.
 */
export const BROWSER_MAX_PLAN_TILES = 100_000;

/** Desktop handoff link for images beyond the browser tab (`dezoomify://`).
 * Returns "" for non-http(s) sources (for example local `file:` URLs): the
 * desktop deep link only carries bounded http(s) input, so local files show
 * the local-only note instead of a broken link. */
export function desktopHandoffLink(sourceUrl: string): string {
  try {
    const u = new URL(String(sourceUrl ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  } catch {
    return "";
  }
  return `dezoomify://open?v=2&src=${encodeURIComponent(sourceUrl)}`;
}

/** True for `file:` URLs pasted into the website input. Local files stay on
 * this computer, so the failed view shows the local-only note (nothing is
 * sent) instead of a deep link. */
function isLocalFileUrl(urlString: string): boolean {
  try {
    return new URL(String(urlString ?? "").trim()).protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * Tile-count estimate for a declared size assuming 256 px tiles (todo 5.3).
 * 256 px is the smallest common tile, so the estimate is a conservative
 * upper bound: when it already exceeds `BROWSER_MAX_PLAN_TILES`, any real
 * tile size would still need the desktop app. Overflow-safe: returns null
 * for invalid sizes or when the multiply would exceed MAX_SAFE_INTEGER,
 * which callers treat as over-limit (fail fast, never plan).
 */
export function estimateTileCount(width: number, height: number, tileSide: number = 256): number | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (!Number.isInteger(tileSide) || tileSide <= 0) return null;
  const cols = Math.floor((width + tileSide - 1) / tileSide);
  const rows = Math.floor((height + tileSide - 1) / tileSide);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols <= 0 || rows <= 0) return null;
  if (cols > Number.MAX_SAFE_INTEGER / rows) return null;
  return cols * rows;
}

function canvasTooLargeFailure(width: number, height: number, sourceUrl: string, extra?: string) {
  const handoff = desktopHandoffLink(sourceUrl);
  const technical = extra
    ? `canvas ${width}x${height} exceeds the browser limit (${extra}); desktop handoff ${handoff}`
    : `canvas ${width}x${height} exceeds the browser limit; desktop handoff ${handoff}`;
  return failure(
    "PLAN_INVALID",
    "This image is too large for this browser tab. Use the desktop app for the full-size image.",
    false,
    `Open in the desktop app: ${handoff}`,
    technical,
  );
}

/**
 * Head-start window for the direct metadata fetch: if the site does not
 * answer within 1500 ms, the eligible metadata proxy takes over
 * automatically (first-wins: the loser is aborted via AbortController so
 * direct and proxy bytes never overlap). 250 ms proved too aggressive on
 * slow sites and caused false proxy fallback; 1500 ms keeps direct-first
 * while failing over promptly. Tiles keep the full 30 s timeout (they
 * never use the proxy).
 */
export const DIRECT_METADATA_TIMEOUT_MS = 1500;

/**
 * Tile politeness + resilience (todo 5.2) plus adaptive website concurrency
 * (todo 5.4). At most 5 tile request starts per second per host (legacy
 * ZoomManager.MAX_REQUESTS_PER_SECOND parity: 1000/5 ms spacing between
 * starts). The website pool below is adaptive 6-12 from hardwareConcurrency
 * plus RTT within the capability cap, never below the floor of 4; starts for
 * the same host are staggered through a per-host chain so the parallel
 * workers still cap at 5/s combined, they do not each get 5/s. Each tile
 * retries twice (3 attempts) with exponential backoff + jitter; the
 * exhausted failure still maps to TILE_FAILED (never a display string).
 * Native/CLI keep their own max_concurrent of 16 (protocol native baseline);
 * only the website path uses the adaptive 6-12 range.
 */
export const TILE_MAX_REQUESTS_PER_SECOND = 5;
export const TILE_MIN_INTERVAL_MS = 1000 / TILE_MAX_REQUESTS_PER_SECOND;
export const TILE_MAX_RETRIES = 2;
export const TILE_RETRY_BASE_MS = 250;

/**
 * Website tile concurrency bounds (todo 5.4). The adaptive range is 6-12;
 * 4 is the absolute floor for unknown or constrained hosts. The website cap
 * is 12; native/CLI stay at their own 16 and never read this cap.
 */
export const TILE_CONCURRENCY_FLOOR = 4;
export const TILE_CONCURRENCY_MIN = 6;
export const TILE_CONCURRENCY_MAX = 12;
export const TILE_CONCURRENCY_CAP = 12;
export const TILE_RTT_MEDIUM_MS = 400;
export const TILE_RTT_SLOW_MS = 800;

/**
 * Pure adaptive concurrency: base from core count, minus for slow RTT,
 * clamped to 6-12, then within the capability cap with a floor of 4.
 * Slow networks back off so extra workers do not pile onto timeouts.
 */
export function pickTileConcurrency(opts?: {
  hardwareConcurrency?: unknown;
  rttMs?: unknown;
  capabilityCap?: unknown;
}): number {
  let cap = TILE_CONCURRENCY_CAP;
  if (typeof opts?.capabilityCap === "number" && Number.isFinite(opts.capabilityCap as number)) {
    cap = Math.floor(opts.capabilityCap as number);
  }
  let cores = 4;
  if (
    typeof opts?.hardwareConcurrency === "number" &&
    Number.isFinite(opts.hardwareConcurrency as number)
  ) {
    cores = Math.floor(opts.hardwareConcurrency as number);
  }
  let base: number;
  if (cores <= 2) base = TILE_CONCURRENCY_MIN;
  else if (cores <= 4) base = 8;
  else if (cores <= 8) base = 10;
  else base = TILE_CONCURRENCY_MAX;
  const rtt = opts?.rttMs;
  if (typeof rtt === "number" && Number.isFinite(rtt)) {
    if (rtt >= TILE_RTT_SLOW_MS) base -= 2;
    else if (rtt >= TILE_RTT_MEDIUM_MS) base -= 1;
  }
  const clamped = Math.min(Math.max(base, TILE_CONCURRENCY_MIN), TILE_CONCURRENCY_MAX);
  return Math.max(TILE_CONCURRENCY_FLOOR, Math.min(clamped, cap));
}

/**
 * Website concurrency from host hints. hardwareConcurrency sizes the pool;
 * NetworkInformation.rtt (ms, when present) backs off slow links. Every read
 * is best-effort: unknown hosts get the deterministic default (4 cores, no
 * RTT), which still respects the floor.
 */
export function websiteTileConcurrency(): number {
  let cores = 4;
  let rtt: number | undefined;
  try {
    if (typeof navigator !== "undefined") {
      const nav = navigator as unknown as {
        hardwareConcurrency?: unknown;
        connection?: { rtt?: unknown };
      };
      if (typeof nav.hardwareConcurrency === "number" && Number.isFinite(nav.hardwareConcurrency)) {
        cores = Math.floor(nav.hardwareConcurrency);
      }
      const connRtt = nav.connection?.rtt;
      if (typeof connRtt === "number" && Number.isFinite(connRtt)) rtt = connRtt;
    }
  } catch {
    // Host globals are best-effort; defaults keep the floor.
  }
  return pickTileConcurrency({ hardwareConcurrency: cores, rttMs: rtt, capabilityCap: TILE_CONCURRENCY_CAP });
}

/**
 * Off-main-thread tile decode (todo 5.4). When Worker plus OffscreenCanvas
 * exist, createImageBitmap plus drawImage run in a singleton decode worker
 * (Blob URL, no extra file) and the ImageBitmap is transferred back; the
 * main thread only paints the finished bitmap. Otherwise this falls back to
 * main-thread createImageBitmap. Full transferControlToOffscreen drawing
 * stays out: it would break the ordinary <img> display-only fallback and the
 * canvas.toBlob save path, while decode offload already removes the costly
 * raster from the main thread.
 */
let tileDecodeWorker: Worker | null = null;
let tileDecodeSeq = 0;
let tileDecodeUnavailable = false;
const tileDecodePending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: unknown) => void }>();

function tileDecodeWorkerCode(): string {
  return (
    "self.onmessage = async (e) => {\n" +
    "  const data = e.data || {};\n" +
    "  const id = data.id;\n" +
    "  try {\n" +
    "    const bitmap = await createImageBitmap(new Blob([data.bytes]));\n" +
    "    let out = bitmap;\n" +
    "    try {\n" +
    '      if (typeof OffscreenCanvas !== "undefined") {\n' +
    "        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);\n" +
    '        const ctx = canvas.getContext("2d");\n' +
    "        if (ctx) {\n" +
    "          ctx.drawImage(bitmap, 0, 0);\n" +
    "          out = canvas.transferToImageBitmap();\n" +
    "          try { bitmap.close(); } catch (err) {}\n" +
    "        }\n" +
    "      }\n" +
    "    } catch (err) {}\n" +
    "    self.postMessage({ id, ok: true, bitmap: out }, [out]);\n" +
    "  } catch (err) {\n" +
    "    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });\n" +
    "  }\n" +
    "};\n"
  );
}

function getTileDecodeWorker(): Worker | null {
  if (tileDecodeUnavailable) return null;
  if (tileDecodeWorker) return tileDecodeWorker;
  try {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      tileDecodeUnavailable = true;
      return null;
    }
    if (typeof Blob === "undefined" || typeof URL === "undefined") {
      tileDecodeUnavailable = true;
      return null;
    }
    const createUrl = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    if (typeof createUrl !== "function") {
      tileDecodeUnavailable = true;
      return null;
    }
    const worker = new Worker(
      (createUrl as (b: Blob) => string).call(URL, new Blob([tileDecodeWorkerCode()], { type: "text/javascript" })),
    );
    worker.onmessage = (e: MessageEvent) => {
      const data = (e as MessageEvent & { data?: { id?: unknown; ok?: unknown; bitmap?: unknown; error?: unknown } }).data ?? {};
      const id = typeof data.id === "number" ? data.id : -1;
      const pending = tileDecodePending.get(id);
      if (!pending) return;
      tileDecodePending.delete(id);
      if (data.ok === true && data.bitmap) {
        pending.resolve(data.bitmap as ImageBitmap);
      } else {
        pending.reject(new Error(typeof data.error === "string" ? data.error : "tile decode failed"));
      }
    };
    worker.onerror = () => {
      tileDecodeUnavailable = true;
      for (const [, pending] of tileDecodePending) {
        try {
          pending.reject(new Error("tile decode worker failed"));
        } catch {
          // Rejecting must never throw.
        }
      }
      tileDecodePending.clear();
      try {
        worker.terminate();
      } catch {
        // Termination is best-effort.
      }
      tileDecodeWorker = null;
    };
    tileDecodeWorker = worker;
    return worker;
  } catch {
    tileDecodeUnavailable = true;
    return null;
  }
}

function decodeTileBitmap(bytes: ArrayBuffer): Promise<ImageBitmap> {
  const worker = getTileDecodeWorker();
  if (!worker) return createImageBitmap(new Blob([bytes]));
  try {
    const id = ++tileDecodeSeq;
    const copy = bytes.slice(0);
    const pending = new Promise<ImageBitmap>((resolve, reject) => {
      tileDecodePending.set(id, { resolve, reject });
    });
    try {
      worker.postMessage({ id, bytes: copy }, [copy]);
    } catch {
      tileDecodePending.delete(id);
      return createImageBitmap(new Blob([bytes]));
    }
    return pending.catch(() => createImageBitmap(new Blob([bytes])));
  } catch {
    return createImageBitmap(new Blob([bytes]));
  }
}

function tileHostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tileThrottleLast = new Map<string, number>();
const tileThrottleQueue = new Map<string, Promise<void>>();

/**
 * Stagger tile request starts per host to <=5/s. Chained per host so the
 * parallel workers share one spacing clock: each starter waits for the
 * previous starter for that host, enforces the 200 ms gap, then releases
 * the next waiter.
 */
function throttleTileStart(url: string): Promise<void> {
  const host = tileHostOf(url) || "global";
  const prev = tileThrottleQueue.get(host) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tileThrottleQueue.set(host, current);
  const run = (async () => {
    await prev;
    const now = Date.now();
    const last = tileThrottleLast.get(host) ?? 0;
    const wait = TILE_MIN_INTERVAL_MS - (now - last);
    if (wait > 0) await sleep(wait);
    tileThrottleLast.set(host, Date.now());
  })();
  return run.finally(release);
}

function tileRetryDelayMs(retryIndex: number): number {
  return TILE_RETRY_BASE_MS * Math.pow(2, retryIndex) + Math.random() * 100;
}

// --- Live job activity (drives the progressive-disclosure job view) ---
let requestSeq = 0;
const pendingStarts = new Map<number, { startedAt: number; label: string }>();
let completedRequests = 0;
let failedRequests = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let batchedUpdateQueued = false;
let lastHeartbeatKey = "";

/**
 * Coalesce burst progress into one paint per frame (todo 5.4): tile
 * completions call this instead of update(), so N tiles finishing in the
 * same frame render once. Falls back to a zero-delay timer where rAF is
 * unavailable (e.g. node test imports).
 */
function scheduleBatchedUpdate(): void {
  if (batchedUpdateQueued) return;
  batchedUpdateQueued = true;
  const flush = () => {
    batchedUpdateQueued = false;
    update();
  };
  try {
    if (typeof requestAnimationFrame !== "function") throw new Error("no-rAF");
    requestAnimationFrame(flush);
  } catch {
    setTimeout(flush, 0);
  }
}

/** Delta key for the heartbeat: only a real change schedules a paint. */
function heartbeatKey(): string {
  const a = viewCtx.jobActivity;
  if (!a) return "";
  const longest = typeof a.longestPendingMs === "number" ? Math.floor(a.longestPendingMs / 250) : 0;
  return `${pendingStarts.size}:${completedRequests}:${failedRequests}:${longest}:${Math.floor(Date.now() / 1000)}`;
}

function activity(): NonNullable<ViewContext["jobActivity"]> {
  if (!viewCtx.jobActivity) viewCtx.jobActivity = { timeoutMs: REQUEST_TIMEOUT_MS };
  return viewCtx.jobActivity as NonNullable<ViewContext["jobActivity"]>;
}

function resetActivity(url: string): void {
  pendingStarts.clear();
  completedRequests = 0;
  failedRequests = 0;
  const now = Date.now();
  viewCtx.jobActivity = {
    url,
    startedAt: now,
    now,
    stepLabel: "Finding the zoomable image…",
    detail: `Contacting ${hostOf(url)}…`,
    pendingRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    longestPendingMs: 0,
    timeoutMs: REQUEST_TIMEOUT_MS,
    lastProgressAt: now,
    log: [],
  };
}

function touchProgress(): void {
  activity().lastProgressAt = Date.now();
}

function setStep(label: string, detail?: string): void {
  const a = activity();
  a.stepLabel = label;
  if (detail !== undefined) a.detail = detail;
  touchProgress();
  update();
}

function pushLog(line: string): void {
  const a = activity();
  if (!a.log) a.log = [];
  const elapsed = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
  a.log.push(`${elapsed}s: ${line}`);
  if (a.log.length > 60) a.log.splice(0, a.log.length - 60);
}

function noteRequestStart(label: string): number {
  const id = ++requestSeq;
  pendingStarts.set(id, { startedAt: Date.now(), label });
  const a = activity();
  a.pendingRequests = pendingStarts.size;
  refreshLongestPending();
  return id;
}

function noteRequestEnd(id: number, ok: boolean): void {
  pendingStarts.delete(id);
  if (ok) completedRequests += 1;
  else failedRequests += 1;
  const a = activity();
  a.pendingRequests = pendingStarts.size;
  a.completedRequests = completedRequests;
  a.failedRequests = failedRequests;
  refreshLongestPending();
  touchProgress();
}

function refreshLongestPending(): void {
  const a = activity();
  const now = Date.now();
  a.now = now;
  let longest = 0;
  for (const { startedAt } of pendingStarts.values()) {
    longest = Math.max(longest, now - startedAt);
  }
  a.longestPendingMs = longest;
}

function startHeartbeat(): void {
  stopHeartbeat();
  lastHeartbeatKey = heartbeatKey();
  // 500 ms cadence refreshes the data, but the paint is delta-gated and
  // rAF-batched (todo 5.4): idle ticks with no change render nothing.
  heartbeatTimer = setInterval(() => {
    refreshLongestPending();
    const key = heartbeatKey();
    if (key === lastHeartbeatKey) return;
    lastHeartbeatKey = key;
    scheduleBatchedUpdate();
  }, 500);
  const t = heartbeatTimer as unknown as { unref?: () => void };
  if (t && typeof t.unref === "function") {
    try {
      t.unref();
    } catch {
      // browser timers lack unref
    }
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

interface TimeoutCombined {
  signal: AbortSignal;
  cleanup(): void;
  timedOut?: () => boolean;
}

/**
 * Combine a caller signal with the 30 s per-request timeout.
 * Uses AbortSignal.any/timeout when available, manual wiring otherwise.
 */
function timeoutSignal(parentSignal?: AbortSignal, ms: number = REQUEST_TIMEOUT_MS): TimeoutCombined {
  const AS = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof AbortSignal !== "undefined" && typeof AS.timeout === "function") {
    const timeout = (AS.timeout as (ms: number) => AbortSignal)(ms);
    if (parentSignal && typeof AS.any === "function") {
      return { signal: (AS.any as (s: AbortSignal[]) => AbortSignal)([parentSignal, timeout]), cleanup() {} };
    }
    if (!parentSignal) return { signal: timeout, cleanup() {} };
  }
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (parentSignal && onAbort) parentSignal.removeEventListener("abort", onAbort);
  };
  if (parentSignal?.aborted) {
    ctrl.abort((parentSignal as AbortSignal & { reason?: unknown }).reason);
    return { signal: ctrl.signal, cleanup() {}, timedOut: () => false };
  }
  let timedOut = false;
  timer = setTimeout(() => {
    timedOut = true;
    try {
      ctrl.abort(new DOMException(`Request timed out after ${ms / 1000}s`, "TimeoutError"));
    } catch {
      ctrl.abort();
    }
  }, ms);
  if (parentSignal) {
    onAbort = () => {
      cleanup();
      try {
        ctrl.abort((parentSignal as AbortSignal & { reason?: unknown }).reason);
      } catch {
        ctrl.abort();
      }
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, cleanup, timedOut: () => timedOut };
}

function nextEvent(kind: string, extra: Record<string, unknown> = {}) {
  currentSeq++;
  return { seq: currentSeq, sessionId, kind, ...extra };
}

function isAllowedSourceUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface DirectOutcome {
  outcome: "readable" | "http-error" | "network-error" | "cancelled";
  finalUrl?: string;
  status?: number;
  bytes?: ArrayBuffer;
  contentType?: string;
}

async function fetchDirect(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  ms: number = REQUEST_TIMEOUT_MS,
): Promise<DirectOutcome> {
  const reqId = noteRequestStart("direct");
  const combined = timeoutSignal(signal, ms);
  try {
    const res = await fetch(url, { headers, signal: combined.signal, credentials: "omit" });
    if (!res.ok) {
      noteRequestEnd(reqId, false);
      return { outcome: "http-error", finalUrl: res.url, status: res.status };
    }
    const bytes = await res.arrayBuffer();
    noteRequestEnd(reqId, true);
    let contentType: string | undefined;
    try {
      const ct = res.headers?.get?.("content-type");
      if (typeof ct === "string" && ct !== "") contentType = ct;
    } catch {
      // A missing/unreadable header must never break the readable path.
    }
    return { outcome: "readable", finalUrl: res.url, status: res.status, bytes, ...(contentType ? { contentType } : {}) };
  } catch (e) {
    noteRequestEnd(reqId, false);
    if (signal?.aborted) return { outcome: "cancelled" };
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || (combined.timedOut && combined.timedOut())) {
      pushLog(`Direct fetch did not complete within ${ms} ms: ${shortUrl(url)}`);
      return { outcome: "network-error" };
    }
    return { outcome: "network-error" };
  } finally {
    combined.cleanup();
    update();
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? `…${u.pathname.slice(-39)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return String(url).slice(0, 60);
  }
}

/** Hostname of a job's website, for plain-language progress messages. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}

// Shared metadata-proxy client (single policy implementation; the inline
// duplicate is gone). Pre-checks credential-bearing targets, cancellation,
// and the response-size budget; status codes map to stable machine-readable
// codes. Request timing instrumentation stays here so the live job view
// keeps counting proxy attempts.
const proxyTransport = createProxyTransport(
  (input: string, init?: Record<string, unknown>) =>
    fetch(input, init as RequestInit).then((res) => ({
      status: res.status,
      headers: res.headers,
      arrayBuffer: () => res.arrayBuffer(),
    })),
  { protocolVersion: 1, maxBytes: PROXY_METADATA_MAX_BYTES },
);

/**
 * Delay before a single retry after PROXY_RATE_LIMITED (todo 5.1). Honors
 * the relay's Retry-After hint when present (parsed by the transport as
 * retryAfterMs), otherwise backs off 1 s. Returns null when the hint
 * exceeds the UX budget: fail fast with extension/desktop guidance
 * instead of stalling the job on a long throttle.
 */
const PROXY_RATE_LIMIT_RETRY_BASE_MS = 1000;
const PROXY_RATE_LIMIT_RETRY_MAX_MS = 5000;

function proxyRateLimitDelayMs(retryAfterMs?: number): number | null {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
    if (retryAfterMs <= 0) return 0;
    if (retryAfterMs > PROXY_RATE_LIMIT_RETRY_MAX_MS) return null;
    return Math.min(Math.floor(retryAfterMs), PROXY_RATE_LIMIT_RETRY_MAX_MS);
  }
  return PROXY_RATE_LIMIT_RETRY_BASE_MS;
}

async function fetchViaProxy(
  targetUrl: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; bytes?: ArrayBuffer; code?: string; reason?: string; finalUrl?: string; retryAfterMs?: number }> {
  const reqId = noteRequestStart("proxy");
  const combined = timeoutSignal(signal);
  try {
    const res = await proxyTransport.fetchViaProxy(targetUrl, { signal: combined.signal });
    if (!res.ok) {
      noteRequestEnd(reqId, false);
      return {
        ok: false,
        status: res.status,
        code: res.code ?? "PROXY_ERROR",
        ...((res as { reason?: unknown }).reason !== undefined && typeof (res as { reason?: unknown }).reason === "string" && ((res as { reason?: string }).reason as string) !== "" ? { reason: (res as { reason?: string }).reason as string } : {}),
        ...(typeof res.retryAfterMs === "number" ? { retryAfterMs: res.retryAfterMs } : {}),
      };
    }
    noteRequestEnd(reqId, true);
    // The relay follows upstream redirects internally; surface the
    // post-redirect URL when the transport provides it, otherwise fall back
    // to the requested URL downstream. Never leave the base empty: an empty
    // final URI makes relative tile URLs (e.g. krpano
    // galleria_04.tiles/mres_d/...) resolve against the app page (/beta/)
    // and 404.
    const upstream = typeof (res as { finalUrl?: unknown }).finalUrl === "string" &&
        ((res as { finalUrl?: string }).finalUrl as string) !== ""
      ? ((res as { finalUrl?: string }).finalUrl as string)
      : targetUrl;
    return { ok: true, status: res.status, bytes: res.bytes, finalUrl: upstream };
  } catch (e) {
    noteRequestEnd(reqId, false);
    if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    if (((e as { name?: string })?.name === "TimeoutError") || (combined.timedOut && combined.timedOut())) {
      pushLog("Metadata proxy request timed out after 30 s.");
      return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
    }
    return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
  } finally {
    combined.cleanup();
    update();
  }
}

const DIRECT_LABEL = "Direct from your browser";
const PROXY_LABEL = "Metadata proxy";

/**
 * Plain words for a relay policy `reason` (mirrors
 * `classifyProxyFailure` in `packages/browser-runtime/src/web-fetch.ts`;
 * the two stay in sync because the website ships its own fetcher rather
 * than the runtime module).
 */
function proxyPolicyReasonText(reason?: string): string | null {
  switch (reason) {
    case "invalid-url":
    case "scheme":
    case "userinfo":
    case "signed-query":
    case "non-standard-port":
    case "protocol-version":
    case "malformed-body":
    case "method":
      return "Check the address and try again.";
    case "loopback-host":
    case "private-host":
    case "blocked-ipv4":
    case "blocked-ipv6":
    case "dns-rebinding":
    case "dns-rebinding-v6":
      return "The website cannot open private or local addresses.";
    case "content-type":
      return "The site answered with a file type the website does not check here.";
    case "redirect-limit":
    case "redirect-target":
    case "origin":
      return "The site redirected in a way the website cannot follow.";
    default:
      return null;
  }
}

/**
 * Classify a failed proxy result. Our policy denial and an upstream HTTP
 * refusal never share a message or a retryable flag: retrying a 403 from
 * the viewed site never helps, while a 502 might.
 */
function classifyProxyFailure(
  proxied: { status: number; code?: string; reason?: string },
  target: string,
): { code: string; message: string; retryable: boolean; technical: string } {
  const code = proxied.code ?? "PROXY_ERROR";
  const status = proxied.status || 0;
  const reasonSuffix =
    typeof proxied.reason === "string" && proxied.reason !== "" ? `, reason=${proxied.reason}` : "";
  const technical = `metadata proxy: ${code} (HTTP ${status}${reasonSuffix}) fetching ${target}`;
  if (code === "PROXY_POLICY_DENIED") {
    const hint = proxyPolicyReasonText(proxied.reason) ?? "Check the address and try again.";
    return {
      code: "TRANSPORT_POLICY_DENIED",
      message:
        `This address cannot be opened through the website. ${hint} ` +
        "The browser extension or the desktop app may still work.",
      retryable: false,
      technical,
    };
  }
  if (code === "PROXY_BUDGET_EXCEEDED") {
    return {
      code: "PROXY_BUDGET_EXCEEDED",
      message: "This page is too large to check here. Try the desktop app for very large images.",
      retryable: false,
      technical,
    };
  }
  if (code === "TRANSPORT_HTTP_ERROR" || status === 401 || status === 403) {
    if (status === 404) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message: "This page could not be found. Check the address and try again.",
        retryable: false,
        technical,
      };
    }
    if (status === 401 || status === 403) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message:
          `The site refused to share this file (HTTP ${status}). It may block shared servers; ` +
          "the browser extension or the desktop app may still work.",
        retryable: false,
        technical,
      };
    }
    if (status >= 500 && status <= 599) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message: "The site had a problem opening this page. Try again shortly.",
        retryable: true,
        technical,
      };
    }
    if (status >= 400 && status <= 499) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message: "This page could not be opened. Check the address and try again.",
        retryable: false,
        technical,
      };
    }
  }
  if (code === "TRANSPORT_NETWORK_ERROR" || code === "PROXY_NETWORK_ERROR" || code === "PROXY_ERROR") {
    return {
      code: "PROXY_ERROR",
      message: "The metadata proxy could not fetch this address. Try again shortly.",
      retryable: true,
      technical,
    };
  }
  return { code, message: "The metadata proxy could not fetch this address. Try again shortly.", retryable: status >= 500 || status === 0, technical };
}

/**
 * Fetch one metadata resource for discovery: direct first with a 1500 ms
 * head start, then the eligible metadata proxy after a classified network
 * failure (first-wins: the loser is aborted via AbortController so direct
 * and proxy bytes never overlap). Every readable payload is forwarded to
 * the WASM core, which is the single authority for discovery (it follows
 * secondary resources such as info.json, tour.xml, or tile-info XML). The
 * substring classifier below is a UI hint only and never gates: a head
 * without literals must still reach the core (extension parity, which tries
 * ranked candidates directly), while a generic page still ends as
 * NO_IMAGE_FOUND from the engine.
 *
 * Eligibility stays owned here by the web app (isProxyEligible on a
 * metadata request); integrations execute the supplied transport effects.
 * Tiles never use the proxy. A transient PROXY_RATE_LIMITED retries once
 * after Retry-After/backoff; a persistent throttle fails fast with
 * extension/desktop guidance.
 *
 * Every thrown failure carries two layers: `message` (a plain, actionable
 * sentence for the UI) and `technical` (transport, HTTP status, proxy code,
 * trimmed URL) which the engine feeds into its per-candidate diagnostics and
 * the technical-details section. The two never mix.
 */
async function fetchMetadataFor(
  url: string,
  headers: Record<string, string>,
): Promise<{ bytes: ArrayBuffer; finalUri?: string; via: string }> {
  const target = shortUrl(url);
  activeTransport = DIRECT_LABEL;
  // AbortController dedupe: the direct loser is aborted before the proxy
  // starts so the two transports never overlap on the same resource.
  const directCtrl = new AbortController();
  const direct = await fetchDirect(url, headers, directCtrl.signal, DIRECT_METADATA_TIMEOUT_MS);
  let via = "direct";
  let bytes: ArrayBuffer | null = null;
  let contentType: string | undefined;
  // Post-redirect base for relative tile URLs. Direct fetches report
  // res.url; proxied fetches must fall back to the requested URL (the relay
  // follows redirects internally without exposing the upstream final URL).
  // Leaving this empty reproduces the krpano regression where
  // galleria_04.tiles/* resolved against /beta/ and every tile 404'd.
  let finalUri: string = url;
  if (direct.outcome === "readable" && direct.bytes) {
    bytes = direct.bytes;
    if (typeof direct.finalUrl === "string" && direct.finalUrl !== "") finalUri = direct.finalUrl;
    if (typeof direct.contentType === "string" && direct.contentType !== "") contentType = direct.contentType;
  } else if (
    direct.outcome === "network-error" &&
    isProxyEligible({ url, kind: "metadata", headers }).eligible
  ) {
    try {
      directCtrl.abort();
    } catch {
      // Abort is idempotent when the head-start timeout already fired; it
      // must never break the automatic proxy fallback.
    }
    activeTransport = PROXY_LABEL;
    via = "proxy";
    let proxied = await fetchViaProxy(url);
    // Retry-After + backoff: one bounded retry converts a transient
    // token-bucket 429 into success. A persistent throttle, or a
    // Retry-After beyond the UX budget, still fails fast below with the
    // extension/desktop guidance (never tiles, never wider eligibility).
    if (!proxied.ok && proxied.code === "PROXY_RATE_LIMITED") {
      const delay = proxyRateLimitDelayMs(proxied.retryAfterMs);
      if (delay !== null) {
        pushLog(`Metadata proxy rate-limited; retrying once after ${delay} ms.`);
        await sleep(delay);
        proxied = await fetchViaProxy(url);
      }
    }
    if (!proxied.ok || !proxied.bytes) {
      if (proxied.code === "PROXY_RATE_LIMITED") {
        throw failure(
          "UPSTREAM_RATE_LIMITED",
          RATE_LIMITED_BY_SITE_MESSAGE,
          true,
          undefined,
          `metadata proxy: upstream rate limit (HTTP 429, PROXY_RATE_LIMITED) fetching ${target}`,
        );
      }
      const classified = classifyProxyFailure(proxied, target);
      throw failure(classified.code, classified.message, classified.retryable, undefined, classified.technical);
    }
    bytes = proxied.bytes;
    if (typeof proxied.finalUrl === "string" && proxied.finalUrl !== "") finalUri = proxied.finalUrl;
  } else if (direct.outcome === "http-error") {
    if (direct.status === 429) {
      // A direct fetch uses the user's own connection, so this throttle is on
      // their IP, not on our server; the fix is waiting, not another app.
      throw failure(
        "UPSTREAM_RATE_LIMITED",
        SITE_BUSY_MESSAGE,
        true,
        undefined,
        `direct fetch: HTTP 429 Too Many Requests from ${target}`,
      );
    }
    throw failure(
      "DISCOVERY_HTTP_ERROR",
      "This page could not be opened. Check the address and try again.",
      false,
      undefined,
      `direct fetch: HTTP ${direct.status} from ${target}`,
    );
  } else {
    throw failure(
      "DISCOVERY_FAILED",
      discoveryFailedError(via).message,
      true,
      undefined,
      `direct fetch: no readable response (network error or blocked read) fetching ${target}`,
    );
  }
  // WASM core is authoritative: always forward readable bytes so formats
  // whose first head carries no zoomable literal (GAC/tour/info.json reached
  // via secondary resources) still resolve. The classifier is a UI hint only.
  const hint = classifyReadableBytes(bytes, { via, contentType });
  if (!hint.found) {
    pushLog(`content hint: no zoomable marker in first bytes (${via}); running full discovery…`);
  }
  return { bytes, finalUri, via };
}

async function fetchTileFor(url: string, headers: Record<string, string>): Promise<{ bytes: ArrayBuffer }> {
  let lastOutcome = "network-error";
  let lastStatus: number | undefined;
  for (let attempt = 0; ; attempt++) {
    await throttleTileStart(url);
    const direct = await fetchDirect(url, headers);
    if (direct.outcome === "readable" && direct.bytes) {
      return { bytes: direct.bytes };
    }
    lastOutcome = direct.outcome;
    lastStatus = direct.status;
    if (direct.outcome === "cancelled" || attempt >= TILE_MAX_RETRIES) {
      break;
    }
    await sleep(tileRetryDelayMs(attempt));
  }
  throw failure(
    "TILE_FAILED",
    "Part of the image could not be saved. Try again in a moment.",
    true,
    undefined,
    `tile fetch: ${lastOutcome} (HTTP ${lastStatus ?? "n/a"}) from ${shortUrl(url)} after ${TILE_MAX_RETRIES + 1} attempts`,
  );
}

async function probeSizeFor(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; width: number; height: number }> {
  try {
    const { bytes } = await fetchTileFor(url, headers);
    const bitmap = await decodeTileBitmap(bytes);
    const size = { ok: bitmap.width > 0 && bitmap.height > 0, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    // Readable bytes are unavailable (e.g. no CORS grant). Probing only
    // needs dimensions, which a plain <img> reports without byte access.
    try {
      const img = await loadTileImage(url);
      return { ok: img.naturalWidth > 0 && img.naturalHeight > 0, width: img.naturalWidth, height: img.naturalHeight };
    } catch {
      return { ok: false, width: 0, height: 0 };
    }
  }
}

/**
 * Load one tile as an ordinary image element: visible, but with no byte
 * access. Deliberately leaves the CORS opt-in unset, so no CORS grant is
 * needed; drawing the result taints the canvas (legacy ZoomManager.addTile
 * parity). The caller must treat a tainted canvas as display-only: no pixel
 * reads, no toBlob/toDataURL, no programmatic save.
 */
function loadTileImage(url: string, ms: number = REQUEST_TIMEOUT_MS): Promise<HTMLImageElement> {
  const reqId = noteRequestStart("img");
  return new Promise((resolve, reject) => {
    const img = new Image();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (ok: boolean, value: HTMLImageElement | Error) => {
      if (timer) clearTimeout(timer);
      timer = null;
      noteRequestEnd(reqId, ok);
      update();
      if (ok) resolve(value as HTMLImageElement);
      else reject(value);
    };
    img.addEventListener("load", () => done(true, img), { once: true });
    img.addEventListener(
      "error",
      () => done(false, new Error(`tile image failed to load: ${shortUrl(url)}`)),
      { once: true },
    );
    timer = setTimeout(() => {
      try {
        img.src = "";
      } catch {
        // Cancelling a hung load must never throw.
      }
      done(false, new Error(`tile image timed out after ${ms / 1000}s: ${shortUrl(url)}`));
    }, ms);
    // Don't tell the tile host the request comes from dezoomify (legacy parity).
    img.referrerPolicy = "no-referrer";
    img.src = url;
  });
}

function setCanvasVisible(visible: boolean): void {
  if (typeof document === "undefined") return;
  try {
    const wrapper = document.getElementById("canvas-wrapper");
    if (wrapper) wrapper.style.display = visible ? "" : "none";
    const controls = document.getElementById("preview-controls");
    if (controls && "hidden" in controls) (controls as { hidden: boolean }).hidden = !visible;
    if (!visible) {
      try {
        preview.resetTransform(document);
      } catch {
        // Preview reset must never break the job.
      }
    }
  } catch {
    // Canvas visibility must never break the job.
  }
}

/** Stable error classification derived from the code, never from text. */
function categoryFor(code: string): string {
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code === "INVALID_URL") return "validation";
  if (code.startsWith("OUTPUT_")) return "output";
  if (code === "WORKER_FAILED" || code === "PLAN_INVALID") return "internal";
  return "transport";
}

function phaseFor(code: string): string {
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.startsWith("OUTPUT_")) return "output";
  return "acquisition";
}

function disposeClient(): void {
  client?.dispose();
  client = null;
}

function reportProgress(current: number, total: number, message: string): void {
  viewCtx.currentProgress = { current, total, message };
  touchProgress();
  scheduleBatchedUpdate();
}

function writeHash(url: string): void {
  if (typeof window === "undefined" || !window.location) return;
  try {
    // Legacy contract: the hash body IS the target URL (`#https://…`).
    window.location.hash = buildHash(url);
  } catch {
    // Hash writes must never break the job.
  }
}

function clearHash(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.history && typeof window.history.replaceState === "function") {
      const clean = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, "", clean);
    } else {
      window.location.hash = "";
    }
  } catch {
    // Hash cleanup must never break reset.
  }
}

function makeClient(): DiscoveryClient {
  disposeClient();
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return createDiscoveryClient({
    worker,
    fetchMetadata: fetchMetadataFor,
    fetchTile: fetchTileFor,
    probeSize: probeSizeFor,
  });
}

interface PickedLevel {
  index: number;
}

/**
 * Largest declared level that fits the browser canvas wins (overflow-safe
 * via `probeLimits`; same 16384-px / area bound, no policy widening).
 * Levels without a declared size keep the old behavior (last wins): their
 * size is only known after probing, so the pre-plan estimate cannot run
 * and the post-plan `probeLimits` + tile-count cap enforces the bound.
 * When declared levels exist but none fits, the smallest declared level is
 * returned so the pre-plan gate fails fast with desktop-app guidance
 * instead of planning a gigapixel level that exhausts worker memory.
 */
export function pickLevel(image: { levels: Array<{ index: number; imageSize?: { x: number; y: number } }> }): PickedLevel {
  let best: PickedLevel | null = null;
  let bestArea = -1;
  let smallest: PickedLevel | null = null;
  let smallestArea = Number.POSITIVE_INFINITY;
  let sawDeclared = false;
  let lastUndeclared: PickedLevel | null = null;
  for (const level of image.levels) {
    const size = level.imageSize;
    if (!size) {
      lastUndeclared = { index: level.index };
      continue;
    }
    sawDeclared = true;
    const fits = probeLimits({ width: size.x, height: size.y }, BROWSER_LIMITS).verdict === "ok";
    const area = safeArea(size.x, size.y) ?? Number.POSITIVE_INFINITY;
    if (fits && area >= bestArea) {
      best = { index: level.index };
      bestArea = area;
    }
    if (area < smallestArea) {
      smallest = { index: level.index };
      smallestArea = area;
    }
  }
  if (best) return best;
  if (sawDeclared) return smallest ?? { index: 0 };
  return lastUndeclared ?? { index: 0 };
}

// Encrypted-tile processing (e.g. Google Arts & Culture XOR-free AES
// container) goes through the single-pending worker client. Tile fetches
// run concurrently, so processing calls are serialized here: fetching stays
// parallel, only the short decrypt step queues.
let processQueue: Promise<unknown> = Promise.resolve();

function enqueueProcess(client2: DiscoveryClient, recipe: string, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const run = processQueue.then(() => client2.process(recipe, bytes));
  processQueue = run.catch(() => undefined);
  return run;
}

/**
 * Draw one planned tile. Returns true when the tile was painted through
 * ordinary image display (canvas now tainted, display-only); false when it
 * arrived as readable bytes (canvas stays clean).
 *
 * Readable bytes come first so CORS-granting sites keep the clean save.
 * After the readable retries are exhausted, an unprocessed tile falls back
 * to a plain <img> (no CORS needed): the user sees the picture and can
 * right-click it, but scripts can no longer read or save the canvas.
 * Processed tiles rethrow: decrypt/re-encode needs readable bytes.
 * When the <img> also fails, the original readable failure (with its
 * technical chain) is what the job reports.
 */
async function drawTile(
  client2: DiscoveryClient,
  ctx2d: CanvasRenderingContext2D,
  tile: PlanTile,
): Promise<boolean> {
  const drawBitmap = async (source: ImageBitmap | HTMLImageElement): Promise<void> => {
    const fullW = source instanceof ImageBitmap ? source.width : source.naturalWidth;
    const fullH = source instanceof ImageBitmap ? source.height : source.naturalHeight;
    // Trust the plan for placement: the canvas layout must stay seamless even
    // when a tile decodes at an unexpected size. Log the mismatch and scale
    // the decoded bytes to the planned extent so no gap appears.
    const planW = tile.w ?? fullW;
    const planH = tile.h ?? fullH;
    if (planW !== fullW || planH !== fullH) {
      pushLog(
        `tile size mismatch at ${tile.x},${tile.y}: plan ${planW}x${planH}, decoded ${fullW}x${fullH} from ${shortUrl(tile.uri)}`,
      );
    }
    if (planW > 0 && planH > 0 && fullW > 0 && fullH > 0) {
      ctx2d.drawImage(source, 0, 0, fullW, fullH, tile.x, tile.y, planW, planH);
    }
  };
  let readableFailure: unknown = null;
  try {
    let { bytes } = await fetchTileFor(tile.uri, tile.headers ?? {});
    if (tile.processing && tile.processing !== "none") {
      bytes = await enqueueProcess(client2, tile.processing, bytes);
    }
    const bitmap = await decodeTileBitmap(bytes);
    try {
      await drawBitmap(bitmap);
    } finally {
      bitmap.close();
    }
    return false;
  } catch (error) {
    readableFailure = error;
  }
  if (!isOrdinaryImageTile(tile.processing)) throw readableFailure;
  try {
    await throttleTileStart(tile.uri);
    const img = await loadTileImage(tile.uri);
    await drawBitmap(img);
    return true;
  } catch {
    throw readableFailure;
  }
}

async function runJob(url: string): Promise<void> {
  const token = ++jobToken;
  resetActivity(url);
  setCanvasVisible(false);
  jobPaused = false;
  viewCtx.paused = false;
  viewCtx.imageChoice = undefined;
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.sourceUrl = undefined;
  viewCtx.desktopHandoffUrl = undefined;
  // Hash owns the active job only: queued URLs never touch the hash until
  // they become active and reach this point.
  writeHash(url);
  let queueOutcome: "done" | "failed" | "cancelled" = "done";
  startHeartbeat();
  setStep("Finding the zoomable image…", `Contacting ${hostOf(url)}…`);
  controller.dispatch(nextEvent("start-discovery", { transport: "direct" }) as never);
  update();
  try {
    client = makeClient();
    pushLog(`Starting discovery for ${shortUrl(url)}`);
    const catalog: WebCatalog = await client.start(url);
    if (token !== jobToken) return;
    pushLog(`Found ${catalog.images.length} image${catalog.images.length === 1 ? "" : "s"}`);
    const image = catalog.images[0];
    const via = activeTransport === PROXY_LABEL ? "proxy" : "direct";
    controller.dispatch(
      nextEvent("images-found", { imageCount: catalog.images.length, transport: via }) as never,
    );
    const foundNoun = catalog.images.length === 1 ? "1 image" : `${catalog.images.length} images`;
    setStep(
      `Found ${foundNoun}, saving largest that fits…`,
      "The website saves the first image automatically; use the desktop app to choose another.",
    );
    controller.dispatch(nextEvent("image-chosen") as never);
    const level = pickLevel(image);
    // Pre-plan gate (todo 5.3): declared sizes fail fast with a desktop
    // handoff link without calling `client.plan`, so the worker never
    // serializes a trillion-tile plan. Undeclared sizes skip this gate
    // (probe-driven; size is known only after probing) and rely on the
    // worker `limit-exceeded` guard plus the post-plan `probeLimits` and
    // tile-count caps below.
    const pickedSize = image.levels.find((entry) => entry.index === level.index)?.imageSize;
    if (pickedSize) {
      if (probeLimits({ width: pickedSize.x, height: pickedSize.y }, BROWSER_LIMITS).verdict !== "ok") {
        throw canvasTooLargeFailure(pickedSize.x, pickedSize.y, url);
      }
      const estimate = estimateTileCount(pickedSize.x, pickedSize.y);
      if (estimate === null || estimate > BROWSER_MAX_PLAN_TILES) {
        throw canvasTooLargeFailure(
          pickedSize.x,
          pickedSize.y,
          url,
          estimate === null
            ? "tile-count estimate overflow"
            : `estimated ${estimate} tiles exceeds the ${BROWSER_MAX_PLAN_TILES}-tile browser plan limit`,
        );
      }
    }
    setStep("Choosing the highest resolution…");
    controller.dispatch(nextEvent("level-chosen") as never);
    setStep("Checking the image size…");
    controller.dispatch(nextEvent("preflight-ok", { transport: via }) as never);
    update();

    let plan;
    try {
      plan = await client.plan(image.id, level.index);
    } catch (error) {
      // Worker allocation guard (wasm MAX_PLAN_TILES) surfaces as the stable
      // `limit-exceeded` code inside the detail string; map that stable code
      // (never UI copy) to the same desktop handoff so probe-driven huge
      // levels fail as PLAN_INVALID instead of generic WORKER_FAILED.
      const structured = error as { code?: string; detail?: string; technical?: string };
      const hay = `${structured?.code ?? ""} ${structured?.detail ?? ""} ${structured?.technical ?? ""}`;
      if (hay.includes("limit-exceeded")) {
        throw canvasTooLargeFailure(pickedSize?.x ?? 0, pickedSize?.y ?? 0, url, "tile plan exceeds the browser plan limit");
      }
      throw error;
    }
    if (token !== jobToken) return;
    pushLog(`Image size determined; planning ${plan.tiles.length} tiles`);
    const canvas = document.getElementById("rendering-canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      throw failure(
        "WORKER_FAILED",
        "The picture could not be assembled in this browser. Try reloading the page.",
        false,
        undefined,
        "no #rendering-canvas element in the document",
      );
    }
    const width = plan.canvas ? plan.canvas.x : 0;
    const height = plan.canvas ? plan.canvas.y : 0;
    if (!(width > 0 && height > 0)) {
      throw failure(
        "PLAN_INVALID",
        "The image size could not be determined.",
        false,
        undefined,
        `invalid tile plan: canvas ${width}x${height}`,
      );
    }
    if (probeLimits({ width, height }, BROWSER_LIMITS).verdict !== "ok") {
      throw canvasTooLargeFailure(width, height, url);
    }
    if (plan.tiles.length > BROWSER_MAX_PLAN_TILES) {
      throw canvasTooLargeFailure(
        width,
        height,
        url,
        `${plan.tiles.length} tiles exceeds the ${BROWSER_MAX_PLAN_TILES}-tile browser plan limit`,
      );
    }
    canvas.width = width;
    canvas.height = height;
    try {
      preview.resetTransform(document);
    } catch {
      // Preview reset must never break the job.
    }
    const ctx2d = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx2d.clearRect(0, 0, width, height);
    // Reveal the canvas before the first tile paints (legacy parity): tiles
    // assemble visibly as they arrive, and the picture stays right-clickable
    // throughout acquisition, whichever finish follows.
    setCanvasVisible(true);
    preview.resetTransform(document);

    const total = plan.tiles.length;
    viewCtx.imageChoice = { width, height, tiles: total };
    setStep("Saving image tiles…", `${total} tiles at full resolution`);
    reportProgress(0, total, `Saving ${total} tiles…`);
    let done = 0;
    let failed: unknown = null;
    let tainted = false;
    const queue = [...plan.tiles];
    const tileWorker = async (): Promise<void> => {
      while (queue.length && !failed) {
        // Pause v1: suspend scheduling new tiles while paused; in-flight
        // `drawTile` calls finish, the canvas is retained, and resume
        // re-drives the same FIFO queue.
        while (jobPaused) {
          if (token !== jobToken) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (failed) return;
        }
        if (token !== jobToken) return;
        const tile = queue.shift();
        if (!tile) return;
        try {
          const tileTainted = await drawTile(client as DiscoveryClient, ctx2d, tile);
          if (tileTainted) tainted = true;
        } catch (error) {
          failed = error;
          return;
        }
        if (token !== jobToken) return;
        done += 1;
        reportProgress(done, total, `Saving ${total} tiles…`);
      }
    };
    const concurrency = Math.min(websiteTileConcurrency(), Math.max(1, total));
    await Promise.all(Array.from({ length: concurrency }, tileWorker));
    if (failed) throw failed;
    if (token !== jobToken) return;

    if (tainted) {
      // Tiles without a readable grant painted through ordinary <img>
      // display: the canvas is tainted, so scripts can neither read nor
      // save it. Show the assembled picture with its display-only guidance
      // instead of failing; the user right-clicks where the browser
      // supports it, or uses the extension/desktop app for a clean save.
      // Tiles never use the metadata proxy; the handoff below is plain
      // navigation to a `dezoomify://` link, not a proxied fetch.
      viewCtx.originClean = false;
      viewCtx.sourceUrl = url;
      viewCtx.desktopHandoffUrl = desktopHandoffLink(url);
      setStep("Displaying the image…", "This site shows its pieces without letting the browser keep a copy.");
      reportProgress(total, total, `Displaying ${total} tiles…`);
      pushLog(`Done: ${width}×${height} display-only (${total} tiles, tainted canvas)`);
      setCanvasVisible(true);
      preview.resetTransform(document);
      controller.dispatch(nextEvent("preflight-display-only", { transport: "display" }) as never);
      recordWebHistory(url, width, height, "display");
      update();
      return;
    }

    controller.dispatch(nextEvent("save-start") as never);
    setStep("Assembling the final picture…", "Encoding PNG in your browser");
    reportProgress(total, total, "Encoding PNG…");
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(failure(
          "OUTPUT_ENCODE_FAILED",
          "The final picture could not be created from the saved pieces.",
          false,
          undefined,
          "canvas.toBlob returned null while encoding the PNG",
        ))),
        "image/png",
      );
    });
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = URL.createObjectURL(blob);
    viewCtx.completedInfo = {
      width,
      height,
      mime: "image/png",
      blobUrl: resultBlobUrl,
    };
    viewCtx.originClean = true;
    pushLog(`Done: ${width}×${height} PNG (${total} tiles)`);
    // The browser canvas path (createImageBitmap -> drawImage -> toBlob) never
    // preserves the source ICC color profile or EXIF metadata (native keeps
    // the first tile's profile); warn so archived colors are not trusted blindly.
    pushLog("Colors may shift slightly: the browser save does not keep the original color profile. For exact colors, use the desktop app.");
    controller.dispatch(nextEvent("save-done") as never);
    recordWebHistory(url, width, height, "png");
    update();
  } catch (error) {
    if (token !== jobToken) return;
    queueOutcome = "failed";
    const structured = error as {
      code?: string;
      message?: string;
      detail?: string;
      technical?: string;
    };
    const code = structured?.code || "DISCOVERY_FAILED";
    const message = structured?.message || "Could not save this zoomable image.";
    const detail = structured?.detail ?? structured?.technical;
    // The activity log is technical: prefer the dense chain over UI copy.
    pushLog(`Failed (${code}): ${structured?.technical || message}`);
    // One-click desktop handoff (todo 5.5): too-large plans fail with the
    // `dezoomify://` link in the view context, so the failed view offers the
    // Send button with the origin/scope consent summary. Only http(s)
    // sources get a link; the deep link never carries credentials.
    if (code === "PLAN_INVALID") {
      const link = desktopHandoffLink(url);
      if (link !== "") {
        viewCtx.sourceUrl = url;
        viewCtx.desktopHandoffUrl = link;
      }
    }
    controller.dispatch(
      nextEvent("fail", {
        error: {
          code,
          category: categoryFor(code),
          retryable: structured?.retryable ?? code !== "NO_IMAGE_FOUND",
          message,
          // Tiles never use the metadata CORS proxy: a tile failure always
          // reports the direct browser fetch, even when the job's metadata
          // arrived through the proxy.
          transport: errorTransportFor(code, activeTransport),
          phase: phaseFor(code),
          ...(detail ? { detail } : {}),
        },
      }) as never,
    );
    update();
  } finally {
    if (token === jobToken) {
      stopHeartbeat();
      refreshLongestPending();
      disposeClient();
      // Sequential queue: the active entry settles, then the first waiting
      // entry (if any) becomes active and starts. A failed entry never stops
      // the rest. Engine stays single-job throughout.
      if (webQueueEnabled()) {
        const settled = finishActiveWebEntry(webQueue, queueOutcome);
        webQueue = settled.queue;
        const next = settled.next;
        if (next) {
          const status = controller.getState().status;
          if (
            status === "completed" ||
            status === "cancelled" ||
            status === "failed" ||
            status === "display-only"
          ) {
            controller.reset(sessionId);
            currentSeq = 0;
          }
          const summary = summarizeWebQueue(webQueue);
          pushLog(
            `Queue: ${summary.succeeded} done, ${summary.failed} failed, ${summary.pending} waiting`,
          );
          void runJob(next.url);
        }
      }
    }
  }
}

function submitQueuedUrl(url: string): void {
  if (!webQueueEnabled()) {
    void runJob(url);
    return;
  }
  const res = enqueueWebQueue(webQueue, url);
  webQueue = res.queue;
  if (res.code !== "ok" || !res.entry) {
    controller.dispatch(
      nextEvent("fail", {
        error: {
          code: "INVALID_URL",
          category: "validation",
          retryable: false,
          message: "Please enter a valid web address starting with http:// or https://",
        },
      }) as never,
    );
    update();
    return;
  }
  if (res.entry.status === "active") {
    void runJob(res.entry.url);
    return;
  }
  // Queued behind the active job: no hash write, no cancel of the running
  // job. The hash stays owned by the active URL until it settles.
  const position = webQueue.entries.filter((e) => e.status === "queued").length;
  pushLog(`Queued ${shortUrl(url)} (position ${position} in queue)`);
  update();
}

const appContainer = typeof document !== "undefined" ? document.getElementById("app") : null;

let viewCtx: ViewContext = {
  capabilities: {
    extensionAvailable: false,
    nativeAvailable: false,
    browserCanSave: true,
  },
  originClean: true,
  initialUrl: undefined,
  history: [...webHistory],
};

function update(): void {
  if (!appContainer) return;
  const state = controller.getState();
  if (activeTransport && !state.transport) {
    state.transport = activeTransport;
  }
  if (viewCtx.jobActivity) refreshLongestPending();
  renderView(
    appContainer,
    state,
    {
      onSubmitUrl(url: string) {
        if (isLocalFileUrl(url)) {
          viewCtx.initialUrl = url;
          viewCtx.sourceUrl = url;
          viewCtx.desktopHandoffUrl = undefined;
          controller.dispatch(
            nextEvent("fail", {
              error: {
                code: "INVALID_URL",
                category: "validation",
                retryable: false,
                message: "Local files cannot be opened on this website. Use the desktop app for files on your computer.",
                transport: "direct",
                phase: "discovery",
                detail: "Local file: open the desktop app and choose the file there; nothing is sent.",
              },
            }) as never,
          );
          update();
          return;
        }
        if (!isAllowedSourceUrl(url)) {
          controller.dispatch(
            nextEvent("fail", {
              error: {
                code: "INVALID_URL",
                category: "validation",
                retryable: false,
                message: "Please enter a valid web address starting with http:// or https://",
              },
            }) as never,
          );
          update();
          return;
        }
        submitQueuedUrl(url);
      },
      onPause() {
        // Pause v1: stop scheduling new tiles; in-flight finishes, the
        // canvas is retained, resume re-drives the FIFO queue.
        if (jobPaused) return;
        jobPaused = true;
        viewCtx.paused = true;
        if (viewCtx.jobActivity) viewCtx.jobActivity.paused = true;
        pushLog("Paused: no new pieces are being fetched.");
        update();
      },
      onResume() {
        if (!jobPaused) return;
        jobPaused = false;
        viewCtx.paused = false;
        if (viewCtx.jobActivity) viewCtx.jobActivity.paused = false;
        pushLog("Resumed: fetching queued pieces again.");
        update();
      },
      onCancel() {
        jobToken += 1;
        jobPaused = false;
        viewCtx.paused = false;
        stopHeartbeat();
        disposeClient();
        controller.dispatch(nextEvent("cancel") as never);
        // Queue: the active entry is cancelled, then the first waiting entry
        // (if any) starts. Cancellation never issues new work beyond the
        // already-queued line.
        if (webQueueEnabled()) {
          const settled = finishActiveWebEntry(webQueue, "cancelled");
          webQueue = settled.queue;
          const next = settled.next;
          if (next) {
            controller.reset(sessionId);
            currentSeq = 0;
            pushLog(`Queue: starting next queued job (${shortUrl(next.url)})`);
            void runJob(next.url);
            update();
            return;
          }
        }
        update();
      },
      onReset() {
        jobToken += 1;
        jobPaused = false;
        viewCtx.paused = false;
        stopHeartbeat();
        disposeClient();
        setCanvasVisible(false);
        sessionId = `sess:web-${Date.now()}`;
        controller.reset(sessionId);
        currentSeq = 0;
        // Reset clears the whole queue: no new work is issued afterwards.
        if (webQueueEnabled()) {
          webQueue = cancelAllWeb(webQueue);
          webQueue = createWebQueue();
        }
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        viewCtx.jobActivity = undefined;
        viewCtx.initialUrl = undefined;
        viewCtx.imageChoice = undefined;
        viewCtx.sourceUrl = undefined;
        viewCtx.desktopHandoffUrl = undefined;
        activeTransport = null;
        clearHash();
        if (resultBlobUrl) {
          URL.revokeObjectURL(resultBlobUrl);
          resultBlobUrl = null;
        }
        update();
      },
      onRetrySameUrl() {
        const lastUrl = viewCtx.jobActivity?.url ?? viewCtx.initialUrl;
        if (!lastUrl || !isAllowedSourceUrl(lastUrl)) return;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        viewCtx.imageChoice = undefined;
        viewCtx.sourceUrl = undefined;
        viewCtx.desktopHandoffUrl = undefined;
        submitQueuedUrl(lastUrl);
      },
      onSave() {
        if (!resultBlobUrl) return;
        const anchor = document.createElement("a");
        anchor.href = resultBlobUrl;
        anchor.download = suggestedNameFor(
          viewCtx.completedInfo?.width,
          viewCtx.completedInfo?.height,
          "png",
        );
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      },
      onCopyShareLink() {
        const href = (typeof window !== "undefined" && window.location && window.location.href) || "";
        const btn = document.getElementById("dz-btn-share");
        const done = () => {
          if (btn) {
            btn.textContent = "Copied!";
            setTimeout(() => {
              try {
                if (btn.isConnected) btn.textContent = "Copy shareable link";
              } catch {
                // Button may be gone after re-render; ignore.
              }
            }, 2000);
          }
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            (navigator.clipboard.writeText(href) as Promise<void>).then(done, done);
          } else if (href) {
            const ta = document.createElement("textarea");
            ta.value = href;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            done();
          }
        } catch {
          // Copy failures stay silent; the address bar link still works.
        }
      },
      onOpenExternalLink(url: string) {
        // Display-only desktop handoff: plain navigation to the
        // `dezoomify://` link, never a proxied tile fetch.
        try {
          if (typeof window !== "undefined" && window.location) {
            window.location.href = url;
          }
        } catch {
          // Handoff navigation must never break display.
        }
      },
      onClearHistory() {
        webHistory = [];
        clearHistoryStore(webHistoryStore, HISTORY_KEY_WEBSITE);
        viewCtx.history = [];
        update();
      },
    },
    viewCtx,
  );
}

function startFromHash(): void {
  if (typeof window === "undefined") return;
  const raw = parseHash(window.location.hash);
  if (raw && looksLikeUsableUrl(raw) && isAllowedSourceUrl(raw)) {
    viewCtx.initialUrl = raw;
    update();
    runJob(raw);
  } else if (raw) {
    viewCtx.initialUrl = raw;
    update();
  }
}

if (appContainer) {
  if (typeof document !== "undefined") {
    try {
      preview.initControls(document);
    } catch {
      // Preview wiring must never break the job.
    }
  }
  document.getElementById("dz-nav-btn-extension")?.addEventListener("click", () => showExtensionGuidance(document));
  document.getElementById("dz-nav-btn-desktop")?.addEventListener("click", () => showDesktopAppGuidance(document, {
    userAgent: navigator.userAgent,
    platform: (navigator as unknown as { platform?: string }).platform,
  }));
  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", () => {
      const raw = parseHash(window.location.hash);
      const current = viewCtx.jobActivity?.url;
      if (raw && raw !== current && looksLikeUsableUrl(raw) && isAllowedSourceUrl(raw)) {
        runJob(raw);
      } else if (!raw && !current) {
        viewCtx.initialUrl = undefined;
        update();
      }
    });
  }
  startFromHash();
  update();
}

export { controller, update };
