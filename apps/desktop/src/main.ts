// Desktop entry: render the shared UI through the desktop integration.
// Routing and component composition stay shared; this file only wires the
// desktop host. Pixels stay native; only protocol progress and job events
// cross IPC, projected by the typed job service.
//
// The typed job service (apps/desktop/src/jobService.ts) owns the job
// lifecycle over the public Tauri API: start_job, answer_choice, cancel_job,
// pause_job, resume_job, request_destination, open_saved_output, and
// query_capabilities. It subscribes to the single dezoomify://job-snapshot
// channel, forwards each canonical EngineSnapshotDto verbatim, and publishes
// authoritative JobSnapshots;
// this file renders them through presentSnapshot and keeps only product
// wiring: queue, history, settings, recovery actions, deep links, and the
// auxiliary panel. No synthetic controller walk exists: the presentation is
// derived from the latest snapshot, and host-local failures (invalid input,
// rejected starts) render through presentFailure.
//
// Recovery decisions read the snapshot decision: AwaitingPartialDecision
// carries generation plus missing tiles (partial keep/discard/retry wired
// to answer_choice with generation+choice).
import {
  HISTORY_KEY_DESKTOP,
  cancelAllQueueEntries,
  cancelQueueEntry,
  finishActiveQueueEntry,
  humanQueueSummary,
  clearHistory as clearHistoryStore,
  loadHistory as loadHistoryStore,
  pushHistory,
  saveHistory as saveHistoryStore,
  suggestedNameFor,
  summarizeQueue,
  toHistoryEntry,
  type HistoryEntry,
  type JobObserver,
  type JobSnapshot,
  type JobStartRequest,
} from "@dezoomify/app-model";
import {
  describeFailure,
  openConfirmModal,
  presentFailure,
  presentIdle,
  presentSnapshot,
  renderView,
  t,
  type SnapshotPresentation,
  type StructuredError,
} from "@dezoomify/shared-ui";
import type { ViewContext } from "@dezoomify/shared-ui";
import { createLogger } from "@dezoomify/browser-runtime";
import {
  encoderToMime,
  formatMissingSummary,
  hostOf,
  isValidInputUrl,
  readInitialUrl,
  redactedOriginOnly,
  trimTechnical,
  validateDeepLinkPayload,
} from "./errorCopy.ts";
import type { ValidatedDeepLink } from "./errorCopy.ts";
import {
  buildCopyDiagnostics,
  handleCopyDiagnostics,
} from "./diagnostics.ts";
import {
  getEffectiveSettings,
  resetDesktopSettings,
} from "./settingsPanel.ts";
import { DesktopSettingsView } from "./settingsView.tsx";
import { createElement } from "react";
import {
  createDesktopIntegration,
  NATIVE_FORMATS,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
} from "./desktopIntegration.ts";
import type { NativeFormat } from "./desktopIntegration.ts";
import { createDesktopJobService } from "./jobService.ts";
import type { DesktopJobHandle } from "./jobService.ts";
import {
  createDesktopQueue,
  enqueueDesktopQueue,
  recordDesktopProgress,
  retryDesktopEntry,
} from "./queue.ts";
import type { DesktopQueue } from "./queue.ts";
import {
  defaultOutputDirectory,
  describeSettingsForLog,
  loadSettings,
  saveSettings,
  settingsToInvokeArgs,
} from "./settings.ts";
import type { DesktopSettings } from "./settings.ts";

const root = typeof document !== "undefined" ? document.getElementById("root") : null;
const integration = createDesktopIntegration();

// Shared-view relative documentation links resolve against this published
// documentation origin. The desktop footer itself is static document markup.
const DESKTOP_DOCS_BASE = "https://dezoomify.ophir.dev";

// Transport reported for every desktop job. Pixels stay native, so the badge
// never claims a browser transport. The "native" code renders via shared-ui
// renderTransportLabel (canonical NATIVE label).
const NATIVE_TRANSPORT = "native";

// Per-request timeout shown in the job view (native parity: 30 s request,
// 6 s connect; the view renders the single per-request figure).
const REQUEST_TIMEOUT_MS = 30000;

// Capped technical log (oldest dropped first), web parity.
const MAX_LOG_LINES = 60;

