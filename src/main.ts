// Web application entry point (single source of truth; Vite bundles this
// file directly, there is no hand-maintained `.js` mirror).
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
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../packages/shared-ui/src/view.tsx";
import type { ViewContext } from "../packages/shared-ui/src/view.tsx";
import type { ErrorDto, HeaderDto, JobEvent, ProcessingRecipe } from "@dezoomify/wasm-bindings";
import { DEFAULT_PAGE_TITLE, isActiveJobStatus, jobPageTitle } from "../packages/shared-ui/src/view-helpers.ts";
import { describeFailure } from "../packages/shared-ui/src/failure.ts";
import {
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
  classifyReadableBytes,
  discoveryFailedError,
  noImageFoundError,
} from "./discovery.ts";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.ts";
import { errorTransportFor, isProxyEligible } from "./webIntegration.ts";
import { createProxyTransport, PROXY_METADATA_MAX_BYTES } from "./proxyTransport.ts";
import {
  createCanvasAssembly,
  createEngineHost,
  createProbeSize,
  dispatchTyped,
  type DispatchTable,
  type EngineHost,
  type WorkerHostOutput,
} from "../packages/browser-runtime/src/index.ts";
import {
  blockedReason,
  errorTransport,
  failure,
  stableErrorCode,
} from "../packages/browser-runtime/src/failure.ts";
import {
  BROWSER_LIMITS,
  BROWSER_MAX_CANVAS_AREA,
  BROWSER_MAX_CANVAS_SIDE,
  BROWSER_MAX_PLAN_TILES,
} from "../packages/browser-runtime/src/limits.ts";
import {
  desktopHandoffLink,
  isAllowedSourceUrl,
  isLocalFileUrl,
} from "../packages/browser-runtime/src/plan-gates.ts";
import { pickEngineSelection } from "../packages/browser-runtime/src/engine-selection.ts";
import {
  cancelAllWeb,
  createWebQueue,
  enqueueWebQueue,
  finishActiveWebEntry,
  isWebQueueAvailable,
  summarizeWebQueue,
} from "../packages/browser-runtime/src/queue.ts";
import {
  PREVIEW_ZOOM_STEP,
  createPreviewControls,
  setCanvasVisible,
} from "../packages/browser-runtime/src/preview.ts";
import {
  REQUEST_TIMEOUT_MS,
  createTileThrottle,
  hostOf,
  websiteTileConcurrency,
} from "../packages/browser-runtime/src/tile-policy.ts";
import { createTileDecoder } from "../packages/browser-runtime/src/tile-decode.ts";
import { loadTileImage } from "../packages/browser-runtime/src/tile-draw.ts";
import { createJobActivity } from "../packages/browser-runtime/src/job-activity.ts";
import { createLogger } from "../packages/browser-runtime/src/logging.ts";
import { createWebFetcher, type WebFetcher } from "../packages/browser-runtime/src/web-fetch.ts";
import { PROXY_TRANSPORT_LABEL } from "../packages/browser-runtime/src/transport-labels.ts";
import {
  BROWSER_SAVE_COLOR_WARNING,
  canvasToPngBlob,
  isCanvasTaintError,
  saveBlobViaAnchor,
} from "../packages/browser-runtime/src/canvas-save.ts";

// Re-export the shared browser limits for existing website test imports.
export {
  BROWSER_MAX_CANVAS_AREA,
  BROWSER_MAX_CANVAS_SIDE,
  BROWSER_MAX_PLAN_TILES,
  desktopHandoffLink,
  PREVIEW_ZOOM_STEP,
};

const preview = createPreviewControls();

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;
let engineHost: EngineHost | null = null;
let engineWorker: Worker | null = null;
let jobToken = 0;
let resultBlobUrl: string | null = null;
let resultTitle: string | undefined;
// Cross-worker processing calls (session.applyProcessing) awaiting a reply.
const pendingProcess = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: unknown) => void }>();
let processSeq = 0;
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

