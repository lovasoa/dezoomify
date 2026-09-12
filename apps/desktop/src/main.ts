// Desktop entry: render the shared UI through the desktop integration.
// Routing and component composition stay shared; this file only wires the
// desktop host. Pixels stay native; only protocol progress and job events
// cross IPC, guarded by assertNoTileBytes and redactForEvent.
//
// Tauri commands used here: start_job, answer_choice, cancel_job,
// request_destination (via integration.requestSaveDestination), and
// query_capabilities (one boot handshake; see queryCapabilitiesAtBoot).
// Event channels subscribed here: dezoomify://job-state,
// dezoomify://job-progress, dezoomify://job-output, dezoomify://job-error,
// dezoomify://deep-link-pending.
//
// Controller mapping (TRANSITIONS in packages/shared-ui/src/controller.ts):
// discovering -> images-found -> image-chosen -> level-chosen ->
// preflight-ok -> progress -> save-start -> save-done -> completed, plus
// fail -> failed, cancel -> cancelled, reset -> idle. The display-only
// transition exists only in the shared controller for browser paths; the
// desktop frontend never dispatches preflight-display-only (no native
// emitter). Recovery-requested (destination/partial) events
// surface typed choices (retry / choose-output / keep-partial /
// discard-partial / handoff-to-native) wired to answer_choice (RetryReady /
// PartialKeep), request_destination, and requestHandoff.
import {
  HISTORY_KEY_DESKTOP,
  clearHistory as clearHistoryStore,
  createController,
  loadHistory as loadHistoryStore,
  pushHistory,
  renderView,
  openConfirmModal,
  saveHistory as saveHistoryStore,
  t,
  toHistoryEntry,
} from "@dezoomify/shared-ui";
import type { HistoryEntry, ViewContext } from "@dezoomify/shared-ui";
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
  DESKTOP_COMMANDS,
  NATIVE_FORMATS,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
} from "./desktopIntegration.ts";
import type { NativeFormat } from "./desktopIntegration.ts";
import { DESKTOP_EVENT_CHANNELS, assertNoTileBytes, redactForEvent } from "./events.ts";
import type { DesktopEventChannel } from "./events.ts";
import {
  cancelAllDesktop,
  cancelDesktopEntry,
  createDesktopQueue,
  enqueueDesktopQueue,
  finishActiveDesktopEntry,
  humanDesktopQueueSummary,
  recordDesktopProgress,
  retryDesktopEntry,
  summarizeDesktopQueue,
} from "./queue.ts";
import type { DesktopQueue } from "./queue.ts";
import {
  defaultOutputDirectory,
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

const root = typeof document !== "undefined" ? document.getElementById("root") : null;
const integration = createDesktopIntegration();

// Shared-view relative documentation links resolve against this published
// documentation origin. The desktop footer itself is static document markup.
const DESKTOP_DOCS_BASE = "https://dezoomify.ophir.dev";

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

// Sequential multi-job queue (todo 5.3): lives in the integration layer
// (this file plus ./queue.ts), never in the engine. One active native job at
// a time; further submits wait FIFO. Progress is tracked per job, one entry
// can be cancelled without touching the rest, cancel-all stops new work, and
// failed entries retry behind the line. A failed entry never stops the rest;
// totals mirror the CLI bulk contract. Only redacted origins enter the panel.
let desktopQueue: DesktopQueue = createDesktopQueue();
let activeQueueId: string | null = null;
function desktopQueueEnabled(): boolean {
  try {
    return integration.getCapabilities().bulkSupported === true;
  } catch {
    return true;
  }
}

// Recent-jobs history (todo 5.2): local-only ledger on this device, newest
// first, at most 20 entries. Only a redacted origin plus a path hash persists.
// Credentials never enter history.
const desktopMemoryFallback = new Map<string, string>();
const desktopHistoryStore = {
  getItem(key: string): string | null {
    try {
      const storage = (globalThis as Record<string, unknown>)["localStorage"] as
        | { getItem?: (key: string) => string | null }
        | undefined;
      if (storage && typeof storage.getItem === "function") {
        return storage.getItem(key);
      }
    } catch {
      // Storage unavailable; fall through to the memory fallback.
    }
    return desktopMemoryFallback.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    try {
      const storage = (globalThis as Record<string, unknown>)["localStorage"] as
        | { setItem?: (key: string, value: string) => void }
        | undefined;
      if (storage && typeof storage.setItem === "function") {
        storage.setItem(key, value);
        return;
      }
    } catch {
      // Storage unavailable; fall through to the memory fallback.
    }
    desktopMemoryFallback.set(key, value);
  },
  removeItem(key: string): void {
    try {
      const storage = (globalThis as Record<string, unknown>)["localStorage"] as
        | { removeItem?: (key: string) => void }
        | undefined;
      if (storage && typeof storage.removeItem === "function") {
        storage.removeItem(key);
      }
    } catch {
      // Removal must never throw.
    }
    desktopMemoryFallback.delete(key);
  },
};
let desktopHistory: Array<HistoryEntry> = loadHistoryStore(desktopHistoryStore, HISTORY_KEY_DESKTOP);

function recordDesktopHistory(url: string, width?: number, height?: number, format?: string): void {
  const entry = toHistoryEntry(
    url,
    {
      ...(typeof width === "number" ? { width } : {}),
      ...(typeof height === "number" ? { height } : {}),
      ...(typeof format === "string" ? { format } : {}),
      at: Date.now(),
    },
  );
  if (!entry) return;
  desktopHistory = pushHistory(desktopHistory, entry);
  saveHistoryStore(desktopHistoryStore, HISTORY_KEY_DESKTOP, desktopHistory);
}

// Native output formats (todo 4.4, todo 5.1): single source is
// NATIVE_FORMATS in desktopIntegration.ts matches the formats accepted by
// SUPPORTED_FORMATS in commands.rs and the tauri_shell.rs dialog filters.
// The selector below writes grantedFormat; requestOutputAndResume
// reads it so the Save and choose-output paths never hard-code a format.
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
// use describeSettingsForLog for any diagnostics. The persisted outputFormat
// (todo 5.1, first-class in settings.ts) seeds the encoder picker below so
// the chosen encoder survives reloads; download settings still travel via
// settingsToInvokeArgs only.
let desktopSettings: DesktopSettings = loadSettings();
grantedFormat = normalizeNativeFormat(desktopSettings.outputFormat);

function persistOutputFormat(format: NativeFormat): void {
  if (desktopSettings.outputFormat === format) return;
  desktopSettings = { ...desktopSettings, outputFormat: format };
  saveSettings(desktopSettings);
}
let settingsError: string | null = null;
let pendingDecision: PendingDecision | null = null;
let cancelPending = false;

// Catalog aux (todo 4.3): local-only completion geometry (WxH/K tiles) for
// the save-name suggestion and the aux choice summary, in the
// pendingDecision aux pattern, never a new protocol event. The native
// pipeline auto-saves images[0] at the largest fitting level and emits no
// imageCount, so no multi-image notice is rendered here; the shared job
// view's choiceCount notice stays for other apps. `docs/user/desktop-app.md`
// documents single-output saves only.
let catalogNotice: CatalogNotice | null = null;

// Accessibility (Task 5.2): dialog focus state. Each modal stores the element
// focused before it opened so focus returns on close. Recovery tracks its key
// so a new decision moves focus once without stealing it on every tick.
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
// The sibling basename names the `.partial` file actually written (never the
// granted path), so the UI can never claim a complete save for partial bytes.
let completedPartial = false;
let completedMissing: Array<string> = [];
let completedSibling: string | null = null;
let outputActionError: { action: "open" | "folder"; code: string } | undefined;

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

// Sibling basename for the honest partial note. Set alongside
// `completedPartial` on a partial-completed event; cleared on submit/reset.
function setCompletedSibling(name: string | null): void {
  completedSibling = name && name.length > 0 && name.length <= 256 ? name : null;
}

const settingsEnv: SettingsPanelEnv = {
  root,
  getSettings: () => desktopSettings,
  setSettings: (settings: DesktopSettings) => {
    desktopSettings = settings;
    grantedFormat = normalizeNativeFormat(settings.outputFormat);
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
  void applyPlatformOutputDefault();
}

// A null output folder represents only legacy/first-run settings. Upgrade it
// to the platform Downloads directory as soon as the native bridge is ready,
// so the compact Folder control always starts somewhere useful.
async function applyPlatformOutputDefault(): Promise<void> {
  if (desktopSettings.outputDir !== null) return;
  const outputDir = await defaultOutputDirectory();
  if (!outputDir || desktopSettings.outputDir !== null) return;
  desktopSettings = { ...desktopSettings, outputDir };
  saveSettings(desktopSettings);
  update();
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
    outputActionError,
  };
}

// --- Controller transitions ---


function clearJobViewState(): void {
  outputActionError = undefined;
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.jobActivity = undefined;
  viewCtx.imageChoice = undefined;
  pendingDecision = null;
  catalogNotice = null;
  completedPartial = false;
  completedMissing = [];
  completedSibling = null;
  // The encoder choice is a persisted preference (settings.ts outputFormat,
  // seeded into grantedFormat at boot): a new submit must not reset it to
  // png, or the reloaded choice would never reach the picker.
  stopHeartbeat();
}

function handleSubmitUrl(url: string): void {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidInputUrl(trimmed)) {
    // Validation failures use the same failed view as later job failures.
    // The shared controller intentionally has no idle -> failed edge, so
    // enter the submitted-job lifecycle before recording the failure.
    if (controller.getState().status === "idle") {
      controller.dispatch({
        seq: nextSeq(),
        sessionId,
        kind: "start-discovery",
        transport: NATIVE_TRANSPORT,
      });
    }
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
  if (desktopQueueEnabled() && !isTerminalStatus(controller.getState().status)) {
    // Busy: enqueue behind the active job instead of retiring it. The hash
    // equivalent here is the save dialog: only the active job ever asks for
    // a destination, queued entries never do.
    const res = enqueueDesktopQueue(desktopQueue, trimmed);
    desktopQueue = res.queue;
    if (res.code !== "ok" || !res.entry) {
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
    if (res.entry.status === "queued") {
      const position = desktopQueue.entries.filter((e) => e.status === "queued").length;
      pushLog(`Queued ${res.entry.origin || "the server"} (position ${position} in queue)`);
      update();
      return;
    }
    activeQueueId = res.entry.id;
  } else {
    // A submit after a terminal state starts a fresh job on the same session:
    // reset to idle first (completed/cancelled only accept reset; failed also
    // accepts start-discovery, and reset is valid there too). N-1 peers
    // without the queue always take this path: the new submit retires the
    // previous job id so its late events can never be mistaken for the new job.
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
    const res = enqueueDesktopQueue(desktopQueue, trimmed);
    desktopQueue = res.queue;
    activeQueueId = res.entry ? res.entry.id : null;
  }
  launchNativeJob(trimmed, ++submitToken);
}

function launchNativeJob(trimmed: string, token: number): void {
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
    settleActiveQueue("failed", { errorCode: "INVALID_SETTINGS" });
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
        if (cancelPending) {
          cancelPending = false;
          requestNativeCancellation(job, invoke);
        }
      }
      update();
    },
    (error: unknown) => {
      if (token !== submitToken) return;
      cancelPending = false;
      const message = error instanceof Error ? error.message : t("desktop.invoke.startFallback");
      dispatchFail(failEnv, "START_FAILED", message);
      settleActiveQueue("failed", { errorCode: "START_FAILED" });
    },
  );
}

