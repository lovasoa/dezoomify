// Desktop entry: render the shared UI through the desktop integration.
// Routing and component composition stay shared; this file only wires the
// desktop host. Pixels stay native; only protocol progress and job events
// cross IPC, guarded by assertNoTileBytes and redactForEvent.
//
// Tauri commands used here: start_job, answer_choice, cancel_job,
// request_destination (via integration.requestSaveDestination).
// Event channels subscribed here: dezoomify://job-state,
// dezoomify://job-progress, dezoomify://job-output, dezoomify://job-error,
// dezoomify://deep-link-pending.
//
// Controller mapping (TRANSITIONS in packages/shared-ui/src/controller.ts):
// discovering -> images-found -> image-chosen -> level-chosen ->
// preflight-ok -> progress -> save-start -> save-done -> completed, plus
// preflight-display-only -> display-only, fail -> failed, cancel ->
// cancelled, reset -> idle. Recovery-requested (destination/partial) events
// surface typed choices (retry / choose-output / keep-partial /
// discard-partial / handoff-to-native) wired to answer_choice (RetryReady /
// PartialKeep), request_destination, and requestHandoff.
import { createController, renderView, t } from "@dezoomify/shared-ui";
import type { ViewContext } from "@dezoomify/shared-ui";
import { suggestedNameFor } from "@dezoomify/browser-runtime";
import {
  asPayload,
  extractMissingTiles,
  formatMissingSummary,
  hostOf,
  isValidInputUrl,
  numField,
  parseDetailObject,
  payloadJob,
  payloadReason,
  payloadSeq,
  payloadText,
  phaseFor,
  encoderToMime,
  readInitialUrl,
  redactedOriginOnly,
  strField,
  technicalDetailFor,
  validateDeepLinkPayload,
} from "./errorCopy.ts";
import type { ValidatedDeepLink } from "./errorCopy.ts";
import {
  DISCARD_PARTIAL_CHOICE,
  KEEP_PARTIAL_CHOICE,
  RETRY_CHOICE,
  completeJob,
  dispatchFail,
  ensureChosenThroughPreflight,
  isTerminalStatus,
} from "./jobController.ts";
import type { CatalogNotice, PendingDecision } from "./jobController.ts";
import {
  buildCopyDiagnostics,
  DESKTOP_APP_VERSION,
  handleCopyDiagnostics,
} from "./diagnostics.ts";
import {
  ensureDesktopSettingsPanel,
  getEffectiveSettings,
  persistSettingsFromPanel,
  resetDesktopSettings,
} from "./settingsPanel.ts";
import type { SettingsPanelEnv } from "./settingsPanel.ts";
import {
  createDesktopIntegration,
  NATIVE_FORMATS,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
} from "./desktopIntegration.ts";
import type { NativeFormat } from "./desktopIntegration.ts";
import { DESKTOP_EVENT_CHANNELS, assertNoTileBytes, redactForEvent } from "./events.ts";
import type { DesktopEventChannel } from "./events.ts";
import {
  describeSettingsForLog,
  loadSettings,
  parseHeadersText,
  pickDirectory,
  saveSettings,
  settingsToInvokeArgs,
  validateSettings,
} from "./settings.ts";
import type { DesktopSettings } from "./settings.ts";
import { listen as tauriApiListen } from "@tauri-apps/api/event";
import "./desktop.css";

const root = typeof document !== "undefined" ? document.getElementById("root") : null;
const integration = createDesktopIntegration();

// Task 5.3 Help/About (docs rule: docs/user/ is the only source of user
// text; link, never duplicate). Short link labels only; every user guide
// lives in the published docs pages below, opened via openExternalLink
// (https-only). No user copy is duplicated here.
const DESKTOP_DOCS_BASE = "https://dezoomify.ophir.dev";
const DESKTOP_HELP_LINKS: Array<{ label: string; url: string }> = [
  { label: t("desktop.help.help"), url: `${DESKTOP_DOCS_BASE}/help/` },
  { label: t("desktop.help.desktopGuide"), url: `${DESKTOP_DOCS_BASE}/help/desktop-app.html` },
  { label: t("desktop.help.troubleshooting"), url: `${DESKTOP_DOCS_BASE}/help/troubleshooting.html` },
  { label: t("desktop.help.faq"), url: `${DESKTOP_DOCS_BASE}/help/troubleshooting.html` },
  { label: t("desktop.help.privacy"), url: `${DESKTOP_DOCS_BASE}/privacy.html` },
  { label: t("desktop.help.terms"), url: `${DESKTOP_DOCS_BASE}/terms.html` },
  { label: t("desktop.help.donate"), url: "https://github.com/sponsors/lovasoa/" },
];

// Transport reported for every desktop controller transition. Pixels stay
// native, so the badge never claims a browser transport. The "native" code
// renders via shared-ui renderTransportLabel (canonical NATIVE label).
const NATIVE_TRANSPORT = "native";

// Per-request timeout shown in the job view (native parity: 30 s request,
// 6 s connect; the view renders the single per-request figure).
const REQUEST_TIMEOUT_MS = 30000;

// Capped technical log (oldest dropped first), web parity.
const MAX_LOG_LINES = 60;

let sessionId = "sess:desktop-1";
const controller = createController(sessionId);
// Outbound UI seq namespace for controller.dispatch (stale/foreign guarded
// by the controller). Inbound IPC seqs live in remoteSeqByJob below: the two
// namespaces are independent and must not be mixed.
let currentSeq = 0;
let currentJobId: string | null = null;
// Job id abandoned by a newer submit. Late events for it are ignored even
// before the new job id is known (Rust mints job:n monotonically, never
// reused, so this can never collide with the new job).
let retiredJobId: string | null = null;
// Inbound IPC seq high-water per job id. Events with seq <= stored are stale
// duplicates or reordered redeliveries and are ignored.
let remoteSeqByJob: Record<string, number> = {};
let submitToken = 0;
let lastInputUrl = "";
let grantedFormat: NativeFormat = "png";

// Native output formats (todo 4.4, todo 5.1): single source is
// NATIVE_FORMATS in desktopIntegration.ts
// (png/jpeg/tiff/zif/webp/iiif-dir), matching SUPPORTED_FORMATS in
// commands.rs and the tauri_shell.rs dialog filters. The 6-radio selector
// below writes grantedFormat (file encoders plus the `iiif-dir` tree mode);
// requestOutputAndResume reads it so the Save and choose-output paths never
// hard-code a format. `iiif-dir` suggests a `.iiif` name (extensionless also
// validates natively) and the shell writes the tile tree at that path.
function normalizeNativeFormat(value: unknown): NativeFormat {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if ((NATIVE_FORMATS as readonly string[]).includes(lower)) {
      return lower as NativeFormat;
    }
    if (lower === "iiif") return "iiif-dir";
  }
  return "png";
}

function suggestedNameForFormat(
  format: NativeFormat,
  width?: unknown,
  height?: unknown,
): string {
  return suggestedNameFor(width, height, format);
}

// Minimal settings (task 3.5): persisted locally, validated with fail-closed
// bounds, and sent on the next start_job. Header values never enter logs;
// use describeSettingsForLog for any diagnostics. Todo 5.1: the persisted
// outputFormat seeds the encoder picker so ZIF/WebP/`iiif-dir` survive
// reloads; download settings still travel via settingsToInvokeArgs only.
let desktopSettings: DesktopSettings = loadSettings();
grantedFormat = normalizeNativeFormat(desktopSettings.outputFormat);

function persistOutputFormat(format: NativeFormat): void {
  if (desktopSettings.outputFormat === format) return;
  desktopSettings = { ...desktopSettings, outputFormat: format };
  saveSettings(desktopSettings);
}
let settingsError: string | null = null;
let pendingDecision: PendingDecision | null = null;

// Catalog auto-choice notice (todo 4.3): reuses the pendingDecision aux
// pattern as local-only state, never a new protocol event. The native
// pipeline auto-saves images[0] at the largest fitting level; the shared job
// view renders this honestly from controller imageCount plus this aux
// (WxH/K tiles). No picker is offered.
let catalogNotice: CatalogNotice | null = null;

// Accessibility (Task 5.2): dialog focus state. Each modal stores the element
// focused before it opened so focus returns on close. Recovery tracks its key
// so a new decision moves focus once without stealing it on every tick.
let deepLinkReturnFocus: HTMLElement | null = null;
let recoveryReturnFocus: HTMLElement | null = null;
let lastRecoveryKey: string | null = null;

// Focusable selectors for trap cycles. All desktop actions are native
// buttons, inputs, textareas, links, or summaries, so Tab reaches submit,
// save, cancel, reset, choices, settings, browse, and confirm without
// positive tabindex or div click handlers.
const FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function focusableIn(container: HTMLElement): Array<HTMLElement> {
  const nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
  const out: Array<HTMLElement> = [];
  for (const node of Array.from(nodes)) {
    const el = node as HTMLElement;
    if (el.tabIndex < 0 && el.getAttribute("tabindex") === "-1") continue;
    out.push(el);
  }
  return out;
}

function activeElementOf(doc: Document): HTMLElement | null {
  const active = doc.activeElement;
  if (active && active instanceof HTMLElement) return active;
  return null;
}

function restoreFocus(target: HTMLElement | null): void {
  if (!target) return;
  try {
    if (target.isConnected && typeof target.focus === "function") target.focus();
  } catch {
    // Focus restore is best effort; a detached node stays ignored.
  }
}