// The typed job service: one service, many window-owned jobs. Deep-link
// confirmations stay in the product shell; settings ride every start_job.
const service = createDesktopJobService({
  settings: () => settingsToInvokeArgs(desktopSettings),
  onDeepLink: (payload) => {
    const validated = validateDeepLinkPayload(payload);
    if (validated) showDeepLinkConfirm(validated);
  },
});

// The job this window currently follows. Snapshots arrive verbatim from
// the typed service and render directly; no follow guard or partial field
// mirrors live here. Product wiring only: the active handle plus the
// sequential queue and the local history ledger below.
let activeHandle: DesktopJobHandle | null = null;
// Authoritative snapshot of the active job; null before any start. Set
// verbatim from the observer with no fold and no follow check: late
// snapshots for retired jobs never arrive (their observer was disposed).
let currentSnapshot: JobSnapshot | null = null;
// Host-local failure that never reached an engine snapshot (invalid input,
// rejected start, denied dialog). Renders through presentFailure.
let localFailure: StructuredError | null = null;
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
// grantedFormat seeds the submit suggestedName and the completed-view mime;
// the persisted settings output_format owns the choice across reloads.
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

// Minimal settings (task 3.5): persisted locally, validated with fail-closed
// bounds, and sent on the next start_job. Header values never enter logs;
// use describeSettingsForLog for any diagnostics. The persisted output_format
// (todo 5.1, first-class in settings.ts) seeds grantedFormat at boot so
// the chosen encoder survives reloads; download settings still travel via
// settingsToInvokeArgs only.
let desktopSettings: DesktopSettings = loadSettings();
grantedFormat = normalizeNativeFormat(desktopSettings.output_format);

let settingsError: string | null = null;

// Outstanding recovery decision, derived from the snapshot decision.
// AwaitingPartialDecision carries generation plus missing tile ordinals;
// the keep/discard/retry answers ride answer_choice with generation+choice.
interface PendingDecision {
  missingTiles: Array<number>;
  failedCount: number;
  totalCount?: number;
  generation: number;
}

function pendingDecisionOf(): PendingDecision | null {
  if (localFailure) return null;
  const snapshot = currentSnapshot;
  if (!snapshot || snapshot.terminal || snapshot.lifecycle !== "AwaitingPartialDecision") return null;
  const decision = snapshot.decision;
  if (!decision) return null;
  const missingTiles = decision.missing.map((entry) => entry.tile);
  return {
    missingTiles,
    failedCount: missingTiles.length,
    ...(typeof snapshot.progress.total === "number" ? { totalCount: snapshot.progress.total } : {}),
    generation: decision.generation,
  };
}

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
  const missing = decision.missingTiles.join(",");
  return `${decision.generation}:${missing}:${decision.failedCount}:${decision.totalCount ?? ""}`;
}

// Marked partial completion: a kept partial output stays distinguishable
// from a complete save. Read from the snapshot output account (missing tile
// ordinals), so the UI can never claim a complete save for partial bytes.
let outputActionError: { action: "open" | "folder"; code: string } | undefined;

// Live heartbeat for the loading view: advances now and longestPendingMs
// so the pending box and smooth track stay current between IPC snapshots.
// The desktop shell reports snapshots (progress.completed/total), not
// per-request start/end, so the longest wait derives from last progress.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function isTerminalNow(): boolean {
  return localFailure !== null || (currentSnapshot?.terminal ?? null) !== null;
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
      if (isTerminalNow()) {
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

function pushLog(line: string): void {
  appLog.info(undefined, line);
}

/** Append an accepted log line to the job view's technical-details buffer. */
function appendActivityLog(line: string): void {
  const a = activity();
  if (!a.log) a.log = [];
  const elapsed = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
  a.log.push(`${elapsed}s: ${line}`);
  if (a.log.length > MAX_LOG_LINES) a.log.splice(0, a.log.length - MAX_LOG_LINES);
  a.now = Date.now();
}

// The shared logger owns formatting and level gating; the desktop sink feeds
// the job view's log, so failed jobs show the same trace in technical details.
const appLog = createLogger("app", { defaultContext: "app", sink: (entry) => appendActivityLog(entry.line) });

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

// Host-local failure presentation: the same layered presenter the other
// products use, rendered through presentFailure. Clears the recovery
// decision (derived state) by construction and settles the queue unless the
// caller opts out (validation failures never created a queue entry).
function failLocally(
  code: string,
  message: string,
  opts?: {
    phase?: string;
    retryable?: boolean;
    detail?: string;
    transport?: string;
    settle?: boolean;
  },
): void {
  const sourceUrl = lastInputUrl || activity().url || "";
  localFailure = describeFailure({
    code,
    engineDetail: trimTechnical(message || ""),
    extraDetail: opts?.detail && opts.detail !== message ? trimTechnical(opts.detail) : undefined,
    retryable: opts?.retryable,
    transport: opts?.transport ?? NATIVE_TRANSPORT,
    phase: opts?.phase,
    url: sourceUrl || undefined,
    host: hostOf(sourceUrl),
    extras: [
      `Status: ${currentSnapshot?.lifecycle ?? "idle"}`,
      `Origin: ${redactedOriginOnly(sourceUrl) === "" ? "n/a" : redactedOriginOnly(sourceUrl)}`,
    ],
  });
  pushLog(`Failed (${code}): ${trimTechnical(message, 160)}`);
  stopHeartbeat();
  if (opts?.settle !== false) settleActiveQueue("failed", { errorCode: code });
  update();
}

function invokeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback;
}