// Settle the active queue entry at a terminal outcome and start the next
// queued job, if any. No-op when no queue entry is active (N-1 path or an
// already-settled job), so duplicate terminals stay exactly-once. A failed
// entry never stops the rest; totals mirror the CLI bulk contract.
function settleActiveQueue(
  outcome: "done" | "failed" | "cancelled",
  detail?: { outputHash?: string; errorCode?: string },
): void {
  if (!activeQueueId) return;
  const finished = finishActiveDesktopEntry(desktopQueue, outcome, detail);
  desktopQueue = finished.queue;
  trimDesktopQueue();
  const summary = summarizeDesktopQueue(desktopQueue);
  pushLog(`Queue: ${humanDesktopQueueSummary(summary)}`);
  activeQueueId = null;
  const next = finished.next;
  if (!next) {
    update();
    return;
  }
  // Fresh view for the next queued job on the same session.
  controller.reset();
  currentSeq = 0;
  currentJobId = null;
  retiredJobId = null;
  remoteSeqByJob = {};
  clearJobViewState();
  activeQueueId = next.id;
  pushLog(`Queue: starting next job for ${next.origin || "the server"}`);
  launchNativeJob(next.inputUrl, ++submitToken);
}

// Keep the panel bounded: at most 20 settled entries ride alongside live ones.
function trimDesktopQueue(): void {
  if (desktopQueue.entries.length <= 24) return;
  const settled = desktopQueue.entries.filter((e) => e.status !== "queued" && e.status !== "active");
  const drop = settled.length - 20;
  if (drop <= 0) return;
  const dropIds = new Set(settled.slice(0, drop).map((e) => e.id));
  desktopQueue = {
    entries: desktopQueue.entries.filter((e) => !dropIds.has(e.id)),
    activeId: desktopQueue.activeId,
    nextId: desktopQueue.nextId,
  };
}

