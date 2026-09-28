import {
  copyDiagnosticText,
  createAttemptDiagnostics,
  retainDiagnosticReport,
  retainDiagnostics,
  saveDiagnosticReport,
} from "@dezoomify/browser-runtime";
import type { ViewContext } from "@dezoomify/shared-ui";
import {
  boundDiagnosticReport,
  cancelAllQueueEntries,
  cancelQueueEntry,
  clearHistory as clearHistoryStore,
  describeFailure,
  finishActiveQueueEntry,
  HISTORY_KEY_DESKTOP,
  type HistoryEntry,
  loadHistory as loadHistoryStore,
  openConfirmModal,
  type Presentation,
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
  pushHistory,
  renderView,
  type StructuredError,
  saveHistory as saveHistoryStore,
  summarizeQueue,
  t,
  toHistoryEntry,
} from "@dezoomify/shared-ui";
import type { MissingTiles, Output, Progress } from "@dezoomify/wasm-bindings";
import { createElement } from "react";
import type { NativeFormat } from "./desktopIntegration.ts";
import { createDesktopIntegration, NATIVE_FORMATS } from "./desktopIntegration.ts";
import type { ValidatedDeepLink } from "./errorCopy.ts";
import {
  encoderToMime,
  formatMissingSummary,
  hostOf,
  isValidInputUrl,
  readInitialUrl,
  trimTechnical,
  validateDeepLinkPayload,
} from "./errorCopy.ts";
import {
  invokeNative,
  listenDeepLinks,
  type NativeInvocation,
  queryNativeCapabilities,
  readNativeDiagnostics,
} from "./native.ts";
import type { DesktopQueue } from "./queue.ts";
import {
  createDesktopQueue,
  enqueueDesktopQueue,
  recordDesktopProgress,
  retryDesktopEntry,
} from "./queue.ts";
import type { DesktopSettings } from "./settings.ts";
import { defaultOutputDirectory, loadSettings, saveSettings } from "./settings.ts";
import { getEffectiveSettings, resetDesktopSettings } from "./settingsPanel.ts";
import { DesktopSettingsView } from "./settingsView.tsx";

const root = typeof document !== "undefined" ? document.getElementById("root") : null;
const integration = createDesktopIntegration();

const DESKTOP_DOCS_BASE = "https://dezoomify.ophir.dev";

const NATIVE_TRANSPORT = "native";

const REQUEST_TIMEOUT_MS = 30000;

void listenDeepLinks((payload) => {
  const validated = validateDeepLinkPayload(payload);
  if (validated) showDeepLinkConfirm(validated);
}).catch(() => {});

function newAttempt() {
  return {
    diagnostics: createAttemptDiagnostics("desktop"),
    retired: false,
    settled: false,
    activeHandle: null as NativeInvocation | null,
    progress: null as Progress | null,
    output: null as Output | null,
    partial: null as { question: number; value: MissingTiles } | null,
    paused: false,
    localFailure: null as StructuredError | null,
    lastInputUrl: "",
    activeQueueId: null as string | null,
    heartbeatTimer: null as ReturnType<typeof setInterval> | null,
    outputActionError: undefined as { action: "open" | "folder"; code: string } | undefined,
    recoveryReturnFocus: null as HTMLElement | null,
    lastRecoveryKey: null as string | null,
    viewCtx: createViewContext(),
  };
}
type DesktopAttempt = ReturnType<typeof newAttempt>;
let currentAttempt = newAttempt();
function owns(attempt: DesktopAttempt): boolean {
  return currentAttempt === attempt && !attempt.retired;
}

let grantedFormat: NativeFormat = "png";

let desktopQueue: DesktopQueue = createDesktopQueue();
function desktopQueueEnabled(): boolean {
  try {
    return integration.getCapabilities().bulkSupported === true;
  } catch {
    return true;
  }
}

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
    } catch {}
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
    } catch {}
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
    } catch {}
    desktopMemoryFallback.delete(key);
  },
};
let desktopHistory: Array<HistoryEntry> = loadHistoryStore(
  desktopHistoryStore,
  HISTORY_KEY_DESKTOP,
);

