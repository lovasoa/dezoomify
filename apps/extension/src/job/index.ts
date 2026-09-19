/** Dedicated extension job-tab integration. No webpage postMessage bridge. */
import { describeFailure, isActiveJobStatus, jobPageTitle, renderView } from "@dezoomify/shared-ui";
import { createJobService } from "@dezoomify/app-model";
import { presentFailure, presentSnapshot, presentStatus } from "@dezoomify/shared-ui";
import { createElement } from "react";
import type { JobHandle, JobSnapshot } from "@dezoomify/app-model";
import type {
  PresentationStatus,
  SnapshotPresentation,
  StructuredError,
  ViewContext as SharedViewContext,
} from "@dezoomify/shared-ui";
import {
  canvasToPngBlob,
  createBrowserRunner,
  createCanvasAssembly,
  createProbeSize,
  createTileDecoder,
  MAX_DEFERRED_FOLLOWS,
  pickDeferredUri,
  pickEngineSelection,
  saveBlobViaAnchor,
} from "@dezoomify/browser-runtime";
import { createExtensionFetcher } from "../runtime/fetch.ts";
import { originOfUrl } from "@dezoomify/browser-runtime";
import { createLogger } from "@dezoomify/browser-runtime/logging";
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
/** Origin of the bound source document; "" until the binding arrives. Same-origin tiles and probes prefer the tab-origin transport. */
let siteOrigin = "";
/** Fallback request ids for probes that arrive without an engine request id. Start clear of the engine's small sequential ids. */
let probeSeq = 1 << 30;
// One shared browser runner attempt. The runner owns the worker, the WASM
// session, cross-worker processing calls, the abort scope, and disposal;
// this tab keeps binding, transport, selection, recovery, and view wiring.
let jobHandle: JobHandle | null = null;
let sourceTransport: ReturnType<typeof createCoordinatorSourceTransport> | null = null;
/** Runner abort signal of the live attempt (drives the cancelled() transport view). */
let attemptSignal: AbortSignal | null = null;
/** @type {ReturnType<typeof createCanvasAssembly> | null} */
let assembly: ReturnType<typeof createCanvasAssembly> | null = null;
let saveCompleted = false;
let jobServiceHandle: { dispose(): Promise<void> } | null = null;
let latestSnapshot: JobSnapshot | null = null;
let localFailure: StructuredError | null = null;
let started = false;
let selected = false;
let hostFailed = false;
let lastSource = "";
let selectedTitle: string | undefined;
// Deferred-follow depth for the current logical job: reset when a new binding
// or explicit retry starts, incremented once per followed ImageRequest.
let followDepth = 0;
let accessRequest: { hosts: string[]; requesting: boolean } | null = null;
let partialDecision: number | null = null;
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
export function syncExtensionJobTitle(status: PresentationStatus, sourceUrl: string): void {
  if (typeof document === "undefined") return;
  try {
    const active = isActiveJobStatus(status);
    const next = active && sourceUrl !== "" ? jobPageTitle(sourceUrl) : EXTENSION_JOB_BASE_TITLE;
    if (document.title !== next) document.title = next;
  } catch {
    // Title updates must never break the job.
  }
}

function presentFor(status: PresentationStatus, ctx: ViewContext): SnapshotPresentation {
  if (localFailure) return presentFailure(localFailure, "browser-session");
  if (latestSnapshot) return presentSnapshot(latestSnapshot, "browser-session");
  return presentStatus(status, {
    transport: "browser-session",
    ...(ctx.failure ? { error: ctx.failure } : {}),
  });
}

