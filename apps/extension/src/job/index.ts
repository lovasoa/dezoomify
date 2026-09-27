import type { JobHandle } from "@dezoomify/app-model";
import { suggestedNameFor } from "@dezoomify/app-model";
import type { ResourceRequest } from "@dezoomify/wasm-bindings";
import { createAttemptPermissions, type PermissionWait } from "./permissions.ts";
/** Dedicated extension job-tab integration. No webpage postMessage bridge. */

import type { Error as EngineError, JobSnapshot, JobState } from "@dezoomify/app-model";
import {
  BROWSER_MAX_PLAN_TILES,
  type BrowserAssemblyArgs,
  browserLimitsFor,
  type ClientHints,
  createBrowserAssembly,
  createBrowserJobService,
  desktopHandoffLink,
  loadTileImage,
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
  PartialDecisionActions,
  presentFailure,
  presentSnapshot,
  presentStatus,
  renderView,
  t,
} from "@dezoomify/shared-ui";
import { createElement } from "react";
import { browser as api } from "wxt/browser";
import { asFetchFailure, createExtensionFetcher } from "../runtime/fetch.ts";
import { saveExtensionBlob } from "./download.ts";
import { createSourceAccess } from "./source-access.ts";
import { createEngineResourceFetcher } from "./transport.ts";
import { AccessRequestView } from "./view.tsx";

const TEST_PERMISSION_MOCK = import.meta.env.MODE === "testing";

type ViewContext = SharedViewContext & { failure?: StructuredError };

function newAttempt() {
  return {
    retired: false,
    startedAt: Date.now(),
    jobHandle: null as JobHandle | null,
    assembly: null as ReturnType<typeof createBrowserAssembly> | null,
    activeSnapshot: null as JobSnapshot | null,
    localFailure: null as StructuredError | null,
    pendingPermission: null as PermissionWait | null,
    savedDownloadId: null as number | null,
    attemptSourceUrl: "",
    testCompletionNotified: false,
    uiLogLines: [] as string[],
  };
}
type ExtensionAttempt = ReturnType<typeof newAttempt>;
let currentAttempt = newAttempt();
function owns(attempt: ExtensionAttempt): boolean {
  return currentAttempt === attempt && !attempt.retired;
}

const jobLog = createLogger("job");
// Mirror accepted log lines into the job view's technical-details log (and the
// copied diagnostics) so a failed job shows the interaction trace. Worker
// lines arrive over `engine.log` and join the same buffer.
const UI_LOG_MAX_LINES = 120;
jobLog.addSink((entry) => {
  currentAttempt.uiLogLines.push(entry.line);
  if (currentAttempt.uiLogLines.length > UI_LOG_MAX_LINES)
    currentAttempt.uiLogLines.splice(0, currentAttempt.uiLogLines.length - UI_LOG_MAX_LINES);
});

let sourceAccess: ReturnType<typeof createSourceAccess> | null = null;
let siteOrigin = "";
// One shared browser job service attempt. The service owns the worker, the WASM
// session, cross-worker processing calls, the abort scope, and disposal;
// this tab owns source access, transport, currentAttempt.assembly, and view wiring. The single
// authoritative snapshot renders directly; no derived mirrors.
/** Single authoritative snapshot: render it directly, never a derived copy. */
let lastActionIndicator = "";
/** Ephemeral permission view (telemetry only, never gates commands). */
const testGrantedOrigins = new Set<string>();
/** True when the next attempt must target the maximum known resolution. */
let tryMaximumNext = false;
/** Source URL of the live attempt (desktop handoff link for canvas failures). */
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
  const catalog = currentAttempt.activeSnapshot?.selection.catalog;
  const idx = currentAttempt.activeSnapshot?.selection.image;
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
  if (currentAttempt.localFailure)
    return presentFailure(currentAttempt.localFailure, "browser-session");
  if (currentAttempt.activeSnapshot) {
    // Display-only is a host-known output fact (tainted canvas): probe the
    // currentAttempt.assembly like the website does and pass it explicitly to
    // presentSnapshot. It is never written into the DTO.
    let displayOnly = false;
    try {
      displayOnly = currentAttempt.assembly?.isTainted?.() === true;
    } catch {
      displayOnly = false;
    }
    return presentSnapshot(currentAttempt.activeSnapshot, "browser-session", { displayOnly });
  }
  return presentStatus(status, {
    transport: "browser-session",
    ...(ctx.failure ? { error: ctx.failure } : {}),
  });
}

