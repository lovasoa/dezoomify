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
import {
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
  classifyReadableBytes,
  discoveryFailedError,
  noImageFoundError,
} from "./discovery.ts";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.ts";
import { errorTransportFor, isOrdinaryImageTile, isProxyEligible } from "./webIntegration.ts";
import { createProxyTransport, PROXY_METADATA_MAX_BYTES } from "./proxyTransport.ts";
import {
  createDiscoveryClient,
  type DiscoveryClient,
  type PlanTile,
  type WebCatalog,
} from "../packages/browser-runtime/src/session.ts";
import { failure, stableErrorCode } from "../packages/browser-runtime/src/failure.ts";
import {
  BROWSER_LIMITS,
  BROWSER_MAX_CANVAS_AREA,
  BROWSER_MAX_CANVAS_SIDE,
  BROWSER_MAX_PLAN_TILES,
} from "../packages/browser-runtime/src/limits.ts";
import {
  assertDeclaredSizeFitsBrowser,
  assertPlanFitsBrowser,
  categoryFor,
  desktopHandoffLink,
  isAllowedSourceUrl,
  isLocalFileUrl,
  mapWorkerLimitExceeded,
  phaseFor,
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
  shortUrl,
  websiteTileConcurrency,
} from "../packages/browser-runtime/src/tile-policy.ts";
import { createTileDecoder } from "../packages/browser-runtime/src/tile-decode.ts";
import { createTilePainter, loadTileImage } from "../packages/browser-runtime/src/tile-draw.ts";
import { createJobActivity } from "../packages/browser-runtime/src/job-activity.ts";
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
let client: DiscoveryClient | null = null;
let jobToken = 0;
let resultBlobUrl: string | null = null;
let resultTitle: string | undefined;
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
    onLog: (line) => jobActivity.pushLog(line),
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
): Promise<{ ok: boolean; width: number; height: number }> {
  try {
    const { bytes } = await webFetcher.fetchTileFor(url, headers);
    const bitmap = await tileDecoder.decode(bytes);
    const size = { ok: bitmap.width > 0 && bitmap.height > 0, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    // Readable bytes are unavailable (e.g. no CORS grant). Probing only
    // needs dimensions, which a plain <img> reports without byte access.
    try {
      const img = await loadTileImage(url, {
        hooks: {
          onRequestStart: (label) => jobActivity.noteRequestStart(label),
          onRequestEnd: (id, ok) => jobActivity.noteRequestEnd(id, ok),
          onUpdate: update,
        },
      });
      return { ok: img.naturalWidth > 0 && img.naturalHeight > 0, width: img.naturalWidth, height: img.naturalHeight };
    } catch {
      return { ok: false, width: 0, height: 0 };
    }
  }
}

function disposeClient(): void {
  client?.dispose();
  client = null;
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

function makeClient(): DiscoveryClient {
  disposeClient();
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return createDiscoveryClient({
    worker,
    fetchMetadata: webFetcher.fetchMetadataFor,
    fetchTile: webFetcher.fetchTileFor,
    probeSize: probeSizeFor,
  });
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
  resultTitle = undefined;
  // Hash owns the active job only: queued URLs never touch the hash until
  // they become active and reach this point.
  writeHash(url);
  let queueOutcome: "done" | "failed" | "cancelled" = "done";
  jobActivity.startHeartbeat();
  jobActivity.setStep("Finding the zoomable image…", `Contacting ${hostOf(url)}…`);
  controller.dispatch(nextEvent("start-discovery", { transport: "direct" }) as never);
  update();
  try {
    client = makeClient();
    jobActivity.pushLog(`Starting discovery for ${shortUrl(url)}`);
    const catalog: WebCatalog = await client.start(url);
    if (token !== jobToken) return;
    const via = webFetcher.getActiveTransport() === PROXY_TRANSPORT_LABEL ? "proxy" : "direct";
    if (catalog.images.length === 0) {
      throw failure(
        "NO_IMAGE_FOUND",
        noImageFoundError(via).message,
        false,
        "discovery returned an empty image catalog",
      );
    }
    jobActivity.pushLog(`Found ${catalog.images.length} image${catalog.images.length === 1 ? "" : "s"}`);
    controller.dispatch(
      nextEvent("images-found", { imageCount: catalog.images.length, transport: via }) as never,
    );
    const foundNoun = catalog.images.length === 1 ? "1 image" : `${catalog.images.length} images`;
    jobActivity.setStep(
      `Found ${foundNoun}, saving largest that fits…`,
      "The website saves the first image automatically; use the desktop app to choose another.",
    );
    controller.dispatch(nextEvent("image-chosen") as never);
    const selection = pickEngineSelection(catalog, BROWSER_LIMITS);
    if (!selection) {
      throw failure("CATALOG_UNSELECTABLE", "The image catalog has no level this browser can select.", false);
    }
    const image = catalog.images[selection.image];
    resultTitle = image?.title;
    const level = image?.levels[selection.level];
    const declared = level && level.width > 0 && level.height > 0
      ? { x: level.width, y: level.height }
      : undefined;
    const declaredFailure = assertDeclaredSizeFitsBrowser(declared, url);
    if (declaredFailure) throw declaredFailure;
    jobActivity.setStep("Choosing the highest resolution…");
    controller.dispatch(nextEvent("level-chosen") as never);
    jobActivity.setStep("Checking the image size…");
    controller.dispatch(nextEvent("preflight-ok", { transport: via }) as never);
    update();

    let plan;
    try {
      plan = await client.plan(selection.image, selection.level);
    } catch (error) {
      const mapped = mapWorkerLimitExceeded(error, declared?.x ?? 0, declared?.y ?? 0, url);
      if (mapped) throw mapped;
      throw error;
    }
    if (token !== jobToken) return;
    jobActivity.pushLog(`Image size determined; planning ${plan.tiles.length} tiles`);
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
    const planFailure = assertPlanFitsBrowser(width, height, plan.tiles.length, url);
    if (planFailure) throw planFailure;
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
    setCanvasVisible(document, true);
    preview.resetTransform(document);

    const total = plan.tiles.length;
    viewCtx.imageChoice = { width, height, tiles: total };
    jobActivity.setStep("Fetching image tiles…", `${total} tiles at full resolution`);
    reportProgress(0, total, `Saving ${total} tiles…`);
    let done = 0;
    let failed: unknown = null;
    let tainted = false;
    const finishDisplayOnly = (): void => {
      viewCtx.originClean = false;
      viewCtx.sourceUrl = url;
      viewCtx.desktopHandoffUrl = desktopHandoffLink(url);
      jobActivity.setStep("Displaying the image…", "This site shows its pieces without letting the browser keep a copy.");
      reportProgress(total, total, `Displaying ${total} tiles…`);
      jobActivity.pushLog(`Done: ${width}×${height} display-only (${total} tiles, tainted canvas)`);
      setCanvasVisible(document, true);
      preview.resetTransform(document);
      controller.dispatch(nextEvent("preflight-display-only", { transport: "display" }) as never);
      recordWebHistory(url, width, height, "display");
      update();
    };
    const tilePainter = createTilePainter({
      fetchTile: (uri, headers) => webFetcher.fetchTileFor(uri, headers),
      fetchTileOnce: (uri, headers) => webFetcher.fetchTileFor(uri, headers, 0),
      decode: (bytes) => tileDecoder.decode(bytes),
      throttle: (uri) => tileThrottle.throttle(uri),
      processTile: (recipe, bytes) => (client as DiscoveryClient).process(recipe, bytes),
      isOrdinaryImageTile,
      hooks: {
        onRequestStart: (label) => jobActivity.noteRequestStart(label),
        onRequestEnd: (id, ok) => jobActivity.noteRequestEnd(id, ok),
        onLog: (line) => jobActivity.pushLog(line),
        onUpdate: update,
      },
    });
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
          const tileTainted = await tilePainter.drawTile(ctx2d, tile);
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
      finishDisplayOnly();
      return;
    }

    controller.dispatch(nextEvent("save-start") as never);
    jobActivity.setStep("Assembling the final picture…", "Encoding PNG in your browser");
    reportProgress(total, total, "Encoding PNG…");
    let blob: Blob;
    try {
      blob = await canvasToPngBlob(canvas) as Blob;
    } catch (error) {
      // A browser may defer origin-clean enforcement until toBlob. Keep the
      // assembled canvas visible and never retry serialization in that case.
      if (isCanvasTaintError(error)) {
        finishDisplayOnly();
        return;
      }
      throw error;
    }
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = URL.createObjectURL(blob);
    viewCtx.completedInfo = {
      width,
      height,
      mime: "image/png",
      blobUrl: resultBlobUrl,
    };
    viewCtx.originClean = true;
    jobActivity.pushLog(`Done: ${width}×${height} PNG (${total} tiles)`);
    // The browser canvas path (createImageBitmap -> drawImage -> toBlob) never
    // preserves the source ICC color profile or EXIF metadata (native keeps
    // the first tile's profile); warn so archived colors are not trusted blindly.
    jobActivity.pushLog(BROWSER_SAVE_COLOR_WARNING);
    controller.dispatch(nextEvent("save-done") as never);
    recordWebHistory(url, width, height, "png");
    update();
  } catch (error) {
    if (token !== jobToken) return;
    queueOutcome = "failed";
    const structured = error as {
      code?: unknown;
      message?: string;
      detail?: string;
      technical?: string;
      retryable?: boolean;
      url?: string;
      http?: number;
      preview?: string;
    };
    const code = stableErrorCode(error);
    const message = structured?.message || "Could not save this zoomable image.";
    const detail = structured?.detail ?? structured?.technical;
    // The activity log is technical: prefer the dense chain over UI copy.
    jobActivity.pushLog(`Failed (${code}): ${structured?.technical || message}`);
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
          transport: errorTransportFor(code, webFetcher.getActiveTransport()),
          phase: phaseFor(code),
          ...(detail ? { detail } : {}),
          // Structured fetch context for the technical-details renderer:
          // the full request URL is rendered verbatim, on-device only.
          ...(structured?.url ? { url: structured.url } : {}),
          ...(typeof structured?.http === "number" ? { http: structured.http } : {}),
          ...(structured?.preview ? { preview: structured.preview } : {}),
        },
      }) as never,
    );
    update();
  } finally {
    if (token === jobToken) {
      jobActivity.stopHeartbeat();
      jobActivity.refreshLongestPending();
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
          jobActivity.pushLog(
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
  jobActivity.pushLog(`Queued ${shortUrl(url)} (position ${position} in queue)`);
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
        jobActivity.pushLog("Paused: no new pieces are being fetched.");
        update();
      },
      onResume() {
        if (!jobPaused) return;
        jobPaused = false;
        viewCtx.paused = false;
        jobActivity.resume();
        jobActivity.pushLog("Resumed: fetching queued pieces again.");
        update();
      },
      onCancel() {
        jobToken += 1;
        jobPaused = false;
        viewCtx.paused = false;
        jobActivity.stopHeartbeat();
        disposeClient();
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
        disposeClient();
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