function render(status: PresentationStatus, ctx: ViewContext = {}) {
  const target = root();
  if (!target) return;
  const viewActivity = { ...(ctx.jobActivity ?? {}), ...(uiLogLines.length ? { log: uiLogLines.slice() } : {}) };
  const presentation = presentFor(status, ctx);
  renderView(target, presentation, {
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
      void jobHandle?.command({ type: "recovery-choice", generation, choice: keep ? "keep" : "discard" });
      render("downloading", { jobActivity: { startedAt: Date.now() } });
    }, onRetry: () => {
      const generation = partialDecision;
      if (generation === null) return;
      partialDecision = null;
      void jobHandle?.command({ type: "recovery-choice", generation, choice: "retry" });
      render("downloading", { jobActivity: { startedAt: Date.now() } });
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
  const handle = jobHandle;
  jobHandle = null;
  if (handle) {
    void handle.command({ type: "cancel" }).catch(() => {});
    void handle.dispose().catch(() => {});
  }
  if (binding) void send(boundEnvelope("dz.job.cancel")).catch(() => {});
  if (binding) void send(boundEnvelope("dz.job.closed")).catch(() => {});
}

function showAccessRequired(detail: { hosts: string[] }) {
  const hosts = Array.isArray(detail.hosts) ? detail.hosts : [];
  jobLog.info("permission-requested", `jobId=${binding?.jobId ?? "unknown"} hosts=${hosts.length}`);
  accessRequest = { hosts, requesting: false };
  render("downloading", { jobActivity: { startedAt: Date.now() } });
}

function resolvePermission(message: Record<string, unknown>) {
  if (!binding || message.jobId !== binding.jobId || typeof message.granted !== "boolean") return;
  jobLog.info("permission-resolved", `jobId=${binding.jobId} granted=${message.granted}`);
  accessRequest = null;
  if (__DEZOOMIFY_TEST_PERMISSION_MOCK__ && message.granted && Array.isArray(message.origins)) {
    for (const origin of message.origins) if (typeof origin === "string") testGrantedOrigins.add(origin);
  }
  if (message.granted) {
    render("downloading", {
      jobActivity: { startedAt: Date.now() },
    });
  }
  try {
    jobHandle?.resolvePermission?.(message.granted);
  } catch { /* grant resolution is best effort */ }
}

/**
 * The engine stopped for a typed partial decision: every failed tile has
 * exhausted its retries. Only an explicit user action chooses keep/discard;
 * the engine owns the consequence (encode with missing regions, or fail).
 */
function showPartialDecision(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 0) return;
  partialDecision = generation;
  render("downloading", { jobActivity: { startedAt: Date.now() } });
}

function clearPartialDecision() {
  partialDecision = null;
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
  const failure = describeFailure({
    code,
    engineDetail: typeof candidate?.detail === "string"
      ? candidate.detail
      : (typeof candidate?.message === "string" ? candidate.message : undefined),
    retryable: candidate?.retryable === true,
    phase,
    transport: typeof candidate?.transport === "string" ? candidate.transport : undefined,
    host: sourceHost(),
  });
  render("failed", { failure, jobActivity: { startedAt: Date.now() } });
}

function createAssembly(
  sourceUrl: string,
  processTile: (recipe: ProcessingRecipe, bytes: ArrayBuffer) => Promise<ArrayBuffer>,
) {
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
        saveCompleted = true;
      } finally {
        // The anchor save reads the URL synchronously; revoke lazily so the
        // browser never races a slow download start.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    },
    sourceUrl,
  });
}

function onCatalog(event: Extract<JobEvent, { type: "catalog" }>) {
    const entries = event.catalog.entries;
    jobLog.info("engine-event", `type=catalog entries=${entries.length}`);
    const selection = pickEngineSelection(event.catalog);
    if (!selection) {
      // A still-deferred catalog (IIIF manifest, bulk list) resolves through
      // its first request with a fresh, bounded attempt. The engine never
      // follows deferred metadata silently.
      const deferredUri = pickDeferredUri(event.catalog);
      if (deferredUri && followDepth < MAX_DEFERRED_FOLLOWS) {
        followDepth += 1;
        jobLog.info("deferred-follow", `depth=${followDepth}`);
        render("discovering", { jobActivity: { startedAt: Date.now() } });
        // Defer the teardown out of this engine event chain so the current
        // attempt settles before its runner is replaced by a fresh attempt
        // rooted at the resolved request URI (same binding, same identity).
        queueMicrotask(() => {
          stopAttempt();
          resetAttemptState();
          started = true;
          jobLog.info("engine-start", `jobId=${binding?.jobId ?? "unknown"} url=${deferredUri}`);
          render("discovering", { jobActivity: { startedAt: Date.now() } });
          void beginAttempt([{ url: deferredUri }]);
        });
        return;
      }
      onHostFailure(Object.assign(
        new Error(deferredUri
          ? "The image metadata stayed deferred after the resolution limit."
          : "No downloadable image was found on this page."),
        { code: deferredUri ? "discovery.deferred" : "NO_IMAGE_FOUND", retryable: false },
      ));
      void jobHandle?.command({ type: "cancel" }).catch(() => {});
      return;
    }
    selectedTitle = selection.title;
    render("downloading", { jobActivity: { startedAt: Date.now() } });
    void jobHandle?.command({ type: "select-image", image: selection.image }).catch(() => {});
    void jobHandle?.command({ type: "select-level", level: selection.level }).catch(() => {});
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
  try {
    const documentUrl = (bound as { documentUrl?: unknown }).documentUrl;
    siteOrigin = typeof documentUrl === "string" ? originOfUrl(documentUrl) : "";
  } catch { siteOrigin = ""; }
  jobLog.info("binding-received", `jobId=${binding.jobId} tab=${binding.tabId} frame=${binding.frameId} gen=${binding.documentGeneration}`);
  followDepth = 0;
  startAttempt();
}