function recoveryKeyFor(decision: PendingDecision | null): string | null {
  if (!decision) return null;
  const missing = (decision.missingTiles ?? []).join(",");
  return `${decision.kind}:${decision.reason}:${missing}:${decision.failedCount ?? ""}:${decision.totalCount ?? ""}`;
}

// Marked partial completion: a kept partial output stays distinguishable
// from a complete save. Set only on a partial-completed event; cleared on
// submit and reset. The missing list is redacted tile ids only, never URLs.
let completedPartial = false;
let completedMissing: Array<string> = [];

// Live heartbeat for the loading view: advances now and longestPendingMs
// so the pending box and smooth track stay current between IPC snapshots.
// The desktop shell reports snapshots (acquired/total), not per-request
// start/end, so the longest wait derives from last visible progress.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function nextSeq(): number {
  currentSeq += 1;
  return currentSeq;
}

interface TauriInvokeFn {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function tauriInvoke(): TauriInvokeFn | null {
  const internals = (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"] as
    | { invoke?: unknown }
    | undefined;
  if (internals && typeof internals.invoke === "function") {
    return internals.invoke as TauriInvokeFn;
  }
  return null;
}

type TauriListenFn = (
  channel: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<unknown> | unknown;

function tauriListen(): TauriListenFn | null {
  // The window ships with `withGlobalTauri: false`, so no `listen` global
  // exists; the bundled `@tauri-apps/api` call reaches the core event
  // plugin through `__TAURI_INTERNALS__` instead. It rejects outside a
  // Tauri webview, which `subscribeToDesktopEvents` already tolerates.
  if (typeof tauriApiListen === "function") {
    return (channel, handler) => tauriApiListen(channel, handler);
  }
  const g = globalThis as Record<string, unknown>;
  const candidates: Array<unknown> = [g["__TAURI_EVENT__"], g["__TAURI_INTERNALS__"], g["__TAURI__"]];
  for (const cand of candidates) {
    if (cand && typeof (cand as Record<string, unknown>)["listen"] === "function") {
      return (cand as { listen: TauriListenFn }).listen;
    }
  }
  return null;
}

// --- Live job activity (drives the progressive-disclosure job view) ---

function activity(): NonNullable<ViewContext["jobActivity"]> {
  if (!viewCtx.jobActivity) viewCtx.jobActivity = { timeoutMs: REQUEST_TIMEOUT_MS };
  return viewCtx.jobActivity as NonNullable<ViewContext["jobActivity"]>;
}

function refreshLongestPending(): void {
  const a = viewCtx.jobActivity;
  if (!a) return;
  const now = Date.now();
  a.now = now;
  if ((a.pendingRequests ?? 0) > 0) {
    const base = a.lastProgressAt ?? a.startedAt ?? now;
    a.longestPendingMs = Math.max(0, now - base);
  } else {
    a.longestPendingMs = 0;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  try {
    heartbeatTimer = setInterval(() => {
      if (isTerminalStatus(controller.getState().status)) {
        stopHeartbeat();
        return;
      }
      if (!viewCtx.jobActivity) return;
      refreshLongestPending();
      update();
    }, 500);
    const t = heartbeatTimer as unknown as { unref?: () => void };
    if (t && typeof t.unref === "function") {
      try {
        t.unref();
      } catch {
        // Browser timers lack unref.
      }
    }
  } catch {
    heartbeatTimer = null;
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    try {
      clearInterval(heartbeatTimer);
    } catch {
      // Ignore timer errors.
    }
    heartbeatTimer = null;
  }
}

function resetActivity(url: string): void {
  const now = Date.now();
  viewCtx.jobActivity = {
    url,
    startedAt: now,
    now,
    stepLabel: t("view.step.discovering"),
    detail: t("desktop.step.contacting", { host: hostOf(url) }),
    pendingRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    longestPendingMs: 0,
    timeoutMs: REQUEST_TIMEOUT_MS,
    lastProgressAt: now,
    log: [],
  };
  startHeartbeat();
}

function touchProgress(): void {
  const a = activity();
  const now = Date.now();
  a.now = now;
  a.lastProgressAt = now;
}

function setStep(label: string, detail?: string): void {
  const a = activity();
  a.stepLabel = label;
  if (detail !== undefined) a.detail = detail;
  touchProgress();
  update();
}

function pushLog(line: string): void {
  const a = activity();
  if (!a.log) a.log = [];
  const elapsed = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
  a.log.push(`${elapsed}s: ${line}`);
  if (a.log.length > MAX_LOG_LINES) a.log.splice(0, a.log.length - MAX_LOG_LINES);
  a.now = Date.now();
}

function noteProgress(current: number, total: number): void {
  const a = activity();
  const now = Date.now();
  a.now = now;
  a.lastProgressAt = now;
  a.completedRequests = current;
  a.pendingRequests = total > current ? total - current : 0;
  if (typeof a.failedRequests !== "number") a.failedRequests = 0;
  refreshLongestPending();
  // Keep lastProgressAt as the freshness anchor: longestPendingMs derives
  // from it on the heartbeat, so the pending box shows live waiting time.
  a.now = Date.now();
}

// Shared env wiring for the split modules (todo 2.2): single closures over
// the module job state, so errorCopy/jobController/settingsPanel/diagnostics
// stay stateless while behavior is unchanged.
function controllerDispatch(event: unknown): void {
  controller.dispatch(event as never);
}

function preflightThrough(imageCount?: number): void {
  ensureChosenThroughPreflight(controllerDispatch, sessionId, nextSeq, NATIVE_TRANSPORT, imageCount);
}

const failEnv = {
  dispatch: controllerDispatch,
  getStatus: () => controller.getState().status,
  sessionId: () => sessionId,
  next: () => nextSeq(),
  nativeTransport: NATIVE_TRANSPORT,
  host: () => hostOf(lastInputUrl || activity().url || ""),
  origin: () => redactedOriginOnly(lastInputUrl || activity().url || ""),
  clearPending: () => {
    pendingDecision = null;
    catalogNotice = null;
  },
  stopHeartbeat: () => stopHeartbeat(),
  pushLog: (line: string) => pushLog(line),
  update: () => update(),
};

const jobEnv = {
  dispatch: controllerDispatch,
  getStatus: () => controller.getState().status,
  sessionId: () => sessionId,
  next: () => nextSeq(),
  nativeTransport: NATIVE_TRANSPORT,
  getImageCount: () => controller.getState().imageCount ?? 0,
  getProgressTotal: () => viewCtx.currentProgress?.total,
  getCompletedInfo: () => viewCtx.completedInfo,
  setCompletedInfo: (info: { width: number; height: number; mime: string } | undefined) => {
    viewCtx.completedInfo = info;
  },
  setImageChoice: (choice: { width: number; height: number; tiles?: number } | undefined) => {
    viewCtx.imageChoice = choice;
  },
  getCatalogNotice: () => catalogNotice,
  setCatalogNotice: (notice: CatalogNotice | null) => {
    catalogNotice = notice;
  },
  setPendingDecision: (decision: PendingDecision | null) => {
    pendingDecision = decision;
  },
  setCompletedPartial: (partial: boolean, missing: Array<string>) => {
    completedPartial = partial;
    completedMissing = missing;
  },
  pushLog: (line: string) => pushLog(line),
  setStep: (label: string, detail?: string) => setStep(label, detail),
  stopHeartbeat: () => stopHeartbeat(),
  update: () => update(),
};

const settingsEnv: SettingsPanelEnv = {
  root,
  getSettings: () => desktopSettings,
  setSettings: (settings: DesktopSettings) => {
    desktopSettings = settings;
  },
  setError: (error: string | null) => {
    settingsError = error;
  },
  pushLog: (line: string) => pushLog(line),
  update: () => update(),
};

function runPersistSettingsFromPanel(): void {
  persistSettingsFromPanel(settingsEnv);
}

function runResetDesktopSettings(): void {
  resetDesktopSettings(settingsEnv);
}

function diagnosticsSnapshot() {
  const state = controller.getState();
  return {
    status: state.status,
    transport: state.transport,
    jobId: currentJobId,
    attempt: pendingDecision?.attempt,
    sessionId,
    nativeTransport: NATIVE_TRANSPORT,
    error: state.error
      ? {
          code: state.error.code,
          category: state.error.category,
          ...(state.error.phase ? { phase: state.error.phase } : {}),
          retryable: state.error.retryable,
          message: state.error.message,
          ...(state.error.detail ? { detail: state.error.detail } : {}),
        }
      : null,
    progress: viewCtx.currentProgress
      ? { current: viewCtx.currentProgress.current, total: viewCtx.currentProgress.total }
      : undefined,
    origin: redactedOriginOnly(lastInputUrl),
  };
}

// --- Controller transitions ---


function clearJobViewState(): void {
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.jobActivity = undefined;
  viewCtx.imageChoice = undefined;
  pendingDecision = null;
  catalogNotice = null;
  completedPartial = false;
  completedMissing = [];
  grantedFormat = "png";
  stopHeartbeat();
}

function handleSubmitUrl(url: string): void {
  const token = ++submitToken;
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidInputUrl(trimmed)) {
    controller.dispatch({
      seq: nextSeq(),
      sessionId,
      kind: "fail",
      transport: NATIVE_TRANSPORT,
      error: {
        code: "INVALID_URL",
        category: "validation",
        retryable: false,
        message: t("desktop.url.invalid"),
        transport: NATIVE_TRANSPORT,
        phase: "discovery",
      },
    });
    update();
    return;
  }
  // A submit after a terminal state starts a fresh job on the same session:
  // reset to idle first (completed/cancelled only accept reset; failed also
  // accepts start-discovery, and reset is valid there too).
  if (isTerminalStatus(controller.getState().status)) {
    controller.reset();
    currentSeq = 0;
    currentJobId = null;
    retiredJobId = null;
    remoteSeqByJob = {};
    clearJobViewState();
  } else {
    retiredJobId = currentJobId;
    clearJobViewState();
  }
  lastInputUrl = trimmed;
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "start-discovery", transport: NATIVE_TRANSPORT });
  resetActivity(trimmed);
  pushLog(`Starting job for ${redactedOriginOnly(trimmed) || "the server"}`);
  // Minimal settings are validated fail-closed here: invalid settings fail
  // the submit before any start_job effect. The redacted summary never
  // includes header values.
  const effective = getEffectiveSettings(root, desktopSettings);
  if (!effective.ok || !effective.settings) {
    const detail = effective.errors.join("; ") || "Invalid settings.";
    settingsError = detail;
    const technical = technicalDetailFor(
      "INVALID_SETTINGS",
      "These download settings are invalid.",
      detail,
      undefined,
      controller.getState().status,
      redactedOriginOnly(lastInputUrl || activity().url || ""),
      NATIVE_TRANSPORT,
    );
    controller.dispatch({
      seq: nextSeq(),
      sessionId,
      kind: "fail",
      transport: NATIVE_TRANSPORT,
      error: {
        code: "INVALID_SETTINGS",
        category: "validation",
        retryable: false,
        message: t("desktop.settings.invalidSubmit"),
        transport: NATIVE_TRANSPORT,
        phase: "discovery",
        detail: technical,
      },
    });
    pushLog("Settings invalid; job not started");
    stopHeartbeat();
    update();
    return;
  }
  settingsError = null;
  desktopSettings = effective.settings;
  pushLog(`Settings: ${describeSettingsForLog(desktopSettings)}`);
  update();
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  const settingsArgs = settingsToInvokeArgs(desktopSettings);
  // Tauri commands take camelCase args (`inputUrl` for Rust `input_url`).
  void invoke("start_job", { inputUrl: trimmed, settings: settingsArgs }).then(
    (raw) => {
      if (token !== submitToken) return;
      const res = raw as { job?: unknown; seq?: unknown } | null;
      const job = res && typeof res.job === "string" ? res.job : null;
      if (job) {
        currentJobId = job;
        retiredJobId = null;
      }
      update();
    },
    (error: unknown) => {
      if (token !== submitToken) return;
      const message = error instanceof Error ? error.message : t("desktop.invoke.startFallback");
      dispatchFail(failEnv, "START_FAILED", message);
    },
  );
}

function answerChoice(choice: string, onGranted: () => void, failureLabel: string): void {
  const job = currentJobId;
  const invoke = tauriInvoke();
  if (!job || !invoke) {
    onGranted();
    return;
  }
  void invoke("answer_choice", { job, choice }).then(
    () => {
      onGranted();
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : failureLabel;
      dispatchFail(failEnv, "CHOICE_FAILED", message);
    },
  );
}

function handleSelectImage(index: number): void {
  if (isTerminalStatus(controller.getState().status)) return;
  const choice = `img:${index}`;
  pushLog(`Chose image ${index}`);
  answerChoice(
    choice,
    () => {
      controller.dispatch({ seq: nextSeq(), sessionId, kind: "image-chosen" });
      update();
    },
    t("desktop.invoke.choiceImage"),
  );
}

function handleSelectLevel(level: number): void {
  if (isTerminalStatus(controller.getState().status)) return;
  const choice = `level:${level}`;
  pushLog(`Chose level ${level}`);
  answerChoice(
    choice,
    () => {
      controller.dispatch({ seq: nextSeq(), sessionId, kind: "level-chosen" });
      update();
    },
    t("desktop.invoke.choiceLevel"),
  );
}

function handleCancel(): void {
  if (isTerminalStatus(controller.getState().status)) return;
  const job = currentJobId;
  const invoke = tauriInvoke();
  // Cancellation waits for cleanup acknowledgement before reaching
  // cancelled: show the cleaning step now, dispatch the terminal only
  // after the shell acknowledges (cancelled event or cancel_job success).
  // The shell removes uncommitted output best-effort; the cancelled view
  // notes that removal.
  pushLog("Cancelling… cleaning up…");
  setStep(t("view.step.working"), t("desktop.step.cleanupDetail"));
  pendingDecision = null;
  catalogNotice = null;
  if (job && invoke) {
    void invoke("cancel_job", { job }).then(
      () => {
        if (isTerminalStatus(controller.getState().status)) return;
        // Shell acknowledged cleanup: reach cancelled exactly once.
        // The event channel usually delivers the same transition first;
        // the controller guard makes the second a no-op.
        controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
        pushLog("Cancelled; unfinished file removed");
        stopHeartbeat();
        update();
      },
      () => {
        if (isTerminalStatus(controller.getState().status)) return;
        controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
        pushLog("Cancelled; unfinished file removed");
        stopHeartbeat();
        update();
      },
    );
    return;
  }
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
  pushLog("Cancelled by user; unfinished file removed");
  stopHeartbeat();
  update();
}

// Shared save-destination grant path for the Save button and the
// choose-output recovery choice. On grant, walks the controller into saving;
// completion itself arrives via dezoomify://job-output (exactly-once
// terminal guard ignores any duplicate).
function requestOutputAndResume(origin: string): void {
  const job = currentJobId;
  if (!job || isTerminalStatus(controller.getState().status)) return;
  const format = normalizeNativeFormat(grantedFormat);
  const suggestedName = suggestedNameForFormat(
    format,
    catalogNotice?.width ?? viewCtx.imageChoice?.width ?? viewCtx.completedInfo?.width,
    catalogNotice?.height ?? viewCtx.imageChoice?.height ?? viewCtx.completedInfo?.height,
  );
  pushLog(origin === "choose-output" ? "Requesting save destination…" : "Requesting save destination (save)…");
  void integration
    .requestSaveDestination({ jobId: job, format, suggestedName })
    .then(
      (result) => {
        if (isTerminalStatus(controller.getState().status)) return;
        if (result.outcome === "granted") {
          grantedFormat = format;
          if (pendingDecision && pendingDecision.reason === "destination") {
            pendingDecision = null;
          }
          pushLog("Save destination granted");
          preflightThrough();
          controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-start" });
          setStep(t("view.step.saving"), t("desktop.step.encodingNative"));
          if (!tauriInvoke()) {
            // Validation-only fallback (no Tauri host): no native worker
            // will emit job-output, so close the loop locally.
            controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-done" });
          }
          update();
        } else if (result.outcome === "denied") {
          // Stable backend code rides `code` when present (output.exists,
          // output.destination-denied, ...); fall back to the legacy
          // OUTPUT_DENIED only for payloads without it.
          const denied = result as { reason?: string; code?: string };
          const code = typeof denied.code === "string" && denied.code.length > 0 ? denied.code : "OUTPUT_DENIED";
          dispatchFail(failEnv, code, denied.reason ?? t("desktop.output.deniedFallback"));
        } else {
          pushLog("Save destination request cancelled");
          update();
        }
      },
      (error: unknown) => {
        if (isTerminalStatus(controller.getState().status)) return;
        const message = error instanceof Error ? error.message : t("desktop.invoke.destination");
        dispatchFail(failEnv, "OUTPUT_DENIED", message);
      },
    );
}

function handleSave(): void {
  requestOutputAndResume("save");
}

// Recovery: retry the outstanding decision (destination -> back to
// awaiting-destination; partial -> retry failed tiles). Wired to the engine
// RetryReady response via the att:<suffix> choice shape.
function handleRecoveryRetry(): void {
  const decision = pendingDecision;
  if (!decision || isTerminalStatus(controller.getState().status)) return;
  pushLog(`Retry requested (${decision.reason})`);
  answerChoice(
    RETRY_CHOICE,
    () => {
      pendingDecision = null;
      setStep(t("view.step.downloading"), t("desktop.step.retrying"));
      update();
    },
    t("desktop.invoke.retry"),
  );
}

// Recovery: keep or discard a partial result. Wired to the engine PartialKeep
// response via the partial:keep / partial:discard choice shapes. The terminal
// outcome (partial-completed / failed) arrives as an event; nothing is
// dispatched locally so the terminal stays exactly-once.
function handlePartialChoice(keep: boolean): void {
  const decision = pendingDecision;
  if (!decision || decision.kind !== "partial-recovery") return;
  if (isTerminalStatus(controller.getState().status)) return;
  pushLog(keep ? "Keeping partial image…" : "Discarding partial image…");
  answerChoice(
    keep ? KEEP_PARTIAL_CHOICE : DISCARD_PARTIAL_CHOICE,
    () => {
      pendingDecision = null;
      setStep(
        keep ? t("view.step.saving") : t("view.step.working"),
        keep ? t("desktop.step.encodingPartial") : t("desktop.step.discardingPartial"),
      );
      update();
    },
    t("desktop.invoke.partial"),
  );
}

// Recovery: hand the job to another app. The desktop app is already native,
// so this validates the bounded non-secret source and records the outcome;
// the user keeps working here afterwards.
function handleHandoffToNative(): void {
  const decision = pendingDecision;
  if (!decision || isTerminalStatus(controller.getState().status)) return;
  if (!lastInputUrl) return;
  pushLog("Checking handoff to another app…");
  void integration
    .requestHandoff({ sourceUrl: lastInputUrl, provenanceLabel: "desktop" })
    .then(
      (result) => {
        pushLog(
          result.accepted
            ? `Handoff ready: ${result.reason}`
            : `Handoff rejected: ${result.reason}`,
        );
        const a = activity();
        a.detail = result.accepted ? t("desktop.handoff.acceptedDetail") : t("desktop.handoff.rejectedDetail");
        touchProgress();
        update();
      },
      (error: unknown) => {
        pushLog(`Handoff check failed: ${error instanceof Error ? error.message : "unknown error"}`);
        update();
      },
    );
}

function handleReset(): void {
  submitToken += 1;
  sessionId = `sess:desktop-${Date.now()}`;
  controller.reset(sessionId);
  currentSeq = 0;
  currentJobId = null;
  retiredJobId = null;
  remoteSeqByJob = {};
  lastInputUrl = "";
  clearJobViewState();
  dismissDeepLinkConfirm(false);
  deepLinkReturnFocus = null;
  recoveryReturnFocus = null;
  lastRecoveryKey = null;
  // Idle prefill survives reset: a launch URL stays available for the next
  // empty form without ever starting a job on its own.
  const prefilled = readInitialUrl();
  if (prefilled) viewCtx.initialUrl = prefilled;
  else viewCtx.initialUrl = undefined;
  stopHeartbeat();
  update();
}

function handleOpenExternalLink(url: string): void {
  void integration.openExternalLink(url).then(
    () => undefined,
    () => undefined,
  );
}

// No onCopyShareLink: desktop output is a native file handle, so there is no
// shareable browser link to copy. The job view hides the share button when
// the callback is absent; diagnostics copying has its own explicit button.

// Idempotent walk from discovering through selection into downloading. Each
// dispatch is accepted only when the controller transition is legal, so
// calling this on every running/progress signal is safe and duplicate
// signals never double-advance.
function grantedMime(): string {
  return encoderToMime(grantedFormat, "image/png");
}


function dismissDeepLinkConfirm(restore = true): void {
  if (typeof document === "undefined") return;
  document.getElementById("dz-deep-link-confirm")?.remove();
  if (restore) {
    restoreFocus(deepLinkReturnFocus);
    deepLinkReturnFocus = null;
  }
}

// Confirm UI for deep links: shows the validated source plus provenance
// (envelope version, hint, reception channel). Confirm starts the normal
// `start_job` flow; decline dismisses with no effect. Uses the shared modal
// geometry (backdrop + card, architectural radius) so the dialog matches the
// parchment/walnut theme with no nested status card.
//
// Accessibility: role dialog with aria-modal, labelledby/describedby, Escape
// dismisses, Tab traps inside the dialog, focus starts on the confirm action
// and returns to the opener on close. Both actions are native buttons with
// the crisp 2px architectural focus ring (never a neon halo).
function showDeepLinkConfirm(info: ValidatedDeepLink): void {
  if (typeof document === "undefined") return;
  dismissDeepLinkConfirm(false);
  const doc = document;
  deepLinkReturnFocus = activeElementOf(doc);
  const overlay = doc.createElement("div");
  overlay.id = "dz-deep-link-confirm";
  overlay.className = "dz-modal-backdrop";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "dz-deep-link-title");
  overlay.setAttribute("aria-describedby", "dz-deep-link-desc");
  const card = doc.createElement("div");
  card.className = "dz-modal-card";
  const title = doc.createElement("h2");
  title.className = "dz-modal-title";
  title.id = "dz-deep-link-title";
  title.tabIndex = -1;
  title.textContent = t("desktop.link.title");
  const source = doc.createElement("p");
  source.className = "dz-modal-subtitle";
  source.id = "dz-deep-link-desc";
  source.textContent = t("desktop.link.source", { url: info.sourceUrl });
  const provenance = doc.createElement("p");
  provenance.className = "dz-notice-message";
  provenance.textContent = info.hint
    ? t("desktop.link.provHint", { version: info.version, hint: info.hint })
    : t("desktop.link.prov", { version: info.version });
  const note = doc.createElement("p");
  note.className = "dz-notice-message";
  note.textContent = t("desktop.link.note");
  const row = doc.createElement("div");
  row.className = "dz-modal-actions";
  const declineButton = doc.createElement("button");
  declineButton.type = "button";
  declineButton.className = "dz-btn-secondary";
  declineButton.textContent = t("desktop.link.dismiss");
  const close = (): void => {
    doc.removeEventListener("keydown", onKeyDown, true);
    dismissDeepLinkConfirm(true);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = focusableIn(overlay);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    const active = doc.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  declineButton.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  doc.addEventListener("keydown", onKeyDown, true);
  const confirmButton = doc.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "dz-btn-tactile";
  confirmButton.textContent = t("desktop.link.open");
  confirmButton.addEventListener("click", () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    dismissDeepLinkConfirm(true);
    handleSubmitUrl(info.sourceUrl);
  });
  row.append(declineButton, confirmButton);
  card.append(title, source, provenance, note, row);
  overlay.appendChild(card);
  doc.body.appendChild(overlay);
  if (typeof confirmButton.focus === "function") {
    confirmButton.focus();
  }
}

