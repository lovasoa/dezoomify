/** Dedicated extension job-tab integration. No webpage postMessage bridge. */

import type { Error as EngineError, JobHandle, JobSnapshot, JobState } from "@dezoomify/app-model";
import { suggestedNameFor } from "@dezoomify/app-model";
import {
  BROWSER_MAX_PLAN_TILES,
  browserLimitsFor,
  type ClientHints,
  canvasAllocationFailure,
  canvasSurfaceFailure,
  canvasToPngBlob,
  createBrowserJobService,
  createCanvasAssembly,
  createProbeSize,
  createTileDecoder,
  desktopHandoffLink,
  MAXIMUM_SELECTION_LIMITS,
  originOfUrl,
  selectionLimitsFor,
  wantsDesktopHandoff,
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
  t,
} from "@dezoomify/shared-ui";
import type { ProcessingRecipe } from "@dezoomify/wasm-bindings";
import { createElement } from "react";
import type { WxtBrowser } from "wxt/browser";
import { asFetchFailure, createExtensionFetcher } from "../runtime/fetch.ts";
import { actOnDownload, downloadAndWait } from "./downloads.ts";
import { createSourceAccess } from "./source-access.ts";
import { createEngineResourceFetcher } from "./transport.ts";
import { AccessRequestView, PartialOutputActions } from "./view.tsx";

const TEST_PERMISSION_MOCK = import.meta.env.MODE === "testing";

type ExtensionApi = Partial<
  Pick<WxtBrowser, "action" | "runtime" | "permissions" | "tabs" | "scripting" | "downloads">
>;
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

let sourceAccess: ReturnType<typeof createSourceAccess> | null = null;
let siteOrigin = "";
/** Fallback request ids for probes that arrive without an engine request id. Start clear of the engine's small sequential ids. */
let probeSeq = 1 << 30;
// One shared browser job service attempt. The service owns the worker, the WASM
// session, cross-worker processing calls, the abort scope, and disposal;
// this tab owns source access, transport, assembly, and view wiring. The single
// authoritative snapshot renders directly; no derived mirrors.
let jobHandle: JobHandle | null = null;
/** Service abort signal of the live attempt (drives the cancelled() transport view). */
let attemptSignal: AbortSignal | null = null;
let discoveryGeneration = 0;
let assembly: ReturnType<typeof createCanvasAssembly> | null = null;
let savedDownloadId: number | null = null;
let savedDownloadName: string | undefined;
/** Single authoritative snapshot: render it directly, never a derived copy. */
let activeSnapshot: JobSnapshot | null = null;
let localFailure: StructuredError | null = null;
let testCompletionNotified = false;
let lastActionIndicator = "";
/** Ephemeral permission view (telemetry only, never gates commands). */
let pendingPermission: { hosts: string[]; requesting: boolean } | null = null;
const testGrantedOrigins = new Set<string>();
/** True when the next attempt must target the maximum known resolution. */
let tryMaximumNext = false;
/** Source URL of the live attempt (desktop handoff link for canvas failures). */
let attemptSourceUrl = "";
const sourceTabParam = new URLSearchParams(location.hash.slice(1)).get("sourceTabId");
const parsedSourceTabId =
  sourceTabParam !== null && /^\d+$/.test(sourceTabParam) ? Number(sourceTabParam) : -1;
const sourceTabId =
  Number.isSafeInteger(parsedSourceTabId) && parsedSourceTabId >= 0 ? parsedSourceTabId : null;
const sessionId = `job:${crypto.randomUUID()}`;
const IDLE_ICON = {
  16: "icons/icon16-grey.png",
  48: "icons/icon48-grey.png",
  128: "icons/icon128-grey.png",
};
const ACTIVE_ICON = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };

