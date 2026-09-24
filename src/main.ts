import { createTileDecoder } from "../packages/browser-runtime/src/tile-decode.ts";
// Web application entry point (single source of truth; Vite bundles this
// file directly, there is no hand-maintained `.js` mirror).
// Real pipeline: worker-hosted wasm core discovery -> direct-first transport
// with automatic eligible metadata-proxy fallback -> tile acquisition -> canvas
// assembly -> real PNG save. Nothing here fabricates progress or completion.
//
// The shared browser service implements the job service and forwards engine
// events as authoritative JobSnapshots; the
// view renders presentSnapshot of the latest snapshot. Host-local failures
// (invalid input, host rejections) render through presentFailure. No
// synthetic controller walk exists.

import { PROXY_TRANSPORT_LABEL } from "@dezoomify/app-model";
import type { Error as EngineError, Header, ProcessingRecipe } from "@dezoomify/wasm-bindings";
import type { HistoryEntry, JobHandle, JobSnapshot } from "../packages/app-model/src/index.ts";
import {
  cancelAllQueueEntries,
  clearHistory as clearHistoryStore,
  finishActiveQueueEntry,
  HISTORY_KEY_WEBSITE,
  isValidInputUrl,
  loadHistory as loadHistoryStore,
  pushHistory,
  saveHistory as saveHistoryStore,
  summarizeQueue,
  toHistoryEntry,
} from "../packages/app-model/src/index.ts";
import {
  canvasToPngBlob,
  isCanvasTaintError,
  saveBlobViaAnchor,
} from "../packages/browser-runtime/src/canvas-save.ts";
import type { StructuredFailure } from "../packages/browser-runtime/src/failure.ts";
import {
  type BrowserJobHandle,
  createBrowserJobService,
  createCanvasAssembly,
} from "../packages/browser-runtime/src/index.ts";
import { createJobActivity } from "../packages/browser-runtime/src/job-activity.ts";
import {
  BROWSER_MAX_PLAN_TILES,
  browserLimitsFor,
  type ClientHints,
  MAXIMUM_SELECTION_LIMITS,
  selectionLimitsFor,
} from "../packages/browser-runtime/src/limits.ts";
import { createLogger } from "../packages/browser-runtime/src/logging.ts";
import {
  canvasAllocationFailure,
  canvasSurfaceFailure,
  desktopHandoffLink,
  isLocalFileUrl,
  wantsDesktopHandoff,
} from "../packages/browser-runtime/src/plan-gates.ts";
import {
  createPreviewControls,
  setCanvasVisible,
} from "../packages/browser-runtime/src/preview.ts";
import { loadTileImage } from "../packages/browser-runtime/src/tile-draw.ts";
import {
  createTileThrottle,
  hostOf,
  REQUEST_TIMEOUT_MS,
  websiteTileConcurrency,
} from "../packages/browser-runtime/src/tile-policy.ts";
import { createWebFetcher, type WebFetcher } from "../packages/browser-runtime/src/web-fetch.ts";
import {
  errorTransportFor,
  isProxyEligible,
} from "../packages/browser-runtime/src/web-integration.ts";
import type {
  SnapshotPresentation,
  StructuredError,
  ViewContext,
} from "../packages/shared-ui/src/index.ts";
import {
  describeFailure,
  presentFailure,
  presentIdle,
  presentSnapshot,
  renderView,
  showDesktopAppGuidance,
  showExtensionGuidance,
  t,
} from "../packages/shared-ui/src/index.ts";
import {
  DEFAULT_PAGE_TITLE,
  isActiveJobStatus,
  jobPageTitle,
} from "../packages/shared-ui/src/view-helpers.ts";
import {
  classifyReadableBytes,
  noImageFoundError,
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
} from "./discovery.ts";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.ts";
import { createProxyTransport, PROXY_METADATA_MAX_BYTES } from "./proxyTransport.ts";
import { createWebQueue, enqueueWebQueue } from "./queue.ts";