function handleDesktopEvent(channel: DesktopEventChannel, raw: unknown): void {
  const table = asPayload(raw);
  assertNoTileBytes(table);
  const payload = redactForEvent(table);

  if (channel === "dezoomify://deep-link-pending") {
    // Deep links never auto-start: validate again in the frontend, then wait
    // for explicit user confirmation (source + provenance). Declining, or a
    // rejected payload, performs no effect.
    const validated = validateDeepLinkPayload(payload);
    if (validated) {
      showDeepLinkConfirm(validated);
    }
    return;
  }

  // Stale-job guard: events for a job we are no longer following are
  // ignored. A submit retires the previous job id so its late events can
  // never be mistaken for the new job, even before the new id is known.
  const job = payloadJob(payload);
  if (job && job === retiredJobId && job !== currentJobId) return;
  if (job && currentJobId && job !== currentJobId) return;
  if (job && !currentJobId && !retiredJobId) {
    currentJobId = job;
  } else if (job && !currentJobId && retiredJobId && job !== retiredJobId) {
    currentJobId = job;
    retiredJobId = null;
  } else if (job && !currentJobId) {
    return;
  }

  // Stale-seq guard: per-job monotonic IPC seq; old or reordered events are
  // ignored. Events without a seq still apply (command responses and legacy
  // payloads carry none).
  const remoteSeq = payloadSeq(payload);
  const seqKey = job ?? currentJobId ?? "";
  if (remoteSeq !== null && seqKey !== "") {
    const seen = remoteSeqByJob[seqKey] ?? 0;
    if (remoteSeq <= seen) return;
    remoteSeqByJob[seqKey] = remoteSeq;
    const keys = Object.keys(remoteSeqByJob);
    if (keys.length > 8) {
      for (const k of keys) {
        if (k !== seqKey && k !== (currentJobId ?? "")) delete remoteSeqByJob[k];
      }
    }
  }

  // Exactly-once terminal: once the controller reaches completed, cancelled,
  // or failed, later job events are ignored (the controller itself also
  // rejects post-terminal transitions; this additionally freezes progress,
  // activity, and diagnostics at the terminal snapshot).
  if (isTerminalStatus(controller.getState().status)) return;

  const text = `${channel} ${payloadText(payload)}`.toLowerCase();
  const kind = typeof payload["kind"] === "string" ? (payload["kind"] as string).toLowerCase() : "";
  const detailRaw = strField(payload, ["detail"]) ?? "";
  const detailObj = detailRaw !== "" ? parseDetailObject(detailRaw) : null;

  // Recovery-requested (destination / partial): surface typed choices and
  // wait for the user. Nothing is auto-answered and no terminal is
  // dispatched here.
  // `flat` strips hyphens/underscores so PascalCase engine states
  // (`AwaitingRecovery`, `AwaitingPartialDecision`, ...) match the same
  // branches as kebab-case (`awaiting-recovery`, ...).
  const flat = text.replace(/[-_]/g, "");
  if (
    kind === "recovery-requested" ||
    text.indexOf("recovery-requested") >= 0 ||
    text.indexOf("request-decision") >= 0 ||
    text.indexOf("awaiting-recovery") >= 0 ||
    flat.indexOf("awaitingrecovery") >= 0 ||
    text.indexOf("awaitingpartialdecision") >= 0 ||
    flat.indexOf("awaitingpartialdecision") >= 0 ||
    text.indexOf("awaiting-partial") >= 0 ||
    flat.indexOf("awaitingpartial") >= 0
  ) {
    const reason = payloadReason(payload, text) ?? "destination";
    const recovery =
      strField(payload, ["recovery", "recoveryId", "recovery_id"]) ??
      (detailObj ? strField(detailObj, ["recovery", "recoveryId", "recovery_id"]) : undefined);
    const attempt =
      strField(payload, ["attempt", "attemptId", "attempt_id"]) ??
      (detailObj ? strField(detailObj, ["attempt", "attemptId", "attempt_id"]) : undefined);
    const missing = reason === "partial" ? extractMissingTiles(payload, detailObj, detailRaw) : [];
    const failedCount =
      numField(payload, detailRaw, ["failed", "failedRequests", "failures"]) ??
      (detailObj ? numField(detailObj, "", ["failed", "failedRequests", "failures"]) : undefined);
    const totalCount =
      numField(payload, detailRaw, ["total", "tiles", "tileCount"]) ??
      (detailObj ? numField(detailObj, "", ["total", "tiles", "tileCount"]) : undefined);
    pendingDecision = {
      kind: reason === "partial" ? "partial-recovery" : "destination-recovery",
      reason,
      ...(recovery ? { recovery } : {}),
      ...(attempt ? { attempt } : {}),
      ...(reason === "partial" ? { missingTiles: missing } : {}),
      ...(typeof failedCount === "number" ? { failedCount } : {}),
      ...(typeof totalCount === "number" ? { totalCount } : {}),
    };
    if (reason === "partial") {
      const summary = formatMissingSummary(missing, failedCount);
      setStep(t("desktop.step.partialTitle"), t("desktop.step.partialDetail"));
      pushLog(`Recovery requested: partial (${summary} keep-partial / discard-partial / retry)`);
      if (typeof failedCount === "number") {
        const a = activity();
        a.failedRequests = failedCount;
        a.now = Date.now();
      }
    } else {
      setStep(t("desktop.step.chooseWhere"), t("desktop.step.chooseWhereDetail"));
      pushLog("Recovery requested: destination (choose-output / retry)");
    }
    update();
    return;
  }

  // Failure: typed StructuredError with code, category, retryable, message,
  // detail, transport, and phase. The engine technical chain arrives in
  // detail; the first message stays a plain actionable sentence.
  if (
    channel === "dezoomify://job-error" ||
    kind === "failed" ||
    text.indexOf("fail") >= 0
  ) {
    if (kind === "progress" || kind === "downloading" || kind === "discovery" || kind === "encoding") {
      // Progress detail text never signals failure; fall through.
    } else {
      const detailCode = detailObj ? strField(detailObj, ["code"]) : undefined;
      let code = strField(payload, ["code"]) ?? detailCode ?? "JOB_FAILED";
      let message =
        strField(payload, ["message"]) ??
        (detailObj ? strField(detailObj, ["message"]) : undefined);
      let detail: string | undefined;
      if (detailRaw !== "") {
        if (detailObj) {
          detail = detailCode && message ? detailRaw : undefined;
          if (!message) {
            message = detailCode ? detailRaw : undefined;
          }
        } else if (message) {
          detail = detailRaw;
        } else {
          // "code: message" technical chains split back into typed fields.
          const split = detailRaw.indexOf(":");
          if (split > 0 && split < 80) {
            const maybeCode = detailRaw.slice(0, split).trim();
            const maybeMessage = detailRaw.slice(split + 1).trim();
            if (maybeCode && maybeMessage && /^[a-z0-9][a-z0-9._-]*$/i.test(maybeCode)) {
              code = maybeCode;
              message = maybeMessage;
              detail = detailRaw;
            } else {
              message = detailRaw;
            }
          } else {
            message = detailRaw;
          }
        }
      }
      if (!message) message = t("desktop.job.failedFallback");
      // A "code: message" detail that duplicates the message adds no
      // technical value; keep detail only when it carries more.
      if (detail === message) detail = undefined;
      const transport = strField(payload, ["transport"]) ?? NATIVE_TRANSPORT;
      const phase = strField(payload, ["phase"]) ?? phaseFor(code);
      // Stable backend verdicts ride the payload (phase/transport/resource-kind
      // plus retryable); the frontend never recomputes them from messages.
      const rawRetryable = payload["retryable"];
      const retryable = typeof rawRetryable === "boolean" ? rawRetryable : undefined;
      const resourceKind =
        strField(payload, ["resource-kind", "resource_kind", "resourceKind"]) ??
        (detailObj ? strField(detailObj, ["resource-kind", "resource_kind", "resourceKind"]) : undefined);
      const failedCount = numField(payload, `${kind} ${detailRaw}`, ["failed", "failedRequests", "failures"]);
      if (typeof failedCount === "number") {
        const a = activity();
        a.failedRequests = failedCount;
        a.now = Date.now();
      }
      dispatchFail(failEnv, code, message, {
        transport,
        phase,
        ...(typeof retryable === "boolean" ? { retryable } : {}),
        ...(resourceKind ? { resourceKind } : {}),
        ...(detail ? { detail } : {}),
      });
      return;
    }
  }
  if (kind === "error" || text.indexOf("error") >= 0) {
    const code = strField(payload, ["code"]) ?? "JOB_FAILED";
    const message = strField(payload, ["message"]) ?? (detailRaw !== "" ? detailRaw : t("desktop.job.failedFallback"));
    const transport = strField(payload, ["transport"]) ?? NATIVE_TRANSPORT;
    const rawRetryable = payload["retryable"];
    const retryable = typeof rawRetryable === "boolean" ? rawRetryable : undefined;
    const resourceKind = strField(payload, ["resource-kind", "resource_kind", "resourceKind"]);
    dispatchFail(failEnv, code, message, {
      transport,
      phase: strField(payload, ["phase"]) ?? phaseFor(code),
      ...(typeof retryable === "boolean" ? { retryable } : {}),
      ...(resourceKind ? { resourceKind } : {}),
    });
    return;
  }

  // Cancellation echoes back through job-state; clamp to one transition.
  // Intermediate cleaning states keep the loading view with a cleanup note;
  // only an acknowledged cancelled terminal reaches cancelled, after the
  // shell has removed uncommitted output.
  if (
    kind === "cancelled" ||
    text.indexOf("cancelled") >= 0 ||
    text.indexOf("canceled") >= 0
  ) {
    if (isTerminalStatus(controller.getState().status)) return;
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
    pushLog("Cancelled; unfinished file removed");
    pendingDecision = null;
    stopHeartbeat();
    update();
    return;
  }
  if (kind === "cancelling" || text.indexOf("cancelling") >= 0 || text.indexOf("cleaning") >= 0) {
    setStep(t("view.step.working"), t("desktop.step.cleanupDetail"));
    update();
    return;
  }
  if (text.indexOf("cancel") >= 0) {
    if (kind === "progress" || kind === "downloading" || kind === "discovery" || kind === "encoding") {
      // Progress text never signals cancellation; fall through.
    } else {
      setStep(t("view.step.working"), t("desktop.step.cleanupDetail"));
      update();
      return;
    }
  }

  // Completion: output digest plus optional geometry. Only positive geometry
  // becomes completedInfo (the view renders "W by H" verbatim); the mime
  // falls back to the granted encoder. A partial-completed terminal stays
  // distinguishable: the aux panel marks the partial output and its missing
  // tiles instead of claiming a complete save.
  if (
    channel === "dezoomify://job-output" ||
    kind === "completed" ||
    kind === "partial-completed" ||
    kind === "output" ||
    text.indexOf("complet") >= 0 ||
    (text.indexOf("output") >= 0 && kind !== "progress")
  ) {
    const isPartial =
      kind === "partial-completed" ||
      text.indexOf("partial-completed") >= 0 ||
      text.indexOf("partial completed") >= 0;
    const width =
      numField(payload, detailRaw, ["width", "imageWidth", "w"]) ??
      (detailObj
        ? numField(detailObj, "", ["width", "imageWidth", "w"])
        : undefined);
    const height =
      numField(payload, detailRaw, ["height", "imageHeight", "h"]) ??
      (detailObj
        ? numField(detailObj, "", ["height", "imageHeight", "h"])
        : undefined);
    const mime = encoderToMime(
      strField(payload, ["mime", "mimeType", "contentType", "encoder", "format"]) ??
        (detailObj ? strField(detailObj, ["mime", "mimeType", "contentType", "encoder", "format"]) : undefined),
      grantedMime(),
    );
    const outputHash = strField(payload, ["outputHash", "output_hash", "output", "digest"]);
    const missing = isPartial ? extractMissingTiles(payload, detailObj, detailRaw) : [];
    if (outputHash) {
      const short = outputHash.slice(0, 24);
      pushLog(isPartial ? `Partial output ready (${short}…)` : `Output ready (${short}…)`);
    }
    completeJob(jobEnv, 
      typeof width === "number" && typeof height === "number" && width > 0 && height > 0
        ? { width, height, mime }
        : undefined,
      isPartial,
      missing,
    );
    return;
  }

  // Save destination granted on the host side (request_destination emits a
  // destination event): record the format and walk into saving. The user
  // grant itself arrives via requestOutputAndResume; this covers host-side
  // grants observed as events.
  if (kind === "destination" || text.indexOf("destination") >= 0) {
    if (text.indexOf("denied") >= 0) {
      dispatchFail(failEnv, "OUTPUT_DENIED", t("desktop.output.deniedFallback"));
      return;
    }
    const format = strField(payload, ["format"]) ?? detailRaw;
    if (format) {
      const normalized = normalizeNativeFormat(format);
      if ((NATIVE_FORMATS as readonly string[]).includes(normalized)) grantedFormat = normalized;
    }
    if (text.indexOf("awaiting") >= 0 || text.indexOf("request-destination") >= 0) {
      if (!pendingDecision) {
        pendingDecision = { kind: "destination-request", reason: "destination" };
      }
      setStep(t("desktop.step.chooseWhere"), t("desktop.step.pickOutput"));
      pushLog("Save destination requested");
      update();
      return;
    }
    preflightThrough(
      numField(payload, detailRaw, ["imageCount", "images", "count"]),
    );
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-start" });
    setStep(t("view.step.saving"), t("desktop.step.encodingNative"));
    update();
    return;
  }

  // Catalog / image selection: the native pipeline auto-saves images[0] at
  // the largest fitting level. Record the honest auto-choice notice in local
  // aux (pendingDecision pattern, no protocol event); the shared job view
  // renders "Found N images, saving largest that fits (WxH, K tiles)".
  if (
    kind === "catalog" ||
    kind === "images-found" ||
    text.indexOf("images-found") >= 0 ||
    text.indexOf("awaiting-choice") >= 0 ||
    flat.indexOf("awaitingchoice") >= 0 ||
    text.indexOf("awaiting-image") >= 0 ||
    flat.indexOf("awaitingimage") >= 0 ||
    flat.indexOf("awaitingimageselection") >= 0 ||
    text.indexOf("choosing") >= 0
  ) {
    const found = numField(payload, detailRaw, ["imageCount", "images", "count"]);
    controller.dispatch({
      seq: nextSeq(),
      sessionId,
      kind: "images-found",
      ...(found !== undefined ? { imageCount: found } : {}),
      transport: NATIVE_TRANSPORT,
    });
    if (found !== undefined) {
      catalogNotice = { ...(catalogNotice ?? {}), imageCount: found };
    } else if (!catalogNotice && controller.getState().imageCount > 0) {
      catalogNotice = { imageCount: controller.getState().imageCount };
    }
    const nounCount = catalogNotice?.imageCount ?? found ?? 0;
    const noun = nounCount === 1 ? t("view.job.oneImage") : t("view.job.manyImages", { count: nounCount });
    if ((catalogNotice?.imageCount ?? found ?? 0) > 0) {
      pushLog(`Found ${noun}; auto-saving largest that fits`);
      setStep(
        t("desktop.step.foundFits", { noun }),
        t("desktop.step.appAutoDetail"),
      );
    } else {
      setStep(t("view.step.choosingImage"));
    }
    update();
    return;
  }

  // Level selection offered: record image-chosen (legal from
  // choosing-image), then wait for the running signal before level-chosen.
  if (
    kind === "levels" ||
    text.indexOf("levels") >= 0 ||
    flat.indexOf("levels") >= 0 ||
    text.indexOf("awaiting-level") >= 0 ||
    flat.indexOf("awaitinglevel") >= 0
  ) {
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "image-chosen" });
    setStep(t("view.step.choosingLevel"));
    update();
    return;
  }

  // Display-only preview: no bytes will be readable, so no save is offered.
  if (text.indexOf("display-only") >= 0 || text.indexOf("display_only") >= 0) {
    if (isTerminalStatus(controller.getState().status)) return;
    preflightThrough(
      numField(payload, detailRaw, ["imageCount", "images", "count"]),
    );
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "preflight-display-only" });
    setStep(t("desktop.step.displayPreview"), t("desktop.step.displayDetail"));
    pushLog("Display-only preview");
    update();
    return;
  }

  // Progress snapshots: discovery (resources), downloading (acquired/total),
  // encoding. Each ensures the selection chain first so a progress signal
  // alone walks discovering -> downloading.
  if (
    channel === "dezoomify://job-progress" ||
    kind === "progress" ||
    kind === "downloading" ||
    kind === "discovery" ||
    kind === "encoding" ||
    text.indexOf("progress") >= 0 ||
    numField(payload, detailRaw, ["acquired", "completed", "current", "done"]) !== undefined
  ) {
    const current =
      numField(payload, detailRaw, ["current", "acquired", "completed", "done", "resources"]) ?? 0;
    const total = numField(payload, detailRaw, ["total"]) ?? 0;
    const message = strField(payload, ["message"]);
    const progressCount = numField(payload, detailRaw, ["imageCount", "images", "count"]);
    preflightThrough(progressCount);
    if (progressCount !== undefined || total > 0) {
      const prevCount = catalogNotice?.imageCount ?? controller.getState().imageCount ?? 0;
      catalogNotice = {
        ...(catalogNotice ?? {}),
        imageCount: progressCount ?? prevCount,
        ...(total > 0 ? { tiles: total } : {}),
      };
    }
    viewCtx.currentProgress = { current, total, ...(message ? { message } : {}) };
    noteProgress(current, total);
    if (kind === "discovery" || text.indexOf("discover") >= 0) {
      setStep(t("view.step.discovering"), t("desktop.step.contacting", { host: hostOf(lastInputUrl || activity().url || "") }));
    } else if (kind === "encoding" || text.indexOf("encod") >= 0) {
      setStep(t("view.step.saving"), t("desktop.step.encodingNative"));
    } else {
      setStep(
        t("view.step.downloading"),
        total > 0 ? t("desktop.step.tilesAtFull", { current, total }) : undefined,
      );
    }
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "progress" });
    update();
    return;
  }

  // Running / planning / acquisition phases without counts.
  if (
    kind === "job-state" ||
    text.indexOf("running") >= 0 ||
    text.indexOf("downloading") >= 0 ||
    text.indexOf("acquiring") >= 0 ||
    text.indexOf("planning") >= 0 ||
    text.indexOf("processing") >= 0 ||
    text.indexOf("discovering") >= 0 ||
    text.indexOf("job-state") >= 0
  ) {
    if (text.indexOf("running") >= 0 || text.indexOf("downloading") >= 0 || text.indexOf("acquiring") >= 0) {
      const runningCount = numField(payload, detailRaw, ["imageCount", "images", "count"]);
      preflightThrough(runningCount);
      if (runningCount !== undefined && !catalogNotice) {
        catalogNotice = { imageCount: runningCount };
      }
      controller.dispatch({ seq: nextSeq(), sessionId, kind: "progress" });
      setStep(t("view.step.downloading"));
    } else     if (text.indexOf("cancelling") >= 0 || text.indexOf("cleaning") >= 0) {
      setStep(t("view.step.working"), t("desktop.step.cleaningShort"));
    }
    update();
    return;
  }
  update();
}

