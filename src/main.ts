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
import type { Error as EngineError, Header } from "@dezoomify/wasm-bindings";
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
import { saveBlobViaAnchor } from "../packages/browser-runtime/src/canvas-save.ts";
import type { StructuredFailure } from "../packages/browser-runtime/src/failure.ts";
import {
  type BrowserAssemblyArgs,
  createBrowserAssembly,
  createBrowserJobService,
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

function newAttempt() {
  const attempt = {
    retired: false,
    settle: () => {},
    jobHandle: null as JobHandle | null,
    resultBlobUrl: null as string | null,
    resultTitle: undefined as string | undefined,
    activeSnapshot: null as JobSnapshot | null,
    displayOnlyActive: false,
    hostFailure: null as StructuredError | null,
    lastEngineFailureKey: null as string | null,
    pendingRecoveryGeneration: null as number | null,
    activeAssembly: null as ReturnType<typeof createBrowserAssembly> | null,
    jobActivity: null! as ReturnType<typeof createJobActivity>,
    tileAttempts: 0,
    metadataAttempts: [] as Array<{
      at: number;
      transport: string;
      target: string;
      outcome: string;
      durationMs: number;
      bytes?: number;
    }>,
    tileThrottle: createTileThrottle(),
    webFetcher: null! as WebFetcher,
    viewCtx: createViewContext(),
  };
  attempt.jobActivity = createJobActivity({
    onUpdate: () => {
      if (owns(attempt)) update();
    },
  });
  attempt.webFetcher = makeWebFetcher(attempt);
  return attempt;
}
type WebAttempt = ReturnType<typeof newAttempt>;
let currentAttempt: WebAttempt;
function owns(attempt: WebAttempt): boolean {
  return currentAttempt === attempt && !attempt.retired;
}

function retireAttempt(): void {
  currentAttempt.retired = true;
  currentAttempt.settle();
  currentAttempt.jobActivity.stopHeartbeat();
  disposeAttempt();
  if (currentAttempt.resultBlobUrl) URL.revokeObjectURL(currentAttempt.resultBlobUrl);
}

// One browser service attempt (worker, session, abort scope, disposal). The
// service owns the engine host; product code here keeps URL input, transport
// product actions, history, queue, and view wiring only.
// Single authoritative snapshot of the active job, folded by the job service.
// Host-known display-only flag (tainted canvas): passed explicitly to
// presentSnapshot until the engine snapshot round-trips with
// output.disposition. Never written into the DTO.
// Host-local failure that never reached an engine snapshot (invalid input,
// host rejections). View telemetry only; renders through presentFailure.
// Dedupe key for the engine-failure presentation below: failurePresentationOf
// runs on every render, so without this the failure would log and rebuild on
// every heartbeat (and the rebuild's re-render would recurse forever).

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
  currentAttempt.viewCtx.history = [...webHistory];
}

// Website single-queue: enqueue while a job runs, sequential. The
// engine stays single-job; this queue lives in the integration layer (here),
// never in the engine. One active job at a time; further submits wait FIFO.
// A failed entry never stops the rest. Hash writes stay active-only: only the
// running job owns `window.location.hash`, queued URLs never do.
let webQueue = createWebQueue();

// --- Live job activity (drives the progressive-disclosure job view) ---
// Shared structured logger: console output plus the same lines mirrored into
// the job view's technical-details log (and copied diagnostics). The `web`
// context is the default here, so lines carry no bracket; runtime lines from
// the shared fetchers/painters join under the `runtime` code.
const webLog = createLogger("web", { defaultContext: "web" });
webLog.addSink((entry) => currentAttempt.jobActivity.pushLog(entry.line));
function resetActivity(url: string): void {
  currentAttempt.tileAttempts = 0;
  currentAttempt.metadataAttempts.length = 0;
  currentAttempt.jobActivity.reset(url, REQUEST_TIMEOUT_MS);
  currentAttempt.jobActivity.state.detail = `Contacting ${hostOf(url)}…`;
  currentAttempt.viewCtx.jobActivity = currentAttempt.jobActivity.state;
}