const preview = createPreviewControls();

// One browser service attempt (worker, session, abort scope, disposal). The
// service owns the engine host; product code here keeps URL input, transport
// product actions, history, queue, and view wiring only.
let jobHandle: JobHandle | null = null;
let activeRun = 0;
let resultBlobUrl: string | null = null;
let resultTitle: string | undefined;
// Single authoritative snapshot of the active job, folded by the job service.
let activeSnapshot: JobSnapshot | null = null;
// Host-known display-only flag (tainted canvas): passed explicitly to
// presentSnapshot until the engine snapshot round-trips with
// output.disposition. Never written into the DTO.
let displayOnlyActive = false;
// Host-local failure that never reached an engine snapshot (invalid input,
// host rejections). View telemetry only; renders through presentFailure.
let hostFailure: StructuredError | null = null;
// Dedupe key for the engine-failure presentation below: failurePresentationOf
// runs on every render, so without this the failure would log and rebuild on
// every heartbeat (and the rebuild's re-render would recurse forever).
let lastEngineFailureKey: string | null = null;

// Recent-jobs history: local-only ledger, newest first, at most
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

// Website single-queue: enqueue while a job runs, sequential. The
// engine stays single-job; this queue lives in the integration layer (here),
// never in the engine. One active job at a time; further submits wait FIFO.
// A failed entry never stops the rest. Hash writes stay active-only: only the
// running job owns `window.location.hash`, queued URLs never do.
let webQueue = createWebQueue();

// --- Live job activity (drives the progressive-disclosure job view) ---
const jobActivity = createJobActivity({ onUpdate: update });
// Shared structured logger: console output plus the same lines mirrored into
// the job view's technical-details log (and copied diagnostics). The `web`
// context is the default here, so lines carry no bracket; runtime lines from
// the shared fetchers/painters join under the `runtime` code.
const webLog = createLogger("web", { defaultContext: "web" });
webLog.addSink((entry) => jobActivity.pushLog(entry.line));
let tileAttempts = 0;
const metadataAttempts: Array<{
  at: number;
  transport: string;
  target: string;
  outcome: string;
  durationMs: number;
  bytes?: number;
}> = [];

function resetActivity(url: string): void {
  tileAttempts = 0;
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
      const size =
        attempt.bytes === undefined ? "" : ` · ${Math.max(1, Math.round(attempt.bytes / 1024))} KB`;
      lines.push(
        `+${(attempt.at / 1000).toFixed(1)} s  ${attempt.target}  ${attempt.transport}  ${attempt.outcome}  ${attempt.durationMs} ms${size}`,
      );
    }
  }
  if (tileAttempts > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Tile acquisition");
    lines.push(`${tileAttempts} one-attempt requests`);
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

const tileThrottle = createTileThrottle();

// The product-specific proxy transport owns the actual /api/proxy POST.
// Browser-runtime owns direct-first orchestration, fallback, and
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
    onTileAttempt: () => {
      tileAttempts += 1;
      refreshDiagnostics();
    },
  },
  messages: {
    rateLimitedBySite: RATE_LIMITED_BY_SITE_MESSAGE,
    siteBusy: SITE_BUSY_MESSAGE,
    discoveryFailed: (_via) =>
      noImageFoundError().message ?? "No zoomable image was found at this address.",
  },
  throttle: (url) => tileThrottle.throttle(url),
});
/** Tear down the active service attempt: worker, session, assembly, buffers. */
function disposeAttempt(): void {
  const handle = jobHandle;
  jobHandle = null;
  try {
    void handle?.dispose();
  } catch {
    /* teardown is best effort */
  }
}

/** Normalize generated request headers for `fetch`. */
function headerRecord(headers: Header[] | undefined): Record<string, string> {
  return Object.fromEntries((headers ?? []).map(({ name, value }) => [name, value]));
}

let activeAssembly: ReturnType<typeof createCanvasAssembly> | null = null;