function recordDesktopHistory(url: string, width?: number, height?: number, format?: string): void {
  const entry = toHistoryEntry(url, {
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
    ...(typeof format === "string" ? { format } : {}),
    at: Date.now(),
  });
  if (!entry) return;
  desktopHistory = pushHistory(desktopHistory, entry);
  saveHistoryStore(desktopHistoryStore, HISTORY_KEY_DESKTOP, desktopHistory);
}

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

let desktopSettings: DesktopSettings = loadSettings();
grantedFormat = normalizeNativeFormat(desktopSettings.output_format);

let settingsError: string | null = null;

interface PendingDecision {
  missingTiles: Array<number>;
  failedCount: number;
  totalCount?: number;
  question: number;
}

function pendingDecisionOf(): PendingDecision | null {
  if (currentAttempt.localFailure) return null;
  const partial = currentAttempt.partial;
  if (!partial || currentAttempt.settled) return null;
  const missingTiles = partial.value.missing.map((entry) => entry.tile);
  return {
    missingTiles,
    failedCount: missingTiles.length,
    ...(typeof currentAttempt.progress?.total === "number"
      ? { totalCount: currentAttempt.progress.total }
      : {}),
    question: partial.question,
  };
}

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
  } catch {}
}

function recoveryKeyFor(decision: PendingDecision | null): string | null {
  if (!decision) return null;
  const missing = decision.missingTiles.join(",");
  return `${decision.question}:${missing}:${decision.failedCount}:${decision.totalCount ?? ""}`;
}

function isTerminalNow(): boolean {
  return currentAttempt.localFailure !== null || currentAttempt.settled;
}

function activity(): NonNullable<ViewContext["jobActivity"]> {
  if (!currentAttempt.viewCtx.jobActivity)
    currentAttempt.viewCtx.jobActivity = { timeoutMs: REQUEST_TIMEOUT_MS };
  return currentAttempt.viewCtx.jobActivity as NonNullable<ViewContext["jobActivity"]>;
}

function startHeartbeat(): void {
  stopHeartbeat();
  const attempt = currentAttempt;
  try {
    currentAttempt.heartbeatTimer = setInterval(() => {
      if (!owns(attempt)) return;
      if (isTerminalNow()) {
        stopHeartbeat();
        return;
      }
      if (!currentAttempt.viewCtx.jobActivity) return;
      activity().now = Date.now();
      update();
    }, 500);
    const t = currentAttempt.heartbeatTimer as unknown as { unref?: () => void };
    if (t && typeof t.unref === "function") {
      try {
        t.unref();
      } catch {}
    }
  } catch {
    currentAttempt.heartbeatTimer = null;
  }
}

function stopHeartbeat(): void {
  if (currentAttempt.heartbeatTimer) {
    try {
      clearInterval(currentAttempt.heartbeatTimer);
    } catch {}
    currentAttempt.heartbeatTimer = null;
  }
}

function resetActivity(url: string): void {
  const now = Date.now();
  currentAttempt.viewCtx.jobActivity = {
    url,
    startedAt: now,
    now,
    timeoutMs: REQUEST_TIMEOUT_MS,
    lastProgressAt: now,
  };
  startHeartbeat();
}

function touchProgress(): void {
  const a = activity();
  const now = Date.now();
  a.now = now;
  a.lastProgressAt = now;
}

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
  const sourceUrl = currentAttempt.lastInputUrl || activity().url || "";
  currentAttempt.localFailure = describeFailure({
    code,
    detail: trimTechnical(message || ""),
    extraDetail: opts?.detail && opts.detail !== message ? trimTechnical(opts.detail) : undefined,
    retryable: opts?.retryable,
    transport: opts?.transport ?? NATIVE_TRANSPORT,
    phase: opts?.phase,
    url: sourceUrl || undefined,
    host: hostOf(sourceUrl),
    extras: [`Status: ${currentAttempt.progress?.phase ?? "idle"}`, `URL: ${sourceUrl || "n/a"}`],
  });
  currentAttempt.diagnostics.finish("failed", { code, message, ...opts });
  stopHeartbeat();
  if (opts?.settle !== false) settleActiveQueue("failed", { errorCode: code });
  update();
}

function invokeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : fallback;
}

function runPersistSettingsFromPanel(): void {
  const errors = saveSettings(desktopSettings);
  settingsError = errors.length ? errors.join("; ") : null;
  update();
}

function runResetDesktopSettings(): void {
  desktopSettings = resetDesktopSettings();
  grantedFormat = normalizeNativeFormat(desktopSettings.output_format);
  settingsError = null;
  update();
  void applyPlatformOutputDefault();
}

async function applyPlatformOutputDefault(): Promise<void> {
  if (desktopSettings.output_dir !== null) return;
  const output_dir = await defaultOutputDirectory();
  if (!output_dir || desktopSettings.output_dir !== null) return;
  desktopSettings = { ...desktopSettings, output_dir };
  saveSettings(desktopSettings);
  update();
}

function currentPresentation(): Presentation {
  if (currentAttempt.localFailure)
    return presentFailure(currentAttempt.localFailure, NATIVE_TRANSPORT);
  if (currentAttempt.output)
    return presentOutput(
      currentAttempt.output,
      currentAttempt.progress ?? undefined,
      NATIVE_TRANSPORT,
    );
  if (currentAttempt.settled) return presentStatus("cancelled", { transport: NATIVE_TRANSPORT });
  if (!currentAttempt.progress) return presentIdle();
  const presentation = presentProgress(currentAttempt.progress, NATIVE_TRANSPORT, {
    paused: currentAttempt.paused,
  });
  if (currentAttempt.partial) presentation.decision = currentAttempt.partial.value;
  return presentation;
}

function clearJobViewState(): void {
  currentAttempt.outputActionError = undefined;
  currentAttempt.viewCtx.currentProgress = undefined;
  currentAttempt.viewCtx.completedInfo = undefined;
  currentAttempt.viewCtx.jobActivity = undefined;

  stopHeartbeat();
}

function handleSubmitUrl(url: string): void {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidInputUrl(trimmed)) {
    failLocally("INVALID_URL", t("desktop.url.invalid"), { settle: false });
    return;
  }
  if (desktopQueueEnabled() && !isTerminalNow()) {
    const res = enqueueDesktopQueue(desktopQueue, trimmed);
    desktopQueue = res.queue;
    if (res.code !== "ok" || !res.entry) {
      failLocally("INVALID_URL", t("desktop.url.invalid"), { settle: false });
      return;
    }
    if (res.entry.status === "queued") {
      update();
      return;
    }
    currentAttempt.activeQueueId = res.entry.id;
  } else {
    retireActiveJob();
    const res = enqueueDesktopQueue(desktopQueue, trimmed);
    desktopQueue = res.queue;
    currentAttempt.activeQueueId = res.entry ? res.entry.id : null;
  }
  launchNativeJob(trimmed);
}

/** Stop following the current job; its late events can never move the view. */
function retireActiveJob(): void {
  const diagnostics = currentAttempt.diagnostics;
  diagnostics.finish("retired", { reason: "replaced-or-reset" });
  retainDiagnostics(diagnostics);
  currentAttempt.retired = true;
  const handle = currentAttempt.activeHandle;
  currentAttempt.activeHandle = null;
  currentAttempt.progress = null;
  currentAttempt.output = null;
  currentAttempt.partial = null;
  currentAttempt.localFailure = null;
  clearJobViewState();
  if (handle)
    void readNativeDiagnostics(handle.id)
      .then(retainDiagnosticReport, () => {})
      .finally(() => handle.dispose())
      .catch(() => undefined);
  currentAttempt = newAttempt();
}