function runPersistSettingsFromPanel(): void {
  const errors = saveSettings(desktopSettings);
  settingsError = errors.length ? errors.join("; ") : null;
  if (!settingsError) pushLog(`Settings saved: ${describeSettingsForLog(desktopSettings)}`);
  update();
}

function runResetDesktopSettings(): void {
  desktopSettings = resetDesktopSettings();
  grantedFormat = normalizeNativeFormat(desktopSettings.output_format);
  settingsError = null;
  pushLog("Settings reset to defaults");
  update();
  void applyPlatformOutputDefault();
}

// A null output folder represents only legacy/first-run settings. Upgrade it
// to the platform Downloads directory as soon as the native bridge is ready,
// so the compact Folder control always starts somewhere useful.
async function applyPlatformOutputDefault(): Promise<void> {
  if (desktopSettings.output_dir !== null) return;
  const output_dir = await defaultOutputDirectory();
  if (!output_dir || desktopSettings.output_dir !== null) return;
  desktopSettings = { ...desktopSettings, output_dir };
  saveSettings(desktopSettings);
  update();
}

function diagnosticsSnapshot() {
  const presentation = currentPresentation();
  return {
    status: presentation.stateLabel ?? presentation.phase,
    transport: presentation.transport,
    jobId: activeHandle?.id ?? null,
    attempt: undefined,
    sessionId: NATIVE_TRANSPORT,
    nativeTransport: NATIVE_TRANSPORT,
    progress:
      currentSnapshot && (currentSnapshot.progress.total !== undefined || currentSnapshot.progress.completed > 0)
        ? { current: currentSnapshot.progress.completed, total: currentSnapshot.progress.total ?? 0 }
        : undefined,
    origin: redactedOriginOnly(lastInputUrl),
    outputActionError,
  };
}

// --- Presentation (single source: latest snapshot or host-local failure) ---

function failurePresentationOf(snapshot: JobSnapshot): SnapshotPresentation | null {
  const terminal = snapshot.terminal;
  if (!terminal || terminal.type !== "failed") return null;
  const dto = terminal.error;
  const sourceUrl = lastInputUrl || activity().url || "";
  const error = describeFailure({
    code: dto.code,
    engineDetail: dto.detail ?? dto.message,
    retryable: dto.retryable,
    message: dto.message,
    phase: dto.phase,
    transport: dto.transport ?? NATIVE_TRANSPORT,
    url: dto.request,
    host: hostOf(sourceUrl),
    ...(typeof dto.http === "number" ? { http: dto.http } : {}),
    ...(dto.preview ? { preview: dto.preview } : {}),
    ...(dto.resource_kind ? { extras: [`Resource: ${dto.resource_kind}`] } : {}),
  });
  return presentFailure(error, NATIVE_TRANSPORT);
}

function currentPresentation(): SnapshotPresentation {
  if (localFailure) return presentFailure(localFailure, NATIVE_TRANSPORT);
  if (!currentSnapshot) return presentIdle();
  return failurePresentationOf(currentSnapshot) ?? presentSnapshot(currentSnapshot, NATIVE_TRANSPORT);
}

function clearJobViewState(): void {
  outputActionError = undefined;
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.jobActivity = undefined;
  // The encoder choice is a persisted preference (settings.ts output_format,
  // seeded into grantedFormat at boot): a new submit must not reset it to
  // png, or the reloaded choice would never reach the picker.
  stopHeartbeat();
}