type SourceAccessTestHook = {
  scan(): Promise<{ documentUrl: string; count: number; firstUrl: string }>;
  fetch(url: string): Promise<{ byteLength: number }>;
};
type JobTestWindow = Window & { __DEZOOMIFY_TEST_SOURCE_ACCESS__?: SourceAccessTestHook };

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
  const savedOutput =
    status === "completed" && savedDownloadId !== null
      ? completedDownloadSummary(presentation)
      : undefined;
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
      onTryMaximum: tryMaximum,
      onSave: () => {},
      ...(status === "completed" && savedDownloadId !== null
        ? {
            onOpenOutput: () => handleDownloadAction("open"),
            onRevealOutput: () => handleDownloadAction("reveal"),
          }
        : {}),
    },
    {
      ...ctx,
      ...(savedOutput ? { savedOutput } : {}),
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
                // click handler. Keeping it here retains Chrome's user activation.
                // Chromium's native optional-permission prompt cannot be automated by
                // the headless extension driver, so its package mocks this browser API.
                const request = TEST_PERMISSION_MOCK
                  ? Promise.resolve(true)
                  : Promise.resolve(api?.permissions?.request?.({ origins }));
                void request
                  .then((granted) => {
                    if (!granted) throw new Error("permission denied");
                    if (TEST_PERMISSION_MOCK)
                      for (const origin of hosts) testGrantedOrigins.add(origin);
                    return TEST_PERMISSION_MOCK
                      ? true
                      : api?.permissions?.contains?.({ origins }).then(Boolean);
                  })
                  .then((granted) => {
                    if (!granted) throw new Error("permission was not retained");
                    pendingPermission = null;
                    jobHandle?.resolvePermission?.(true);
                    render("downloading", { jobActivity: { startedAt: Date.now() } });
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
  syncExtensionJobIndicator(status);
}

function completedDownloadSummary(
  presentation: SnapshotPresentation,
): SharedViewContext["savedOutput"] {
  const canvas = activeSnapshot?.output?.canvas;
  if (!canvas || !savedDownloadName) return undefined;
  const tiles = presentation.terminal?.output;
  const doneTiles = tiles?.doneTiles ?? 0;
  const failedTiles = tiles?.failedTiles ?? 0;
  return {
    name: savedDownloadName,
    width: canvas.width,
    height: canvas.height,
    doneTiles,
    totalTiles: tiles?.totalTiles ?? doneTiles + failedTiles,
    failedTiles,
  };
}

function handleDownloadAction(action: "open" | "reveal") {
  const downloads = api?.downloads;
  const downloadId = savedDownloadId;
  if (!downloads || downloadId === null) return;
  root()?.querySelector("#dz-output-action-error")?.remove();
  void actOnDownload(downloads, downloadId, action).catch(() => {
    const code = action === "open" ? "output.open-failed" : "output.folder-failed";
    jobLog.error("output-action-failed", `jobId=${sessionId} code=${code}`);
    const section = root()?.querySelector(".dz-completed-section");
    if (!section) return;
    const note = section.ownerDocument.createElement("p");
    note.id = "dz-output-action-error";
    note.setAttribute("role", "alert");
    note.textContent = t(action === "open" ? "desktop.done.openError" : "desktop.done.folderError");
    section.appendChild(note);
  });
}

/** The job page owns the toolbar status; the background only opens this page. */
function syncExtensionJobIndicator(status: PresentationStatus) {
  if (sourceTabId === null || !api?.action) return;
  const active = isActiveJobStatus(status);
  const failed = status === "failed";
  const next = `${active}:${failed}`;
  if (next === lastActionIndicator) return;
  lastActionIndicator = next;
  void api.action
    .setIcon({ tabId: sourceTabId, path: active || failed ? ACTIVE_ICON : IDLE_ICON })
    .catch(() => {});
  void api.action
    .setBadgeText({ tabId: sourceTabId, text: active ? (failed ? "!" : "•") : failed ? "!" : "" })
    .catch(() => {});
}

function closeJob() {
  discoveryGeneration += 1;
  jobLog.info("job-cancelled", `jobId=${sessionId}`);
  const handle = jobHandle;
  void handle?.command({ type: "cancel" }).catch(() => {});
  stopAttempt();
  render("cancelled", { jobActivity: { startedAt: Date.now() } });
}

function showAccessRequired(detail: { hosts: string[] }) {
  const hosts = Array.isArray(detail.hosts) ? detail.hosts : [];
  jobLog.info("permission-requested", `jobId=${sessionId} hosts=${hosts.length}`);
  pendingPermission = { hosts, requesting: false };
  render("downloading", { jobActivity: { startedAt: Date.now() } });
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
 * Desktop handoff action beside a failure report: canvas and size failures
 * (allocation, context, PNG encoding) are recovered in the desktop app.
 */
function failureHandoffCtx(code: string): Partial<ViewContext> {
  if (!wantsDesktopHandoff(code)) return {};
  const link = desktopHandoffLink(attemptSourceUrl);
  return link !== "" ? { sourceUrl: attemptSourceUrl, desktopHandoffUrl: link } : {};
}

/** Device limit tier inputs: client hints where available, else the UA. */
function clientHints(): ClientHints {
  return navigator as unknown as ClientHints;
}

/**
 * One shared presenter for engine failures: the plain headline goes in
 * `message`, the engine's raw per-format aggregate moves to `detail`, and the
 * stable category/phase/retryable are derived from the code. The extension
 * never renders the raw engine block as the first message. Every field is
 * typed from the terminal Error; nothing is read off untyped shapes.
 */
function presentEngineFailure(error: EngineError): StructuredError {
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
    `jobId=${sessionId} code=${code} phase=${phase} message=${error instanceof Error ? error.message : String(error)}`,
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
  render("failed", {
    jobActivity: { startedAt: Date.now() },
    ...failureHandoffCtx(code),
  });
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
    save: async (blob: unknown, width: number, height: number) => {
      if (!(blob instanceof Blob)) throw new TypeError("encoded output is not a Blob");
      const downloads = api?.downloads;
      if (!downloads) {
        throw Object.assign(new Error("The browser download API is unavailable."), {
          code: "OUTPUT_SAVE_FAILED",
          retryable: false,
        });
      }
      const url = URL.createObjectURL(blob);
      try {
        const filename = suggestedNameFor(width, height, "png", activeTitle());
        jobLog.info("output-save-start", `jobId=${sessionId}`);
        const item = await downloadAndWait(downloads, url, filename);
        savedDownloadId = item.id;
        savedDownloadName = item.filename?.split(/[\\/]/).pop() || filename;
        jobLog.info("output-save-complete", `jobId=${sessionId}`);
      } finally {
        URL.revokeObjectURL(url);
      }
      return "browser-save-ready" as const;
    },
    sourceUrl,
    limits: browserLimitsFor(clientHints()),
  });
}

function installTestSourceAccessHook() {
  if (!TEST_PERMISSION_MOCK || !sourceAccess) return;
  (window as JobTestWindow).__DEZOOMIFY_TEST_SOURCE_ACCESS__ = {
    async scan() {
      const snapshot = await sourceAccess?.scan();
      if (!snapshot) throw new Error("source access is unavailable");
      return {
        documentUrl: snapshot.documentUrl,
        count: snapshot.inputs.length,
        firstUrl: snapshot.inputs[0]?.url ?? snapshot.documentUrl,
      };
    },
    async fetch(url) {
      const result = await sourceAccess?.fetch(
        { uri: url, headers: [] },
        new AbortController().signal,
      );
      if (!result) throw new Error("source access is unavailable");
      return { byteLength: result.bytes.byteLength };
    },
  };
}

async function bindSourceTab() {
  render("discovering", { jobActivity: { startedAt: Date.now() } });
  if (sourceTabId === null || !api?.tabs || !api.scripting) {
    onHostFailure(
      Object.assign(new Error("Could not find the source tab for this job."), {
        code: "source-document-lost",
        retryable: false,
      }),
    );
    return;
  }
  try {
    const tab = await api.tabs.get(sourceTabId);
    if (typeof tab.url !== "string" || originOfUrl(tab.url) === "")
      throw Object.assign(new Error("The source tab no longer has a readable web page."), {
        code: "source-document-lost",
        retryable: false,
      });
    sourceAccess = createSourceAccess(api as Pick<WxtBrowser, "tabs" | "scripting">, {
      tabId: sourceTabId,
      documentUrl: tab.url,
    });
    siteOrigin = sourceAccess.origin;
    installTestSourceAccessHook();
    jobLog.info("source-bound", `tab=${sourceTabId} origin=${siteOrigin}`);
    await startAttempt();
  } catch (error) {
    onHostFailure(error);
  }
}

/** Dispose one engine attempt before a retry. The source access stays bound to the source tab. */
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
  savedDownloadId = null;
  savedDownloadName = undefined;
}