function launchNativeJob(trimmed: string): void {
  const attempt = currentAttempt;
  attempt.lastInputUrl = trimmed;
  attempt.diagnostics.context({
    input: trimmed,
    submitted: {
      ...desktopSettings,
      headers: undefined,
      header_names: Object.keys(desktopSettings.headers),
    },
  });
  resetActivity(trimmed);

  const effective = getEffectiveSettings(desktopSettings);
  if (!effective.ok || !effective.settings) {
    const detail = effective.errors.join("; ") || "Invalid settings.";
    settingsError = detail;
    failLocally("INVALID_SETTINGS", t("desktop.settings.invalidSubmit"), { detail });
    return;
  }
  settingsError = null;
  desktopSettings = effective.settings;
  update();
  const request = {
    inputUrl: trimmed,
    settings: { ...desktopSettings, headers: { ...desktopSettings.headers } },
  };
  void invokeNative(request, {
    progress(progress) {
      if (!owns(attempt) || attempt.settled) return;
      attempt.progress = progress;
      attempt.diagnostics.observe(progress);
      touchProgress();
      if (attempt.activeQueueId && typeof progress.total === "number") {
        desktopQueue = recordDesktopProgress(
          desktopQueue,
          attempt.activeQueueId,
          progress.completed,
          progress.total,
        ).queue;
      }
      update();
    },
    partial(question, value) {
      if (!owns(attempt) || attempt.settled) return;
      attempt.partial = { question, value };
      update();
    },
  })
    .then(async (handle) => {
      if (!owns(attempt)) {
        await handle.dispose();
        await handle.finished.catch(() => {});
        return;
      }
      attempt.activeHandle = handle;
      attempt.diagnostics.context({ host_job: handle.id });
      update();
      const output = await handle.finished;
      if (!owns(attempt)) return;
      attempt.settled = true;
      attempt.output = output;
      attempt.partial = null;
      stopHeartbeat();
      if (attempt.lastInputUrl)
        recordDesktopHistory(
          attempt.lastInputUrl,
          output.canvas?.width,
          output.canvas?.height,
          grantedFormat,
        );
      settleActiveQueue("done");
      if (owns(attempt)) update();
    })
    .catch((error: unknown) => {
      if (!owns(attempt)) return;
      attempt.settled = true;
      attempt.partial = null;
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "START_FAILED";
      if (code === "job.cancelled") {
        stopHeartbeat();
        settleActiveQueue("cancelled");
        update();
        return;
      }
      failLocally(code, invokeErrorMessage(error, t("desktop.invoke.startFallback")));
    });
}

function settleActiveQueue(
  outcome: "done" | "failed" | "cancelled",
  detail?: { errorCode?: string },
): void {
  if (!currentAttempt.activeQueueId) return;
  const finished = finishActiveQueueEntry(desktopQueue, outcome, detail?.errorCode);
  desktopQueue = finished.queue;
  trimDesktopQueue();
  currentAttempt.activeQueueId = null;
  const next = finished.next;
  if (!next) {
    update();
    return;
  }

  retireActiveJob();
  currentAttempt.activeQueueId = next.id;
  launchNativeJob(next.inputUrl);
}

function trimDesktopQueue(): void {
  if (desktopQueue.entries.length <= 24) return;
  const settled = desktopQueue.entries.filter(
    (e) => e.status !== "queued" && e.status !== "active",
  );
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
  if (id === currentAttempt.activeQueueId) {
    handleCancel();
    return;
  }
  const res = cancelQueueEntry(desktopQueue, id);
  if (res.code !== "ok") return;
  desktopQueue = res.queue;
  update();
}

function handleQueueCancelAll(): void {
  const hadActive = currentAttempt.activeQueueId !== null;
  desktopQueue = cancelAllQueueEntries(desktopQueue);
  currentAttempt.activeQueueId = null;
  if (hadActive) {
    handleCancel();
    return;
  }
  update();
}

function handleQueueRetry(id: string): void {
  const res = retryDesktopEntry(desktopQueue, id);
  if (res.code !== "ok" || !res.entry) return;
  desktopQueue = res.queue;
  if (res.entry.status === "active") {
    retireActiveJob();
    currentAttempt.activeQueueId = res.entry.id;
    launchNativeJob(res.entry.inputUrl);
    return;
  }
  update();
}