function subscribeToDesktopEvents(): void {
  const listen = tauriListen();
  if (!listen) return;
  for (const channel of DESKTOP_EVENT_CHANNELS) {
    const name: DesktopEventChannel = channel;
    try {
      const maybe = listen(name, (event) => {
        const raw = (event as { payload?: unknown }).payload ?? event;
        try {
          handleDesktopEvent(name, raw);
        } catch {
          // Guards already threw for tile bytes; never break rendering.
        }
      });
      if (maybe && typeof (maybe as Promise<unknown>).catch === "function") {
        (maybe as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // No host listener available; validation-only fallback stays usable.
    }
  }
}

const viewCtx: ViewContext = {
  capabilities: {
    nativeAvailable: integration.getCapabilities().nativeAvailable,
    extensionAvailable: integration.getCapabilities().extensionAvailable,
    browserCanSave: integration.getCapabilities().browserCanSave,
    proxyAllowed: integration.getCapabilities().proxyAllowed,
  },
};

// Idle prefill is launch input only: set once at startup and on reset, never
// from a submitted job. The shared input section prefills the empty field
// from this value and never overwrites user typing.
function initInitialUrl(): void {
  const prefilled = readInitialUrl();
  if (prefilled) viewCtx.initialUrl = prefilled;
}

function syncInitialUrlFromLocation(): void {
  if (controller.getState().status !== "idle") return;
  const prefilled = readInitialUrl();
  const current = viewCtx.initialUrl;
  if (prefilled && prefilled !== current) {
    viewCtx.initialUrl = prefilled;
    update();
  } else if (!prefilled && current) {
    viewCtx.initialUrl = undefined;
    update();
  }
}

// Output format selector (todo 4.4, todo 5.1): 6 native radios
// (PNG/JPEG/TIFF/ZIF/WebP/IIIF folder) bound to grantedFormat. Flat flow
// inside the aux panel, native inputs so Tab and screen readers work; the
// crisp 2px focus ring comes from desktop.css. Changing a radio only updates
// grantedFormat; requestOutputAndResume reads it when building
// { format, suggestedName } for requestSaveDestination. The `iiif-dir` radio
// is the directory mode: it suggests a `.iiif` name and the shell writes the
// IIIF tile tree at that path (extensionless also validates natively).
function appendOutputFormatRadios(parent: HTMLElement, doc: Document): void {
  const group = doc.createElement("fieldset");
  group.id = "dz-output-format-group";
  group.className = "dz-actions-row";
  group.style.border = "none";
  group.style.padding = "0";
  group.style.margin = "0";
  const legend = doc.createElement("legend");
  legend.className = "dz-notice-message";
  legend.textContent = t("desktop.panel.outputFormat");
  group.appendChild(legend);
  for (const value of NATIVE_FORMATS) {
    const label = doc.createElement("label");
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.gap = "0.35rem";
    label.style.marginRight = "1rem";
    const input = doc.createElement("input");
    input.type = "radio";
    input.name = "dz-output-format";
    input.value = value;
    if (normalizeNativeFormat(grantedFormat) === value) input.checked = true;
    input.addEventListener("change", () => {
      if (input.checked) {
        grantedFormat = normalizeNativeFormat(input.value);
        persistOutputFormat(grantedFormat);
      }
    });
    const text = doc.createElement("span");
    if (value === "png") text.textContent = "PNG";
    else if (value === "jpeg") text.textContent = "JPEG";
    else if (value === "tiff") text.textContent = "TIFF";
    else if (value === "zif") text.textContent = "ZIF";
    else if (value === "webp") text.textContent = "WebP";
    else text.textContent = "IIIF folder";
    label.append(input, text);
    group.appendChild(label);
  }
  parent.appendChild(group);
}

// Desktop auxiliary panel: typed recovery choices, partial and cancelled
// notices, plus a copy-diagnostics button. The shared view owns the card
// layout; this panel is re-applied after every render (idempotent by stable
// id) so phase remounts cannot lose a pending decision, and in-place job
// updates keep it without flicker.
// Visuals stay flat inside the single status card: transparent flow with a
// top separator, left-aligned copy, theme buttons. Never a nested box.
//
// Accessibility (Task 5.2): the pending decision renders as an inline
// role="dialog" with aria-modal="false" (inline, not a modal overlay),
// labelledby/describedby, and an assertive description so screen readers
// announce recovery without a separate alert. A new decision moves focus to
// its primary button once; later ticks preserve the focused button instead
// of dropping focus. Resolving the decision returns focus to the opener.
// Tab cycles inside the decision buttons; Escape moves focus out to the job
// Cancel action (when present) without clearing the decision, since recovery
// must keep waiting for an explicit choice. Partial and cancelled notes use
// role="status" with aria-live polite; the shared job view owns the single
// role="progressbar" with aria-valuenow/min/max, so no second progressbar
// lives here. All buttons are native and keyboard reachable.
function ensureDesktopAuxPanel(): void {
  if (typeof document === "undefined" || !root) return;
  const state = controller.getState();
  const doc = root.ownerDocument;
  const decision = pendingDecision;
  const decisionKey = recoveryKeyFor(decision);
  const prevKey = lastRecoveryKey;
  const existing = doc.getElementById("dz-desktop-aux");
  const focusedInside = existing && existing.contains(doc.activeElement)
    ? (doc.activeElement as HTMLElement)
    : null;
  const focusedLabel = focusedInside && focusedInside instanceof HTMLButtonElement
    ? focusedInside.textContent
    : null;
  const focusedFormat =
    focusedInside &&
    focusedInside instanceof HTMLInputElement &&
    focusedInside.type === "radio" &&
    focusedInside.name === "dz-output-format"
      ? focusedInside.value
      : null;
  if (decisionKey && decisionKey !== prevKey && !recoveryReturnFocus) {
    const opener = activeElementOf(doc);
    recoveryReturnFocus = opener && existing?.contains(opener) ? null : opener;
    if (recoveryReturnFocus === null && opener && !existing?.contains(opener)) {
      recoveryReturnFocus = opener;
    }
    if (existing && existing.contains(opener as Node) && prevKey === null) {
      recoveryReturnFocus = null;
    }
  }
  existing?.remove();
  const showCopy = state.status !== "idle";
  const showPartialDone = state.status === "completed" && completedPartial;
  const showCancelledNote = state.status === "cancelled";
  if (!decision && !showCopy && !showPartialDone && !showCancelledNote) {
    if (prevKey !== null) {
      restoreFocus(recoveryReturnFocus);
      recoveryReturnFocus = null;
    }
    lastRecoveryKey = decisionKey;
    return;
  }
  const card = root.querySelector(".dz-card");
  if (!card) {
    lastRecoveryKey = decisionKey;
    return;
  }

  const aux = doc.createElement("div");
  aux.id = "dz-desktop-aux";
  aux.className = "dz-view-body dz-desktop-aux";
  aux.setAttribute("role", "region");
  aux.setAttribute("aria-label", t("desktop.panel.jobActions"));
  appendOutputFormatRadios(aux, doc);

  let decisionBox: HTMLElement | null = null;

  if (decision) {
    decisionBox = doc.createElement("div");
    decisionBox.className = "dz-recovery-dialog";
    decisionBox.setAttribute("role", "dialog");
    decisionBox.setAttribute("aria-modal", "false");
    decisionBox.setAttribute("aria-labelledby", "dz-recovery-title");
    decisionBox.setAttribute("aria-describedby", "dz-recovery-desc");
    const title = doc.createElement("h2");
    title.className = "dz-notice-title";
    title.id = "dz-recovery-title";
    title.tabIndex = -1;
    const desc = doc.createElement("p");
    desc.className = "dz-notice-message";
    desc.id = "dz-recovery-desc";
    desc.setAttribute("aria-live", "assertive");
    const row = doc.createElement("div");
    row.className = "dz-actions-row";

    function addButton(label: string, primary: boolean, onClick: () => void): void {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = primary ? "dz-btn-tactile" : "dz-btn-secondary";
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      row.appendChild(btn);
    }

    if (decision.kind === "partial-recovery") {
      title.textContent = t("desktop.rec.partialTitle");
      const missing = decision.missingTiles ?? [];
      const summary = formatMissingSummary(missing, decision.failedCount);
      desc.textContent = t("desktop.rec.partialDesc", { summary });
      decisionBox.append(title, desc);
      if (missing.length > 0) {
        const list = doc.createElement("p");
        list.className = "dz-notice-message dz-missing-list";
        const shown = missing.slice(0, 20).join(", ");
        const rest = missing.length > 20 ? t("desktop.rec.more", { n: missing.length - 20 }) : "";
        list.textContent = t("desktop.rec.missing", { shown, rest });
        decisionBox.appendChild(list);
      }
      decisionBox.appendChild(row);
      addButton(t("desktop.rec.keep"), true, () => handlePartialChoice(true));
      addButton(t("desktop.rec.discard"), false, () => handlePartialChoice(false));
      addButton(t("desktop.rec.retryTiles"), false, () => handleRecoveryRetry());
    } else if (decision.kind === "destination-recovery") {
      title.textContent = t("desktop.rec.destTitle");
      desc.textContent = t("desktop.rec.destDesc");
      decisionBox.append(title, desc, row);
      addButton(t("desktop.rec.chooseOutput"), true, () => requestOutputAndResume("choose-output"));
      addButton(t("desktop.rec.tryAgain"), false, () => handleRecoveryRetry());
      addButton(t("desktop.rec.useOther"), false, () => handleHandoffToNative());
    } else {
      title.textContent = t("desktop.rec.chooseTitle");
      desc.textContent = t("desktop.rec.chooseDesc");
      decisionBox.append(title, desc, row);
      addButton(t("desktop.rec.chooseOutput"), true, () => requestOutputAndResume("choose-output"));
      addButton(t("desktop.rec.useOther"), false, () => handleHandoffToNative());
    }
    decisionBox.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const cancelBtn = doc.getElementById("dz-btn-cancel") as HTMLElement | null;
        if (cancelBtn && typeof cancelBtn.focus === "function") cancelBtn.focus();
        else {
          const firstOutside = focusableIn(aux).filter((el) => !decisionBox?.contains(el))[0];
          if (firstOutside) firstOutside.focus();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const box = decisionBox as HTMLElement;
      const focusables = focusableIn(box);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      const active = doc.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !box.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    });
    aux.appendChild(decisionBox);
  }

  if (showPartialDone) {
    const doneBox = doc.createElement("div");
    doneBox.className = "dz-partial-note";
    doneBox.setAttribute("role", "status");
    doneBox.setAttribute("aria-live", "polite");
    const title = doc.createElement("h2");
    title.className = "dz-notice-title";
    title.textContent = t("desktop.done.partialTitle");
    const desc = doc.createElement("p");
    desc.className = "dz-notice-message";
    const summary = formatMissingSummary(completedMissing, completedMissing.length);
    desc.textContent = t("desktop.done.partialDesc", { summary });
    doneBox.append(title, desc);
    if (completedMissing.length > 0) {
      const list = doc.createElement("p");
      list.className = "dz-notice-message dz-missing-list";
      const shown = completedMissing.slice(0, 20).join(", ");
      const rest = completedMissing.length > 20 ? t("desktop.rec.more", { n: completedMissing.length - 20 }) : "";
      list.textContent = t("desktop.rec.missing", { shown, rest });
      doneBox.appendChild(list);
    }
    aux.appendChild(doneBox);
  }

  if (showCancelledNote) {
    const note = doc.createElement("p");
    note.className = "dz-notice-message";
    note.id = "dz-cancel-cleanup-note";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    note.textContent = t("desktop.cancel.note");
    aux.appendChild(note);
  }

  if (showCopy) {
    const copyRow = doc.createElement("div");
    copyRow.className = "dz-actions-row";
    const copyBtn = doc.createElement("button");
    copyBtn.type = "button";
    copyBtn.id = "dz-btn-copy-diag";
    copyBtn.className = "dz-btn-secondary";
    copyBtn.textContent = t("desktop.copy.diagnostics");
    copyBtn.addEventListener("click", () => handleCopyDiagnostics(() => buildCopyDiagnostics(diagnosticsSnapshot())));
    copyRow.appendChild(copyBtn);
    aux.appendChild(copyRow);
  }

  card.appendChild(aux);
  if (decisionKey && decisionKey !== prevKey) {
    const primary = decisionBox?.querySelector("button.dz-btn-tactile") as HTMLElement | null;
    if (primary && typeof primary.focus === "function") primary.focus();
    else {
      const firstBtn = decisionBox ? focusableIn(decisionBox)[0] : undefined;
      if (firstBtn) firstBtn.focus();
    }
  } else if (focusedFormat) {
    const radio = aux.querySelector(
      `input[name="dz-output-format"][value="${focusedFormat}"]`,
    ) as HTMLElement | null;
    if (radio && typeof radio.focus === "function") radio.focus();
  } else if (focusedLabel && decisionBox) {
    const candidates = focusableIn(decisionBox);
    for (const candidate of candidates) {
      if (candidate.textContent === focusedLabel && typeof candidate.focus === "function") {
        candidate.focus();
        break;
      }
    }
  } else if (focusedLabel) {
    const candidates = focusableIn(aux);
    for (const candidate of candidates) {
      if (candidate.textContent === focusedLabel && typeof candidate.focus === "function") {
        candidate.focus();
        break;
      }
    }
  }
  if (!decisionKey && prevKey !== null) {
    restoreFocus(recoveryReturnFocus);
    recoveryReturnFocus = null;
  }
  lastRecoveryKey = decisionKey;
}

// Resolve any anchor href seen in the privileged window to a canonical
// https external URL (docs/user/ rendered pages, legal pages, repo links).
// Returns null for in-page fragments and non-navigating hrefs. Relative
// docs/site hrefs from the shared view ("./help/…", "./privacy.html", …)
// map to the published site so they also leave via openExternalLink.
function resolveDesktopExternalUrl(href: string): string | null {
  const raw = (href ?? "").trim();
  if (raw === "") return null;
  if (raw.startsWith("#")) return null;
  const lower = raw.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:")
  ) {
    return null;
  }
  if (raw.startsWith("https://")) return raw;
  if (raw.startsWith("http://")) return `https://${raw.slice("http://".length)}`;
  let path = raw;
  while (path.startsWith("../")) path = path.slice(3);
  if (path.startsWith("./")) path = path.slice(2);
  else if (path.startsWith("/")) path = path.slice(1);
  if (path === "" || path === "index.html") return `${DESKTOP_DOCS_BASE}/`;
  if (path === "help" || path === "help/") return `${DESKTOP_DOCS_BASE}/help/`;
  if (path.startsWith("help/")) return `${DESKTOP_DOCS_BASE}/${path}`;
  if (path === "privacy.html" || path === "terms.html") {
    return `${DESKTOP_DOCS_BASE}/${path}`;
  }
  return null;
}