// --- Live job activity (drives the progressive-disclosure job view) ---
const jobActivity = createJobActivity({ onUpdate: update });
// Shared structured logger: console output plus the same lines mirrored into
// the job view's technical-details log (and copied diagnostics). The `web`
// context is the default here, so lines carry no bracket; runtime lines from
// the shared fetchers/painters join under the `runtime` code.
const webLog = createLogger("web", { defaultContext: "web" });
webLog.addSink((entry) => jobActivity.pushLog(entry.line));
let tileAttempts = 0;
let tileRetries = 0;
const metadataAttempts: Array<{ at: number; transport: string; target: string; outcome: string; durationMs: number; bytes?: number }> = [];

function resetActivity(url: string): void {
  tileAttempts = 0;
  tileRetries = 0;
  metadataAttempts.length = 0;
  jobActivity.reset(url, REQUEST_TIMEOUT_MS);
  jobActivity.state.detail = `Contacting ${hostOf(url)}…`;
  viewCtx.jobActivity = jobActivity.state;
}

/** Keep diagnostics bounded and useful without retaining individual tile URLs. */
function refreshDiagnostics(): void {
  const a = jobActivity.state;
  const lines: string[] = [];
  if (metadataAttempts.length > 0) {
    lines.push("Metadata requests");
    for (const attempt of metadataAttempts) {
      const size = attempt.bytes === undefined ? "" : ` · ${Math.max(1, Math.round(attempt.bytes / 1024))} KB`;
      lines.push(
        `+${(attempt.at / 1000).toFixed(1)} s  ${attempt.target}  ${attempt.transport}  ${attempt.outcome}  ${attempt.durationMs} ms${size}`,
      );
    }
  }
  if (tileAttempts > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Tile acquisition");
    lines.push(`${tileAttempts} attempts · ${tileRetries} retries`);
  }
  a.diagnostics = lines.join("\n");
}

function recordMetadataAttempt(
  startedAt: number,
  transport: "direct" | "metadata proxy",
  target: string,
  outcome: string,
  bytes?: number,
): void {
  metadataAttempts.push({
    at: Math.max(0, startedAt - (jobActivity.state.startedAt ?? startedAt)),
    transport,
    target,
    outcome,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(typeof bytes === "number" ? { bytes } : {}),
  });
  if (metadataAttempts.length > 20) metadataAttempts.splice(0, metadataAttempts.length - 20);
  refreshDiagnostics();
}

function nextEvent(kind: string, extra: Record<string, unknown> = {}) {
  currentSeq++;
  return { seq: currentSeq, sessionId, kind, ...extra };
}

const tileThrottle = createTileThrottle();
const tileDecoder = createTileDecoder();

// The product-specific proxy transport owns the actual /api/proxy POST.
// Browser-runtime owns direct-first orchestration, fallback, retries, and
// failure classification around this injected effect.
const proxyTransport = createProxyTransport(
  (input: string, init?: Record<string, unknown>) =>
    fetch(input, init as RequestInit).then((res) => ({
      status: res.status,
      headers: res.headers,
      arrayBuffer: () => res.arrayBuffer(),
    })),
  { protocolVersion: 1, maxBytes: PROXY_METADATA_MAX_BYTES },
);

const webFetcher: WebFetcher = createWebFetcher({
  proxyTransport,
  isProxyEligible,
  classifyHint: (bytes, info) => classifyReadableBytes(bytes, info),
  hooks: {
    onRequestStart: (label) => jobActivity.noteRequestStart(label),
    onRequestEnd: (id, ok) => jobActivity.noteRequestEnd(id, ok),
    onLog: (line) => webLog.info("runtime", line),
    onUpdate: update,
    onMetadataAttempt: ({ startedAt, transport, target, outcome, bytes }) =>
      recordMetadataAttempt(startedAt, transport, target, outcome, bytes),
    onTileAttempt: (retrying) => {
      tileAttempts += 1;
      if (retrying) tileRetries += 1;
      refreshDiagnostics();
    },
  },
  messages: {
    rateLimitedBySite: RATE_LIMITED_BY_SITE_MESSAGE,
    siteBusy: SITE_BUSY_MESSAGE,
    discoveryFailed: (via) => discoveryFailedError(via).message,
  },
  throttle: (url) => tileThrottle.throttle(url),
});
async function probeSizeFor(
  url: string,
  headers: Record<string, string>,
) {
  const probe = createProbeSize({
    fetchTile: (probeUrl, probeHeaders) => webFetcher.fetchTileFor(probeUrl, probeHeaders),
    decode: (bytes) => tileDecoder.decode(bytes),
    loadImage: async (probeUrl) => {
      const img = await loadTileImage(probeUrl, {
        hooks: {
          onRequestStart: (label) => jobActivity.noteRequestStart(label),
          onRequestEnd: (id, ok) => jobActivity.noteRequestEnd(id, ok),
          onUpdate: update,
        },
      });
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        image: img,
      };
    },
  });
  return probe(url, headers);
}