function desktopQueueStatusLabel(status: string): string {
  if (status === "active") return t("desktop.queue.statusActive");
  if (status === "done") return t("desktop.queue.statusDone");
  if (status === "failed") return t("desktop.queue.statusFailed");
  if (status === "cancelled") return t("desktop.queue.statusCancelled");
  return t("desktop.queue.statusQueued");
}

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
    let text = `${entry.inputUrl} - ${desktopQueueStatusLabel(entry.status)}`;
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

function handleCancel(): void {
  if (isTerminalNow()) return;
  const handle = currentAttempt.activeHandle;

  if (handle) void handle.cancel().catch(() => undefined);
  handleReset();
}

function handlePause(): void {
  const attempt = currentAttempt;
  if (isTerminalNow()) return;
  const handle = currentAttempt.activeHandle;
  if (!handle) return;
  void handle.pause().then(
    () => {
      if (owns(attempt)) {
        attempt.paused = true;
        update();
      }
    },
    (error: unknown) => {
      if (!owns(attempt)) return;
      failLocally("PAUSE_FAILED", invokeErrorMessage(error, "The pause request was rejected."));
    },
  );
}

function handleResume(): void {
  const attempt = currentAttempt;
  if (isTerminalNow()) return;
  const handle = currentAttempt.activeHandle;
  if (!handle) return;
  void handle.resume().then(
    () => {
      if (!owns(attempt)) return;
      attempt.paused = false;
      touchProgress();
      update();
    },
    (error: unknown) => {
      if (!owns(attempt)) return;
      failLocally("RESUME_FAILED", invokeErrorMessage(error, "The resume request was rejected."));
    },
  );
}

async function handleOpenOutput(attempt: DesktopAttempt, reveal: boolean): Promise<void> {
  if (!owns(attempt)) return;
  const handle = attempt.activeHandle;
  if (!handle) return;
  attempt.outputActionError = undefined;
  try {
    await handle.openOutput(reveal);
  } catch (error) {
    if (!owns(attempt) || handle !== attempt.activeHandle) return;
    const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
    const code =
      typeof rawCode === "string" && /^output\.[a-z-]+$/.test(rawCode)
        ? rawCode
        : "output.invoke-failed";
    attempt.outputActionError = { action: reveal ? "folder" : "open", code };
    attempt.diagnostics.context({ output_action_error: attempt.outputActionError });
    attempt.diagnostics.record("error", "output-action-failed", attempt.outputActionError);
    throw error;
  }
}

function handleRecoveryRetry(): void {
  const attempt = currentAttempt;
  const decision = pendingDecisionOf();
  const handle = currentAttempt.activeHandle;
  if (!decision || !handle || isTerminalNow()) return;
  void handle.answer(decision.question, "retry").then(
    () => {
      if (!owns(attempt)) return;
      attempt.partial = null;
      touchProgress();
      update();
    },
    (error: unknown) => {
      if (!owns(attempt)) return;
      failLocally("CHOICE_FAILED", invokeErrorMessage(error, t("desktop.invoke.retry")));
    },
  );
}

function handlePartialChoice(keep: boolean): void {
  const attempt = currentAttempt;
  const decision = pendingDecisionOf();
  const handle = currentAttempt.activeHandle;
  if (!decision || !handle) return;
  if (isTerminalNow()) return;
  void handle.answer(decision.question, keep ? "keep" : "discard").then(
    () => {
      if (!owns(attempt)) return;
      attempt.partial = null;
      touchProgress();
      update();
    },
    (error: unknown) => {
      if (!owns(attempt)) return;
      failLocally("CHOICE_FAILED", invokeErrorMessage(error, t("desktop.invoke.partial")));
    },
  );
}

function handleReset(): void {
  retireActiveJob();

  desktopQueue = createDesktopQueue();
  currentAttempt.activeQueueId = null;
  dismissDeepLinkConfirm(false);
  currentAttempt.recoveryReturnFocus = null;
  currentAttempt.lastRecoveryKey = null;

  const prefilled = readInitialUrl();
  if (prefilled) currentAttempt.viewCtx.initialUrl = prefilled;
  else currentAttempt.viewCtx.initialUrl = undefined;
  update();
}