/** Device limit tier inputs: client hints where available, else the UA. */
function clientHints(): ClientHints {
  return navigator as unknown as ClientHints;
}

/** True when the next attempt must target the maximum known resolution. */
let tryMaximumNext = false;

function createAssembly(
  sourceUrl: string,
  processTile: (recipe: ProcessingRecipe, bytes: ArrayBuffer) => Promise<ArrayBuffer>,
): ReturnType<typeof createCanvasAssembly> {
  const decoder = createTileDecoder();
  return createCanvasAssembly({
    decode: (bytes: ArrayBuffer) => decoder.decode(bytes),
    processTile,
    createCanvas: (width: number, height: number) => {
      const element =
        (document.getElementById("rendering-canvas") as HTMLCanvasElement | null) ??
        document.createElement("canvas");
      try {
        element.width = width;
        element.height = height;
      } catch {
        throw canvasAllocationFailure(width, height, sourceUrl);
      }
      if (element.width !== width || element.height !== height) {
        throw canvasAllocationFailure(width, height, sourceUrl);
      }
      const ctx2d = element.getContext("2d");
      if (!ctx2d) {
        throw canvasSurfaceFailure(width, height, sourceUrl);
      }
      // Reveal the canvas before drawing (legacy parity): the picture stays
      // visible and right-clickable while the job finishes.
      setCanvasVisible(document, true);
      preview.resetTransform(document);
      return {
        width,
        height,
        ctx2d,
        toBlob: (cb: BlobCallback, mime?: string) => element.toBlob(cb, mime),
      };
    },
    encode: (canvas) =>
      canvasToPngBlob(canvas as unknown as { toBlob(cb: BlobCallback, mime?: string): void }),
    save: (blob, width, height) => {
      if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
      resultBlobUrl = URL.createObjectURL(blob as Blob);
      viewCtx.completedInfo = { width, height, mime: "image/png", blobUrl: resultBlobUrl };
      viewCtx.originClean = true;
      return "browser-save-ready";
    },
    sourceUrl,
    limits: browserLimitsFor(clientHints()),
    onDisplayOnly: () => {
      if (viewCtx.originClean === false) return;
      viewCtx.originClean = false;
      viewCtx.sourceUrl = sourceUrl;
      viewCtx.desktopHandoffUrl = desktopHandoffLink(sourceUrl);
      // Display-only is a host-known output fact; it rides an explicit
      // presentation flag, never a forged snapshot field.
      displayOnlyActive = true;
      const dims = activeAssembly?.dimensions();
      recordWebHistory(sourceUrl, dims?.width ?? 0, dims?.height ?? 0, "display");
      update();
    },
    isTaintError: (error) => isCanvasTaintError(error),
    log: (line) => webLog.info("runtime", line),
  });
}

/** Shared presenter for engine failures: headline plus stable classification. */
function presentEngineFailure(error: EngineError, url: string): void {
  const code = error.code;
  webLog.error("failed", `code=${code} message=${error.message}`);
  if (wantsDesktopHandoff(code)) {
    const link = desktopHandoffLink(url);
    if (link !== "") {
      viewCtx.sourceUrl = url;
      viewCtx.desktopHandoffUrl = link;
    }
  }
  const discovery = classifyDiscoveryCopy(code);
  hostFailure = describeFailure({
    code,
    engineDetail: error.detail ?? error.message,
    // The metadata proxy classifies its own outcome into user copy. Other
    // engine terminals keep the shared headline selected from their code.
    ...(error.transport === "metadata-proxy" ? { message: error.message } : {}),
    phase: error.phase,
    retryable: discovery ? discovery.retryable : error.retryable,
    transport: error.transport ?? errorTransportFor(code, webFetcher.getActiveTransport()),
    host: hostOf(url),
    url: error.request,
    http: error.http,
    preview: error.preview,
  });
  // No update() here: callers render (failurePresentationOf runs inside a
  // render pass); re-rendering from inside would recurse without bound.
}