function handleSubmitUrl(url: string): void {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidInputUrl(trimmed)) {
    // Validation failures use the same failed view as later job failures;
    // no queue entry exists yet, so nothing settles.
    failLocally("INVALID_URL", t("desktop.url.invalid"), { settle: false });
    return;
  }
  if (desktopQueueEnabled() && !isTerminalNow()) {
    // Busy: enqueue behind the active job instead of retiring it. Queued
    // entries never start work until promoted to active.
    const res = enqueueDesktopQueue(desktopQueue, trimmed);
    desktopQueue = res.queue;
    if (res.code !== "ok" || !res.entry) {
      failLocally("INVALID_URL", t("desktop.url.invalid"), { settle: false });
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
    // A submit after a terminal state starts a fresh job; a submit while a
    // non-queue peer still runs retires it (its late snapshots are dropped
    // at the service boundary via dispose).
    retireActiveJob();
    const res = enqueueDesktopQueue(desktopQueue, trimmed);
    desktopQueue = res.queue;
    activeQueueId = res.entry ? res.entry.id : null;
  }
  launchNativeJob(trimmed, ++submitToken);
}

/** Stop following the current job; its late events can never move the view. */
function retireActiveJob(): void {
  const handle = activeHandle;
  activeHandle = null;
  currentSnapshot = null;
  localFailure = null;
  clearJobViewState();
  if (handle) void handle.dispose().catch(() => undefined);
}

function launchNativeJob(trimmed: string, token: number): void {
  lastInputUrl = trimmed;
  resetActivity(trimmed);
  pushLog(`Starting job for ${redactedOriginOnly(trimmed) || "the server"}`);
  // Minimal settings are validated fail-closed here: invalid settings fail
  // the submit before any start_job effect. The redacted summary never
  // includes header values.
  const effective = getEffectiveSettings(desktopSettings);
  if (!effective.ok || !effective.settings) {
    const detail = effective.errors.join("; ") || "Invalid settings.";
    settingsError = detail;
    pushLog("Settings invalid; job not started");
    failLocally("INVALID_SETTINGS", t("desktop.settings.invalidSubmit"), { detail });
    return;
  }
  settingsError = null;
  desktopSettings = effective.settings;
  pushLog(`Settings: ${describeSettingsForLog(desktopSettings)}`);
  update();
  const format = normalizeNativeFormat(grantedFormat);
  const request: JobStartRequest = {
    inputs: [{ url: trimmed }],
    engine: {},
    exec: {
      kind: "native",
      destination: {
        kind: "file",
        suggestedName: suggestedNameFor(undefined, undefined, format),
        format,
      },
    },
  };
  // An unreachable host rejects into the typed start-failed path below.
  void service.start(request, jobObserver).then(
    (handle) => {
      if (token !== submitToken) {
        void handle.dispose().catch(() => undefined);
        return;
      }
      activeHandle = handle;
      update();
    },
    (error: unknown) => {
      if (token !== submitToken) return;
      failLocally("START_FAILED", invokeErrorMessage(error, t("desktop.invoke.startFallback")));
    },
  );
}

// Authoritative snapshots from the typed service. The payload is already
// the `JobSnapshot`: it renders verbatim with no fold and no follow guard.
// Side effects (logs, queue progress, history, settling) key off snapshot
// transitions; the view itself renders the presentation derived in update().
const jobObserver: JobObserver = {
  snapshot(snapshot: JobSnapshot): void {
    currentSnapshot = snapshot;
    onSnapshotSideEffects(snapshot);
    update();
  },
  hostStatus(): void {
    // The desktop transport is native and fixed; nothing to present.
  },
};