function handleQueueCancelOne(id: string): void {
  if (id === activeQueueId) {
    handleCancel();
    return;
  }
  const res = cancelDesktopEntry(desktopQueue, id);
  if (res.code !== "ok") return;
  desktopQueue = res.queue;
  pushLog("Queue: entry cancelled");
  update();
}

function handleQueueCancelAll(): void {
  const hadActive = activeQueueId !== null;
  desktopQueue = cancelAllDesktop(desktopQueue);
  activeQueueId = null;
  if (hadActive) {
    // Cancel the running native job too; its terminal event finds no active
    // queue entry and settles nothing.
    handleCancel();
    return;
  }
  pushLog("Queue: all entries cancelled");
  update();
}

function handleQueueRetry(id: string): void {
  const res = retryDesktopEntry(desktopQueue, id);
  if (res.code !== "ok" || !res.entry) return;
  desktopQueue = res.queue;
  if (res.entry.status === "active") {
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
    activeQueueId = res.entry.id;
    pushLog(`Queue: retrying ${res.entry.origin || "the server"}`);
    launchNativeJob(res.entry.inputUrl, ++submitToken);
    return;
  }
  pushLog(`Queue: retry queued for ${res.entry.origin || "the server"}`);
  update();
}

function desktopQueueStatusLabel(status: string): string {
  if (status === "active") return t("desktop.queue.statusActive");
  if (status === "done") return t("desktop.queue.statusDone");
  if (status === "failed") return t("desktop.queue.statusFailed");
  if (status === "cancelled") return t("desktop.queue.statusCancelled");
  return t("desktop.queue.statusQueued");
}

