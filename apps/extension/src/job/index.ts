/** Dedicated extension job-tab integration. No webpage postMessage bridge. */

import type { ErrorDto, JobHandle, JobSnapshot, JobState } from "@dezoomify/app-model";
import { createJobService } from "@dezoomify/app-model";
import {
  BROWSER_MAX_CANVAS_AREA,
  BROWSER_MAX_CANVAS_SIDE,
  BROWSER_MAX_PLAN_TILES,
  canvasToPngBlob,
  createBrowserRunner,
  createCanvasAssembly,
  createProbeSize,
  createTileDecoder,
  originOfUrl,
  saveBlobViaAnchor,
} from "@dezoomify/browser-runtime";
import { createLogger } from "@dezoomify/browser-runtime/logging";
import type {
  PresentationStatus,
  ViewContext as SharedViewContext,
  SnapshotPresentation,
  StructuredError,
} from "@dezoomify/shared-ui";
import {
  describeFailure,
  isActiveJobStatus,
  jobPageTitle,
  presentFailure,
  presentSnapshot,
  presentStatus,
  renderView,
} from "@dezoomify/shared-ui";
import type { ProcessingRecipe } from "@dezoomify/wasm-bindings";
import { createElement } from "react";
import { createExtensionFetcher } from "../runtime/fetch.ts";
import type { JobBinding } from "./transport.ts";
import {
  createCoordinatorSourceTransport,
  createEngineResourceFetcher,
  engineFailure,
  isJobBinding,
} from "./transport.ts";
import { AccessRequestView, PartialOutputActions } from "./view.tsx";

const TEST_PERMISSION_MOCK = import.meta.env.MODE === "testing";

type ExtensionApi = {
  runtime?: {
    sendMessage?(message: unknown): Promise<unknown>;
    onMessage?: { addListener(listener: (message: Record<string, unknown>) => void): void };
  };
  permissions?: {
    contains?(request: { origins: string[] }): Promise<boolean>;
    request?(request: { origins: string[] }): Promise<boolean>;
  };
};
type ViewContext = SharedViewContext & { failure?: StructuredError };

const hostGlobal = globalThis as typeof globalThis & {
  browser?: ExtensionApi;
  chrome?: ExtensionApi;
};
const api = hostGlobal.browser ?? hostGlobal.chrome;
const jobLog = createLogger("job");
// Mirror accepted log lines into the job view's technical-details log (and the
// copied diagnostics) so a failed job shows the interaction trace. Worker
// lines arrive over `engine.log` and join the same buffer.
const UI_LOG_MAX_LINES = 120;
const uiLogLines: string[] = [];
jobLog.addSink((entry) => {
  uiLogLines.push(entry.line);
  if (uiLogLines.length > UI_LOG_MAX_LINES)
    uiLogLines.splice(0, uiLogLines.length - UI_LOG_MAX_LINES);
});

/** @type {any | null} */
let binding: JobBinding | null = null;
/** Origin of the bound source document; "" until the binding arrives. Same-origin tiles and probes prefer the tab-origin transport. */
let siteOrigin = "";
/** Fallback request ids for probes that arrive without an engine request id. Start clear of the engine's small sequential ids. */
let probeSeq = 1 << 30;
// One shared browser runner attempt. The runner owns the worker, the WASM
// session, cross-worker processing calls, the abort scope, and disposal;
// this tab keeps binding, transport, assembly, and view wiring. The single
// authoritative snapshot renders directly; no derived mirrors.
let jobHandle: JobHandle | null = null;
let sourceTransport: ReturnType<typeof createCoordinatorSourceTransport> | null = null;
/** Runner abort signal of the live attempt (drives the cancelled() transport view). */
let attemptSignal: AbortSignal | null = null;
/** @type {ReturnType<typeof createCanvasAssembly> | null} */
let assembly: ReturnType<typeof createCanvasAssembly> | null = null;
let saveCompleted = false;
/** Single authoritative snapshot: render it directly, never a derived copy. */
let activeSnapshot: JobSnapshot | null = null;
let localFailure: StructuredError | null = null;
/** Ephemeral permission view (telemetry only, never gates commands). */
let pendingPermission: { hosts: string[]; requesting: boolean } | null = null;
const testGrantedOrigins = new Set<string>();
const bootstrapJobId = new URLSearchParams(location.hash.slice(1)).get("jobId");

function requestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? Date.now().toString(36)}`;
}
function boundEnvelope(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...binding, requestId: requestId(type.replaceAll(".", "-")), ...extra };
}

function root() {
  return document.getElementById("dz-job-app");
}

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

/** Save filename from the authoritative snapshot catalog; undefined when nothing is selected yet. */
function activeTitle(): string | undefined {
  const catalog = activeSnapshot?.selection.catalog;
  const idx = activeSnapshot?.selection.image;
  if (!catalog || idx === null || idx === undefined) return undefined;
  const entry = catalog.entries[idx];
  if (entry && entry.kind === "image" && typeof entry.title === "string" && entry.title !== "")
    return entry.title;
  return undefined;
}

/**
 * Host-step status for the pre-terminal title/activity only. Headlines and
 * progress always come from presentSnapshot of the DTO; this never drives
 * engine commands.
 */
function statusForLifecycle(lifecycle: JobState): PresentationStatus {
  switch (lifecycle) {
    case "Created":
    case "Discovering":
      return "discovering";
    case "AwaitingImageSelection":
      return "choosing-image";
    case "AwaitingLevelSelection":
      return "choosing-level";
    case "Planning":
      return "preflighting";
    case "Finalizing":
      return "saving";
    case "AcquiringTiles":
    case "AwaitingPartialDecision":
    case "Cancelling":
      return "downloading";
    case "Completed":
    case "PartiallyCompleted":
      return "completed";
    case "Failed":
      return "failed";
    case "Cancelled":
      return "cancelled";
  }
}

function presentFor(status: PresentationStatus, ctx: ViewContext): SnapshotPresentation {
  if (localFailure) return presentFailure(localFailure, "browser-session");
  if (activeSnapshot) {
    // Display-only is a host-known output fact (tainted canvas): probe the
    // assembly like the website does and pass it explicitly to
    // presentSnapshot. It is never written into the DTO.
    let displayOnly = false;
    try {
      displayOnly = assembly?.isTainted?.() === true;
    } catch {
      displayOnly = false;
    }
    return presentSnapshot(activeSnapshot, "browser-session", { displayOnly });
  }
  return presentStatus(status, {
    transport: "browser-session",
    ...(ctx.failure ? { error: ctx.failure } : {}),
  });
}

function render(status: PresentationStatus, ctx: ViewContext = {}) {
  const target = root();
  if (!target) return;
  const viewActivity = {
    ...(ctx.jobActivity ?? {}),
    ...(uiLogLines.length ? { log: uiLogLines.slice() } : {}),
  };
  const presentation = presentFor(status, ctx);
  // Outstanding partial decision, read off the DTO only: the closed
  // keep/retry/discard answers are the engine's RecoveryChoice values, never
  // fabricated actions.
  const decisionGeneration =
    activeSnapshot?.lifecycle === "AwaitingPartialDecision"
      ? activeSnapshot.decision?.generation
      : undefined;
  renderView(
    target,
    presentation,
    {
      onSubmitUrl: () => {},
      onCancel: closeJob,
      onCopyDiagnostics: copyDiagnostics,
      onRetrySameUrl: retryJob,
      onSave: () => {},
    },
    {
      ...ctx,
      ...(Object.keys(viewActivity).length ? { jobActivity: viewActivity } : {}),
    },
    {
      ...(pendingPermission
        ? {
            replace: createElement(AccessRequestView, {
              origin:
                pendingPermission.hosts.length === 1
                  ? pendingPermission.hosts[0]
                  : "the required image host",
              requesting: pendingPermission.requesting,
              onRequest: () => {
                if (!pendingPermission || pendingPermission.requesting) return;
                pendingPermission.requesting = true;
                render(status, ctx);
                const hosts = pendingPermission.hosts;
                const origins = hosts.map((origin) => `${origin}/*`);
                // Optional-host consent must be requested synchronously from this
                // click handler. A message hop to the service worker loses Chrome's
                // required user activation and leaves the UI stuck requesting access.
                // Chromium's native optional-permission prompt cannot be automated by
                // the headless extension driver. Its test package mocks only that
                // browser boundary; the click, coordinator validation, retry, and
                // completed output still run end to end.
                const request = TEST_PERMISSION_MOCK
                  ? Promise.resolve(true)
                  : Promise.resolve(api?.permissions?.request?.({ origins }));
                void request
                  .then((granted) => {
                    if (!granted) throw new Error("permission denied");
                    return send(
                      boundEnvelope("dz.job.permission-required", {
                        origins: hosts,
                        ...(TEST_PERMISSION_MOCK ? { testGrant: true } : {}),
                      }),
                    );
                  })
                  .catch(() => {
                    if (!pendingPermission) return;
                    pendingPermission.requesting = false;
                    render(status, ctx);
                  });
              },
            }),
          }
        : {}),
      ...(decisionGeneration !== undefined && !pendingPermission
        ? {
            after: createElement(PartialOutputActions, {
              onChoose: (keep) => {
                void jobHandle?.command({
                  type: "answer-partial",
                  generation: decisionGeneration,
                  decision: keep ? "keep" : "discard",
                });
                render("downloading", { jobActivity: { startedAt: Date.now() } });
              },
              onRetry: () => {
                void jobHandle?.command({
                  type: "answer-partial",
                  generation: decisionGeneration,
                  decision: "retry",
                });
                render("downloading", { jobActivity: { startedAt: Date.now() } });
              },
            }),
          }
        : {}),
    },
  );
  syncExtensionJobTitle(status, siteOrigin);
}

function send(message: unknown): Promise<unknown> {
  const type =
    message && typeof message === "object" && "type" in message
      ? String((message as { type?: unknown }).type)
      : "unknown";
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
  pendingPermission = { hosts, requesting: false };
  render("downloading", { jobActivity: { startedAt: Date.now() } });
}

function resolvePermission(message: Record<string, unknown>) {
  if (!binding || message.jobId !== binding.jobId || typeof message.granted !== "boolean") return;
  jobLog.info("permission-resolved", `jobId=${binding.jobId} granted=${message.granted}`);
  pendingPermission = null;
  if (TEST_PERMISSION_MOCK && message.granted && Array.isArray(message.origins)) {
    for (const origin of message.origins)
      if (typeof origin === "string") testGrantedOrigins.add(origin);
  }
  if (message.granted) {
    render("downloading", {
      jobActivity: { startedAt: Date.now() },
    });
  }
  try {
    jobHandle?.resolvePermission?.(message.granted);
  } catch {
    /* grant resolution is best effort */
  }
}