// No in-window remote navigation: a single delegated interceptor routes
// every anchor in the privileged window through openExternalLink
// (https-only, validated again in desktopIntegration.ts). Unknown remote
// hrefs are blocked fail-closed (prevented, never opened in-window).
// Wired once; covers the footer, the shared-view guidance links, and any
// future anchors. Idempotent.
function ensureDesktopExternalNav(): void {
  if (typeof document === "undefined") return;
  const doc = document as Document & { [key: string]: unknown };
  if (doc.documentElement?.getAttribute("data-dz-external-wired") === "true") return;
  doc.documentElement?.setAttribute("data-dz-external-wired", "true");
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !document.contains(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      const trimmed = href.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return;
      const resolved = resolveDesktopExternalUrl(trimmed);
      if (resolved) {
        e.preventDefault();
        handleOpenExternalLink(resolved);
        return;
      }
      // Fail closed: anything that looks like a remote or site navigation
      // never runs inside the privileged window.
      const looksRemote =
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("./") ||
        trimmed.startsWith("../") ||
        trimmed.startsWith("/") ||
        trimmed.startsWith("help/") ||
        trimmed.endsWith(".html");
      if (looksRemote) {
        e.preventDefault();
      }
    },
    true,
  );
}

// Pinned bottom footer: the static markup in index.html carries exactly the
// five legal/repo links. Navigation itself is handled by the delegated
// ensureDesktopExternalNav interceptor above, so this only verifies the
// footer exists. Idempotent.
function ensureDesktopFooter(): void {
  if (typeof document === "undefined") return;
  const footer = document.querySelector(".dz-site-footer");
  if (!footer) return;
  if (footer.getAttribute("data-dz-wired") === "true") return;
  footer.setAttribute("data-dz-wired", "true");
}