// Multi-job queue panel (todo 5.3): one row per queued job with its redacted
// origin, status, and progress, plus cancel-one, cancel-all, and retry
// actions. Rendered only when the negotiated capabilities offer the queue and
// at least one entry exists. All actions are native buttons in the existing
// architectural style; only counts, hashes, codes, and redacted origins ever
// reach this panel, never full URLs, paths, or secrets.
function appendDesktopQueuePanel(aux: HTMLElement, doc: Document): void {
  if (!desktopQueueEnabled()) return;
  if (desktopQueue.entries.length === 0) return;
  const box = doc.createElement("div");
  box.className = "dz-queue-panel";
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", t("desktop.queue.title"));
  const title = doc.createElement("h2");
  title.className = "dz-notice-title";
  title.textContent = t("desktop.queue.title");
  box.appendChild(title);
  const summary = summarizeDesktopQueue(desktopQueue);
  const summaryLine = doc.createElement("p");
  summaryLine.className = "dz-notice-message";
  summaryLine.setAttribute("role", "status");
  summaryLine.setAttribute("aria-live", "polite");
  summaryLine.textContent = t("desktop.queue.summary", {
    succeeded: summary.succeeded,
    failed: summary.failed,
    total: summary.total,
  });
  box.appendChild(summaryLine);
  const list = doc.createElement("ul");
  list.className = "dz-queue-list";
  for (const entry of desktopQueue.entries) {
    const item = doc.createElement("li");
    item.className = "dz-queue-item";
    const label = doc.createElement("span");
    label.className = "dz-queue-label";
    let text = `${entry.origin || t("desktop.queue.unknownOrigin")} - ${desktopQueueStatusLabel(entry.status)}`;
    if (entry.status === "active" && entry.progress.total > 0) {
      text += ` - ${t("desktop.queue.progress", {
        current: entry.progress.acquired,
        total: entry.progress.total,
      })}`;
    }
    if (entry.status === "failed" && entry.errorCode) {
      text += ` - ${entry.errorCode}`;
    }
    label.textContent = text;
    item.appendChild(label);
    const row = doc.createElement("div");
    row.className = "dz-actions-row";
    const addBtn = (btnLabel: string, primary: boolean, onClick: () => void): void => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = primary ? "dz-btn-tactile" : "dz-btn-secondary";
      btn.textContent = btnLabel;
      btn.addEventListener("click", onClick);
      row.appendChild(btn);
    };
    if (entry.status === "queued" || entry.status === "active") {
      const id = entry.id;
      addBtn(t("desktop.queue.cancel"), false, () => handleQueueCancelOne(id));
    }
    if (entry.status === "failed" || entry.status === "cancelled") {
      const id = entry.id;
      addBtn(t("desktop.queue.retry"), true, () => handleQueueRetry(id));
    }
    if (row.childElementCount > 0) item.appendChild(row);
    list.appendChild(item);
  }
  box.appendChild(list);
  if (summary.pending > 0) {
    const allRow = doc.createElement("div");
    allRow.className = "dz-actions-row";
    const allBtn = doc.createElement("button");
    allBtn.type = "button";
    allBtn.className = "dz-btn-secondary";
    allBtn.textContent = t("desktop.queue.cancelAll");
    allBtn.addEventListener("click", () => handleQueueCancelAll());
    allRow.appendChild(allBtn);
    box.appendChild(allRow);
  }
  aux.appendChild(box);
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