/** Source host for shared copy interpolation; "" when the input is unparseable. */
function sourceHost(): string {
  try {
    return new URL(siteOrigin).host;
  } catch {
    return "";
  }
}

/**
 * One shared presenter for engine failures: the plain headline goes in
 * `message`, the engine's raw per-format aggregate moves to `detail`, and the
 * stable category/phase/retryable are derived from the code. The extension
 * never renders the raw engine block as the first message. Every field is
 * typed from the terminal ErrorDto; nothing is read off untyped shapes.
 */
function presentEngineFailure(error: ErrorDto): StructuredError {
  return describeFailure({
    code: error.code,
    engineDetail: error.detail ?? error.message,
    retryable: error.retryable,
    message: error.message,
    phase: error.phase,
    // The extension always fetches under the granted browser session; the
    // engine's typed event carries no transport, so the details line would
    // otherwise misreport `direct`.
    transport: error.transport ?? "browser-session",
    host: sourceHost(),
    url: error.request,
    http: error.http,
    preview: error.preview,
  });
}

/** Host-side effect execution failed terminally: render it and stop. */
function onHostFailure(error: unknown) {
  if (localFailure) return;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "output-failed";
  const phase =
    error && typeof error === "object" && "phase" in error
      ? String((error as { phase?: unknown }).phase)
      : "unknown";
  jobLog.error(
    "host-failure",
    `jobId=${binding?.jobId ?? "unknown"} code=${code} phase=${phase} message=${error instanceof Error ? error.message : String(error)}`,
  );
  const candidate =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          message?: unknown;
          retryable?: unknown;
          detail?: unknown;
          phase?: unknown;
          transport?: unknown;
        })
      : null;
  localFailure = describeFailure({
    code,
    engineDetail:
      typeof candidate?.detail === "string"
        ? candidate.detail
        : typeof candidate?.message === "string"
          ? candidate.message
          : undefined,
    retryable: candidate?.retryable === true,
    phase,
    transport: typeof candidate?.transport === "string" ? candidate.transport : undefined,
    host: sourceHost(),
  });
  render("failed", { jobActivity: { startedAt: Date.now() } });
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
        throw Object.assign(new Error("This browser could not create the output surface."), {
          code: "OUTPUT_SURFACE_UNAVAILABLE",
          retryable: false,
        });
      }
      // The executor draws through ctx2d and encodes through toBlob: expose
      // both on one surface object.
      return {
        width,
        height,
        ctx2d,
        toBlob: (cb: BlobCallback, mime?: string) => element.toBlob(cb, mime),
      };
    },
    encode: (canvas) =>
      canvasToPngBlob(canvas as unknown as { toBlob(cb: BlobCallback, mime?: string): void }),
    save: (blob: unknown, width: number, height: number) => {
      if (!(blob instanceof Blob)) throw new TypeError("encoded output is not a Blob");
      const url = URL.createObjectURL(blob);
      try {
        saveBlobViaAnchor(document, url, width, height, activeTitle());
        saveCompleted = true;
      } finally {
        // The anchor save reads the URL synchronously; revoke lazily so the
        // browser never races a slow download start.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      return "browser-save-initiated";
    },
    sourceUrl,
  });
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
  } catch {
    siteOrigin = "";
  }
  jobLog.info(
    "binding-received",
    `jobId=${binding.jobId} tab=${binding.tabId} frame=${binding.frameId} gen=${binding.documentGeneration}`,
  );
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
  attemptSignal = null;
  if (handle) {
    try {
      void handle.dispose().catch(() => {});
    } catch {
      /* teardown is best effort */
    }
  }
  try {
    assembly?.release();
  } catch {
    /* bitmap cleanup is best effort */
  }
  assembly = null;
  saveCompleted = false;
  sourceTransport = null;
}

