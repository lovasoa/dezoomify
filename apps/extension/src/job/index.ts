/** Dedicated extension job-tab integration. No webpage postMessage bridge. */
import { createExtensionFetcher } from "../runtime/fetch.js";
import { renderView } from "../vendor/view.js";
import { createJobController } from "./controller.js";
import { createCoordinatorSourceTransport, isJobBinding } from "./transport.js";

const api = globalThis.browser ?? globalThis.chrome;

/** @type {any | null} */
let binding = null;
/** @type {ReturnType<typeof createJobController> | null} */
let controller = null;
let sourceTransport = null;
let seq = 0;
let started = false;
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

function setup(bound) {
  if (!isJobBinding(bound) || binding) return;
  binding = bound;
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const extensionTransport = createExtensionFetcher({
    hasPermission: async (origin) => !!(api?.permissions?.contains && await api.permissions.contains({ origins: [`${origin}/*`] })),
  });
  sourceTransport = createCoordinatorSourceTransport({ sendMessage: send });
  controller = createJobController({
    worker,
    binding: () => binding,
    sourceTransport,
    extensionTransport,
    onPermissionRequired: showAccessRequired,
    onEvent: (event) => {
      if (event.type === "progress") render("downloading", { currentProgress: { current: event.acquired, total: event.total }, jobActivity: { startedAt: Date.now(), stepLabel: "Acquiring image tiles" } });
      else if (event.type === "failed") render("failed", { failure: event.error, jobActivity: { startedAt: Date.now(), stepLabel: "Job failed" } });
      else if (event.type === "cancelled") render("cancelled", { jobActivity: { startedAt: Date.now(), stepLabel: "Cancelled" } });
      else if (event.type === "completed" || event.type === "partial-completed") render("completed", { jobActivity: { startedAt: Date.now(), stepLabel: "Completed" } });
      else if (event.type === "catalog") render("downloading", { imageCount: event.catalog?.images?.length ?? 0, jobActivity: { startedAt: Date.now(), stepLabel: "Choose an image" } });
    },
    onUnsupportedEffect: (effect) => {
      // Existing WASM HostEffect lacks canvas geometry/output ownership. Do
      // not fabricate a JS plan or pretend an encoded file was produced.
      render("failed", { failure: { code: "transport-unavailable", category: "extension", retryable: false, message: `The job engine cannot yet expose ${effect.type} to this extension host.` } });
      controller?.cancel();
    },
  });
  worker.addEventListener("message", (event) => {
    if (event.data?.type === "engine.messages") controller?.handleEngineMessages(event.data.messages);
    if (event.data?.type === "engine.error") render("failed", { failure: event.data.error });
  });
  render("discovering", { jobActivity: { startedAt: Date.now(), stepLabel: "Waiting for image candidates" } });
}

function candidates(message) {
  if (!binding || !message || message.jobId !== binding.jobId || started) return;
  const values = Array.isArray(message.urls) ? message.urls : [];
  const first = values.find((candidate) => typeof candidate === "string");
  if (!first) return;
  started = true;
  lastSource = first;
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