/** Keep diagnostics bounded and useful without retaining individual tile URLs. */
function refreshDiagnostics(attempt = currentAttempt): void {
  const a = attempt.jobActivity.state;
  const lines: string[] = [];
  if (attempt.metadataAttempts.length > 0) {
    lines.push("Metadata requests");
    for (const entry of attempt.metadataAttempts) {
      const size =
        entry.bytes === undefined ? "" : ` · ${Math.max(1, Math.round(entry.bytes / 1024))} KB`;
      lines.push(
        `+${(entry.at / 1000).toFixed(1)} s  ${entry.target}  ${entry.transport}  ${entry.outcome}  ${entry.durationMs} ms${size}`,
      );
    }
  }
  if (attempt.tileAttempts > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Tile acquisition");
    lines.push(`${attempt.tileAttempts} one-attempt requests`);
  }
  a.diagnostics = lines.join("\n");
}

function recordMetadataAttempt(
  startedAt: number,
  transport: "direct" | "metadata proxy",
  target: string,
  outcome: string,
  bytes: number | undefined,
  attempt: WebAttempt,
): void {
  attempt.metadataAttempts.push({
    at: Math.max(0, startedAt - (attempt.jobActivity.state.startedAt ?? startedAt)),
    transport,
    target,
    outcome,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(typeof bytes === "number" ? { bytes } : {}),
  });
  if (attempt.metadataAttempts.length > 20)
    attempt.metadataAttempts.splice(0, attempt.metadataAttempts.length - 20);
  refreshDiagnostics(attempt);
}

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