function handleOpenExternalLink(url: string): void {
  void integration.openExternalLink(url).then(
    () => undefined,
    () => undefined,
  );
}

function grantedMime(): string {
  return encoderToMime(grantedFormat, "image/png");
}

function dismissDeepLinkConfirm(restore = true): void {
  void restore;
}

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

function queryCapabilitiesAtBoot(): void {
  void queryNativeCapabilities().catch((error) =>
    currentAttempt.diagnostics.record("error", "capability.unavailable", error),
  );
}

function createViewContext(): ViewContext {
  return {
    capabilities: {
      nativeAvailable: integration.getCapabilities().nativeAvailable,
      extensionAvailable: integration.getCapabilities().extensionAvailable,
      browserCanSave: integration.getCapabilities().browserCanSave,
      proxyAllowed: integration.getCapabilities().proxyAllowed,
    },
  };
}

function initInitialUrl(): void {
  const prefilled = readInitialUrl();
  if (prefilled) currentAttempt.viewCtx.initialUrl = prefilled;
}

function syncInitialUrlFromLocation(): void {
  if (currentAttempt.progress !== null || currentAttempt.localFailure !== null) return;
  const prefilled = readInitialUrl();
  const current = currentAttempt.viewCtx.initialUrl;
  if (prefilled && prefilled !== current) {
    currentAttempt.viewCtx.initialUrl = prefilled;
    update();
  } else if (!prefilled && current) {
    currentAttempt.viewCtx.initialUrl = undefined;
    update();
  }
}

function ensureDesktopAuxPanel(): void {
  if (typeof document === "undefined" || !root) return;
  const presentation = currentPresentation();
  const doc = root.ownerDocument;
  const decision = pendingDecisionOf();
  const decisionKey = recoveryKeyFor(decision);
  const prevKey = currentAttempt.lastRecoveryKey;
  const existing = doc.getElementById("dz-desktop-aux");
  const focusedInside =
    existing && existing.contains(doc.activeElement) ? (doc.activeElement as HTMLElement) : null;
  const focusedLabel =
    focusedInside && focusedInside instanceof HTMLButtonElement ? focusedInside.textContent : null;
  if (decisionKey && decisionKey !== prevKey && !currentAttempt.recoveryReturnFocus) {
    const opener = activeElementOf(doc);
    currentAttempt.recoveryReturnFocus = opener && existing?.contains(opener) ? null : opener;
    if (currentAttempt.recoveryReturnFocus === null && opener && !existing?.contains(opener)) {
      currentAttempt.recoveryReturnFocus = opener;
    }
    if (existing && existing.contains(opener as Node) && prevKey === null) {
      currentAttempt.recoveryReturnFocus = null;
    }
  }
  existing?.remove();
  const showPartialDone = presentation.phase === "completed" && presentation.partial;
  const showCancelledNote = presentation.phase === "cancelled";
  if (!decision && !showPartialDone && !showCancelledNote) {
    if (prevKey !== null) {
      restoreFocus(currentAttempt.recoveryReturnFocus);
      currentAttempt.recoveryReturnFocus = null;
    }
    currentAttempt.lastRecoveryKey = decisionKey;
    return;
  }
  const card = root.querySelector(".dz-card");
  if (!card) {
    currentAttempt.lastRecoveryKey = decisionKey;
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
    const completedMissing = (currentAttempt.output?.missing ?? []).map(String);
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
      const rest =
        completedMissing.length > 20
          ? t("desktop.rec.more", { n: completedMissing.length - 20 })
          : "";
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

  if (presentation.phase !== "completed" && desktopQueue.entries.length > 1)
    appendDesktopQueuePanel(aux, doc);

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
    restoreFocus(currentAttempt.recoveryReturnFocus);
    currentAttempt.recoveryReturnFocus = null;
  }
  currentAttempt.lastRecoveryKey = decisionKey;
}