/**
 * Tear down the current attempt. The durable source binding survives; the
 * runner attempt (worker, WASM session, output assembly, fetch state) does
 * not. Called before every attempt so a retry can never reuse a terminal
 * engine session or a stale request ledger.
 */
function stopAttempt() {
  const handle = jobHandle;
  jobHandle = null;
  const serviceHandle = jobServiceHandle;
  jobServiceHandle = null;
  if (serviceHandle) {
    try {
      void serviceHandle.dispose().catch(() => {});
    } catch { /* teardown is best effort */ }
  }
  attemptSignal = null;
  if (handle) {
    try {
      void handle.dispose().catch(() => {});
    } catch { /* teardown is best effort */ }
  }
  try { assembly?.release(); } catch { /* bitmap cleanup is best effort */ }
  assembly = null;
  saveCompleted = false;
  sourceTransport = null;
}

/** Clear every per-attempt flag and buffer; the source binding is untouched. */
function resetAttemptState() {
  started = false;
  selected = false;
  hostFailed = false;
  selectedTitle = undefined;
  lastSource = "";
  latestSnapshot = null;
  localFailure = null;
  accessRequest = null;
  partialDecision = null;
}

/**
 * Begin one discovery-and-fetch attempt behind the shared browser runner.
 * The extension injects its source-bound transport (tab-origin fetch under
 * the narrowest grant plus extension-origin fallback), its output assembly
 * (page canvas, anchor save), and its product actions (explicit permission
 * prompt, keep/discard recovery). Retries, partials, and ordering stay in
 * the engine; the abort scope and disposal live in the runner attempt.
 */
