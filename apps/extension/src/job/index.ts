/** Dedicated extension job-tab integration. No webpage postMessage bridge. */
import { describeFailure, isActiveJobStatus, jobPageTitle, renderView } from "@dezoomify/shared-ui";
import { createElement } from "react";
import type { StructuredError, UiStatus, ViewContext as SharedViewContext } from "@dezoomify/shared-ui";
import {
  canvasToPngBlob,
  createCanvasAssembly,
  createEngineHost,
  createProbeSize,
  createTileDecoder,
  dispatchTyped,
  pickEngineSelection,
  saveBlobViaAnchor,
  type DispatchTable,
  type WorkerHostOutput,
} from "@dezoomify/browser-runtime";
import { createExtensionFetcher } from "../runtime/fetch.ts";
import { createLogger } from "@dezoomify/browser-runtime/logging";
import type { EngineHost } from "@dezoomify/browser-runtime";
import { AccessRequestView, PartialOutputActions } from "./view.tsx";
import { createCoordinatorSourceTransport, createEngineResourceFetcher, engineFailure, isJobBinding } from "./transport.ts";
import type { JobBinding } from "./transport.ts";
import type { JobEvent, ProcessingRecipe } from "@dezoomify/wasm-bindings";

declare const __DEZOOMIFY_TEST_DRIVER__: boolean;
declare const __DEZOOMIFY_TEST_PERMISSION_MOCK__: boolean;

type ExtensionApi = {
  runtime?: { sendMessage?(message: unknown): Promise<unknown>; onMessage?: { addListener(listener: (message: Record<string, unknown>) => void): void } };
  permissions?: { contains?(request: { origins: string[] }): Promise<boolean>; request?(request: { origins: string[] }): Promise<boolean> };
};
type ViewContext = SharedViewContext & { failure?: StructuredError };

const hostGlobal = globalThis as typeof globalThis & { browser?: ExtensionApi; chrome?: ExtensionApi };
const api = hostGlobal.browser ?? hostGlobal.chrome;
const jobLog = createLogger("job");
// Mirror accepted log lines into the job view's technical-details log (and the
// copied diagnostics) so a failed job shows the interaction trace. Worker
// lines arrive over `engine.log` and join the same buffer.
const UI_LOG_MAX_LINES = 120;
const uiLogLines: string[] = [];
jobLog.addSink((entry) => {
  uiLogLines.push(entry.line);
  if (uiLogLines.length > UI_LOG_MAX_LINES) uiLogLines.splice(0, uiLogLines.length - UI_LOG_MAX_LINES);
});

/** @type {any | null} */
let binding: JobBinding | null = null;
let controller: EngineHost | null = null;
let sourceTransport: ReturnType<typeof createCoordinatorSourceTransport> | null = null;
let jobWorker: Worker | null = null;
/** @type {ReturnType<typeof createCanvasAssembly> | null} */
let assembly: ReturnType<typeof createCanvasAssembly> | null = null;
let seq = 0;
let started = false;
let selected = false;
let hostFailed = false;
let lastSource = "";
let selectedTitle: string | undefined;
// The engine emits the initial 0/N tile snapshot before it dispatches tile
// effects. Keep it while a permission view temporarily replaces the job view
// so approval resumes the same determinate progress display immediately.
let lastTileProgress: { current: number; total: number } | null = null;
let accessRequest: { hosts: string[]; requesting: boolean } | null = null;
let partialDecision: number | null = null;
// Display-only origins for this attempt: an ordinary image succeeded there,
// so later tiles of the same origin skip the failing readable fetch.
const displayOnlyOrigins = new Set<string>();
// Cross-worker processing calls (session.applyProcessing) awaiting a reply.
const pendingProcess = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: unknown) => void }>();
let processSeq = 0;
const testGrantedOrigins = new Set<string>();
const bootstrapJobId = new URLSearchParams(location.hash.slice(1)).get("jobId");

function requestId(prefix: string) { return `${prefix}-${crypto.randomUUID?.() ?? Date.now().toString(36)}`; }
function boundEnvelope(type: string, extra: Record<string, unknown> = {}) { return { type, ...binding, requestId: requestId(type.replaceAll(".", "-")), ...extra }; }

function root() { return document.getElementById("dz-job-app"); }

function copyDiagnostics(text: string) {
  if (text === "") return;
  const operation = navigator.clipboard?.writeText?.(text);
  void operation?.catch(() => undefined);
}