function resolveDesktopExternalUrl(href: string): string | null {
  const raw = (href ?? "").trim();
  if (raw === "") return null;
  if (raw.startsWith("#")) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("blob:")) {
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

function ensureDesktopFooter(): void {
  if (typeof document === "undefined") return;
  const footer = document.querySelector(".dz-site-footer");
  if (!footer) return;
  if (footer.getAttribute("data-dz-wired") === "true") return;
  footer.setAttribute("data-dz-wired", "true");
}

function update() {
  if (!root) return;
  const attempt = currentAttempt;
  const presentation = currentPresentation();
  const caps = integration.getCapabilities();
  if (currentAttempt.viewCtx.jobActivity && presentation.phase === "job") {
    activity().now = Date.now();
  }

  const canvas = currentAttempt.output?.canvas;
  if (presentation.phase === "completed" && canvas) {
    currentAttempt.viewCtx.completedInfo = {
      width: canvas.width,
      height: canvas.height,
      mime: encoderToMime(currentAttempt.output?.format, grantedMime()),
    };
  } else if (presentation.phase !== "completed") {
    currentAttempt.viewCtx.completedInfo = undefined;
  }

  renderView(
    root,
    presentation,
    {
      onSubmitUrl(url: string) {
        handleSubmitUrl(url);
      },
      onCancel() {
        if (!owns(attempt)) return;
        handleCancel();
      },
      onPause() {
        if (!owns(attempt)) return;
        handlePause();
      },
      onResume() {
        if (!owns(attempt)) return;
        handleResume();
      },
      onCopyDiagnostics: copyDiagnosticText,
      onSaveDiagnostics: saveDiagnosticReport,
      async onLoadDiagnostics() {
        const local = attempt.diagnostics.report();
        const handle = attempt.activeHandle;
        if (!handle) return local;
        const native = await readNativeDiagnostics(handle.id);
        return boundDiagnosticReport({
          ...native,
          context: { ...local.context, ...native.context, frontend_report: local.id },
        });
      },
      onRetrySameUrl() {
        if (!owns(attempt)) return;

        const url = currentAttempt.lastInputUrl || currentAttempt.viewCtx.jobActivity?.url || "";
        if (isValidInputUrl(url)) handleSubmitUrl(url);
      },
      onReset() {
        if (!owns(attempt)) return;
        handleReset();
      },
      ...(presentation.phase === "completed"
        ? {
            onOpenOutput: () => handleOpenOutput(attempt, false),
            onRevealOutput: () => handleOpenOutput(attempt, true),
          }
        : {}),
      onHistorySelect(entry: HistoryEntry) {
        currentAttempt.viewCtx.initialUrl = entry.url;
        const input = root.querySelector<HTMLInputElement>("#dz-url-input");
        if (input) input.value = entry.url;
        update();
        root.querySelector<HTMLInputElement>("#dz-url-input")?.focus();
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
      diagnosticReport: attempt.diagnostics.report(),
      ...(presentation.phase === "completed"
        ? { nativeSaved: { partial: presentation.partial }, outputKey: attempt.activeHandle?.id }
        : {}),
      ...(currentAttempt.viewCtx.jobActivity
        ? { jobActivity: currentAttempt.viewCtx.jobActivity }
        : {}),
      ...(currentAttempt.viewCtx.initialUrl
        ? { initialUrl: currentAttempt.viewCtx.initialUrl }
        : {}),
      ...(currentAttempt.viewCtx.completedInfo
        ? { completedInfo: currentAttempt.viewCtx.completedInfo }
        : {}),
      history: [...desktopHistory],
    },
    presentation.phase === "idle"
      ? {
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
        }
      : undefined,
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
  return currentAttempt.activeHandle?.id ?? null;
}

export {
  dismissDeepLinkConfirm,
  getCurrentJobId,
  getEffectiveSettings,
  integration,
  showDeepLinkConfirm,
  update,
  validateDeepLinkPayload,
};