/**
 * Website discovery facts for the shared failure table: the transport the
 * metadata rode plus the retry policy. Headline copy stays in the table;
 * only facts travel here.
 */
function classifyDiscoveryCopy(code: string): { retryable: boolean } | null {
  const lower = code.toLowerCase();
  if (
    code === "NO_IMAGE_FOUND" ||
    lower.indexOf("no-images") >= 0 ||
    lower.indexOf("catalog") >= 0 ||
    lower.indexOf("empty-resource") >= 0
  ) {
    return { retryable: false };
  }
  if (lower.indexOf("discovery") >= 0 || lower.indexOf("unknown-format") >= 0) {
    return { retryable: true };
  }
  return null;
}

function reportProgress(current: number, total: number, message: string): void {
  // Progress text is view telemetry only: it rides the shared view context
  // and never gates engine commands.
  viewCtx.currentProgress = { ...(viewCtx.currentProgress ?? {}), message };
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

/** Snapshot-failure presentation with the website's discovery copy. */
function failurePresentationOf(snapshot: JobSnapshot): SnapshotPresentation | null {
  const terminal = snapshot.terminal;
  if (!terminal || terminal.type !== "failed") return null;
  // Runs on every render: present (log + hostFailure) exactly once per
  // distinct engine failure, then reuse the stored presentation inputs.
  const key = `${terminal.error.code}\n${terminal.error.message}\n${terminal.error.detail ?? ""}`;
  if (key !== lastEngineFailureKey) {
    presentEngineFailure(terminal.error, viewCtx.jobActivity?.url ?? "");
    lastEngineFailureKey = key;
  }
  return hostFailure ? presentFailure(hostFailure, webFetcher.getActiveTransport()) : null;
}

function activeTransport(): string | null {
  return webFetcher.getActiveTransport();
}

function currentPresentation(): SnapshotPresentation {
  // Render the authoritative snapshot directly; hostFailure covers failures
  // that never reached a snapshot. Display-only rides an explicit host flag.
  if (hostFailure && !activeSnapshot) return presentFailure(hostFailure, activeTransport());
  if (!activeSnapshot) return presentIdle();
  return (
    failurePresentationOf(activeSnapshot) ??
    presentSnapshot(activeSnapshot, activeTransport(), { displayOnly: displayOnlyActive })
  );
}

function isTerminalNow(): boolean {
  return hostFailure !== null || (activeSnapshot?.terminal ?? null) !== null;
}

async function runJob(url: string, origin = url): Promise<void> {
  const run = ++activeRun;
  webFetcher.resetActiveTransport();
  tileThrottle.reset();
  resetActivity(origin);
  setCanvasVisible(document, false);
  preview.resetTransform(document);
  activeSnapshot = null;
  displayOnlyActive = false;
  hostFailure = null;
  lastEngineFailureKey = null;
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.sourceUrl = undefined;
  viewCtx.desktopHandoffUrl = undefined;
  viewCtx.originClean = true;
  resultTitle = undefined;
  // Hash owns the active job only: queued URLs never touch the hash until
  // they become active and reach this point.
  writeHash(origin);
  jobActivity.startHeartbeat();
  update();

  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let settledOutcome: "done" | "failed" | "cancelled" = "done";

  const onHostFailure = (error: unknown): void => {
    if (run !== activeRun) return;
    if (hostFailure || activeSnapshot?.terminal) return;
    const structured = error as {
      code?: unknown;
      message?: unknown;
      detail?: unknown;
      retryable?: unknown;
    };
    const code = typeof structured?.code === "string" ? structured.code : "OUTPUT_FAILED";
    webLog.error("host-failure", `code=${code} message=${String(structured?.message ?? code)}`);
    if (wantsDesktopHandoff(code)) {
      const link = desktopHandoffLink(origin);
      if (link !== "") {
        viewCtx.sourceUrl = origin;
        viewCtx.desktopHandoffUrl = link;
      }
    }
    hostFailure = describeFailure({
      code,
      engineDetail: typeof structured?.detail === "string" ? structured.detail : undefined,
      message: typeof structured?.message === "string" ? structured.message : undefined,
      retryable: typeof structured?.retryable === "boolean" ? structured.retryable : undefined,
      transport: "browser-session",
      host: hostOf(origin),
    });
    settledOutcome = "failed";
    update();
    settle();
  };

  // One shared browser service: the website injects its transport (direct
  // first with automatic eligible metadata-proxy fallback) and its output
  // assembly (visible page canvas, anchor save). Retries, partials, and
  // ordering stay in the engine; the abort scope and disposal live here.
  // The service is the browser JobService; the observer below renders and
  // drives product side effects.
  const service = createBrowserJobService({
    createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
    fetchResource: async (request, signal) => {
      if (request.purpose === "metadata") {
        const result = await webFetcher.fetchMetadataFor(
          request.uri,
          headerRecord(request.headers),
          signal,
        );
        return {
          bytes: new Uint8Array(result.bytes),
          ...(typeof result.finalUri === "string" && result.finalUri !== ""
            ? { finalUri: result.finalUri }
            : {}),
        };
      }
      const result = await webFetcher.fetchTileFor(
        request.uri,
        headerRecord(request.headers),
        signal,
      );
      return { bytes: new Uint8Array(result.bytes) };
    },
    loadDisplayImage: (tileUrl: string, signal: AbortSignal) =>
      loadTileImage(tileUrl, {
        signal,
        hooks: {
          onLog: (line) => {
            if (run === activeRun && jobHandle) webLog.info("runtime", line);
          },
          onRequestStart: (label) => jobActivity.noteRequestStart(label),
          onRequestEnd: (id, ok) => jobActivity.noteRequestEnd(id, ok),
          onUpdate: update,
        },
      }),
    classifyFailure: (error) => {
      const structured = error as Partial<StructuredFailure>;
      const reason = structured.cause?.reason;
      const transport = structured.transportKind ?? structured.cause?.transport;
      return {
        code: structured.fetchFailureCode ?? "DISCOVERY_FAILED",
        retryable: structured.retryable === true,
        message: structured.message ?? "The browser could not read this resource.",
        ...(reason ? { blocked_reason: reason } : {}),
        transport: transport ?? "direct",
        ...(typeof structured.http === "number" ? { http: structured.http } : {}),
        ...(typeof structured.retry_after_ms === "number"
          ? { retry_after_ms: structured.retry_after_ms }
          : {}),
        ...(typeof structured.cause?.http === "number" ? { http: structured.cause.http } : {}),
        ...(structured.preview ? { preview: structured.preview } : {}),
        ...(structured.detail ? { detail: structured.detail } : {}),
      };
    },
    createAssembly: ({ processTile }) => {
      const assembly = createAssembly(origin, processTile);
      activeAssembly = assembly;
      return assembly;
    },
    quotas: { max_concurrent_fetches: websiteTileConcurrency() },
    onRecoveryRequested: (generation) => {
      // Website policy answers partial decisions immediately as discard;
      // the engine owns the consequence.
      void jobHandle?.command({ type: "answer-partial", generation, decision: "discard" });
    },
    log: (level, code, detail) => {
      webLog.log(level, code, detail);
    },
  });

  const onSnapshot = (snapshot: JobSnapshot): void => {
    if (run !== activeRun) return;
    activeSnapshot = snapshot;
    const imageIndex = snapshot.selection.image;
    const selected =
      imageIndex === null || imageIndex === undefined
        ? undefined
        : snapshot.selection.catalog?.entries[imageIndex];
    const image = selected?.kind === "image" ? selected : undefined;
    resultTitle = typeof image?.title === "string" ? image.title : undefined;

    const completed = snapshot.progress.completed;
    const total = snapshot.progress.total ?? null;
    if (completed > 0 || total !== null) {
      reportProgress(completed, total ?? 0, `Saving ${total ?? "?"} tiles…`);
      update();
    }

    const terminalOutcome = snapshot.terminal;
    const terminalKind = terminalOutcome?.type;
    if (terminalOutcome && terminalKind) {
      if (activeAssembly?.isTainted() === true) {
        settledOutcome = "done";
        settle();
        return;
      }
      if (terminalKind === "completed" || terminalKind === "partial-completed") {
        recordWebHistory(
          origin,
          viewCtx.completedInfo?.width ?? 0,
          viewCtx.completedInfo?.height ?? 0,
          "png",
        );
        settledOutcome = "done";
        update();
        settle();
        return;
      }
      if (terminalKind === "failed") {
        settledOutcome = "failed";
        update();
        settle();
        return;
      }
      settledOutcome = "cancelled";
      update();
      settle();
    }
  };

  try {
    // A "Try maximum" attempt takes the largest known level; the canvas gate
    // reports what cannot work (allocation, context, or PNG encoding).
    const selection = tryMaximumNext ? MAXIMUM_SELECTION_LIMITS : selectionLimitsFor(clientHints());
    tryMaximumNext = false;
    const handle = await service.start(
      {
        inputs: [{ url }],
        engine: {
          max_tiles: BROWSER_MAX_PLAN_TILES,
          browser_selection: selection,
        },
      },
      { snapshot: onSnapshot, failure: onHostFailure },
    );
    if (run !== activeRun) {
      await handle.dispose();
      return;
    }
    jobHandle = handle;
    await finished;
    if (run !== activeRun) return;
  } catch (error) {
    if (run !== activeRun) return;
    onHostFailure(error);
  }
  if (run !== activeRun) return;
  jobActivity.stopHeartbeat();
  jobActivity.refreshLongestPending();
  disposeAttempt();
  activeAssembly = null;
  const queueOutcome: "done" | "failed" | "cancelled" = settledOutcome;
  // Sequential queue: the active entry settles, then the first waiting
  // entry (if any) becomes active and starts. A failed entry never stops
  // the rest. Engine stays single-job throughout.
  const settled = finishActiveQueueEntry(webQueue, queueOutcome);
  webQueue = settled.queue;
  const next = settled.next;
  if (next) {
    if (isTerminalNow()) {
      activeSnapshot = null;
      displayOnlyActive = false;
      hostFailure = null;
    }
    const summary = summarizeQueue(webQueue);
    webLog.info(
      "queue",
      `succeeded=${summary.succeeded} failed=${summary.failed} pending=${summary.pending}`,
    );
    void runJob(next.url);
  }
}

function submitQueuedUrl(url: string): void {
  const res = enqueueWebQueue(webQueue, url);
  webQueue = res.queue;
  if (res.code !== "ok" || !res.entry) {
    hostFailure = {
      code: "INVALID_URL",
      category: "validation",
      retryable: false,
      message: "Please enter a valid web address starting with http:// or https://",
    };
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

const viewCtx: ViewContext = {
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
  const presentation = currentPresentation();
  // In-flight tile count rides the context; counts come from the snapshot.
  // Telemetry (pending requests, progress text) never gates engine commands.
  const keptMessage = viewCtx.currentProgress?.message;
  const snapTotal = activeSnapshot?.progress.total ?? null;
  const snapDone = activeSnapshot?.progress.completed ?? 0;
  if (presentation.phase === "job" && snapTotal) {
    viewCtx.currentProgress = {
      active: Math.min(jobActivity.state.pendingRequests ?? 0, Math.max(0, snapTotal - snapDone)),
      ...(keptMessage ? { message: keptMessage } : {}),
    };
  } else if (keptMessage && presentation.phase === "job") {
    viewCtx.currentProgress = { message: keptMessage };
  } else if (presentation.phase !== "job") {
    viewCtx.currentProgress = undefined;
  }
  if (viewCtx.jobActivity) jobActivity.refreshLongestPending();
  syncPageTitle(presentation.phase === "job" ? "downloading" : presentation.phase);
  renderView(
    appContainer,
    presentation,
    {
      onSubmitUrl(url: string) {
        if (isLocalFileUrl(url)) {
          viewCtx.initialUrl = url;
          viewCtx.sourceUrl = url;
          viewCtx.desktopHandoffUrl = undefined;
          hostFailure = {
            code: "INVALID_URL",
            category: "validation",
            retryable: false,
            message:
              "Local files cannot be opened on this website. Use the desktop app for files on your computer.",
            transport: "direct",
            phase: "discovery",
            detail: "Local file: open the desktop app and choose the file there; nothing is sent.",
          };
          update();
          return;
        }
        if (!isValidInputUrl(url)) {
          hostFailure = {
            code: "INVALID_URL",
            category: "validation",
            retryable: false,
            message: "Please enter a valid web address starting with http:// or https://",
          };
          update();
          return;
        }
        submitQueuedUrl(url);
      },
      onPause() {
        // Pause v1: stop scheduling new tiles; in-flight finishes, the
        // canvas is retained, resume re-drives the FIFO queue.
        void jobHandle?.command({ type: "pause" });
        jobActivity.pause();
        webLog.info("paused", "no new pieces are being fetched");
        update();
      },
      onResume() {
        void jobHandle?.command({ type: "resume" });
        jobActivity.resume();
        webLog.info("resumed", "fetching queued pieces again");
        update();
      },
      onCancel() {
        // Stop returns directly to the initial view. Effects from the retired
        // run finish harmlessly without mutating the replacement job.
        stopActiveJob();
        update();
      },
      onReset() {
        stopActiveJob();
        update();
      },
      onTryMaximum() {
        // Replace the current attempt with one targeting the maximum known
        // resolution; failures report with the desktop-app action.
        const lastUrl = viewCtx.jobActivity?.url ?? viewCtx.initialUrl;
        if (!lastUrl || !isValidInputUrl(lastUrl)) return;
        stopActiveJob();
        tryMaximumNext = true;
        submitQueuedUrl(lastUrl);
      },
      onRetrySameUrl() {
        const lastUrl = viewCtx.jobActivity?.url ?? viewCtx.initialUrl;
        if (!lastUrl || !isValidInputUrl(lastUrl)) return;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
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

function resetJobViewState(): void {
  activeSnapshot = null;
  displayOnlyActive = false;
  hostFailure = null;
  lastEngineFailureKey = null;
  lastEngineFailureKey = null;
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.jobActivity = undefined;
  viewCtx.initialUrl = undefined;
  viewCtx.sourceUrl = undefined;
  viewCtx.desktopHandoffUrl = undefined;
}

/** Retire the active run and every queued entry; the view returns to idle. */
function stopActiveJob(): void {
  activeRun += 1;
  jobActivity.stopHeartbeat();
  disposeAttempt();
  webFetcher.resetActiveTransport();
  tileThrottle.reset();
  setCanvasVisible(document, false);
  preview.resetTransform(document);
  // Reset clears the whole queue: no new work is issued afterwards.
  webQueue = cancelAllQueueEntries(webQueue);
  webQueue = createWebQueue();
  resetJobViewState();
  clearHash();
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
}

function startFromHash(): void {
  if (typeof window === "undefined") return;
  const raw = parseHash(window.location.hash);
  if (raw && looksLikeUsableUrl(raw) && isValidInputUrl(raw)) {
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
  document
    .getElementById("dz-nav-btn-extension")
    ?.addEventListener("click", () => showExtensionGuidance(document));
  document.getElementById("dz-nav-btn-desktop")?.addEventListener("click", () =>
    showDesktopAppGuidance(document, {
      userAgent: navigator.userAgent,
      platform: (navigator as unknown as { platform?: string }).platform,
    }),
  );
  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", () => {
      const raw = parseHash(window.location.hash);
      const current = viewCtx.jobActivity?.url;
      if (raw && raw !== current && looksLikeUsableUrl(raw) && isValidInputUrl(raw)) {
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

export { currentPresentation, update };