/** Base job-tab title when no source is active; while dezooming it becomes `Dezoomify <host>`. */
export const EXTENSION_JOB_BASE_TITLE = "Dezoomify job";

/**
 * Keep the job-tab title useful while a job runs. Hosts own the
 * `document.title` assignment; shared UI stays pure.
 */
export function syncExtensionJobTitle(status: UiStatus, sourceUrl: string): void {
  if (typeof document === "undefined") return;
  try {
    const active = isActiveJobStatus(status);
    const next = active && sourceUrl !== "" ? jobPageTitle(sourceUrl) : EXTENSION_JOB_BASE_TITLE;
    if (document.title !== next) document.title = next;
  } catch {
    // Title updates must never break the job.
  }
}

function render(status: UiStatus, ctx: ViewContext = {}) {
  const target = root();
  if (!target) return;
  seq += 1;
  const viewActivity = { ...(ctx.jobActivity ?? {}), ...(uiLogLines.length ? { log: uiLogLines.slice() } : {}) };
  renderView(target, { status, seq, sessionId: binding?.jobId ?? "job:pending", transport: "browser-session", imageCount: 0, ...(ctx.failure ? { error: ctx.failure } : {}) }, {
    onSubmitUrl: () => {},
    onCancel: closeJob,
    onCopyDiagnostics: copyDiagnostics,
    onRetrySameUrl: retryJob,
    onSave: () => {},
  }, {
    ...ctx,
    ...(Object.keys(viewActivity).length ? { jobActivity: viewActivity } : {}),
  }, {
    ...(accessRequest ? { replace: createElement(AccessRequestView, {
      origin: accessRequest.hosts.length === 1 ? accessRequest.hosts[0] : "the required image host",
      requesting: accessRequest.requesting,
      onRequest: () => {
      if (!accessRequest || accessRequest.requesting) return;
      accessRequest.requesting = true;
      render(status, ctx);
      const hosts = accessRequest.hosts;
      const origins = hosts.map((origin) => `${origin}/*`);
      // Optional-host consent must be requested synchronously from this
      // click handler. A message hop to the service worker loses Chrome's
      // required user activation and leaves the UI stuck requesting access.
      // Chromium's native optional-permission prompt cannot be automated by
      // the headless extension driver. Its test package mocks only that
      // browser boundary; the click, coordinator validation, retry, and
      // completed output still run end to end.
      const request = __DEZOOMIFY_TEST_PERMISSION_MOCK__ ? Promise.resolve(true) : Promise.resolve(api?.permissions?.request?.({ origins }));
      void request.then((granted) => {
        if (!granted) throw new Error("permission denied");
        return send(boundEnvelope("dz.job.permission-required", {
          origins: hosts,
          ...(__DEZOOMIFY_TEST_PERMISSION_MOCK__ ? { testGrant: true } : {}),
        }));
      }).catch(() => {
        if (!accessRequest) return;
        accessRequest.requesting = false;
        render(status, ctx);
      });
      },
    }) } : {}),
    ...(partialDecision !== null ? { after: createElement(PartialOutputActions, { onChoose: (keep) => {
      const generation = partialDecision;
      if (generation === null) return;
      partialDecision = null;
      controller?.chooseRecovery(generation, keep ? "keep" : "discard");
      render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Finishing the image" } });
    } }) } : {}),
  });
  syncExtensionJobTitle(status, typeof ctx.jobActivity?.url === "string" && ctx.jobActivity.url !== "" ? ctx.jobActivity.url : lastSource);
}

function send(message: unknown): Promise<unknown> {
  const type = message && typeof message === "object" && "type" in message ? String((message as { type?: unknown }).type) : "unknown";
  jobLog.debug("background-message-sent", `type=${type}`);
  if (!api?.runtime?.sendMessage) return Promise.reject(new Error("extension runtime unavailable"));
  return api.runtime.sendMessage(message);
}

function closeJob() {
  jobLog.info("job-close", `jobId=${binding?.jobId ?? "unknown"}`);
  controller?.cancel();
  if (binding) void send(boundEnvelope("dz.job.cancel")).catch(() => {});
  if (binding) void send(boundEnvelope("dz.job.closed")).catch(() => {});
}

function showAccessRequired(detail: { hosts: string[] }) {
  const hosts = Array.isArray(detail.hosts) ? detail.hosts : [];
  jobLog.info("permission-requested", `jobId=${binding?.jobId ?? "unknown"} hosts=${hosts.length}`);
  accessRequest = { hosts, requesting: false };
  render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Waiting for access" } });
}