/** Tear down the active engine attempt: worker, session, assembly, buffers. */
function disposeAttempt(): void {
  const host = engineHost;
  engineHost = null;
  try { host?.dispose(); } catch { /* teardown is best effort */ }
  const worker = engineWorker;
  engineWorker = null;
  try { worker?.terminate(); } catch { /* already gone */ }
  for (const { reject } of pendingProcess.values()) {
    reject(failure("WORKER_FAILED", "The image engine stopped.", false));
  }
  pendingProcess.clear();
}

/** Apply one core processing recipe through the worker session. */
function processTile(recipe: ProcessingRecipe, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const worker = engineWorker;
  if (!worker) return Promise.reject(failure("WORKER_FAILED", "The image engine is not running.", false));
  const requestId = ++processSeq;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pendingProcess.set(requestId, { resolve, reject });
    worker.postMessage({ type: "engine.process", requestId, recipe, bytes }, [bytes]);
  });
}

/** Normalize generated request headers for `fetch`. */
function headerRecord(headers: HeaderDto[] | undefined): Record<string, string> {
  return Object.fromEntries((headers ?? []).map(({ name, value }) => [name, value]));
}

let activeAssembly: ReturnType<typeof createCanvasAssembly> | null = null;

function createAssembly(sourceUrl: string): ReturnType<typeof createCanvasAssembly> {
  const decoder = createTileDecoder();
  return createCanvasAssembly({
    decode: (bytes: ArrayBuffer) => decoder.decode(bytes),
    processTile,
    createCanvas: (width: number, height: number) => {
      const element = (document.getElementById("rendering-canvas") as HTMLCanvasElement | null)
        ?? document.createElement("canvas");
      element.width = width;
      element.height = height;
      const ctx2d = element.getContext("2d");
      if (!ctx2d) {
        throw failure("OUTPUT_SURFACE_UNAVAILABLE", "This browser could not create the output surface.", false);
      }
      // Reveal the canvas before drawing (legacy parity): the picture stays
      // visible and right-clickable while the job finishes.
      setCanvasVisible(document, true);
      preview.resetTransform(document);
      return { width, height, ctx2d, toBlob: (cb: BlobCallback, mime?: string) => element.toBlob(cb, mime) };
    },
    encode: (canvas) =>
      canvasToPngBlob(canvas as unknown as { toBlob(cb: BlobCallback, mime?: string): void }),
    save: (blob, width, height) => {
      if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
      resultBlobUrl = URL.createObjectURL(blob as Blob);
      viewCtx.completedInfo = { width, height, mime: "image/png", blobUrl: resultBlobUrl };
      viewCtx.originClean = true;
    },
    sourceUrl,
    onDisplayOnly: () => {
      if (viewCtx.originClean === false) return;
      viewCtx.originClean = false;
      viewCtx.sourceUrl = sourceUrl;
      viewCtx.desktopHandoffUrl = desktopHandoffLink(sourceUrl);
      controller.dispatch(nextEvent("preflight-display-only", { transport: "display" }) as never);
      const dims = activeAssembly?.dimensions();
      recordWebHistory(sourceUrl, dims?.width ?? 0, dims?.height ?? 0, "display");
      update();
    },
    isTaintError: (error) => isCanvasTaintError(error),
    log: (line) => webLog.info("runtime", line),
  });
}

