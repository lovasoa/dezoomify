/** Dedicated extension job-tab integration. No webpage postMessage bridge. */
import { createExtensionFetcher } from "../runtime/fetch.js";
import { renderView } from "../vendor/view.js";
import { createTileDecoder } from "../vendor/tile-decode.js";
import { canvasToPngBlob, saveBlobViaAnchor } from "../vendor/canvas-save.js";
import { createCanvasAssembly } from "../vendor/assembly.js";
import { pickEngineSelection } from "../vendor/engine-selection.js";
import { createJobController } from "./controller.js";
import { createCoordinatorSourceTransport, engineFailure, isJobBinding } from "./transport.js";

const api = globalThis.browser ?? globalThis.chrome;

/** @type {any | null} */
let binding = null;
/** @type {ReturnType<typeof createJobController> | null} */
let controller = null;
let sourceTransport = null;
let jobWorker = null;
/** @type {ReturnType<typeof createCanvasAssembly> | null} */
let assembly = null;
let seq = 0;
let started = false;
let selected = false;
let hostFailed = false;
let lastSource = "";
const bootstrapJobId = new URLSearchParams(location.hash.slice(1)).get("jobId");

function requestId(prefix) { return `${prefix}-${crypto.randomUUID?.() ?? Date.now().toString(36)}`; }
function boundEnvelope(type, extra = {}) { return { type, ...binding, requestId: requestId(type.replaceAll(".", "-")), ...extra }; }

function root() { return document.getElementById("dz-job-app"); }

function render(status, ctx = {}) {
  const target = root();
  if (!target) return;
  seq += 1;
  renderView(target, { status, seq, sessionId: binding?.jobId ?? "job:pending", transport: "browser-session", imageCount: 0, ...(ctx.failure ? { error: ctx.failure } : {}) }, {
    onSubmitUrl: () => {},
    onCancel: closeJob,
    onReset: () => {},
    onRetrySameUrl: () => {},
    onSave: () => {},
  }, ctx);
}

function send(message) {
  if (!api?.runtime?.sendMessage) return Promise.reject(new Error("extension runtime unavailable"));
  return api.runtime.sendMessage(message);
}

function closeJob() {
  controller?.cancel();
  if (binding) void send(boundEnvelope("dz.job.cancel")).catch(() => {});
  if (binding) void send(boundEnvelope("dz.job.closed")).catch(() => {});
}

