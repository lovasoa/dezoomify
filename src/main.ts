// Web application entry point (single source of truth; `./main.js` is
// generated from this file by `scripts/sync-web-js.mjs`, never hand-edited).
// Real pipeline: worker-hosted wasm core discovery -> direct-first transport
// with automatic eligible metadata-proxy fallback -> tile acquisition -> canvas
// assembly -> real PNG save. Nothing here fabricates progress or completion.
import { createController } from "../packages/shared-ui/src/controller.ts";
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../packages/shared-ui/src/view.ts";
import type { ViewContext } from "../packages/shared-ui/src/view.ts";
import {
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
  classifyReadableBytes,
  discoveryFailedError,
  noImageFoundError,
} from "./discovery.ts";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.ts";
import { isProxyEligible } from "./webIntegration.ts";
import { createProxyTransport, PROXY_METADATA_MAX_BYTES } from "./proxyTransport.ts";
import {
  createDiscoveryClient,
  failure,
  type DiscoveryClient,
  type PlanTile,
  type WebCatalog,
} from "../packages/browser-runtime/src/session.ts";

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;
let activeTransport: string | null = null;
let client: DiscoveryClient | null = null;
let jobToken = 0;
let resultBlobUrl: string | null = null;

/** Per-request timeout applied to every individual HTTP request (30 s). */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Largest canvas a browser tab can hold (16384 x 16384, legacy
 * MAX_CANVAS_AREA parity). Level picking never plans above this: gigapixel
 * services (e.g. the 2-gigapixel deepest WMTS matrix of global imagery)
 * would otherwise exhaust worker memory while serializing trillions of
 * tiles and trap the engine. The post-plan canvas check below enforces the
 * same bound for levels without declared sizes.
 */
export const BROWSER_MAX_CANVAS_AREA = 268435456;

/**
 * Short timeout for the direct metadata fetch: if the site does not answer
 * within 250 ms, the eligible metadata proxy takes over automatically.
 * Tiles keep the full 30 s timeout (they never use the proxy).
 */
export const DIRECT_METADATA_TIMEOUT_MS = 250;

/**
 * Tile politeness + resilience (todo 5.2). At most 5 tile request starts per
 * second per host (legacy ZoomManager.MAX_REQUESTS_PER_SECOND parity:
 * 1000/5 ms spacing between starts). The 4-worker pool below is unchanged;
 * starts for the same host are staggered through a per-host chain so the
 * 4 parallel workers still cap at 5/s combined, they do not each get 5/s.
 * Each tile retries twice (3 attempts) with exponential backoff + jitter;
 * the exhausted failure still maps to TILE_FAILED (never a display string).
 */