/** Clear every per-attempt flag and buffer; the source binding is untouched. */
function resetAttemptState() {
  activeSnapshot = null;
  localFailure = null;
  pendingPermission = null;
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
    hasPermission: async (origin) =>
      testGrantedOrigins.has(origin) ||
      (!TEST_PERMISSION_MOCK &&
        !!(
          api?.permissions?.contains &&
          (await api.permissions.contains({ origins: [`${origin}/*`] }))
        )),
  });
  const extensionTransport = {
    async fetchResource(url: string, opts?: unknown) {
      jobLog.debug(
        "extension-fetch-start",
        `url=${url} purpose=${String((opts as { purpose?: unknown } | undefined)?.purpose ?? "unknown")}`,
      );
      try {
        const result = await fetcher.fetchResource(
          url,
          opts as Parameters<typeof fetcher.fetchResource>[1],
        );
        jobLog.debug("extension-fetch-complete", `url=${url} bytes=${result.bytes.byteLength}`);
        return result;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "unknown";
        jobLog.warn(
          "extension-fetch-failed",
          `url=${url} code=${code} message=${error instanceof Error ? error.message : String(error)}`,
        );
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
    onSourceFailure: (cause) =>
      jobLog.warn(
        "source-fetch-failed",
        `code=${String(cause.code ?? cause.blocked_reason ?? "network")} retrying=extension-origin`,
      ),
  });
  const probeDecoder = createTileDecoder();
  const runner = createBrowserRunner({
    createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
    fetchResource: (effect, signal) => {
      attemptSignal = signal;
      if (signal.aborted || attemptCancelled) {
        return Promise.reject(
          Object.assign(new Error("request cancelled"), { category: "cancelled" }),
        );
      }
      return fetchResource(effect);
    },
    probeSize: createProbeSize({
      fetchTile: async (url: string, headers: Record<string, string>, requestId?: number) => {
        let id = requestId;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
          probeSeq += 1;
          id = probeSeq;
        }
        const result = await fetchResource({
          request: {
            id,
            uri: url,
            headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
            purpose: "probe",
          },
        });
        const bytes = new Uint8Array(result.bytes).slice().buffer as ArrayBuffer;
        return { bytes };
      },
      decode: (bytes: ArrayBuffer) => probeDecoder.decode(bytes),
      loadImage: (url: string) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () =>
            resolve({
              width: img.naturalWidth,
              height: img.naturalHeight,
              image: img,
            });
          img.onerror = () => reject(new Error("probe image failed to load"));
          img.src = url;
        }),
    }),
    loadDisplayImage: (url: string) =>
      new Promise((resolve, reject) => {
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
    isPermissionPending: () => pendingPermission !== null,
    getOutputState: () => (saveCompleted ? "writable" : "pending"),
    onPermissionRequired: (detail) => {
      showAccessRequired(detail);
    },
    onRecoveryRequested: () => {
      // The authoritative snapshot carries the decision generation; re-render
      // it directly instead of copying the generation aside.
      if (activeSnapshot) renderForSnapshot(activeSnapshot);
    },
    log: (level, code, detail) => jobLog.log(level, code, detail),
    onAbort: () => {
      attemptCancelled = true;
      try {
        fetcher.cancel();
      } catch {
        /* abort must never break teardown */
      }
    },
  });
  const service = createJobService(runner);
  try {
    const handle = await service.start(
      {
        inputs,
        engine: {
          max_tiles: BROWSER_MAX_PLAN_TILES,
          browser_selection: {
            maxWidth: BROWSER_MAX_CANVAS_SIDE,
            maxHeight: BROWSER_MAX_CANVAS_SIDE,
            maxArea: BROWSER_MAX_CANVAS_AREA,
          },
        },
        exec: { kind: "browser", sourceUrl: inputs[0]?.url ?? "" },
      },
      {
        snapshot: (snapshot: JobSnapshot) => {
          if (localFailure) return;
          activeSnapshot = snapshot;
          renderForSnapshot(snapshot);
        },
        hostStatus: () => {},
      },
    );
    jobHandle = handle;
  } catch (error) {
    onHostFailure(error);
  }
}

