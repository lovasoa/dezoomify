/** Dedicated extension job-tab integration. No webpage postMessage bridge. */
import { renderView } from "@dezoomify/shared-ui";
import { createElement } from "react";
import type { UiStatus, ViewContext as SharedViewContext } from "@dezoomify/shared-ui";
import {
  canvasToPngBlob,
  createCanvasAssembly,
  createTileDecoder,
  pickEngineSelection,
  saveBlobViaAnchor,
} from "@dezoomify/browser-runtime";
import { createExtensionFetcher } from "../runtime/fetch.js";
import { createJobController } from "./controller.js";
import { AccessRequestView, PartialOutputActions } from "./view.tsx";
import { createCoordinatorSourceTransport, engineFailure, isJobBinding } from "./transport.js";
import type { JobBinding } from "./transport.js";

declare const __DEZOOMIFY_TEST_DRIVER__: boolean;
declare const __DEZOOMIFY_TEST_PERMISSION_MOCK__: boolean;

type ExtensionApi = {
  runtime?: { sendMessage?(message: unknown): Promise<unknown>; onMessage?: { addListener(listener: (message: Record<string, unknown>) => void): void } };
  permissions?: { contains?(request: { origins: string[] }): Promise<boolean>; request?(request: { origins: string[] }): Promise<boolean> };
};
type Failure = { code: string; category: string; retryable: boolean; message: string };
type ViewContext = SharedViewContext & { failure?: Failure };
type JobEvent = Record<string, unknown> & { type: string; acquired?: number; total?: number; error?: Failure; catalog?: { images?: unknown[] } };
type WorkerMessage = { type?: string; messages?: unknown[]; error?: unknown; urls?: unknown[] };

const hostGlobal = globalThis as typeof globalThis & { browser?: ExtensionApi; chrome?: ExtensionApi };
const api = hostGlobal.browser ?? hostGlobal.chrome;

/** @type {any | null} */
let binding: JobBinding | null = null;
/** @type {ReturnType<typeof createJobController> | null} */
let controller: ReturnType<typeof createJobController> | null = null;
let sourceTransport: ReturnType<typeof createCoordinatorSourceTransport> | null = null;
let jobWorker: Worker | null = null;
/** @type {ReturnType<typeof createCanvasAssembly> | null} */
let assembly: ReturnType<typeof createCanvasAssembly> | null = null;
let seq = 0;
let started = false;
let selected = false;
let hostFailed = false;
let lastSource = "";
// The engine emits the initial 0/N tile snapshot before it dispatches tile
// effects. Keep it while a permission view temporarily replaces the job view
// so approval resumes the same determinate progress display immediately.
let lastTileProgress: { current: number; total: number } | null = null;
let accessRequest: { hosts: string[]; requesting: boolean } | null = null;
let partialDecision: string | null = null;
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

function render(status: UiStatus, ctx: ViewContext = {}) {
  const target = root();
  if (!target) return;
  seq += 1;
  renderView(target, { status, seq, sessionId: binding?.jobId ?? "job:pending", transport: "browser-session", imageCount: 0, ...(ctx.failure ? { error: ctx.failure } : {}) }, {
    onSubmitUrl: () => {},
    onCancel: closeJob,
    onCopyDiagnostics: copyDiagnostics,
    onReset: () => {},
    onRetrySameUrl: () => {},
    onSave: () => {},
  }, {
    ...ctx,
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
    ...(partialDecision ? { after: createElement(PartialOutputActions, { onChoose: (keep) => {
      const recovery = partialDecision;
      if (!recovery) return;
      partialDecision = null;
      controller?.choosePartial(recovery, keep);
      render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Finishing the image" } });
    } }) } : {}),
  });
}

function send(message: unknown): Promise<unknown> {
  if (!api?.runtime?.sendMessage) return Promise.reject(new Error("extension runtime unavailable"));
  return api.runtime.sendMessage(message);
}

function closeJob() {
  controller?.cancel();
  if (binding) void send(boundEnvelope("dz.job.cancel")).catch(() => {});
  if (binding) void send(boundEnvelope("dz.job.closed")).catch(() => {});
}

function showAccessRequired(detail: { hosts: string[] }) {
  const hosts = Array.isArray(detail.hosts) ? detail.hosts : [];
  accessRequest = { hosts, requesting: false };
  render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Waiting for access" } });
}

function resolvePermission(message: Record<string, unknown>) {
  if (!binding || message.jobId !== binding.jobId || typeof message.granted !== "boolean") return;
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
function showPartialDecision(recovery: string) {
  if (typeof recovery !== "string" || !recovery.startsWith("rec:")) return;
  partialDecision = recovery;
  render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Some tiles are missing" } });
}

/** Host-side effect execution failed terminally: render it and stop. */
function onHostFailure(error: unknown) {
  if (hostFailed) return;
  hostFailed = true;
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; retryable?: unknown; detail?: unknown; phase?: unknown; transport?: unknown }
    : null;
  const failure = candidate && typeof candidate.code === "string"
    ? {
      code: candidate.code,
      category: "extension",
      retryable: candidate.retryable === true,
      message: candidate.code === "adapter.wrong-state"
        ? "The extension lost sync while reading this image. Start the scan again."
        : (typeof candidate.message === "string" ? candidate.message : "The image could not be assembled in this tab."),
      ...(typeof candidate.detail === "string" ? { detail: candidate.detail } : {}),
      ...(typeof candidate.phase === "string" ? { phase: candidate.phase } : {}),
      ...(typeof candidate.transport === "string" ? { transport: candidate.transport } : {}),
    }
    : { code: "output-failed", category: "extension", retryable: false, message: "The image could not be assembled in this tab." };
  render("failed", { failure, jobActivity: { startedAt: Date.now(), stepLabel: "Job failed" } });
}