/** Shared presenter for engine failures: headline plus stable classification. */
function presentEngineFailure(error: ErrorDto, url: string, token: number): void {
  if (token !== jobToken) return;
  const code = error.code;
  const via = webFetcher.getActiveTransport() === PROXY_TRANSPORT_LABEL ? "proxy" : "direct";
  const lower = code.toLowerCase();
  webLog.error("failed", `code=${code} message=${error.message}`);
  if (code === "PLAN_INVALID" || code === "job.resource-limit") {
    const link = desktopHandoffLink(url);
    if (link !== "") {
      viewCtx.sourceUrl = url;
      viewCtx.desktopHandoffUrl = link;
    }
  }
  const noImageFound =
    code === "NO_IMAGE_FOUND" || lower.indexOf("no-images") >= 0 || lower.indexOf("catalog") >= 0 || lower.indexOf("empty-resource") >= 0;
  const discoveryFailed = lower.indexOf("discovery") >= 0 || lower.indexOf("unknown-dezoomer") >= 0;
  const discoveryCopy = noImageFound
    ? noImageFoundError(via)
    : discoveryFailed
      ? discoveryFailedError(via)
      : null;
  controller.dispatch(
    nextEvent("fail", {
      error: describeFailure({
        code,
        engineDetail: error.detail ?? error.message,
        ...(discoveryCopy
          ? { message: discoveryCopy.message, category: discoveryCopy.category }
          : {}),
        phase: error.phase,
        retryable: discoveryCopy ? discoveryCopy.retryable : error.retryable,
        transport: error.transport ?? errorTransportFor(code, webFetcher.getActiveTransport()),
        host: hostOf(url),
        url: error.request,
        http: error.http,
        preview: error.preview,
      }),
    }) as never,
  );
  update();
}