export const TILE_MAX_REQUESTS_PER_SECOND = 5;
export const TILE_MIN_INTERVAL_MS = 1000 / TILE_MAX_REQUESTS_PER_SECOND;
export const TILE_MAX_RETRIES = 2;
export const TILE_RETRY_BASE_MS = 250;

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
  heartbeatTimer = setInterval(() => {
    refreshLongestPending();
    update();
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

async function fetchViaProxy(
  targetUrl: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; bytes?: ArrayBuffer; code?: string; finalUrl?: string }> {
  const reqId = noteRequestStart("proxy");
  const combined = timeoutSignal(signal);
  try {
    const res = await proxyTransport.fetchViaProxy(targetUrl, { signal: combined.signal });
    if (!res.ok) {
      noteRequestEnd(reqId, false);
      return { ok: false, status: res.status, code: res.code ?? "PROXY_ERROR" };
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
 * Fetch one metadata resource for discovery: direct first, then the eligible
 * metadata proxy after a classified network failure. The zoomable-content
 * classifier gates every success: generic pages fail with NO_IMAGE_FOUND.
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
  const direct = await fetchDirect(url, headers, undefined, DIRECT_METADATA_TIMEOUT_MS);
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
    activeTransport = PROXY_LABEL;
    via = "proxy";
    const proxied = await fetchViaProxy(url);
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
      throw failure(
        "PROXY_ERROR",
        "The metadata proxy could not fetch this address. Try again shortly.",
        false,
        undefined,
        `metadata proxy: ${proxied.code ?? "PROXY_ERROR"} (HTTP ${proxied.status || 0}) fetching ${target}`,
      );
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
  const verdict = classifyReadableBytes(bytes, { via, contentType });
  if (!verdict.found) {
    throw failure(
      "NO_IMAGE_FOUND",
      noImageFoundError(via).message,
      false,
      undefined,
      `content classifier: no zoomable-image content in ${bytes.byteLength} bytes (${via}) from ${target}`,
    );
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
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const size = { ok: bitmap.width > 0 && bitmap.height > 0, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { ok: false, width: 0, height: 0 };
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
  update();
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
 * Largest declared level that fits the browser canvas wins. Levels without
 * a declared size keep the old behavior (area -1, last wins). When declared
 * levels exist but none fits, the smallest declared level is returned so the
 * post-plan canvas check fails cheaply with desktop-app guidance instead of
 * planning a gigapixel level that exhausts worker memory.
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
    const area = size.x * size.y;
    if (area <= BROWSER_MAX_CANVAS_AREA && area >= bestArea) {
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

async function drawTile(client2: DiscoveryClient, ctx2d: CanvasRenderingContext2D, tile: PlanTile): Promise<void> {
  let { bytes } = await fetchTileFor(tile.uri, tile.headers ?? {});
  if (tile.processing && tile.processing !== "none") {
    bytes = await enqueueProcess(client2, tile.processing, bytes);
  }
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const w = Math.min(tile.w ?? bitmap.width, bitmap.width);
    const h = Math.min(tile.h ?? bitmap.height, bitmap.height);
    if (w > 0 && h > 0) {
      ctx2d.drawImage(bitmap, 0, 0, w, h, tile.x, tile.y, w, h);
    }
  } finally {
    bitmap.close();
  }
}

async function runJob(url: string): Promise<void> {
  const token = ++jobToken;
  resetActivity(url);
  viewCtx.imageChoice = undefined;
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  writeHash(url);
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
    setStep("Choosing the highest resolution…");
    controller.dispatch(nextEvent("level-chosen") as never);
    setStep("Checking the image size…");
    controller.dispatch(nextEvent("preflight-ok", { transport: via }) as never);
    update();

    const plan = await client.plan(image.id, level.index);
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
    if (width * height > BROWSER_MAX_CANVAS_AREA) {
      throw failure(
        "PLAN_INVALID",
        "This image is too large for this browser tab. Use the desktop app for the full-size image.",
        false,
        undefined,
        `canvas ${width}x${height} exceeds the browser limit`,
      );
    }
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx2d.clearRect(0, 0, width, height);

    const total = plan.tiles.length;
    viewCtx.imageChoice = { width, height, tiles: total };
    setStep("Saving image tiles…", `${total} tiles at full resolution`);
    reportProgress(0, total, `Saving ${total} tiles…`);
    let done = 0;
    let failed: unknown = null;
    const queue = [...plan.tiles];
    const tileWorker = async (): Promise<void> => {
      while (queue.length && !failed) {
        const tile = queue.shift();
        if (!tile) return;
        try {
          await drawTile(client as DiscoveryClient, ctx2d, tile);
        } catch (error) {
          failed = error;
          return;
        }
        if (token !== jobToken) return;
        done += 1;
        reportProgress(done, total, `Saving ${total} tiles…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, total)) }, tileWorker));
    if (failed) throw failed;
    if (token !== jobToken) return;

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
    controller.dispatch(nextEvent("save-done") as never);
    update();
  } catch (error) {
    if (token !== jobToken) return;
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
    controller.dispatch(
      nextEvent("fail", {
        error: {
          code,
          category: categoryFor(code),
          retryable: structured?.retryable ?? code !== "NO_IMAGE_FOUND",
          message,
          transport: activeTransport ?? "direct",
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
    }
  }
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
        runJob(url);
      },
      onCancel() {
        jobToken += 1;
        stopHeartbeat();
        disposeClient();
        controller.dispatch(nextEvent("cancel") as never);
        update();
      },
      onReset() {
        jobToken += 1;
        stopHeartbeat();
        disposeClient();
        sessionId = `sess:web-${Date.now()}`;
        controller.reset(sessionId);
        currentSeq = 0;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        viewCtx.jobActivity = undefined;
        viewCtx.initialUrl = undefined;
        viewCtx.imageChoice = undefined;
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
        runJob(lastUrl);
      },
      onSave() {
        if (!resultBlobUrl) return;
        const anchor = document.createElement("a");
        anchor.href = resultBlobUrl;
        anchor.download = "zoomed-image.png";
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