function onSnapshotSideEffects(snapshot: JobSnapshot): void {
  if (snapshot.terminal) {
    stopHeartbeat();
    const terminal = snapshot.terminal;
    if (terminal.type === "completed" || terminal.type === "partial-completed") {
      const output = snapshot.output;
      pushLog(terminal.type === "partial-completed" ? "Partial output ready" : "Output ready");
      if (output?.format) {
        grantedFormat = normalizeNativeFormat(output.format);
      }
      if (lastInputUrl !== "") {
        recordDesktopHistory(
          lastInputUrl,
          output?.canvas?.width,
          output?.canvas?.height,
          grantedFormat,
        );
      }
      settleActiveQueue("done");
    } else if (terminal.type === "failed") {
      const code = terminal.error.code;
      pushLog(`Failed (${code})`);
      settleActiveQueue("failed", { errorCode: code });
    } else {
      pushLog("Cancelled; unfinished file removed");
      settleActiveQueue("cancelled");
    }
    return;
  }
  touchProgress();
  const total = snapshot.progress.total;
  if (typeof total === "number" && total > 0) {
    noteProgress(snapshot.progress.completed, total);
    if (activeQueueId) {
      const res = recordDesktopProgress(desktopQueue, activeQueueId, snapshot.progress.completed, total);
      desktopQueue = res.queue;
    }
  }
  if (snapshot.lifecycle === "AwaitingPartialDecision" && snapshot.decision) {
    const missing = snapshot.decision.missing.map((entry) => entry.tile);
    const summary = formatMissingSummary(missing.map(String), missing.length);
    pushLog(`Recovery requested: partial (${summary} keep-partial / discard-partial / retry)`);
    const a = activity();
    a.failedRequests = missing.length;
    a.now = Date.now();
  }
}

// Settle the active queue entry at a terminal outcome and start the next
// queued job, if any. No-op when no queue entry is active (N-1 path or an
// already-settled job), so duplicate terminals stay exactly-once. A failed
// entry never stops the rest; totals mirror the CLI bulk contract.
function settleActiveQueue(
  outcome: "done" | "failed" | "cancelled",
  detail?: { errorCode?: string },
): void {
  if (!activeQueueId) return;
  const finished = finishActiveQueueEntry(desktopQueue, outcome, detail?.errorCode);
  desktopQueue = finished.queue;
  trimDesktopQueue();
  const summary = summarizeQueue(desktopQueue);
  pushLog(`Queue: ${humanQueueSummary(summary)}`);
  activeQueueId = null;
  const next = finished.next;
  if (!next) {
    update();
    return;
  }
  // Fresh view for the next queued job.
  retireActiveJob();
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
    idPrefix: desktopQueue.idPrefix,
  };
}

function handleQueueCancelOne(id: string): void {
  if (id === activeQueueId) {
    handleCancel();
    return;
  }
  const res = cancelQueueEntry(desktopQueue, id);
  if (res.code !== "ok") return;
  desktopQueue = res.queue;
  pushLog("Queue: entry cancelled");
  update();
}