// Task 5.3 Help/About: link-only region inside the single status card.
// Buttons (never anchors, so no navigation risk) open the published
// docs/user/ pages, legal pages, and Donate via openExternalLink
// (https-only). Labels only; no user copy is duplicated here. The version
// line is app metadata, not docs text.
//
// Accessibility: region labelled by its heading; all actions are native
// buttons reachable by Tab with the crisp 2px focus ring. Rebuilds are
// skipped while focus sits inside so progress ticks never drop focus.
function ensureDesktopHelpAbout(): void {
  if (typeof document === "undefined" || !root) return;
  const card = root.querySelector(".dz-card");
  if (!card) return;
  const existing = document.getElementById("dz-desktop-help");
  if (existing && existing.contains(document.activeElement)) return;
  existing?.remove();

  const doc = root.ownerDocument;
  const region = doc.createElement("div");
  region.id = "dz-desktop-help";
  region.className = "dz-view-body dz-desktop-help";
  region.setAttribute("role", "region");
  region.setAttribute("aria-labelledby", "dz-help-title");

  const title = doc.createElement("h2");
  title.className = "dz-notice-title";
  title.id = "dz-help-title";
  title.textContent = t("desktop.help.title");
  region.appendChild(title);

  const version = doc.createElement("p");
  version.className = "dz-notice-message";
  version.textContent = `Dezoomify Desktop ${DESKTOP_APP_VERSION}`;
  region.appendChild(version);

  const row = doc.createElement("div");
  row.className = "dz-actions-row dz-help-actions";
  for (const link of DESKTOP_HELP_LINKS) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "dz-btn-secondary";
    btn.textContent = link.label;
    btn.setAttribute("aria-label", link.label);
    btn.addEventListener("click", () => handleOpenExternalLink(link.url));
    row.appendChild(btn);
  }
  region.appendChild(row);

  card.appendChild(region);
}