function showAccessRequired(detail) {
  const hosts = Array.isArray(detail.hosts) ? detail.hosts : [];
  render("failed", {
    failure: { code: "access-required", category: "extension", retryable: true, message: `This image uses files from: ${hosts.join(", ") || "another site"}` },
    jobActivity: { startedAt: Date.now(), stepLabel: "Waiting for access" },
  });
  const target = root();
  if (!target || target.querySelector("[data-dz-allow-access]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dz-btn-tactile";
  button.dataset.dzAllowAccess = "true";
  button.textContent = "Allow access and continue";
  button.addEventListener("click", () => {
    // This click is the only path that may cause the coordinator to call the
    // browser permission API. The worker/fetch transport never does so.
    void send(boundEnvelope("dz.job.permission-required", { origins: hosts })).catch(() => {});
  });
  target.append(button);
}

/**
 * The engine stopped for a typed partial decision: every failed tile has
 * exhausted its retries. Only an explicit user action chooses keep/discard;
 * the engine owns the consequence (encode with missing regions, or fail).
 */
function showPartialDecision(recovery) {
  if (typeof recovery !== "string" || !recovery.startsWith("rec:")) return;
  render("downloading", { jobActivity: { startedAt: Date.now(), stepLabel: "Some tiles are missing" } });
  const target = root();
  if (!target || target.querySelector("[data-dz-partial-choice]")) return;
  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "dz-btn-tactile";
  keep.dataset.dzPartialChoice = "keep";
  keep.textContent = "Keep the partial image";
  keep.addEventListener("click", () => controller?.choosePartial(recovery, true));
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "dz-btn-tactile";
  discard.dataset.dzPartialChoice = "discard";
  discard.textContent = "Discard the partial image";
  discard.addEventListener("click", () => controller?.choosePartial(recovery, false));
  target.append(keep, discard);
}

/** Host-side effect execution failed terminally: render it and stop. */
function onHostFailure(error) {
  if (hostFailed) return;
  hostFailed = true;
  const failure = error && typeof error.code === "string"
    ? { code: error.code, category: "extension", retryable: false, message: error.message || "The image could not be assembled in this tab." }
    : { code: "output-failed", category: "extension", retryable: false, message: "The image could not be assembled in this tab." };
  render("failed", { failure, jobActivity: { startedAt: Date.now(), stepLabel: "Job failed" } });
}

function createAssembly(sourceUrl) {
  const decoder = createTileDecoder();
  return createCanvasAssembly({
    decode: (bytes) => decoder.decode(bytes),
    createCanvas: (width, height) => {
      const element = document.createElement("canvas");
      element.width = width;
      element.height = height;
      const ctx2d = element.getContext("2d");
      if (!ctx2d) {
        throw Object.assign(new Error("This browser could not create the output surface."), { code: "OUTPUT_SURFACE_UNAVAILABLE", retryable: false });
      }
      // The executor draws through ctx2d and encodes through toBlob: expose
      // both on one surface object.
      return { width, height, ctx2d, toBlob: (cb, mime) => element.toBlob(cb, mime) };
    },
    encode: (canvas) => canvasToPngBlob(canvas),
    save: (blob, width, height) => {
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

function handleEvent(event) {
  if (hostFailed) return;
  if (event.type === "progress") render("downloading", { currentProgress: { current: event.acquired, total: event.total }, jobActivity: { startedAt: Date.now(), stepLabel: "Acquiring image tiles" } });
  else if (event.type === "failed") render("failed", { failure: event.error, jobActivity: { startedAt: Date.now(), stepLabel: "Job failed" } });
  else if (event.type === "cancelled") render("cancelled", { jobActivity: { startedAt: Date.now(), stepLabel: "Cancelled" } });
  else if (event.type === "completed" || event.type === "partial-completed") render("completed", { jobActivity: { startedAt: Date.now(), stepLabel: event.type === "completed" ? "Completed" : "Completed (partial)" } });
  else if (event.type === "catalog" && !selected) {
    selected = true;
    const selection = pickEngineSelection(event.catalog ?? {});
    if (!selection) {
      onHostFailure(Object.assign(new Error("No downloadable image was found on this page."), { code: "NO_IMAGE_FOUND", retryable: false }));
      controller?.cancel();
      return;
    }
    render("downloading", { imageCount: event.catalog?.images?.length ?? 0, jobActivity: { startedAt: Date.now(), stepLabel: "Preparing the image" } });
    controller?.selectImage(selection.image);
    controller?.selectLevel(selection.level);
  }
}

function setup(bound) {
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
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  jobWorker = worker;
  const extensionTransport = createExtensionFetcher({
    hasPermission: async (origin) => !!(api?.permissions?.contains && await api.permissions.contains({ origins: [`${origin}/*`] })),
  });
  sourceTransport = createCoordinatorSourceTransport({ sendMessage: send });
  controller = createJobController({
    worker,
    binding: () => binding,
    sourceTransport,
    extensionTransport,
    get assembly() { return assembly; },
    classifyFailure: engineFailure,
    onPermissionRequired: showAccessRequired,
    onPartialDecision: showPartialDecision,
    onHostFailure,
    onEvent: handleEvent,
    onUnsupportedEffect: (effect) => {
      // An effect this host cannot execute is a contract gap, never a fake
      // success: fail visibly instead of pretending it was performed.
      onHostFailure(Object.assign(new Error(`This app cannot yet perform the ${effect?.type} step.`), { code: "EFFECT_UNSUPPORTED", retryable: false }));
      controller?.cancel();
    },
  });
  worker.addEventListener("message", (event) => {
    if (event.data?.type === "engine.messages") controller?.handleEngineMessages(event.data.messages);
    else if (event.data?.type === "engine.ranked") ranked(event.data);
    else if (event.data?.type === "engine.error") onHostFailure(event.data.error);
  });
  render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Waiting for image candidates" } });
}

function candidates(message) {
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

function ranked(message) {
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
});

window.addEventListener("beforeunload", () => {
  controller?.dispose();
  if (binding) void send(boundEnvelope("dz.job.closed")).catch(() => {});
});

render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Connecting to Dezoomify" } });
void send({ type: "dz.job.ready", jobId: bootstrapJobId, requestId: requestId("job-ready") }).catch(() => render("failed", { failure: { code: "network", category: "extension", retryable: true, message: "Could not connect this job tab to the extension." } }));