function reportProgress(current: number, total: number, message: string): void {
  viewCtx.currentProgress = { current, total, message };
  jobActivity.touchProgress();
  jobActivity.scheduleUpdate();
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

async function runJob(url: string): Promise<void> {
  const token = ++jobToken;
  webFetcher.resetActiveTransport();
  tileThrottle.reset();
  resetActivity(url);
  setCanvasVisible(document, false);
  preview.resetTransform(document);
  jobPaused = false;
  viewCtx.paused = false;
  viewCtx.imageChoice = undefined;
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.sourceUrl = undefined;
  viewCtx.desktopHandoffUrl = undefined;
  viewCtx.originClean = true;
  resultTitle = undefined;
  // Hash owns the active job only: queued URLs never touch the hash until
  // they become active and reach this point.
  writeHash(url);
  jobActivity.startHeartbeat();
  jobActivity.setStep("Finding the zoomable image…", `Contacting ${hostOf(url)}…`);
  controller.dispatch(nextEvent("start-discovery", { transport: "direct" }) as never);
  update();

  let selected = false;
  let displayOnly = false;
  let terminal: "done" | "failed" | "cancelled" | "display" = "done";
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => { settle = resolve; });

  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  engineWorker = worker;
  const assembly = createAssembly(url);
  activeAssembly = assembly;

  const onHostFailure = (error: unknown): void => {
    if (token !== jobToken) return;
    if (terminal !== "done") return;
    const structured = error as { code?: unknown; message?: unknown; detail?: unknown; retryable?: unknown };
    const code = typeof structured?.code === "string" ? structured.code : "OUTPUT_FAILED";
    webLog.error("host-failure", `code=${code} message=${String(structured?.message ?? code)}`);
    controller.dispatch(
      nextEvent("fail", {
        error: describeFailure({
          code,
          engineDetail: typeof structured?.detail === "string" ? structured.detail : undefined,
          message: typeof structured?.message === "string" ? structured.message : undefined,
          retryable: typeof structured?.retryable === "boolean" ? structured.retryable : undefined,
          transport: "browser-session",
          host: hostOf(url),
        }),
      }) as never,
    );
    terminal = "failed";
    update();
    settle();
  };

  const complete = (): void => {
    if (displayOnly || assembly.isTainted()) {
      terminal = "display";
      settle();
      return;
    }
    controller.dispatch(nextEvent("save-start") as never);
    recordWebHistory(url, viewCtx.completedInfo?.width ?? 0, viewCtx.completedInfo?.height ?? 0, "png");
    controller.dispatch(nextEvent("save-done") as never);
    terminal = "done";
    update();
    settle();
  };

  const eventHandlers = {
    catalog: (event) => {
      if (selected) return;
      selected = true;
      const catalog = event.catalog;
      const images = catalog.images;
      const via = webFetcher.getActiveTransport() === PROXY_TRANSPORT_LABEL ? "proxy" : "direct";
      if (images.length === 0) {
        controller.dispatch(nextEvent("images-found", { imageCount: 0, transport: via }) as never);
        onHostFailure(failure("NO_IMAGE_FOUND", noImageFoundError(via).message, false, "discovery returned an empty image catalog"));
        return;
      }
      controller.dispatch(nextEvent("images-found", { imageCount: images.length, transport: via }) as never);
      const selection = pickEngineSelection(catalog, BROWSER_LIMITS);
      if (!selection) {
        onHostFailure(failure("CATALOG_UNSELECTABLE", "The image catalog has no level this browser can select.", false));
        return;
      }
      const image = images[selection.image];
      resultTitle = image?.title;
      const level = image?.levels?.[selection.level];
      if (level) viewCtx.imageChoice = { width: level.width, height: level.height, tiles: 0 };
      controller.dispatch(nextEvent("image-chosen") as never);
      jobActivity.setStep("Choosing the highest resolution…");
      controller.dispatch(nextEvent("level-chosen") as never);
      controller.dispatch(nextEvent("preflight-ok", { transport: via }) as never);
      update();
      engineHost?.selectImage(selection.image);
      engineHost?.selectLevel(selection.level);
    },
    progress: (event) => {
      reportProgress(event.acquired, event.total, `Saving ${event.total} tiles…`);
      update();
    },
    warning: (event) => webLog.warn("engine-warning", JSON.stringify(event.error)),
    "recovery-request": () => {},
    "job-state": () => {},
    paused: () => {},
    resumed: () => {},
    completed: complete,
    "partial-completed": complete,
    failed: (event) => {
      presentEngineFailure(event.error, url, token);
      terminal = "failed";
      settle();
    },
    cancelled: () => {
      controller.dispatch(nextEvent("cancel") as never);
      terminal = "cancelled";
      update();
      settle();
    },
  } satisfies DispatchTable<JobEvent, void>;

  const onEngineEvent = (event: JobEvent): void => {
    if (token !== jobToken) return;
    dispatchTyped(eventHandlers, event);
  };

  const host = createEngineHost({
    worker,
    jobId: () => sessionId,
    fetchResource: async (effect) => {
      const request = effect.request;
      if (request.purpose === "metadata") {
        const result = await webFetcher.fetchMetadataFor(request.uri, headerRecord(request.headers));
        return {
          bytes: new Uint8Array(result.bytes),
          ...(typeof result.finalUri === "string" && result.finalUri !== "" ? { finalUri: result.finalUri } : {}),
        };
      }
      const result = await webFetcher.fetchTileFor(request.uri, headerRecord(request.headers));
      return { bytes: new Uint8Array(result.bytes) };
    },
    fetchResourceOnce: async (effect) => {
      const request = effect.request;
      const result = await webFetcher.fetchTileFor(request.uri, headerRecord(request.headers), 0);
      return { bytes: new Uint8Array(result.bytes) };
    },
    cancelFetch: () => { /* fetches finish harmlessly after a token change */ },
    assembly,
    quotas: { max_concurrent_fetches: websiteTileConcurrency() },
    probeSize: probeSizeFor,
    loadDisplayImage: (tileUrl: string) =>
      loadTileImage(tileUrl, {
        hooks: {
          onRequestStart: (label) => jobActivity.noteRequestStart(label),
          onRequestEnd: (id, ok) => jobActivity.noteRequestEnd(id, ok),
          onUpdate: update,
        },
      }),
    classifyFailure: (error) => {
      const structured = error as {
        blocked_reason?: unknown;
        retryable?: unknown;
        message?: unknown;
        cause?: { reason?: unknown; transport?: unknown; http?: unknown };
        transportKind?: unknown;
        http?: unknown;
        preview?: unknown;
        detail?: unknown;
      };
      const reason = blockedReason(structured?.blocked_reason)
        ?? blockedReason(structured?.cause?.reason);
      const transport = errorTransport(structured?.transportKind)
        ?? errorTransport(structured?.cause?.transport);
      return {
        code: stableErrorCode(error),
        retryable: structured?.retryable === true,
        message: typeof structured?.message === "string" ? structured.message : "The browser could not read this resource.",
        ...(reason ? { blocked_reason: reason } : {}),
        transport: transport ?? "direct",
        ...(typeof structured?.http === "number" ? { http: structured.http } : {}),
        ...(typeof structured?.cause?.http === "number" ? { http: structured.cause.http } : {}),
        ...(typeof structured?.preview === "string" ? { preview: structured.preview } : {}),
        ...(typeof structured?.detail === "string" ? { detail: structured.detail } : {}),
      };
    },
    onPermissionRequired: () => { /* the website has no host grants */ },
    onRecoveryRequested: (generation) => { engineHost?.chooseRecovery(generation, "discard"); },
    onHostFailure,
    onEvent: onEngineEvent,
    log: (level, code, detail) => {
      if (level === "error") webLog.error(code, detail);
      else if (level === "warn") webLog.warn(code, detail);
      else webLog.info(code, detail);
    },
  });
  engineHost = host;

  worker.addEventListener("message", (event: MessageEvent<WorkerHostOutput>) => {
    const data = event.data;
    if (!data || typeof data.type !== "string") return;
    if (data.type === "engine.messages") {
      engineHost?.handleEngineMessages(data.messages);
      return;
    }
    if (data.type === "engine.processed" || data.type === "engine.process-failed") {
      const requestId = typeof data.requestId === "number" ? data.requestId : -1;
      const pending = pendingProcess.get(requestId);
      if (!pending) return;
      pendingProcess.delete(requestId);
      if (data.type === "engine.processed" && data.bytes instanceof ArrayBuffer) pending.resolve(data.bytes);
      else pending.reject(failure("TILE_PROCESSING_FAILED", "A tile could not be processed.", false));
      return;
    }
    if (data.type === "engine.log" && typeof data.line === "string") {
      webLog.info("runtime", data.line);
      return;
    }
    if (data.type === "engine.error") {
      onHostFailure(data.error);
    }
  });

  try {
    host.start([{ url }]);
    await finished;
    if (token !== jobToken) return;
  } catch (error) {
    if (token !== jobToken) return;
    onHostFailure(error);
  } finally {
    if (token === jobToken) {
      jobActivity.stopHeartbeat();
      jobActivity.refreshLongestPending();
      disposeAttempt();
      activeAssembly = null;
      const queueOutcome: "done" | "failed" | "cancelled" =
        (terminal as string) === "failed" ? "failed" : (terminal as string) === "cancelled" ? "cancelled" : "done";
      // Sequential queue: the active entry settles, then the first waiting
      // entry (if any) becomes active and starts. A failed entry never stops
      // the rest. Engine stays single-job throughout.
      if (webQueueEnabled()) {
        const settled = finishActiveWebEntry(webQueue, queueOutcome);
        webQueue = settled.queue;
        const next = settled.next;
        if (next) {
          const status = controller.getState().status;
          if (status === "completed" || status === "cancelled" || status === "failed" || status === "display-only") {
            controller.reset(sessionId);
            currentSeq = 0;
          }
          const summary = summarizeWebQueue(webQueue);
          webLog.info("queue", `succeeded=${summary.succeeded} failed=${summary.failed} pending=${summary.pending}`);
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
  webLog.info("queued", `url=${url} position=${position}`);
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

/**
 * Keep the tab title useful while a job runs: `Dezoomify <host>`.
 * Hosts own the `document.title` assignment; shared UI stays pure.
 */
function syncPageTitle(status: string): void {
  if (typeof document === "undefined") return;
  try {
    if (!isActiveJobStatus(status)) {
      if (document.title !== DEFAULT_PAGE_TITLE) document.title = DEFAULT_PAGE_TITLE;
      return;
    }
    const url = jobActivity.state.url ?? viewCtx.jobActivity?.url ?? viewCtx.initialUrl;
    const next = jobPageTitle(url);
    if (document.title !== next) document.title = next;
  } catch {
    // Title updates must never break the job.
  }
}

function update(): void {
  if (!appContainer) return;
  const state = controller.getState();
  if (state.status === "downloading" && viewCtx.currentProgress) {
    const progress = viewCtx.currentProgress;
    progress.active = Math.min(
      jobActivity.state.pendingRequests ?? 0,
      Math.max(0, progress.total - progress.current),
    );
  }
  const activeTransport = webFetcher.getActiveTransport();
  if (activeTransport && !state.transport) {
    state.transport = activeTransport;
  }
  if (viewCtx.jobActivity) jobActivity.refreshLongestPending();
  syncPageTitle(state.status);
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
        jobActivity.pause();
        engineHost?.pause();
        webLog.info("paused", "no new pieces are being fetched");
        update();
      },
      onResume() {
        if (!jobPaused) return;
        jobPaused = false;
        viewCtx.paused = false;
        jobActivity.resume();
        engineHost?.resume();
        webLog.info("resumed", "fetching queued pieces again");
        update();
      },
      onCancel() {
        jobToken += 1;
        jobPaused = false;
        viewCtx.paused = false;
        jobActivity.stopHeartbeat();
        disposeAttempt();
        // Stop returns directly to the initial view. Effects from the retired
        // token finish harmlessly without mutating the replacement job.
        if (webQueueEnabled()) {
          webQueue = cancelAllWeb(webQueue);
          webQueue = createWebQueue();
        }
        sessionId = `sess:web-${Date.now()}`;
        controller.reset(sessionId);
        currentSeq = 0;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        viewCtx.jobActivity = undefined;
        viewCtx.initialUrl = undefined;
        viewCtx.imageChoice = undefined;
        viewCtx.sourceUrl = undefined;
        viewCtx.desktopHandoffUrl = undefined;
        webFetcher.resetActiveTransport();
        tileThrottle.reset();
        setCanvasVisible(document, false);
        preview.resetTransform(document);
        clearHash();
        if (resultBlobUrl) {
          URL.revokeObjectURL(resultBlobUrl);
          resultBlobUrl = null;
        }
        update();
      },
      onReset() {
        jobToken += 1;
        jobPaused = false;
        viewCtx.paused = false;
        jobActivity.stopHeartbeat();
        disposeAttempt();
        webFetcher.resetActiveTransport();
        tileThrottle.reset();
        setCanvasVisible(document, false);
        preview.resetTransform(document);
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
        saveBlobViaAnchor(
          document,
          resultBlobUrl,
          viewCtx.completedInfo?.width,
          viewCtx.completedInfo?.height,
          resultTitle,
        );
      },
      onCopyDiagnostics(text: string) {
        const btn = document.getElementById("dz-btn-copy-diagnostics");
        const done = () => {
          if (btn) {
            btn.setAttribute("title", "Copied");
            btn.setAttribute("aria-label", "Copied");
            setTimeout(() => {
              try {
                if (btn.isConnected) {
                  btn.setAttribute("title", "Copy technical details");
                  btn.setAttribute("aria-label", "Copy technical details");
                }
              } catch {
                // Button may be gone after re-render; ignore.
              }
            }, 2000);
          }
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            (navigator.clipboard.writeText(text) as Promise<void>).then(done, done);
          } else if (text) {
            const ta = document.createElement("textarea");
            ta.value = text;
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