function update() {
  if (!root) return;
  const state = controller.getState();
  const caps = integration.getCapabilities();
  if (viewCtx.jobActivity && !isTerminalStatus(state.status)) refreshLongestPending();
  const auxTiles = catalogNotice?.tiles ?? viewCtx.imageChoice?.tiles ?? viewCtx.currentProgress?.total;
  const auxWidth = catalogNotice?.width ?? viewCtx.imageChoice?.width ?? viewCtx.completedInfo?.width;
  const auxHeight = catalogNotice?.height ?? viewCtx.imageChoice?.height ?? viewCtx.completedInfo?.height;
  const auxChoice =
    catalogNotice || viewCtx.imageChoice || auxTiles !== undefined || auxWidth !== undefined
      ? {
          ...(typeof auxWidth === "number" ? { width: auxWidth } : {}),
          ...(typeof auxHeight === "number" ? { height: auxHeight } : {}),
          ...(typeof auxTiles === "number" ? { tiles: auxTiles } : {}),
        }
      : undefined;

  renderView(
    root,
    state,
    {
      onSubmitUrl(url: string) {
        handleSubmitUrl(url);
      },
      onCancel() {
        handleCancel();
      },
      onReset() {
        handleReset();
      },
      onSave() {
        handleSave();
      },
      onSelectImage(index: number) {
        handleSelectImage(index);
      },
      onSelectLevel(level: number) {
        handleSelectLevel(level);
      },
      onOpenExternalLink(url: string) {
        handleOpenExternalLink(url);
      },
    },
    {
      capabilities: {
        nativeAvailable: caps.nativeAvailable,
        extensionAvailable: caps.extensionAvailable,
        browserCanSave: caps.browserCanSave,
        proxyAllowed: caps.proxyAllowed,
      },
      ...(viewCtx.currentProgress ? { currentProgress: viewCtx.currentProgress } : {}),
      ...(viewCtx.completedInfo ? { completedInfo: viewCtx.completedInfo } : {}),
      ...(viewCtx.jobActivity ? { jobActivity: viewCtx.jobActivity } : {}),
      ...(viewCtx.initialUrl ? { initialUrl: viewCtx.initialUrl } : {}),
      ...(auxChoice ? { imageChoice: auxChoice } : {}),
    },
  );
  ensureDesktopAuxPanel();
  ensureDesktopSettingsPanel({
    root,
    settings: desktopSettings,
    error: settingsError,
    onPersist: () => runPersistSettingsFromPanel(),
    onReset: () => runResetDesktopSettings(),
  });
  ensureDesktopHelpAbout();
  ensureDesktopExternalNav();
  ensureDesktopFooter();
}