function resolvePermission(message: Record<string, unknown>) {
  if (!binding || message.jobId !== binding.jobId || typeof message.granted !== "boolean") return;
  jobLog.info("permission-resolved", `jobId=${binding.jobId} granted=${message.granted}`);
  accessRequest = null;
  if (__DEZOOMIFY_TEST_PERMISSION_MOCK__ && message.granted && Array.isArray(message.origins)) {
    for (const origin of message.origins) if (typeof origin === "string") testGrantedOrigins.add(origin);
  }
  if (message.granted) {
    const progress = lastTileProgress;
    render("downloading", {
      ...(progress ? { currentProgress: progress } : {}),
      jobActivity: { startedAt: Date.now(), stepLabel: "Acquiring image tiles" },
    });
  }
  controller?.resolvePermission(message.granted);
}

/**
 * The engine stopped for a typed partial decision: every failed tile has
 * exhausted its retries. Only an explicit user action chooses keep/discard;
 * the engine owns the consequence (encode with missing regions, or fail).
 */
function showPartialDecision(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 0) return;
  partialDecision = generation;
  render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Some tiles are missing" } });
}

/** Source host for shared copy interpolation; "" when the input is unparseable. */
function sourceHost(): string {
  try {
    return new URL(lastSource).host;
  } catch {
    return "";
  }
}

/**
 * One shared presenter for engine failures: the plain headline goes in
 * `message`, the engine's raw per-format aggregate moves to `detail`, and the
 * stable category/phase/retryable are derived from the code. The extension
 * never renders the raw engine block as the first message.
 */
function presentEngineFailure(raw: unknown): StructuredError {
  const candidate = raw && typeof raw === "object"
    ? raw as { code?: unknown; message?: unknown; detail?: unknown; retryable?: unknown; phase?: unknown; transport?: unknown; request?: unknown; http?: unknown; preview?: unknown }
    : null;
  return describeFailure({
    code: typeof candidate?.code === "string" ? candidate.code : "job.failed",
    engineDetail: typeof candidate?.detail === "string"
      ? candidate.detail
      : (typeof candidate?.message === "string" ? candidate.message : ""),
    retryable: typeof candidate?.retryable === "boolean" ? candidate.retryable : undefined,
    phase: typeof candidate?.phase === "string" ? candidate.phase : undefined,
    // The extension always fetches under the granted browser session; the
    // engine's typed event carries no transport, so the details line would
    // otherwise misreport `direct`.
    transport: typeof candidate?.transport === "string" ? candidate.transport : "browser-session",
    host: sourceHost(),
    url: typeof candidate?.request === "string" ? candidate.request : undefined,
    http: typeof candidate?.http === "number" ? candidate.http : undefined,
    preview: typeof candidate?.preview === "string" ? candidate.preview : undefined,
  });
}

/** Host-side effect execution failed terminally: render it and stop. */
function onHostFailure(error: unknown) {
  if (hostFailed) return;
  hostFailed = true;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "output-failed";
  const phase = error && typeof error === "object" && "phase" in error ? String((error as { phase?: unknown }).phase) : "unknown";
  jobLog.error("host-failure", `jobId=${binding?.jobId ?? "unknown"} code=${code} phase=${phase} message=${error instanceof Error ? error.message : String(error)}`);
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; retryable?: unknown; detail?: unknown; phase?: unknown; transport?: unknown }
    : null;
  const message = code === "adapter.wrong-state"
    ? "The extension lost sync while reading this image. Start the scan again."
    : (typeof candidate?.message === "string" ? candidate.message : "The image could not be assembled in this tab.");
  const failure = describeFailure({
    code,
    message,
    engineDetail: typeof candidate?.detail === "string" ? candidate.detail : undefined,
    category: "extension",
    retryable: candidate?.retryable === true,
    phase,
    transport: typeof candidate?.transport === "string" ? candidate.transport : undefined,
    host: sourceHost(),
  });
  render("failed", { failure, jobActivity: { startedAt: Date.now(), stepLabel: "Job failed" } });
}

/** Apply one core processing recipe through the worker session. */
function processTile(recipe: ProcessingRecipe, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!jobWorker) return Promise.reject(Object.assign(new Error("worker unavailable"), { code: "WORKER_FAILED" }));
  const requestId = ++processSeq;
  return new Promise((resolve, reject) => {
    pendingProcess.set(requestId, { resolve, reject });
    jobWorker?.postMessage({ type: "engine.process", requestId, recipe, bytes }, [bytes]);
  });
}