function createAssembly(sourceUrl: string) {
  const decoder = createTileDecoder();
  return createCanvasAssembly({
    decode: (bytes: ArrayBuffer) => decoder.decode(bytes),
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
        saveBlobViaAnchor(document, url, width, height);
      } finally {
        // The anchor save reads the URL synchronously; revoke lazily so the
        // browser never races a slow download start.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    },
    sourceUrl,
  });
}

function handleEvent(event: JobEvent) {
  if (hostFailed) return;
  if (event.type === "progress") {
    if (typeof event.acquired !== "number" || typeof event.total !== "number") return;
    lastTileProgress = { current: event.acquired, total: event.total };
    render("downloading", { currentProgress: lastTileProgress, jobActivity: { startedAt: Date.now(), stepLabel: "Acquiring image tiles" } });
  }
  else if (event.type === "failed") { partialDecision = null; render("failed", { failure: event.error, jobActivity: { startedAt: Date.now(), stepLabel: "Job failed" } }); }
  else if (event.type === "cancelled") { partialDecision = null; render("cancelled", { jobActivity: { startedAt: Date.now(), stepLabel: "Cancelled" } }); }
  else if (event.type === "completed" || event.type === "partial-completed") { partialDecision = null; render("completed", { jobActivity: { startedAt: Date.now(), stepLabel: event.type === "completed" ? "Completed" : "Completed (partial)" } }); }
  else if (event.type === "catalog" && !selected) {
    selected = true;
    const selection = pickEngineSelection(
      (event.catalog ?? {}) as Parameters<typeof pickEngineSelection>[0],
    );
    if (!selection) {
      onHostFailure(Object.assign(new Error("No downloadable image was found on this page."), { code: "NO_IMAGE_FOUND", retryable: false }));
      controller?.cancel();
      return;
    }
    render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Preparing the image" } });
    controller?.selectImage(selection.image);
    controller?.selectLevel(selection.level);
  }
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
  lastTileProgress = null;
  const activeBinding = binding;
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  jobWorker = worker;
  const extensionTransport = createExtensionFetcher({
    hasPermission: async (origin) => testGrantedOrigins.has(origin) ||
      (!__DEZOOMIFY_TEST_PERMISSION_MOCK__ && !!(api?.permissions?.contains && await api.permissions.contains({ origins: [`${origin}/*`] }))),
  });
  sourceTransport = createCoordinatorSourceTransport({ sendMessage: send });
  controller = createJobController({
    worker,
    binding: () => activeBinding,
    sourceTransport,
    extensionTransport,
    get assembly() {
      if (!assembly) throw new Error("output assembly is not initialized");
      return assembly;
    },
    classifyFailure: engineFailure,
    onPermissionRequired: showAccessRequired,
    onPartialDecision: showPartialDecision,
    onHostFailure,
    onEvent: handleEvent,
    onUnsupportedEffect: (effect: unknown) => {
      // An effect this host cannot execute is a contract gap, never a fake
      // success: fail visibly instead of pretending it was performed.
      const type = effect && typeof effect === "object" && "type" in effect ? String(effect.type) : "unknown";
      onHostFailure(Object.assign(new Error(`This app cannot yet perform the ${type} step.`), { code: "EFFECT_UNSUPPORTED", retryable: false }));
      controller?.cancel();
    },
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    if (event.data?.type === "engine.messages") controller?.handleEngineMessages(event.data.messages ?? []);
    else if (event.data?.type === "engine.ranked") ranked(event.data);
    else if (event.data?.type === "engine.error") onHostFailure(event.data.error);
  });
  render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Waiting for image candidates" } });
}

function candidates(message: Record<string, unknown>) {
  if (!binding || !message || message.jobId !== binding.jobId || started) return;
  const values = Array.isArray(message.urls) ? message.urls.filter((candidate) => typeof candidate === "string") : [];
  if (!values.length) return;
  started = true;
  render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Finding the zoomable image" } });
  // The document URL is an explicit candidate, so the first entry is not
  // necessarily the zoomable source: rank with the core preference order
  // (resource-timing viewer traffic first) before starting the engine.
  jobWorker?.postMessage({ type: "engine.rank", requestId: requestId("rank"), urls: values });
}

function ranked(message: WorkerMessage) {
  if (!binding || assembly) return;
  const values = Array.isArray(message.urls) ? message.urls : [];
  const first = values.find((candidate) => typeof candidate === "string");
  if (!first) return;
  lastSource = first;
  assembly = createAssembly(first);
  controller?.start(lastSource);
}

api?.runtime?.onMessage?.addListener((message) => {
  if (message?.type === "dz.job.binding") setup(message);
  else if (message?.type === "dz.job.candidates") candidates(message);
  else if (message?.type === "dz.job.fetch") sourceTransport?.handleMessage?.(message);
  else if (message?.type === "dz.job.permission-required") resolvePermission(message);
});

window.addEventListener("beforeunload", () => {
  controller?.dispose();
  if (binding) void send(boundEnvelope("dz.job.closed")).catch(() => {});
});

render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Connecting to Dezoomify" } });
void send({ type: "dz.job.ready", jobId: bootstrapJobId, requestId: requestId("job-ready") }).catch(() => render("failed", { failure: { code: "network", category: "extension", retryable: true, message: "Could not connect this job tab to the extension." } }));