function makeWebFetcher(attempt: WebAttempt): WebFetcher {
  return createWebFetcher({
    proxyTransport,
    isProxyEligible,
    classifyHint: (bytes, info) => classifyReadableBytes(bytes, info),
    hooks: {
      onRequestStart: (label) => attempt.jobActivity.noteRequestStart(label),
      onRequestEnd: (id, ok) => attempt.jobActivity.noteRequestEnd(id, ok),
      onLog: (line) => {
        if (owns(attempt)) webLog.info("runtime", line);
      },
      onUpdate: () => {
        if (owns(attempt)) update();
      },
      onMetadataAttempt: ({ startedAt, transport, target, outcome, bytes }) =>
        recordMetadataAttempt(startedAt, transport, target, outcome, bytes, attempt),
      onTileAttempt: () => {
        attempt.tileAttempts += 1;
        refreshDiagnostics(attempt);
      },
    },
    messages: {
      rateLimitedBySite: RATE_LIMITED_BY_SITE_MESSAGE,
      siteBusy: SITE_BUSY_MESSAGE,
      discoveryFailed: (_via) =>
        noImageFoundError().message ?? "No zoomable image was found at this address.",
    },
    throttle: (url) => attempt.tileThrottle.throttle(url),
  });
}
currentAttempt = newAttempt();
/** Tear down the active service attempt: worker, session, assembly, buffers. */
function disposeAttempt(): void {
  const handle = currentAttempt.jobHandle;
  currentAttempt.jobHandle = null;
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

/** Device limit tier inputs: client hints where available, else the UA. */
function clientHints(): ClientHints {
  return navigator as unknown as ClientHints;
}

/** True when the next attempt must target the maximum known resolution. */
let tryMaximumNext = false;

function createAssembly(
  sourceUrl: string,
  args: BrowserAssemblyArgs,
  attempt: WebAttempt,
): ReturnType<typeof createBrowserAssembly> {
  return createBrowserAssembly({
    ...args,
    sourceUrl,
    canvas: () => {
      const existing = document.getElementById("rendering-canvas");
      return existing instanceof HTMLCanvasElement ? existing : document.createElement("canvas");
    },
    showCanvas: () => {
      setCanvasVisible(document, true);
      preview.resetTransform(document);
    },
    save: (blob, width, height, signal) => {
      signal.throwIfAborted();
      if (!owns(attempt)) throw new DOMException("Result retired", "AbortError");
      if (attempt.resultBlobUrl) URL.revokeObjectURL(attempt.resultBlobUrl);
      attempt.resultBlobUrl = URL.createObjectURL(blob);
      attempt.viewCtx.completedInfo = {
        width,
        height,
        mime: "image/png",
        blobUrl: attempt.resultBlobUrl,
      };
      attempt.viewCtx.originClean = true;
      return "browser-save-ready";
    },
    limits: browserLimitsFor(clientHints()),
    onDisplayOnly: () => {
      if (!owns(attempt)) return;
      if (attempt.viewCtx.originClean === false) return;
      attempt.viewCtx.originClean = false;
      attempt.viewCtx.sourceUrl = sourceUrl;
      attempt.viewCtx.desktopHandoffUrl = desktopHandoffLink(sourceUrl);
      // Display-only is a host-known output fact; it rides an explicit
      // presentation flag, never a forged snapshot field.
      attempt.displayOnlyActive = true;
      const dims = attempt.activeAssembly?.dimensions();
      recordWebHistory(sourceUrl, dims?.width ?? 0, dims?.height ?? 0, "display");
      update();
    },
    log: (line) => {
      if (owns(attempt)) webLog.info("runtime", line);
    },
  });
}

/** Shared presenter for engine failures: headline plus stable classification. */
function presentEngineFailure(error: EngineError, url: string): void {
  const code = error.code;
  webLog.error("failed", `code=${code} message=${error.message}`);
  if (wantsDesktopHandoff(code)) {
    const link = desktopHandoffLink(url);
    if (link !== "") {
      currentAttempt.viewCtx.sourceUrl = url;
      currentAttempt.viewCtx.desktopHandoffUrl = link;
    }
  }
  const discovery = classifyDiscoveryCopy(code);
  currentAttempt.hostFailure = describeFailure({
    code,
    engineDetail: error.detail ?? error.message,
    // The metadata proxy classifies its own outcome into user copy. Other
    // engine terminals keep the shared headline selected from their code.
    ...(error.transport === "metadata-proxy" ? { message: error.message } : {}),
    phase: error.phase,
    retryable: discovery ? discovery.retryable : error.retryable,
    transport:
      error.transport ?? errorTransportFor(code, currentAttempt.webFetcher.getActiveTransport()),
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
  currentAttempt.viewCtx.currentProgress = {
    ...(currentAttempt.viewCtx.currentProgress ?? {}),
    message,
  };
  currentAttempt.jobActivity.touchProgress();
  currentAttempt.jobActivity.scheduleUpdate();
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
  // Runs on every render: present (log + currentAttempt.hostFailure) exactly once per
  // distinct engine failure, then reuse the stored presentation inputs.
  const key = `${terminal.error.code}\n${terminal.error.message}\n${terminal.error.detail ?? ""}`;
  if (key !== currentAttempt.lastEngineFailureKey) {
    presentEngineFailure(terminal.error, currentAttempt.viewCtx.jobActivity?.url ?? "");
    currentAttempt.lastEngineFailureKey = key;
  }
  return currentAttempt.hostFailure
    ? presentFailure(currentAttempt.hostFailure, currentAttempt.webFetcher.getActiveTransport())
    : null;
}

function activeTransport(): string | null {
  return currentAttempt.webFetcher.getActiveTransport();
}

function currentPresentation(): SnapshotPresentation {
  // Render the authoritative snapshot directly; currentAttempt.hostFailure covers failures
  // that never reached a snapshot. Display-only rides an explicit host flag.
  if (currentAttempt.hostFailure)
    return presentFailure(currentAttempt.hostFailure, activeTransport());
  if (!currentAttempt.activeSnapshot) return presentIdle();
  return (
    failurePresentationOf(currentAttempt.activeSnapshot) ??
    presentSnapshot(currentAttempt.activeSnapshot, activeTransport(), {
      displayOnly: currentAttempt.displayOnlyActive,
    })
  );
}

function isTerminalNow(): boolean {
  return (
    currentAttempt.hostFailure !== null ||
    (currentAttempt.activeSnapshot?.terminal ?? null) !== null
  );
}

async function runJob(url: string, origin = url): Promise<void> {
  retireAttempt();
  currentAttempt = newAttempt();
  const attempt = currentAttempt;
  attempt.webFetcher.resetActiveTransport();
  attempt.tileThrottle.reset();
  resetActivity(origin);
  setCanvasVisible(document, false);
  preview.resetTransform(document);
  attempt.activeSnapshot = null;
  attempt.displayOnlyActive = false;
  attempt.hostFailure = null;
  attempt.lastEngineFailureKey = null;
  attempt.viewCtx.currentProgress = undefined;
  attempt.viewCtx.completedInfo = undefined;
  attempt.viewCtx.sourceUrl = undefined;
  attempt.viewCtx.desktopHandoffUrl = undefined;
  attempt.viewCtx.originClean = true;
  attempt.resultTitle = undefined;
  // Hash owns the active job only: queued URLs never touch the hash until
  // they become active and reach this point.
  writeHash(origin);
  attempt.jobActivity.startHeartbeat();
  update();

  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
    attempt.settle = resolve;
  });
  let settledOutcome: "done" | "failed" | "cancelled" = "done";

  const onHostFailure = (error: unknown): void => {
    if (!owns(attempt)) return;
    if (attempt.hostFailure || attempt.activeSnapshot?.terminal) return;
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
        attempt.viewCtx.sourceUrl = origin;
        attempt.viewCtx.desktopHandoffUrl = link;
      }
    }
    attempt.hostFailure = describeFailure({
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
        const result = await attempt.webFetcher.fetchMetadataFor(
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
      const result = await attempt.webFetcher.fetchTileFor(
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
            if (owns(attempt) && attempt.jobHandle) webLog.info("runtime", line);
          },
          onRequestStart: (label) => attempt.jobActivity.noteRequestStart(label),
          onRequestEnd: (id, ok) => attempt.jobActivity.noteRequestEnd(id, ok),
          onUpdate: () => {
            if (owns(attempt)) update();
          },
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
    createAssembly: (args) => {
      const assembly = createAssembly(origin, args, attempt);
      attempt.activeAssembly = assembly;
      return assembly;
    },
    quotas: { max_concurrent_fetches: websiteTileConcurrency() },
    onRecoveryRequested: (generation) => {
      // Website policy answers partial decisions immediately as discard;
      // the engine owns the consequence.
      if (!owns(attempt)) return;
      if (attempt.jobHandle) {
        void attempt.jobHandle.command({ type: "answer-partial", generation, decision: "discard" });
      } else {
        attempt.pendingRecoveryGeneration = generation;
      }
    },
    log: (level, code, detail) => {
      if (owns(attempt)) webLog.log(level, code, detail);
    },
  });

  const onSnapshot = (snapshot: JobSnapshot): void => {
    if (!owns(attempt)) return;
    attempt.activeSnapshot = snapshot;
    const imageIndex = snapshot.selection.image;
    const selected =
      imageIndex === null || imageIndex === undefined
        ? undefined
        : snapshot.selection.catalog?.entries[imageIndex];
    const image = selected?.kind === "image" ? selected : undefined;
    attempt.resultTitle = typeof image?.title === "string" ? image.title : undefined;

    const completed = snapshot.progress.completed;
    const total = snapshot.progress.total ?? null;
    if (completed > 0 || total !== null) {
      reportProgress(completed, total ?? 0, `Saving ${total ?? "?"} tiles…`);
      update();
    }

    const terminalOutcome = snapshot.terminal;
    const terminalKind = terminalOutcome?.type;
    if (terminalOutcome && terminalKind) {
      if (attempt.activeAssembly?.isTainted() === true) {
        settledOutcome = "done";
        settle();
        return;
      }
      if (terminalKind === "completed" || terminalKind === "partial-completed") {
        recordWebHistory(
          origin,
          attempt.viewCtx.completedInfo?.width ?? 0,
          attempt.viewCtx.completedInfo?.height ?? 0,
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
    if (!owns(attempt)) {
      await handle.dispose();
      return;
    }
    attempt.jobHandle = handle;
    if (attempt.pendingRecoveryGeneration !== null) {
      const generation = attempt.pendingRecoveryGeneration;
      attempt.pendingRecoveryGeneration = null;
      void handle.command({ type: "answer-partial", generation, decision: "discard" });
    }
    await finished;
    if (!owns(attempt)) return;
  } catch (error) {
    if (!owns(attempt)) return;
    onHostFailure(error);
  }
  if (!owns(attempt)) return;
  attempt.jobActivity.stopHeartbeat();
  attempt.jobActivity.refreshLongestPending();
  disposeAttempt();
  attempt.activeAssembly = null;
  const queueOutcome: "done" | "failed" | "cancelled" = settledOutcome;
  // Sequential queue: the active entry settles, then the first waiting
  // entry (if any) becomes active and starts. A failed entry never stops
  // the rest. Engine stays single-job throughout.
  const settled = finishActiveQueueEntry(webQueue, queueOutcome);
  webQueue = settled.queue;
  const next = settled.next;
  if (next) {
    if (isTerminalNow()) {
      attempt.activeSnapshot = null;
      attempt.displayOnlyActive = false;
      attempt.hostFailure = null;
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
    currentAttempt.hostFailure = {
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

function createViewContext(): ViewContext {
  return {
    capabilities: {
      extensionAvailable: false,
      nativeAvailable: false,
      browserCanSave: true,
    },
    originClean: true,
    initialUrl: undefined,
    history: [...webHistory],
  };
}

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
    const url =
      currentAttempt.jobActivity.state.url ??
      currentAttempt.viewCtx.jobActivity?.url ??
      currentAttempt.viewCtx.initialUrl;
    const next = jobPageTitle(url);
    if (document.title !== next) document.title = next;
  } catch {
    // Title updates must never break the job.
  }
}

function update(): void {
  if (!appContainer) return;
  const attempt = currentAttempt;
  const presentation = currentPresentation();
  // In-flight tile count rides the context; counts come from the snapshot.
  // Telemetry (pending requests, progress text) never gates engine commands.
  const keptMessage = attempt.viewCtx.currentProgress?.message;
  const snapTotal = attempt.activeSnapshot?.progress.total ?? null;
  const snapDone = attempt.activeSnapshot?.progress.completed ?? 0;
  if (presentation.phase === "job" && snapTotal) {
    attempt.viewCtx.currentProgress = {
      active: Math.min(
        attempt.jobActivity.state.pendingRequests ?? 0,
        Math.max(0, snapTotal - snapDone),
      ),
      ...(keptMessage ? { message: keptMessage } : {}),
    };
  } else if (keptMessage && presentation.phase === "job") {
    attempt.viewCtx.currentProgress = { message: keptMessage };
  } else if (presentation.phase !== "job") {
    attempt.viewCtx.currentProgress = undefined;
  }
  if (attempt.viewCtx.jobActivity) attempt.jobActivity.refreshLongestPending();
  syncPageTitle(presentation.phase === "job" ? "downloading" : presentation.phase);
  renderView(
    appContainer,
    presentation,
    {
      onSubmitUrl(url: string) {
        if (isLocalFileUrl(url)) {
          attempt.viewCtx.initialUrl = url;
          attempt.viewCtx.sourceUrl = url;
          attempt.viewCtx.desktopHandoffUrl = undefined;
          attempt.hostFailure = {
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
          attempt.hostFailure = {
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
        if (!owns(attempt)) return;
        // Pause v1: stop scheduling new tiles; in-flight finishes, the
        // canvas is retained, resume re-drives the FIFO queue.
        void attempt.jobHandle?.command({ type: "pause" });
        attempt.jobActivity.pause();
        webLog.info("paused", "no new pieces are being fetched");
        update();
      },
      onResume() {
        if (!owns(attempt)) return;
        void attempt.jobHandle?.command({ type: "resume" });
        attempt.jobActivity.resume();
        webLog.info("resumed", "fetching queued pieces again");
        update();
      },
      onCancel() {
        if (!owns(attempt)) return;
        // Stop returns directly to the initial view. Effects from the retired
        // run finish harmlessly without mutating the replacement job.
        stopActiveJob();
        update();
      },
      onReset() {
        if (!owns(attempt)) return;
        stopActiveJob();
        update();
      },
      onTryMaximum() {
        if (!owns(attempt)) return;
        // Replace the current attempt with one targeting the maximum known
        // resolution; failures report with the desktop-app action.
        const lastUrl = attempt.viewCtx.jobActivity?.url ?? attempt.viewCtx.initialUrl;
        if (!lastUrl || !isValidInputUrl(lastUrl)) return;
        stopActiveJob();
        tryMaximumNext = true;
        submitQueuedUrl(lastUrl);
      },
      onRetrySameUrl() {
        if (!owns(attempt)) return;
        const lastUrl = attempt.viewCtx.jobActivity?.url ?? attempt.viewCtx.initialUrl;
        if (!lastUrl || !isValidInputUrl(lastUrl)) return;
        attempt.viewCtx.currentProgress = undefined;
        attempt.viewCtx.completedInfo = undefined;
        attempt.viewCtx.sourceUrl = undefined;
        attempt.viewCtx.desktopHandoffUrl = undefined;
        submitQueuedUrl(lastUrl);
      },
      onSave() {
        if (!owns(attempt)) return;
        if (!attempt.resultBlobUrl) return;
        saveBlobViaAnchor(
          document,
          attempt.resultBlobUrl,
          attempt.viewCtx.completedInfo?.width,
          attempt.viewCtx.completedInfo?.height,
          attempt.resultTitle,
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
        attempt.viewCtx.history = [];
        update();
      },
    },
    attempt.viewCtx,
  );
}

function resetJobViewState(): void {
  currentAttempt.activeSnapshot = null;
  currentAttempt.displayOnlyActive = false;
  currentAttempt.hostFailure = null;
  currentAttempt.lastEngineFailureKey = null;
  currentAttempt.viewCtx.currentProgress = undefined;
  currentAttempt.viewCtx.completedInfo = undefined;
  currentAttempt.viewCtx.jobActivity = undefined;
  currentAttempt.viewCtx.initialUrl = undefined;
  currentAttempt.viewCtx.sourceUrl = undefined;
  currentAttempt.viewCtx.desktopHandoffUrl = undefined;
}

/** Retire the active run and every queued entry; the view returns to idle. */
function stopActiveJob(): void {
  retireAttempt();
  currentAttempt = newAttempt();
  currentAttempt.webFetcher.resetActiveTransport();
  currentAttempt.tileThrottle.reset();
  setCanvasVisible(document, false);
  preview.resetTransform(document);
  // Reset clears the whole queue: no new work is issued afterwards.
  webQueue = cancelAllQueueEntries(webQueue);
  webQueue = createWebQueue();
  resetJobViewState();
  clearHash();
  if (currentAttempt.resultBlobUrl) {
    URL.revokeObjectURL(currentAttempt.resultBlobUrl);
    currentAttempt.resultBlobUrl = null;
  }
}

function startFromHash(): void {
  if (typeof window === "undefined") return;
  const raw = parseHash(window.location.hash);
  if (raw && looksLikeUsableUrl(raw) && isValidInputUrl(raw)) {
    currentAttempt.viewCtx.initialUrl = raw;
    update();
    runJob(raw);
  } else if (raw) {
    currentAttempt.viewCtx.initialUrl = raw;
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
      const current = currentAttempt.viewCtx.jobActivity?.url;
      if (raw && raw !== current && looksLikeUsableUrl(raw) && isValidInputUrl(raw)) {
        runJob(raw);
      } else if (!raw && !current) {
        currentAttempt.viewCtx.initialUrl = undefined;
        update();
      }
    });
  }
  startFromHash();
  update();
}

export { currentPresentation, update };