function handleQueueCancelAll(): void {
  const hadActive = activeQueueId !== null;
  desktopQueue = cancelAllQueueEntries(desktopQueue);
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
    retireActiveJob();
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
  const summary = summarizeQueue(desktopQueue);
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

function handleSelectImage(index: number): void {
  if (isTerminalNow()) return;
  pushLog(`Chose image ${index}`);
  const handle = activeHandle;
  if (!handle) return;
  void handle.command({ type: "select-image", image: index }).then(
    () => update(),
    (error: unknown) => {
      failLocally("CHOICE_FAILED", invokeErrorMessage(error, t("desktop.invoke.choiceImage")));
    },
  );
}

function handleSelectLevel(level: number): void {
  if (isTerminalNow()) return;
  pushLog(`Chose level ${level}`);
  const handle = activeHandle;
  if (!handle) return;
  void handle.command({ type: "select-level", level }).then(
    () => update(),
    (error: unknown) => {
      failLocally("CHOICE_FAILED", invokeErrorMessage(error, t("desktop.invoke.choiceLevel")));
    },
  );
}

function handleCancel(): void {
  if (isTerminalNow()) return;
  const handle = activeHandle;
  // Stop is immediate in the UI. The native host still receives cancellation
  // and performs cleanup, while its late events are retired below.
  if (handle) void handle.command({ type: "cancel" }).catch(() => undefined);
  handleReset();
}

function handlePause(): void {
  if (isTerminalNow()) return;
  const handle = activeHandle;
  if (!handle) return;
  pushLog("Pause requested");
  void handle.command({ type: "pause" }).then(
    () => update(),
    (error: unknown) => {
      failLocally("PAUSE_FAILED", invokeErrorMessage(error, "The pause request was rejected."));
    },
  );
}

function handleResume(): void {
  if (isTerminalNow()) return;
  const handle = activeHandle;
  if (!handle) return;
  pushLog("Resume requested");
  void handle.command({ type: "resume" }).then(
    () => {
      touchProgress();
      update();
    },
    (error: unknown) => {
      failLocally("RESUME_FAILED", invokeErrorMessage(error, "The resume request was rejected."));
    },
  );
}

async function handleOpenOutput(reveal: boolean): Promise<void> {
  const handle = activeHandle;
  if (!handle) return;
  outputActionError = undefined;
  root?.querySelector("#dz-open-error")?.remove();
  try {
    await handle.openOutput(reveal);
  } catch (error) {
    if (handle !== activeHandle) return;
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

// Recovery: retry the outstanding partial decision (retry failed tiles).
// Wired to the typed shell `Choice::Partial` via answer_choice with
// generation+choice.
function handleRecoveryRetry(): void {
  const decision = pendingDecisionOf();
  const handle = activeHandle;
  if (!decision || !handle || isTerminalNow()) return;
  pushLog("Retry requested (partial)");
  void handle.command({ type: "answer-partial", generation: decision.generation, decision: "retry" }).then(
    () => {
      touchProgress();
      update();
    },
    (error: unknown) => {
      failLocally("CHOICE_FAILED", invokeErrorMessage(error, t("desktop.invoke.retry")));
    },
  );
}

// Recovery: keep or discard a partial result. Wired to the typed shell
// `Choice::Partial` via answer_choice. The terminal outcome
// (partial-completed / failed) arrives as the next snapshot; nothing is
// rendered locally so the terminal stays exactly-once.
function handlePartialChoice(keep: boolean): void {
  const decision = pendingDecisionOf();
  const handle = activeHandle;
  if (!decision || !handle) return;
  if (isTerminalNow()) return;
  pushLog(keep ? "Keeping partial image…" : "Discarding partial image…");
  void handle.command({ type: "answer-partial", generation: decision.generation, decision: keep ? "keep" : "discard" }).then(
    () => {
      touchProgress();
      update();
    },
    (error: unknown) => {
      failLocally("CHOICE_FAILED", invokeErrorMessage(error, t("desktop.invoke.partial")));
    },
  );
}

function handleReset(): void {
  submitToken += 1;
  retireActiveJob();
  // Reset clears the whole queue: no new work is issued afterwards.
  desktopQueue = createDesktopQueue();
  activeQueueId = null;
  dismissDeepLinkConfirm(false);
  recoveryReturnFocus = null;
  lastRecoveryKey = null;
  // Idle prefill survives reset: a launch URL stays available for the next
  // empty form without ever starting a job on its own.
  const prefilled = readInitialUrl();
  if (prefilled) viewCtx.initialUrl = prefilled;
  else viewCtx.initialUrl = undefined;
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
    id: "dz-deep-link-confirm",
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

// Boot handshake: invoke the granted `query_capabilities` command once at
// startup so the `dezoomify:allow-query-capabilities` grant always maps to
// shipped code. Local IPC only, so it works offline; an unreachable host or
// a protocol/registry mismatch only records a typed log line: the idle view
// stays usable, and offline use is never blocked.
function queryCapabilitiesAtBoot(): void {
  void service.queryCapabilities().then(
    (caps) => {
      const commands = [...caps.commands].sort();
      const expected = ["answer_choice", "cancel_job", "open_saved_output", "pause_job", "query_capabilities", "request_destination", "resume_job", "start_job"];
      const mismatch =
        caps.protocolMin !== PROTOCOL_MIN ||
        caps.protocolMax !== PROTOCOL_MAX ||
        commands.length !== expected.length ||
        commands.some((name, index) => name !== expected[index]);
      if (mismatch) {
        pushLog("Capability handshake mismatch (capability.mismatch)");
      }
    },
    (error: unknown) => {
      const detail = invokeErrorMessage(error, "query_capabilities denied");
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
  if (currentSnapshot !== null || localFailure !== null) return;
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
  const presentation = currentPresentation();
  const doc = root.ownerDocument;
  const decision = pendingDecisionOf();
  const decisionKey = recoveryKeyFor(decision);
  const prevKey = lastRecoveryKey;
  const existing = doc.getElementById("dz-desktop-aux");
  const focusedInside = existing && existing.contains(doc.activeElement)
    ? (doc.activeElement as HTMLElement)
    : null;
  const focusedLabel = focusedInside && focusedInside instanceof HTMLButtonElement
    ? focusedInside.textContent
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
  const showPartialDone = presentation.phase === "completed" && presentation.partial;
  const showCancelledNote = presentation.phase === "cancelled";
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

    // The only pending decision is the partial one: keep, discard, or
    // retry the missing tiles through answer_choice generation+choice.
    title.textContent = t("desktop.rec.partialTitle");
    const missing = decision.missingTiles.map(String);
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
    // Marked partial completion: a kept partial output stays distinguishable
    // from a complete save. The missing tile ordinals ride the snapshot
    // output account, so the UI can never claim a complete save for
    // partial bytes.
    const completedMissing = (currentSnapshot?.output?.missing ?? []).map(String);
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

  if (presentation.phase !== "completed" && desktopQueue.entries.length > 1) appendDesktopQueuePanel(aux, doc);

  card.appendChild(aux);
  if (decisionKey && decisionKey !== prevKey) {
    const primary = decisionBox?.querySelector("button.dz-btn-tactile") as HTMLElement | null;
    if (primary && typeof primary.focus === "function") primary.focus();
    else {
      const firstBtn = decisionBox ? focusableIn(decisionBox)[0] : undefined;
      if (firstBtn) firstBtn.focus();
    }
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
  const presentation = currentPresentation();
  const caps = integration.getCapabilities();
  if (viewCtx.jobActivity && presentation.phase === "job") {
    refreshLongestPending();
  }
  // Completion geometry rides the snapshot output canvas; the view context
  // only carries what the shared view renders.
  const canvas = currentSnapshot?.output?.canvas;
  if (presentation.phase === "completed" && canvas) {
    viewCtx.completedInfo = {
      width: canvas.width,
      height: canvas.height,
      mime: encoderToMime(currentSnapshot?.output?.format, grantedMime()),
    };
  } else if (presentation.phase !== "completed") {
    viewCtx.completedInfo = undefined;
  }

  renderView(
    root,
    presentation,
    {
      onSubmitUrl(url: string) {
        handleSubmitUrl(url);
      },
      onCancel() {
        handleCancel();
      },
      onPause() {
        handlePause();
      },
      onResume() {
        handleResume();
      },
      onCopyDiagnostics(text: string) {
        handleCopyDiagnostics(() => `${text}\n\n${buildCopyDiagnostics(diagnosticsSnapshot())}`);
      },
      onRetrySameUrl() {
        // Re-run the last submitted address. `handleSubmitUrl` retires the
        // terminal job first, so this is a true retry rather than a no-op.
        const url = lastInputUrl || viewCtx.jobActivity?.url || "";
        if (isValidInputUrl(url)) handleSubmitUrl(url);
      },
      onReset() {
        handleReset();
      },
      ...(presentation.phase === "completed" ? {
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
      ...(presentation.phase === "completed" ? { nativeSaved: { partial: presentation.partial } } : {}),
      ...(viewCtx.jobActivity ? { jobActivity: viewCtx.jobActivity } : {}),
      ...(viewCtx.initialUrl ? { initialUrl: viewCtx.initialUrl } : {}),
      ...(viewCtx.completedInfo ? { completedInfo: viewCtx.completedInfo } : {}),
      history: [...desktopHistory],
    },
    presentation.phase === "idle" ? {
      idleBeforeHistory: createElement(DesktopSettingsView, {
        settings: desktopSettings,
        error: settingsError,
        onChange: (settings: DesktopSettings) => {
          desktopSettings = settings;
          grantedFormat = normalizeNativeFormat(settings.output_format);
          runPersistSettingsFromPanel();
        },
        onReset: runResetDesktopSettings,
      }),
    } : undefined,
  );
  ensureDesktopAuxPanel();
  ensureDesktopExternalNav();
  ensureDesktopFooter();
}

initInitialUrl();
queryCapabilitiesAtBoot();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("hashchange", () => syncInitialUrlFromLocation());
}

if (root !== null) {
  update();
  void applyPlatformOutputDefault();
}

function getCurrentJobId(): string | null {
  return activeHandle?.id ?? null;
}

export {
  integration,
  service,
  update,
  getCurrentJobId,
  getEffectiveSettings,
  buildCopyDiagnostics,
  handleCopyDiagnostics,
  validateDeepLinkPayload,
  showDeepLinkConfirm,
  dismissDeepLinkConfirm,
};