/** Reset data owned by the previous engine attempt. */
function resetAttemptState() {
  activeSnapshot = null;
  localFailure = null;
  pendingPermission = null;
  savedDownloadId = null;
  savedDownloadName = undefined;
}

/** Start one WASM-backed attempt with source-tab access and extension-origin fallback. */
async function beginAttempt(inputs: Array<{ url: string; contents?: string }>) {
  const generation = discoveryGeneration;
  const source = sourceAccess;
  if (!source) return;
  attemptSourceUrl = inputs[0]?.url ?? "";
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
    async fetchResource(url: string, opts?: Parameters<typeof fetcher.fetchResource>[1]) {
      jobLog.debug(
        "extension-fetch-start",
        `url=${url} purpose=${String(opts?.purpose ?? "unknown")}`,
      );
      try {
        const result = await fetcher.fetchResource(url, opts);
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
  const fetchResource = createEngineResourceFetcher({
    sourceAccess: source,
    extensionTransport,
    onSourceFailure: (cause) =>
      jobLog.warn(
        "source-fetch-fallback",
        `code=${String(cause.code ?? "network")} origin=extension`,
      ),
  });
  const probeDecoder = createTileDecoder();
  const service = createBrowserJobService({
    createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
    fetchResource: (effect, signal) => {
      attemptSignal = signal;
      if (signal.aborted) {
        return Promise.reject(
          Object.assign(new Error("request cancelled"), { category: "cancelled" }),
        );
      }
      return fetchResource(effect, signal);
    },
    probeSize: createProbeSize({
      fetchTile: async (url: string, headers: Record<string, string>, requestId?: number) => {
        let id = requestId;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
          probeSeq += 1;
          id = probeSeq;
        }
        const result = await fetchResource(
          {
            request: {
              id,
              uri: url,
              headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
              purpose: "probe",
            },
          },
          attemptSignal ?? new AbortController().signal,
        );
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
    classifyFailure: asFetchFailure,
    createAssembly: ({ sourceUrl, processTile }) => {
      const asm = createAssembly(sourceUrl, processTile);
      assembly = asm;
      return asm;
    },
    // Browser session baseline: 6 concurrent tile fetches (matches the
    // website). The engine validates the budget at job creation.
    quotas: { max_concurrent_fetches: 6 },
    sessionId: () => sessionId,
    getTransport: () => "browser-session",
    isPermissionPending: () => pendingPermission !== null,
    getOutputState: () => (savedDownloadId !== null ? "writable" : "pending"),
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
      try {
        fetcher.cancel();
      } catch {
        /* abort must never break teardown */
      }
    },
  });
  try {
    // A "Try maximum" attempt takes the largest known level; the canvas gate
    // reports what cannot work (allocation, context, or PNG encoding).
    const selection = tryMaximumNext ? MAXIMUM_SELECTION_LIMITS : selectionLimitsFor(clientHints());
    tryMaximumNext = false;
    const handle = await service.start(
      {
        inputs,
        engine: {
          max_tiles: BROWSER_MAX_PLAN_TILES,
          browser_selection: selection,
        },
        host: { kind: "browser", sourceUrl: inputs[0]?.url ?? "" },
      },
      {
        snapshot: (snapshot: JobSnapshot) => {
          if (localFailure || generation !== discoveryGeneration) return;
          activeSnapshot = snapshot;
          renderForSnapshot(snapshot);
        },
        hostStatus: () => {},
      },
    );
    if (generation !== discoveryGeneration) {
      void handle.command({ type: "cancel" }).catch(() => {});
      void handle.dispose().catch(() => {});
      return;
    }
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
    render("failed", {
      jobActivity: { startedAt: Date.now() },
      ...failureHandoffCtx(terminal.error.code),
    });
    return;
  }
  if (terminal?.type === "cancelled") {
    render("cancelled", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  if (terminal?.type === "completed" || terminal?.type === "partial-completed") {
    if (TEST_PERMISSION_MOCK && !testCompletionNotified) {
      testCompletionNotified = true;
      void api?.runtime?.sendMessage?.({ type: "dezoomify-test-job-complete" }).catch(() => {});
    }
    render("completed", { jobActivity: { startedAt: Date.now() } });
    return;
  }
  render(statusForLifecycle(snapshot.lifecycle), { jobActivity: { startedAt: Date.now() } });
}

function retryJob() {
  jobLog.info("retry-requested", `jobId=${sessionId}`);
  void startAttempt();
}

/** Each retry takes one fresh source snapshot and starts a fresh engine service. */
async function startAttempt() {
  const source = sourceAccess;
  if (!source) {
    onHostFailure(
      Object.assign(new Error("The source tab is unavailable."), {
        code: "source-document-lost",
        retryable: false,
      }),
    );
    return;
  }
  const generation = ++discoveryGeneration;
  stopAttempt();
  resetAttemptState();
  render("discovering", { jobActivity: { startedAt: Date.now() } });
  try {
    const snapshot = await source.scan();
    if (generation !== discoveryGeneration) return;
    if (snapshot.inputs.length === 0)
      throw Object.assign(new Error("No image references were found on this page."), {
        code: "no-candidates",
        retryable: true,
      });
    jobLog.info(
      "source-scan-complete",
      `jobId=${sessionId} candidates=${snapshot.inputs.length} overflow=${snapshot.overflow}`,
    );
    await beginAttempt(snapshot.inputs);
  } catch (error) {
    if (generation === discoveryGeneration) onHostFailure(error);
  }
}

/** Restart the job targeting the maximum known resolution. */
function tryMaximum() {
  jobLog.info("maximum-requested", `jobId=${sessionId}`);
  tryMaximumNext = true;
  retryJob();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

api?.runtime?.onMessage?.addListener((message) => {
  if (!isRecord(message) || typeof message.type !== "string") return;
  if (message.type === "dz.toolbar-click" && message.sourceTabId === sourceTabId) {
    jobLog.info(
      "toolbar-click-forwarded",
      `jobId=${sessionId} state=${activeSnapshot?.lifecycle ?? "starting"}`,
    );
    const terminal = activeSnapshot?.terminal?.type;
    if (
      !localFailure &&
      terminal !== "completed" &&
      terminal !== "partial-completed" &&
      terminal !== "failed" &&
      terminal !== "cancelled"
    )
      closeJob();
    return;
  }
  if (!TEST_PERMISSION_MOCK) return;
  if (message.type === "dezoomify-test-source-access") {
    if (!sourceAccess) return;
    return (async () => {
      const snapshot = await sourceAccess.scan();
      const expected = message.scenario === "cookie-session" ? "/protected/artwork.dzi" : "/fetch/";
      const input = snapshot.inputs.find((candidate) => candidate.url.includes(expected));
      if (!input) throw new Error(`direct scan did not find ${expected}`);
      const fetchUrl =
        message.scenario === "cookie-session"
          ? new URL("/__source-access-proof", sourceAccess.documentUrl).href
          : input.url;
      const result = await sourceAccess.fetch(
        { uri: fetchUrl, headers: [] },
        new AbortController().signal,
      );
      return {
        ok: true,
        documentUrl: snapshot.documentUrl,
        candidates: snapshot.inputs.length,
        bytes: result.bytes.byteLength,
      };
    })().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  if (message.type === "dezoomify-test-source-navigation") {
    if (!sourceAccess) return;
    return sourceAccess.scan().then(
      () => ({ ok: false, code: "source-access-stayed-live" }),
      (error: unknown) => ({
        ok: false,
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "unknown-error",
      }),
    );
  }
});

api?.permissions?.onRemoved?.addListener((removed) => {
  for (const origin of removed.origins ?? [])
    testGrantedOrigins.delete(origin.replace(/\/\*$/, ""));
});

window.addEventListener("beforeunload", () => {
  stopAttempt();
  syncExtensionJobIndicator("cancelled");
  sourceAccess?.dispose();
});

void bindSourceTab();