/** Render one authoritative snapshot: terminal.type wins over the live lifecycle. */
function renderForSnapshot(snapshot: JobSnapshot) {
  const terminal = snapshot.terminal;
  if (terminal?.type === "failed") {
    jobLog.error("engine-terminal", `type=failed code=${terminal.error.code}`);
    localFailure = presentEngineFailure(terminal.error);
    render("failed", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  if (terminal?.type === "cancelled") {
    render("cancelled", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  if (terminal?.type === "completed" || terminal?.type === "partial-completed") {
    render("completed", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  render(statusForLifecycle(snapshot.lifecycle), { jobActivity: { startedAt: Date.now() } });
}

/**
 * Announce this job tab to the coordinator. Used on first load and when a
 * retry is pressed before the first binding ever arrived; the coordinator
 * replies with the binding and a fresh candidate snapshot.
 */
function announceReady() {
  jobLog.info("job-ready-sent", `jobId=${bootstrapJobId ?? "unknown"}`);
  render("discovering", { jobActivity: { startedAt: Date.now() } });
  void send({
    type: "dz.job.ready",
    jobId: bootstrapJobId,
    requestId: requestId("job-ready"),
  }).catch(() =>
    onHostFailure(
      Object.assign(new Error("Could not connect this job tab to the extension."), {
        code: "network",
        retryable: true,
      }),
    ),
  );
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
    onHostFailure(
      Object.assign(new Error("Could not ask the extension to retry this job."), {
        code: "network",
        retryable: true,
      }),
    ),
  );
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
  if (!binding || !message || message.jobId !== binding.jobId || jobHandle) return;
  const values = Array.isArray(message.inputs)
    ? message.inputs.flatMap((candidate) => {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          !("url" in candidate) ||
          typeof candidate.url !== "string"
        )
          return [];
        return [
          {
            url: candidate.url,
            ...("contents" in candidate && typeof candidate.contents === "string"
              ? { contents: candidate.contents }
              : {}),
          },
        ];
      })
    : [];
  if (!values.length) return;
  jobLog.info(
    "candidates-received",
    `jobId=${binding.jobId} count=${values.length} overflow=${typeof message.overflow === "number" ? message.overflow : 0}`,
  );
  render("discovering", { jobActivity: { startedAt: Date.now() } });
  const firstUrl = values[0].url;
  jobLog.info("engine-start", `jobId=${binding.jobId} url=${firstUrl}`);
  void beginAttempt(values);
}

api?.runtime?.onMessage?.addListener((message) => {
  if (typeof message?.type === "string" && message.type.startsWith("dz.job."))
    jobLog.debug("background-message-received", `type=${message.type}`);
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