function render(status: PresentationStatus, ctx: ViewContext = {}) {
  const attempt = currentAttempt;
  const target = root();
  if (!target) return;
  const viewActivity = {
    ...(ctx.jobActivity ?? {}),
    ...(attempt.uiLogLines.length ? { log: attempt.uiLogLines.slice() } : {}),
  };
  const presentation = presentFor(status, ctx);
  // Outstanding partial decision, read off the DTO only: the closed
  // keep/retry/discard answers are the engine's RecoveryChoice values, never
  // fabricated actions.
  const decision =
    attempt.activeSnapshot?.lifecycle === "AwaitingPartialDecision"
      ? attempt.activeSnapshot.decision
      : undefined;
  renderView(
    target,
    presentation,
    {
      onSubmitUrl: () => {},
      onCancel: () => {
        if (owns(attempt)) closeJob();
      },
      onCopyDiagnostics: copyDiagnostics,
      onRetrySameUrl: () => {
        if (owns(attempt)) retryJob();
      },
      onTryMaximum: () => {
        if (owns(attempt)) tryMaximum();
      },
      onSave: () => {},
    },
    {
      ...ctx,
      ...(Object.keys(viewActivity).length ? { jobActivity: viewActivity } : {}),
    },
    {
      ...(attempt.pendingPermission
        ? {
            replace: createElement(AccessRequestView, {
              origin: attempt.pendingPermission.origin,
              requesting: attempt.pendingPermission.requesting,
              onRequest: attempt.pendingPermission.request,
            }),
          }
        : {}),
      ...(decision && !attempt.pendingPermission
        ? {
            after: createElement(PartialDecisionActions, {
              decision,
              labels: {
                keep: t("view.partial.extensionKeep"),
                discard: t("view.partial.extensionDiscard"),
                retry: t("view.partial.extensionRetry"),
              },
              onAnswer: (command) => {
                if (!owns(attempt)) return;
                void attempt.jobHandle?.command(command);
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
  jobLog.info("job-cancelled", `jobId=${sessionId}`);
  const handle = currentAttempt.jobHandle;
  void handle?.command({ type: "cancel" }).catch(() => {});
  stopAttempt();
  currentAttempt = newAttempt();
  render("cancelled", { jobActivity: { startedAt: Date.now() } });
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
  const link = desktopHandoffLink(currentAttempt.attemptSourceUrl);
  return link !== "" ? { sourceUrl: currentAttempt.attemptSourceUrl, desktopHandoffUrl: link } : {};
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
function onHostFailure(error: unknown, attempt = currentAttempt) {
  if (!owns(attempt)) return;
  if (currentAttempt.localFailure) return;
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
  currentAttempt.localFailure = describeFailure({
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

function createAssembly(args: BrowserAssemblyArgs, attempt: ExtensionAttempt) {
  return createBrowserAssembly({
    ...args,
    canvas: () => document.createElement("canvas"),
    save: async (blob, width, height, signal) => {
      signal.throwIfAborted();
      if (!owns(attempt)) throw new DOMException("Result retired", "AbortError");
      const id = await saveExtensionBlob(
        api.downloads,
        blob,
        suggestedNameFor(width, height, "png", activeTitle()),
        signal,
      );
      if (!owns(attempt)) throw new DOMException("Result retired", "AbortError");
      attempt.savedDownloadId = id;
      return "browser-save-initiated" as const;
    },
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
    sourceAccess = createSourceAccess(api, {
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
  currentAttempt.retired = true;
  const handle = currentAttempt.jobHandle;
  currentAttempt.jobHandle = null;
  if (handle) {
    try {
      void handle.dispose().catch(() => {});
    } catch {
      /* teardown is best effort */
    }
  }
  try {
    currentAttempt.assembly?.release();
  } catch {
    /* bitmap cleanup is best effort */
  }
  currentAttempt.assembly = null;
}

/** Start one WASM-backed attempt with source-tab access and extension-origin fallback. */
async function beginAttempt(inputs: Array<{ url: string; contents?: string }>) {
  const attempt = currentAttempt;
  const source = sourceAccess;
  if (!source) return;
  attempt.attemptSourceUrl = inputs[0]?.url ?? "";
  const permissionApi = {
    contains: async ({ origins }: { origins?: string[] }) =>
      TEST_PERMISSION_MOCK
        ? (origins ?? []).every((pattern) => testGrantedOrigins.has(pattern.slice(0, -2)))
        : api!.permissions!.contains({ origins }),
    request: ({ origins }: { origins?: string[] }) => {
      if (!TEST_PERMISSION_MOCK) return api!.permissions!.request({ origins });
      for (const pattern of origins ?? []) testGrantedOrigins.add(pattern.slice(0, -2));
      return Promise.resolve(true);
    },
  };
  const permissions = createAttemptPermissions(permissionApi, (pending) => {
    if (!owns(attempt)) return;
    attempt.pendingPermission = pending[0] ?? null;
    render("downloading", { jobActivity: { startedAt: Date.now() } });
  });
  const fetcher = createExtensionFetcher({
    hasPermission: (origin) => permissionApi.contains({ origins: [`${origin}/*`] }),
  });
  const extensionTransport = {
    async fetchResource(request: ResourceRequest, signal: AbortSignal) {
      const url = request.uri;
      signal.throwIfAborted();
      jobLog.debug("extension-fetch-start", `url=${url} purpose=${request.purpose}`);
      try {
        await permissions.ensure(new URL(request.uri).origin, signal);
        const result = await fetcher.fetchResource(request, signal);
        if (!owns(attempt)) signal.throwIfAborted();
        if (owns(attempt))
          jobLog.debug("extension-fetch-complete", `url=${url} bytes=${result.bytes.byteLength}`);
        return result;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "unknown";
        if (owns(attempt))
          jobLog.warn(
            "extension-fetch-failed",
            `url=${url} code=${code} message=${error instanceof Error ? error.message : String(error)}`,
          );
        throw error;
      }
    },
  };
  const fetchResource = createEngineResourceFetcher({
    sourceAccess: source,
    extensionTransport,
    onSourceFailure: (cause) =>
      owns(attempt) &&
      jobLog.warn(
        "source-fetch-fallback",
        `code=${String(cause.code ?? "network")} origin=extension`,
      ),
  });
  const service = createBrowserJobService({
    createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
    fetchResource,
    loadDisplayImage: (url, signal) => loadTileImage(url, { signal }),
    classifyFailure: asFetchFailure,
    createAssembly: (args) => {
      const asm = createAssembly(args, attempt);
      attempt.assembly = asm;
      return asm;
    },
    // Browser session baseline: 6 concurrent tile fetches (matches the
    // website). The engine validates the budget at job creation.
    quotas: { max_concurrent_fetches: 6 },
    onRecoveryRequested: () => {
      // The authoritative snapshot carries the decision generation; re-render
      // it directly instead of copying the generation aside.
      if (owns(attempt) && attempt.activeSnapshot) renderForSnapshot(attempt.activeSnapshot);
    },
    log: (level, code, detail) => {
      if (owns(attempt)) jobLog.log(level, code, detail);
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
      },
      {
        snapshot: (snapshot: JobSnapshot) => {
          if (attempt.localFailure || !owns(attempt)) return;
          attempt.activeSnapshot = snapshot;
          renderForSnapshot(snapshot);
        },
        failure: (error) => onHostFailure(error, attempt),
      },
    );
    if (!owns(attempt)) {
      void handle.command({ type: "cancel" }).catch(() => {});
      void handle.dispose().catch(() => {});
      return;
    }
    attempt.jobHandle = handle;
  } catch (error) {
    onHostFailure(error, attempt);
  }
}

/** Render one authoritative snapshot: terminal.type wins over the live lifecycle. */
function renderForSnapshot(snapshot: JobSnapshot) {
  const terminal = snapshot.terminal;
  if (terminal?.type === "failed") {
    jobLog.error("engine-terminal", `type=failed code=${terminal.error.code}`);
    currentAttempt.localFailure = presentEngineFailure(terminal.error);
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
    if (TEST_PERMISSION_MOCK && !currentAttempt.testCompletionNotified) {
      currentAttempt.testCompletionNotified = true;
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
  stopAttempt();
  currentAttempt = newAttempt();
  const attempt = currentAttempt;
  render("discovering", { jobActivity: { startedAt: Date.now() } });
  try {
    const snapshot = await source.scan();
    if (!owns(attempt)) return;
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
    if (owns(attempt)) onHostFailure(error, attempt);
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
      `jobId=${sessionId} state=${currentAttempt.activeSnapshot?.lifecycle ?? "starting"}`,
    );
    const terminal = currentAttempt.activeSnapshot?.terminal?.type;
    if (
      !currentAttempt.localFailure &&
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