async function beginAttempt(inputs: Array<{ url: string; contents?: string }>) {
  if (!binding) return;
  const activeBinding = binding;
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
  const coordinator = createCoordinatorSourceTransport({ sendMessage: send });
  sourceTransport = coordinator;
  let attemptCancelled = false;
  // Metadata and the bound site's own tiles and probes prefer the source
  // tab's origin context and fall back to the granted extension-origin
  // session; cross-origin tiles always use the extension origin.
  const fetchResource = createEngineResourceFetcher({
    binding: () => activeBinding,
    siteOrigin: () => siteOrigin,
    sourceTransport: coordinator,
    extensionTransport,
    cancelled: () => attemptCancelled || attemptSignal?.aborted === true,
    onSourceFailure: (cause) => jobLog.warn("source-fetch-failed", `code=${String(cause.code ?? cause.blocked_reason ?? "network")} retrying=extension-origin`),
  });
  const probeDecoder = createTileDecoder();
  const runner = createBrowserRunner({
    createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
    fetchResource: (effect, signal) => {
      attemptSignal = signal;
      if (signal.aborted || attemptCancelled) {
        return Promise.reject(Object.assign(new Error("request cancelled"), { category: "cancelled" }));
      }
      return fetchResource(effect);
    },
    probeSize: createProbeSize({
      fetchTile: async (url: string, headers: Record<string, string>, requestId?: number) => {
        const id = typeof requestId === "number" && Number.isSafeInteger(requestId) && requestId >= 0 ? requestId : (probeSeq += 1);
        const result = await fetchResource({
          request: {
            id,
            uri: url,
            headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
            purpose: "probe",
          },
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
    }),
    loadDisplayImage: (url: string) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("display image failed to load"));
      img.src = url;
    }),
    classifyFailure: engineFailure,
    createAssembly: ({ sourceUrl, processTile }) => {
      const asm = createAssembly(sourceUrl, processTile);
      assembly = asm;
      return asm;
    },
    // Browser session baseline: 6 concurrent tile fetches (matches the
    // website). The engine validates the budget at job creation.
    quotas: { max_concurrent_fetches: 6 },
    sessionId: () => activeBinding.jobId,
    getTransport: () => "browser-session",
    isPermissionPending: () => accessRequest !== null,
    getOutputState: () => (saveCompleted ? "writable" : "pending"),
    onPermissionRequired: (detail) => {
      showAccessRequired(detail);
    },
    onRecoveryRequested: showPartialDecision,
    log: (level, code, detail) => jobLog.log(level, code, detail),
    onAbort: () => {
      attemptCancelled = true;
      try {
        fetcher.cancel();
      } catch { /* abort must never break teardown */ }
    },
  });
  const service = createJobService(runner);
  try {
    const handle = await service.start(
      { inputs, engine: {}, exec: { kind: "browser", sourceUrl: inputs[0]?.url ?? "" } },
      {
        snapshot: (snapshot: JobSnapshot) => {
          if (hostFailed) return;
          latestSnapshot = snapshot;
          if (snapshot.catalog && !selected) {
            selected = true;
            onCatalog({ type: "catalog", catalog: snapshot.catalog });
          }
          renderForSnapshot(snapshot);
        },
        hostStatus: () => {},
      },
    );
    jobServiceHandle = handle;
  } catch (error) {
    onHostFailure(error);
  }
}

/** Render one folded snapshot: terminal phases win over the live status. */
function renderForSnapshot(snapshot: JobSnapshot) {
  const terminal = snapshot.terminal;
  if (terminal?.kind === "failed" && terminal.error) {
    jobLog.error("engine-event", `type=failed error=${JSON.stringify(terminal.error)}`);
    clearPartialDecision();
    localFailure = presentEngineFailure(terminal.error);
    render("failed", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  if (terminal?.kind === "cancelled") {
    clearPartialDecision();
    render("cancelled", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  if (terminal?.kind === "completed" || terminal?.kind === "partial-completed") {
    clearPartialDecision();
    render("completed", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  render("downloading", { jobActivity: { startedAt: Date.now() } });
}

/**
 * Announce this job tab to the coordinator. Used on first load and when a
 * retry is pressed before the first binding ever arrived; the coordinator
 * replies with the binding and a fresh candidate snapshot.
 */
function announceReady() {
  jobLog.info("job-ready-sent", `jobId=${bootstrapJobId ?? "unknown"}`);
  render("discovering", { jobActivity: { startedAt: Date.now() } });
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
  followDepth = 0;
  if (!binding) {
    resetAttemptState();
    announceReady();
    return;
  }
  startAttempt();
  void send(boundEnvelope("dz.job.retry")).catch(() =>
    onHostFailure(Object.assign(new Error("Could not ask the extension to retry this job."), { code: "network", retryable: true })));
}

/**
 * Prepare one attempt slot. The first attempt follows the job tab's
 * readiness announcement; a retry follows an explicit user action and a
 * fresh coordinator snapshot. The runner starts once image candidates
 * arrive (`beginAttempt`); either way the attempt gets a fresh runner so no
 * state leaks between attempts.
 */
function startAttempt() {
  if (!binding) return;
  stopAttempt();
  resetAttemptState();
  render("discovering", { jobActivity: { startedAt: Date.now() } });
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
  render("discovering", { jobActivity: { startedAt: Date.now() } });
  lastSource = values[0].url;
  jobLog.info("engine-start", `jobId=${binding.jobId} url=${lastSource}`);
  void beginAttempt(values);
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