function requestNativeCancellation(job: string, invoke: TauriInvokeFn): void {
  void invoke("cancel_job", { job }).then(
    () => {
      if (isTerminalStatus(controller.getState().status)) return;
      if (currentJobId !== job) return;
      pushLog("Cancellation requested; waiting for cleanup…");
      update();
    },
    (error: unknown) => {
      if (isTerminalStatus(controller.getState().status)) return;
      if (currentJobId !== job) return;
      const message = error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error && typeof error.message === "string"
            ? error.message
            : t("desktop.invoke.cancel");
      dispatchFail(
        failEnv,
        "CANCEL_FAILED",
        message,
        { phase: "cleanup", retryable: true },
      );
      update();
    },
  );
}

function handleCancel(): void {
  if (isTerminalStatus(controller.getState().status)) return;
  const job = currentJobId;
  const invoke = tauriInvoke();
  // Stop is immediate in the UI. The native host still receives cancellation
  // and performs cleanup, while its late events are retired below.
  if (job && invoke) void invoke("cancel_job", { job }).catch(() => undefined);
  handleReset();
  if (job) retiredJobId = job;
}

// Destination recovery grants a replacement output. On grant, walks the controller into saving;
// completion itself arrives via dezoomify://job-output (exactly-once
// terminal guard ignores any duplicate).
function requestOutputAndResume(): void {
  const job = currentJobId;
  if (!job || isTerminalStatus(controller.getState().status)) return;
  const format = normalizeNativeFormat(grantedFormat);
  const suggestedName = suggestedNameForFormat(
    format,
    catalogNotice?.width ?? viewCtx.imageChoice?.width ?? viewCtx.completedInfo?.width,
    catalogNotice?.height ?? viewCtx.imageChoice?.height ?? viewCtx.completedInfo?.height,
  );
  pushLog("Requesting save destination…");
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

async function handleOpenOutput(reveal: boolean): Promise<void> {
  const invoke = tauriInvoke();
  const job = currentJobId;
  if (!invoke || !job) return;
  outputActionError = undefined;
  root?.querySelector("#dz-open-error")?.remove();
  try {
    await invoke("open_saved_output", { job, reveal });
  } catch (error) {
    if (job !== currentJobId) return;
    const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
    const code = typeof rawCode === "string" && /^output\.[a-z-]+$/.test(rawCode)
      ? rawCode : "output.invoke-failed";
    outputActionError = { action: reveal ? "folder" : "open", code };
    pushLog(`File action ${outputActionError.action} failed (${code})`);
    const section = root?.querySelector(".dz-completed-section");
    if (!section) return;
    const note = section.ownerDocument.createElement("p");
    note.id = "dz-open-error";
    note.setAttribute("role", "alert");
    note.textContent = `${t(code === "output.not-found" ? "desktop.done.missingError" : reveal ? "desktop.done.folderError" : "desktop.done.openError")} (${code})`;
    section.appendChild(note);
  }
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

function handleReset(): void {
  outputActionError = undefined;
  cancelPending = false;
  submitToken += 1;
  sessionId = `sess:desktop-${Date.now()}`;
  controller.reset(sessionId);
  currentSeq = 0;
  currentJobId = null;
  retiredJobId = null;
  remoteSeqByJob = {};
  lastInputUrl = "";
  // Reset clears the whole queue: no new work is issued afterwards.
  desktopQueue = createDesktopQueue();
  activeQueueId = null;
  clearJobViewState();
  dismissDeepLinkConfirm(false);
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
  // Shared UI owns modal lifetime. Opening another modal supersedes this one.
  void restore;
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
  void openConfirmModal(document, {
    title: t("desktop.link.title"),
    subtitle: t("desktop.link.source", { url: info.sourceUrl }),
    bodyLines: [
      info.hint
        ? t("desktop.link.provHint", { version: info.version, hint: info.hint })
        : t("desktop.link.prov", { version: info.version }),
      t("desktop.link.note"),
    ],
    confirmLabel: t("desktop.link.open"),
    declineLabel: t("desktop.link.dismiss"),
  }).then((confirmed) => {
    if (confirmed) handleSubmitUrl(info.sourceUrl);
  });
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
      settleActiveQueue("failed", { errorCode: code });
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
    settleActiveQueue("failed", { errorCode: code });
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
    settleActiveQueue("cancelled");
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
    // Sibling basename for the honest partial note (never the granted path;
    // basenames contain no slashes, so a path can never slip through).
    const siblingRaw =
      strField(payload, ["sibling", "siblingName", "partialName", "fileName"]) ??
      (detailObj ? strField(detailObj, ["sibling", "siblingName", "partialName", "fileName"]) : undefined);
    const sibling =
      typeof siblingRaw === "string" &&
      siblingRaw.length > 0 &&
      siblingRaw.length <= 256 &&
      siblingRaw.indexOf("/") < 0 &&
      siblingRaw.indexOf("\\") < 0
        ? siblingRaw
        : null;
    setCompletedSibling(isPartial ? sibling : null);
    if (outputHash) {
      const short = outputHash.slice(0, 24);
      pushLog(isPartial ? `Partial output ready (${short}…)` : `Output ready (${short}…)`);
    }
    if (isPartial && sibling) {
      pushLog(`Partial file: ${sibling}`);
    }
    completeJob(jobEnv,
      typeof width === "number" && typeof height === "number" && width > 0 && height > 0
        ? { width, height, mime }
        : undefined,
      isPartial,
      missing,
    );
    if (lastInputUrl !== "") {
      recordDesktopHistory(
        lastInputUrl,
        typeof width === "number" ? width : undefined,
        typeof height === "number" ? height : undefined,
        grantedFormat,
      );
    }
    settleActiveQueue("done", outputHash ? { outputHash } : undefined);
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
    // Adopt the granted format only when the payload names a real format
    // id. Lifecycle texts also match this branch ("AwaitingDestination"),
    // and normalizeNativeFormat falls back to png for anything unknown, so
    // adopting blindly would clobber the persisted encoder choice with png
    // on every job before the picker is even shown.
    const format = strField(payload, ["format"]) ?? detailRaw;
    if (format) {
      const lower = format.toLowerCase();
      if ((NATIVE_FORMATS as readonly string[]).includes(lower)) {
        grantedFormat = lower as NativeFormat;
      }
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

  // No catalog / image-selection branch: the native pipeline never emits
  // one. The driver folds the catalog internally (job_driver.rs
  // handle_event "catalog" only fills the attempt; PipelineEvent kinds are
  // discovery/downloading/encoding), jobs.rs projects no imageCount (the
  // progress allowlist is acquired/total/resources/bytes/files), and the
  // shell selects images[0] at the largest fitting level by default. The
  // shared view's choiceCount notice stays for other apps (website
  // discovery sets imageCount); desktop walks choosing-image transiently
  // via preflightThrough with no count, so the notice never renders here.

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

  // No display-only branch: only the browser tainted-canvas path produces
  // it (ordinary <img> display with no readable bytes). The native pipeline
  // always yields readable bytes or a typed failure, so no native event
  // carries display-only/display_only; the shared view's display-only
  // section stays for other apps. The progress flow's "no display-only
  // branch on the native path" window assertion pins this.

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
    const reportedTotal = numField(payload, detailRaw, ["total"]) ?? 0;
    const total = Math.max(viewCtx.currentProgress?.total ?? 0, reportedTotal);
    const current = Math.max(viewCtx.currentProgress?.current ?? 0,
      reportedTotal > 0 ? numField(payload, detailRaw, ["current", "acquired", "completed", "done"]) ?? 0 : 0);
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
    if (activeQueueId) {
      const res = recordDesktopProgress(desktopQueue, activeQueueId, current, total);
      desktopQueue = res.queue;
    }
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

// Boot handshake: invoke the granted `query_capabilities` command once at
// startup so the `dezoomify:allow-query-capabilities` grant always maps to
// shipped code. Local IPC only, so it works offline; without a Tauri host
// (unit tests, validation-only fallback) it skips silently. A denied invoke
// or a protocol/registry mismatch only records a typed log line: the
// controller has no `fail` transition from idle, so a mismatch surfaces its
// stable code without bricking the app, and offline use is never blocked.
function queryCapabilitiesAtBoot(): void {
  const invoke = tauriInvoke();
  if (!invoke) return;
  void invoke("query_capabilities").then(
    (raw) => {
      const snapshot = (raw ?? {}) as {
        protocol_min?: unknown;
        protocol_max?: unknown;
        commands?: unknown;
      };
      const commands = Array.isArray(snapshot.commands)
        ? snapshot.commands.map((name) => String(name)).sort()
        : [];
      const expected = DESKTOP_COMMANDS.map((name) => String(name)).sort();
      const mismatch =
        snapshot.protocol_min !== PROTOCOL_MIN ||
        snapshot.protocol_max !== PROTOCOL_MAX ||
        commands.length !== expected.length ||
        commands.some((name, index) => name !== expected[index]);
      if (mismatch) {
        pushLog("Capability handshake mismatch (capability.mismatch)");
      }
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : "query_capabilities denied";
      pushLog(`Capability handshake failed: ${detail} (capability.unavailable)`);
    },
  );
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

// Output format selector (todo 4.4, todo 5.1): native format radios bound to
// grantedFormat. Flat flow
// inside the aux panel, native inputs so Tab and screen readers work; the
// crisp 2px focus ring comes from desktop.css. Changing a radio updates
// grantedFormat and persists it via persistOutputFormat (settings.ts
// outputFormat) so the choice survives reloads; requestOutputAndResume
// reads grantedFormat when building { format, suggestedName } for
// requestSaveDestination.
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
  const showPartialDone = state.status === "completed" && completedPartial;
  const showCancelledNote = state.status === "cancelled";
  if (!decision && !showPartialDone && !showCancelledNote) {
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
  if (decision && decision.kind !== "partial-recovery") appendOutputFormatRadios(aux, doc);

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
      addButton(t("desktop.rec.chooseOutput"), true, () => requestOutputAndResume());
      addButton(t("desktop.rec.tryAgain"), false, () => handleRecoveryRetry());
    } else {
      title.textContent = t("desktop.rec.chooseTitle");
      desc.textContent = t("desktop.rec.chooseDesc");
      decisionBox.append(title, desc, row);
      addButton(t("desktop.rec.chooseOutput"), true, () => requestOutputAndResume());
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
    // Honest sibling basename (never the granted path) rides the existing
    // translated sentence as a literal: no new copy, no shared-ui change.
    const summaryWithFile = completedSibling ? `${summary} File: ${completedSibling}.` : summary;
    desc.textContent = t("desktop.done.partialDesc", { summary: summaryWithFile });
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

  if (state.status !== "completed" && desktopQueue.entries.length > 1) appendDesktopQueuePanel(aux, doc);

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
      onCopyDiagnostics(text: string) {
        handleCopyDiagnostics(() => `${text}\n\n${buildCopyDiagnostics(diagnosticsSnapshot())}`);
      },
      onReset() {
        handleReset();
      },
      ...(state.status === "completed" ? {
        onOpenOutput: () => { void handleOpenOutput(false); },
        onRevealOutput: () => { void handleOpenOutput(true); },
      } : {}),
      onHistorySelect(entry: HistoryEntry) {
        viewCtx.initialUrl = entry.url;
        const input = root.querySelector<HTMLInputElement>("#dz-url-input");
        if (input) input.value = entry.url;
        update();
        root.querySelector<HTMLInputElement>("#dz-url-input")?.focus();
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
      onClearHistory() {
        desktopHistory = [];
        clearHistoryStore(desktopHistoryStore, HISTORY_KEY_DESKTOP);
        update();
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
      ...(state.status === "completed" ? { nativeSaved: { partial: completedPartial } } : {}),
      ...(viewCtx.jobActivity ? { jobActivity: viewCtx.jobActivity } : {}),
      ...(viewCtx.initialUrl ? { initialUrl: viewCtx.initialUrl } : {}),
      ...(auxChoice ? { imageChoice: auxChoice } : {}),
      history: [...desktopHistory],
    },
  );
  ensureDesktopAuxPanel();
  if (state.status === "idle") ensureDesktopSettingsPanel({
    root,
    settings: desktopSettings,
    error: settingsError,
    onPersist: () => runPersistSettingsFromPanel(),
    onReset: () => runResetDesktopSettings(),
  });
  else root.ownerDocument.getElementById("dz-desktop-settings")?.remove();
  ensureDesktopExternalNav();
  ensureDesktopFooter();
}

initInitialUrl();
subscribeToDesktopEvents();
queryCapabilitiesAtBoot();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("hashchange", () => syncInitialUrlFromLocation());
}

if (root !== null) {
  update();
  void applyPlatformOutputDefault();
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

function getCompletedSibling(): string | null {
  return completedSibling;
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
  getCompletedSibling,
  getRemoteSeq,
  getEffectiveSettings,
  buildCopyDiagnostics,
  handleCopyDiagnostics,
  handleDesktopEvent,
  validateDeepLinkPayload,
  showDeepLinkConfirm,
  dismissDeepLinkConfirm,
};