initInitialUrl();
subscribeToDesktopEvents();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("hashchange", () => syncInitialUrlFromLocation());
}

if (root !== null) {
  update();
}

function getCurrentJobId(): string | null {
  return currentJobId;
}

function getSessionId(): string {
  return sessionId;
}

function getSeq(): number {
  return currentSeq;
}

function getPendingDecision(): PendingDecision | null {
  if (!pendingDecision) return null;
  return {
    ...pendingDecision,
    ...(pendingDecision.missingTiles ? { missingTiles: [...pendingDecision.missingTiles] } : {}),
  };
}

function getCatalogNotice(): CatalogNotice | null {
  return catalogNotice ? { ...catalogNotice } : null;
}

function getCompletedPartial(): boolean {
  return completedPartial;
}

function getCompletedMissing(): Array<string> {
  return [...completedMissing];
}

function getRemoteSeq(jobId: string): number {
  return remoteSeqByJob[jobId] ?? 0;
}

export {
  controller,
  integration,
  update,
  getCurrentJobId,
  getSessionId,
  getSeq,
  getPendingDecision,
  getCatalogNotice,
  getCompletedPartial,
  getCompletedMissing,
  getRemoteSeq,
  getEffectiveSettings,
  buildCopyDiagnostics,
  handleCopyDiagnostics,
  handleDesktopEvent,
  validateDeepLinkPayload,
  showDeepLinkConfirm,
  dismissDeepLinkConfirm,
};