function createAssembly(sourceUrl: string) {
  const decoder = createTileDecoder();
  return createCanvasAssembly({
    decode: (bytes: ArrayBuffer) => decoder.decode(bytes),
    processTile,
    createCanvas: (width: number, height: number) => {
      const element = document.createElement("canvas");
      element.width = width;
      element.height = height;
      const ctx2d = element.getContext("2d");
      if (!ctx2d) {
        throw Object.assign(new Error("This browser could not create the output surface."), { code: "OUTPUT_SURFACE_UNAVAILABLE", retryable: false });
      }
      // The executor draws through ctx2d and encodes through toBlob: expose
      // both on one surface object.
      return { width, height, ctx2d, toBlob: (cb: BlobCallback, mime?: string) => element.toBlob(cb, mime) };
    },
    encode: (canvas) =>
      canvasToPngBlob(canvas as unknown as { toBlob(cb: BlobCallback, mime?: string): void }),
    save: (blob: unknown, width: number, height: number) => {
      if (!(blob instanceof Blob)) throw new TypeError("encoded output is not a Blob");
      const url = URL.createObjectURL(blob);
      try {
        saveBlobViaAnchor(document, url, width, height, selectedTitle);
      } finally {
        // The anchor save reads the URL synchronously; revoke lazily so the
        // browser never races a slow download start.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    },
    sourceUrl,
  });
}

const eventHandlers = {
  progress: (event) => {
    jobLog.debug("engine-progress", `acquired=${event.acquired} total=${event.total}`);
    lastTileProgress = { current: event.acquired, total: event.total };
    render("downloading", { currentProgress: lastTileProgress, jobActivity: { startedAt: Date.now(), stepLabel: "Acquiring image tiles" } });
  },
  failed: (event) => {
    jobLog.error("engine-event", `type=failed error=${JSON.stringify(event.error)}`);
    partialDecision = null;
    render("failed", { failure: presentEngineFailure(event.error), jobActivity: { startedAt: Date.now(), stepLabel: "Job failed" } });
  },
  cancelled: () => {
    jobLog.info("engine-event", "type=cancelled");
    partialDecision = null;
    render("cancelled", { jobActivity: { startedAt: Date.now(), stepLabel: "Cancelled" } });
  },
  completed: () => {
    jobLog.info("engine-event", "type=completed");
    partialDecision = null;
    render("completed", { jobActivity: { startedAt: Date.now(), stepLabel: "Completed" } });
  },
  "partial-completed": () => {
    jobLog.info("engine-event", "type=partial-completed");
    partialDecision = null;
    render("completed", { jobActivity: { startedAt: Date.now(), stepLabel: "Completed (partial)" } });
  },
  catalog: (event) => {
    if (selected) return;
    jobLog.info("engine-event", `type=catalog images=${event.catalog.images.length}`);
    selected = true;
    const selection = pickEngineSelection(event.catalog);
    if (!selection) {
      onHostFailure(Object.assign(new Error("No downloadable image was found on this page."), { code: "NO_IMAGE_FOUND", retryable: false }));
      controller?.cancel();
      return;
    }
    selectedTitle = selection.title;
    render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Preparing the image" } });
    controller?.selectImage(selection.image);
    controller?.selectLevel(selection.level);
  },
  warning: (event) => {
    jobLog.warn("engine-warning", JSON.stringify(event.error));
  },
  "recovery-request": () => {},
  "job-state": () => {},
  paused: () => {},
  resumed: () => {},
} satisfies DispatchTable<JobEvent, void>;

function handleEvent(event: JobEvent) {
  if (hostFailed) return;
  dispatchTyped(eventHandlers, event);
}

function setup(bound: unknown) {
  if (!isJobBinding(bound) || binding) return;
  // Keep only the four binding fields: the arriving message carries payload
  // (type, sourceValid, documentUrl) that must never leak into outgoing
  // envelopes, where it would override their own message type.
  binding = {
    jobId: bound.jobId,
    tabId: bound.tabId,
    frameId: bound.frameId,
    documentGeneration: bound.documentGeneration,
  };
  jobLog.info("binding-received", `jobId=${binding.jobId} tab=${binding.tabId} frame=${binding.frameId} gen=${binding.documentGeneration}`);
  startAttempt();
}

/**
 * Tear down the current attempt. The durable source binding survives; the
 * worker, WASM session, controller, output assembly, and pending fetch state
 * do not. Called before every attempt so a retry can never reuse a terminal
 * engine session or a stale request ledger.
 */
function stopAttempt() {
  const activeController = controller;
  controller = null;
  try { activeController?.dispose(); } catch { /* teardown is best effort */ }
  const worker = jobWorker;
  jobWorker = null;
  try { worker?.terminate(); } catch { /* already gone */ }
  try { assembly?.release(); } catch { /* bitmap cleanup is best effort */ }
  assembly = null;
  sourceTransport = null;
  for (const { reject } of pendingProcess.values()) reject(Object.assign(new Error("attempt stopped"), { code: "WORKER_FAILED" }));
  pendingProcess.clear();
}

/** Clear every per-attempt flag and buffer; the source binding is untouched. */
function resetAttemptState() {
  started = false;
  selected = false;
  hostFailed = false;
  selectedTitle = undefined;
  lastSource = "";
  lastTileProgress = null;
  accessRequest = null;
  partialDecision = null;
  displayOnlyOrigins.clear();
}

/**
 * Begin one discovery-and-fetch attempt. The first attempt follows the job
 * tab's readiness announcement; a retry follows an explicit user action and a
 * fresh coordinator snapshot. Either way the attempt gets a fresh worker,
 * controller, and assembly so no state leaks between attempts.
 */
function startAttempt() {
  if (!binding) return;
  stopAttempt();
  resetAttemptState();
  const activeBinding = binding;
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  jobWorker = worker;
  const fetcher = createExtensionFetcher({
    hasPermission: async (origin) => testGrantedOrigins.has(origin) ||
      (!__DEZOOMIFY_TEST_PERMISSION_MOCK__ && !!(api?.permissions?.contains && await api.permissions.contains({ origins: [`${origin}/*`] }))),
  });
  const extensionTransport = {
    async fetchResource(url: string, opts?: unknown) {
      jobLog.debug("extension-fetch-start", `url=${url} purpose=${String((opts as { purpose?: unknown } | undefined)?.purpose ?? "unknown")}`);
      try {
        const result = await fetcher.fetchResource(url, opts as Parameters<typeof fetcher.fetchResource>[1]);
        jobLog.debug("extension-fetch-complete", `url=${url} bytes=${result.bytes.byteLength}`);
        return result;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
        jobLog.warn("extension-fetch-failed", `url=${url} code=${code} message=${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    cancel: () => fetcher.cancel(),
  };
  sourceTransport = createCoordinatorSourceTransport({ sendMessage: send });
  let attemptCancelled = false;
  const cancelFetch = () => { attemptCancelled = true; fetcher.cancel(); };
  // Metadata prefers the source tab's origin context and falls back to the
  // granted extension-origin session; tiles always use the extension origin.
  const fetchResource = createEngineResourceFetcher({
    binding: () => activeBinding,
    sourceTransport,
    extensionTransport,
    cancelled: () => attemptCancelled,
    onSourceFailure: (cause) => jobLog.warn("source-fetch-failed", `code=${String(cause.code ?? cause.blocked_reason ?? "network")} retrying=extension-origin`),
  });
  const probeDecoder = createTileDecoder();
  const probeSize = createProbeSize({
    fetchTile: async (url: string, headers: Record<string, string>) => {
      const result = await extensionTransport.fetchResource(url, {
        headers,
        purpose: "probe",
        userIntent: true,
      });
      const bytes = result.bytes instanceof Uint8Array
        ? new Uint8Array(result.bytes).slice().buffer as ArrayBuffer
        : result.bytes as unknown as ArrayBuffer;
      return { bytes };
    },
    decode: (bytes: ArrayBuffer) => probeDecoder.decode(bytes),
    loadImage: (url: string) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        image: img,
      });
      img.onerror = () => reject(new Error("probe image failed to load"));
      img.src = url;
    }),
  });
  controller = createEngineHost({
    worker,
    jobId: () => activeBinding.jobId,
    fetchResource,
    cancelFetch,
    get assembly() {
      if (!assembly) throw new Error("output assembly is not initialized");
      return assembly;
    },
    // Browser session baseline: 6 concurrent tile fetches (matches the
    // website). The engine validates the budget at job creation.
    quotas: { max_concurrent_fetches: 6 },
    probeSize,
    classifyFailure: engineFailure,
    onPermissionRequired: showAccessRequired,
    onRecoveryRequested: showPartialDecision,
    onHostFailure,
    onEvent: handleEvent,
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerHostOutput>) => {
    if (event.data?.type === "engine.messages") {
      const messages = event.data.messages;
      jobLog.debug("worker-message", `type=engine.messages count=${messages.length}`);
      controller?.handleEngineMessages(messages);
    }
    else if (event.data?.type === "engine.processed" || event.data?.type === "engine.process-failed") {
      const requestId = typeof event.data.requestId === "number" ? event.data.requestId : -1;
      const pending = pendingProcess.get(requestId);
      if (pending) {
        pendingProcess.delete(requestId);
        if (event.data.type === "engine.processed" && event.data.bytes instanceof ArrayBuffer) pending.resolve(event.data.bytes);
        else pending.reject(Object.assign(new Error("tile processing failed"), { code: "tile.processing-failed" }));
      }
    }
    else if (event.data?.type === "engine.log" && typeof event.data.line === "string") {
      uiLogLines.push(event.data.line);
      if (uiLogLines.length > UI_LOG_MAX_LINES) uiLogLines.splice(0, uiLogLines.length - UI_LOG_MAX_LINES);
    }
    else if (event.data?.type === "engine.error") { jobLog.error("worker-error", `jobId=${binding?.jobId ?? "unknown"} message=${JSON.stringify(event.data.error)}`); onHostFailure(event.data.error); }
  });
  render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Waiting for image candidates" } });
}

/**
 * Announce this job tab to the coordinator. Used on first load and when a
 * retry is pressed before the first binding ever arrived; the coordinator
 * replies with the binding and a fresh candidate snapshot.
 */
function announceReady() {
  jobLog.info("job-ready-sent", `jobId=${bootstrapJobId ?? "unknown"}`);
  render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Connecting to Dezoomify" } });
  void send({ type: "dz.job.ready", jobId: bootstrapJobId, requestId: requestId("job-ready") }).catch(() =>
    onHostFailure(Object.assign(new Error("Could not connect this job tab to the extension."), { code: "network", retryable: true })));
}

/**
 * Explicit user retry. With a binding, start a fresh attempt and ask the
 * coordinator for a new bounded snapshot of the bound page. Without one (the
 * first readiness announcement never landed), re-announce the job tab.
 */
function retryJob() {
  jobLog.info("retry-requested", `jobId=${binding?.jobId ?? bootstrapJobId ?? "unknown"}`);
  if (!binding) {
    resetAttemptState();
    announceReady();
    return;
  }
  startAttempt();
  void send(boundEnvelope("dz.job.retry")).catch(() =>
    onHostFailure(Object.assign(new Error("Could not ask the extension to retry this job."), { code: "network", retryable: true })));
}

function candidates(message: Record<string, unknown>) {
  if (!binding || !message || message.jobId !== binding.jobId || started) return;
  const values = Array.isArray(message.inputs) ? message.inputs.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || !("url" in candidate) || typeof candidate.url !== "string") return [];
    return [{ url: candidate.url, ...("contents" in candidate && typeof candidate.contents === "string" ? { contents: candidate.contents } : {}) }];
  }) : [];
  if (!values.length) return;
  started = true;
  jobLog.info("candidates-received", `jobId=${binding.jobId} count=${values.length} overflow=${typeof message.overflow === "number" ? message.overflow : 0}`);
  render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Finding the zoomable image" } });
  lastSource = values[0].url;
  assembly = createAssembly(lastSource);
  jobLog.info("engine-start", `jobId=${binding.jobId} url=${lastSource}`);
  controller?.start(values);
}

api?.runtime?.onMessage?.addListener((message) => {
  if (typeof message?.type === "string" && message.type.startsWith("dz.job.")) jobLog.debug("background-message-received", `type=${message.type}`);
  if (message?.type === "dz.job.binding") setup(message);
  else if (message?.type === "dz.job.candidates") candidates(message);
  else if (message?.type === "dz.job.fetch") sourceTransport?.handleMessage?.(message);
  else if (message?.type === "dz.job.permission-required") resolvePermission(message);
});

window.addEventListener("beforeunload", () => {
  stopAttempt();
  if (binding) void send(boundEnvelope("dz.job.closed")).catch(() => {});
});

announceReady();
