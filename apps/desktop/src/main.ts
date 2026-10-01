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
  causeOf,
  clearHistory as clearHistoryStore,
  detailOf,
  finishActiveQueueEntry,
  formatMissingSummary,
  HISTORY_KEY_DESKTOP,
  type HistoryEntry,
  isJobError,
  isValidInputUrl,
  loadHistory as loadHistoryStore,
  openConfirmModal,
  PartialDecisionActions,
  type Presentation,
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
  pushHistory,
  readInitialUrl,
  renderView,
  saveHistory as saveHistoryStore,
  summarizeQueue,
  t,
  toHistoryEntry,
  trimTechnical,
  type ValidatedDeepLink,
  validateDeepLinkPayload,
} from "@dezoomify/shared-ui";
import type {
  Error as JobError,
  MissingTiles,
  Output,
  Progress,
  RecoveryChoice,
} from "@dezoomify/wasm-bindings";
import { createElement } from "react";
import {
  invokeNative,
  listenDeepLinks,
  type NativeInvocation,
  openExternalLink,
  readNativeDiagnostics,
  validateSettings,
} from "./native.ts";
import type { DesktopQueue } from "./queue.ts";
import {
  createDesktopQueue,
  enqueueDesktopQueue,
  recordDesktopProgress,
  retryDesktopEntry,
} from "./queue.ts";
import type { DesktopSettings } from "./settings.ts";
import { defaultOutputDirectory, loadSettings, resetSettings, saveSettings } from "./settings.ts";
import { DesktopSettingsView } from "./settingsView.tsx";

const root = typeof document !== "undefined" ? document.getElementById("root") : null;

const DESKTOP_DOCS_BASE = "https://dezoomify.ophir.dev";

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
    localFailure: null as JobError | null,
    lastInputUrl: "",
    activeQueueId: null as string | null,
    heartbeatTimer: null as ReturnType<typeof setInterval> | null,
    viewCtx: {} as ViewContext,
  };
}
type DesktopAttempt = ReturnType<typeof newAttempt>;
let currentAttempt = newAttempt();
function owns(attempt: DesktopAttempt): boolean {
  return currentAttempt === attempt && !attempt.retired;
}

let desktopQueue: DesktopQueue = createDesktopQueue();

const desktopMemoryFallback = new Map<string, string>();
const desktopHistoryStore = {
  getItem(key: string): string | null {
    try {
      const storage = (globalThis as Record<string, unknown>).localStorage as
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
      const storage = (globalThis as Record<string, unknown>).localStorage as
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
      const storage = (globalThis as Record<string, unknown>).localStorage as
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

let desktopSettings: DesktopSettings = loadSettings();

let settingsError: string | null = null;

function isTerminalNow(): boolean {
  return currentAttempt.localFailure !== null || currentAttempt.settled;
}

function activity(): NonNullable<ViewContext["jobActivity"]> {
  if (!currentAttempt.viewCtx.jobActivity)
    currentAttempt.viewCtx.jobActivity = { now: Date.now(), timeoutMs: REQUEST_TIMEOUT_MS };
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

function failLocally(error: JobError, opts?: { detail?: string; settle?: boolean }): void {
  const { settle, detail } = opts ?? {};
  const base = detailOf(error);
  const parts = [base, detail && detail !== base ? detail : undefined]
    .filter((part): part is string => Boolean(part))
    .map((part) => trimTechnical(part));
  currentAttempt.localFailure = {
    ...error,
    ...(parts.length > 0 ? { detail: parts.join("\n\n") } : {}),
  };
  currentAttempt.diagnostics.finish("failed", { error: currentAttempt.localFailure });
  stopHeartbeat();
  if (settle !== false) settleActiveQueue("failed", { errorCode: error.kind });
  update();
}

function invokeDetail(error: unknown, fallback: string): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error && typeof error === "object" && "detail" in error && typeof error.detail === "string"
        ? error.detail
        : fallback;
}

// Rust (`parse_settings`) is the single validator: an edit is validated
// before it is persisted, a refused edit persists nothing (fail closed,
// keeps the last good payload), and its typed reason is shown until the
// next accepted change.
async function runPersistSettingsFromPanel(): Promise<void> {
  const candidate = desktopSettings;
  try {
    await validateSettings(candidate);
    if (desktopSettings !== candidate) return;
    const errors = saveSettings(candidate);
    settingsError = errors.length ? errors.join("; ") : null;
  } catch (error) {
    if (desktopSettings !== candidate) return;
    settingsError = isJobError(error)
      ? (detailOf(error) ?? t("desktop.settings.invalidSubmit"))
      : invokeDetail(error, t("desktop.settings.invalidSubmit"));
  }
  update();
}

function runResetDesktopSettings(): void {
  desktopSettings = resetSettings();
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
  if (currentAttempt.localFailure) return presentFailure(currentAttempt.localFailure);
  if (currentAttempt.output)
    return presentOutput(currentAttempt.output, currentAttempt.progress ?? undefined);
  if (currentAttempt.settled) return presentStatus("cancelled");
  if (!currentAttempt.progress) return presentIdle();
  const presentation = presentProgress(currentAttempt.progress, {
    paused: currentAttempt.paused,
  });
  if (currentAttempt.partial) presentation.decision = currentAttempt.partial.value;
  return presentation;
}

function clearJobViewState(): void {
  currentAttempt.viewCtx.currentProgress = undefined;
  currentAttempt.viewCtx.jobActivity = undefined;

  stopHeartbeat();
}

function handleSubmitUrl(url: string): void {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidInputUrl(trimmed)) {
    failLocally({ kind: "invalid-url" }, { settle: false });
    return;
  }
  if (!isTerminalNow()) {
    const res = enqueueDesktopQueue(desktopQueue, trimmed);
    desktopQueue = res.queue;
    if (res.code !== "ok" || !res.entry) {
      failLocally({ kind: "invalid-url" }, { settle: false });
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
      // Raw header lines carry values, so they never enter diagnostics.
      headers: undefined,
    },
  });
  resetActivity(trimmed);

  // Rust (`parse_settings`) is the single settings validator; its typed
  // rejection below is authoritative. A rejected save shows its reason and
  // persists nothing.
  settingsError = null;
  update();
  const request = {
    inputUrl: trimmed,
    settings: { ...desktopSettings, headers: [...desktopSettings.headers] },
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
          output.format,
        );
      settleActiveQueue("done");
      if (owns(attempt)) update();
    })
    .catch((error: unknown) => {
      if (!owns(attempt)) return;
      attempt.settled = true;
      attempt.partial = null;
      if (isJobError(error) && causeOf(error).kind === "cancelled") {
        stopHeartbeat();
        settleActiveQueue("cancelled");
        update();
        return;
      }
      if (isJobError(error) && error.kind === "invalid-settings") {
        // The Rust save command rejected the settings; surface its typed
        // reason in the settings panel as well as the failure view.
        settingsError = detailOf(error) ?? t("desktop.settings.invalidSubmit");
      }
      failLocally(
        isJobError(error)
          ? error
          : {
              kind: "start-failed",
              detail: invokeDetail(error, t("desktop.invoke.startFallback")),
            },
      );
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
      failLocally({
        kind: "choice-failed",
        detail: invokeDetail(error, "the pause request was rejected"),
      });
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
      failLocally({
        kind: "choice-failed",
        detail: invokeDetail(error, "the resume request was rejected"),
      });
    },
  );
}

async function handleOpenOutput(attempt: DesktopAttempt, reveal: boolean): Promise<void> {
  if (!owns(attempt)) return;
  const handle = attempt.activeHandle;
  if (!handle) return;
  try {
    await handle.openOutput(reveal);
  } catch (error) {
    if (!owns(attempt) || handle !== attempt.activeHandle) return;
    const failure = {
      action: reveal ? "folder" : "open",
      kind: isJobError(error) ? error.kind : "invoke-failed",
    };
    attempt.diagnostics.context({ output_action_error: failure });
    attempt.diagnostics.record("error", "output-action-failed", failure);
    throw error;
  }
}

function answerPartial(
  attempt: DesktopAttempt,
  partial: NonNullable<DesktopAttempt["partial"]>,
  choice: RecoveryChoice,
): void {
  const handle = attempt.activeHandle;
  if (!owns(attempt) || attempt.partial !== partial || !handle || isTerminalNow()) return;
  void handle.answer(partial.question, choice).then(
    () => {
      if (!owns(attempt) || attempt.partial !== partial) return;
      attempt.partial = null;
      touchProgress();
      update();
    },
    (error: unknown) => {
      if (!owns(attempt) || attempt.partial !== partial) return;
      failLocally({
        kind: "choice-failed",
        detail: invokeDetail(error, t("desktop.invoke.partial")),
      });
    },
  );
}

function handleReset(): void {
  retireActiveJob();

  desktopQueue = createDesktopQueue();
  currentAttempt.activeQueueId = null;

  const prefilled = readInitialUrl(globalThis.location);
  if (prefilled) currentAttempt.viewCtx.initialUrl = prefilled;
  else currentAttempt.viewCtx.initialUrl = undefined;
  update();
}

function handleOpenExternalLink(url: string): void {
  void openExternalLink(url).then(
    () => undefined,
    () => undefined,
  );
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

function initInitialUrl(): void {
  const prefilled = readInitialUrl(globalThis.location);
  if (prefilled) currentAttempt.viewCtx.initialUrl = prefilled;
}

function syncInitialUrlFromLocation(): void {
  if (currentAttempt.progress !== null || currentAttempt.localFailure !== null) return;
  const prefilled = readInitialUrl(globalThis.location);
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
  doc.getElementById("dz-desktop-aux")?.remove();
  const showPartialDone =
    presentation.phase === "completed" &&
    presentation.output !== undefined &&
    presentation.output.missing.length > 0;
  const showCancelledNote = presentation.phase === "cancelled";
  const showQueue = presentation.phase !== "completed" && desktopQueue.entries.length > 1;
  if (!showPartialDone && !showCancelledNote && !showQueue) return;
  const card = root.querySelector(".dz-card");
  if (!card) return;

  const aux = doc.createElement("div");
  aux.id = "dz-desktop-aux";
  aux.className = "dz-view-body dz-desktop-aux";
  aux.setAttribute("role", "region");
  aux.setAttribute("aria-label", t("desktop.panel.jobActions"));

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

  if (showQueue) appendDesktopQueuePanel(aux, doc);

  card.appendChild(aux);
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

function update() {
  if (!root) return;
  const attempt = currentAttempt;
  const presentation = currentPresentation();
  const partial = presentation.decision ? attempt.partial : null;
  if (currentAttempt.viewCtx.jobActivity && presentation.phase === "job") {
    activity().now = Date.now();
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
      diagnosticReport: attempt.diagnostics.report(),
      ...(presentation.phase === "completed" ? { outputKey: attempt.activeHandle?.id } : {}),
      ...(currentAttempt.viewCtx.jobActivity
        ? { jobActivity: currentAttempt.viewCtx.jobActivity }
        : {}),
      ...(currentAttempt.viewCtx.initialUrl
        ? { initialUrl: currentAttempt.viewCtx.initialUrl }
        : {}),
      history: [...desktopHistory],
    },
    {
      ...(presentation.phase === "idle"
        ? {
            idleBeforeHistory: createElement(DesktopSettingsView, {
              settings: desktopSettings,
              error: settingsError,
              onChange: (settings: DesktopSettings) => {
                desktopSettings = settings;
                void runPersistSettingsFromPanel();
              },
              onReset: runResetDesktopSettings,
            }),
          }
        : {}),
      ...(partial
        ? {
            after: createElement(PartialDecisionActions, {
              key: `${attempt.activeHandle?.id}:${partial.question}`,
              decision: partial.value,
              onAnswer: (choice: RecoveryChoice) => answerPartial(attempt, partial, choice),
              labels: {
                keep: t("desktop.rec.keep"),
                discard: t("desktop.rec.discard"),
                retry: t("desktop.rec.retryTiles"),
              },
            }),
          }
        : {}),
    },
  );
  ensureDesktopAuxPanel();
  ensureDesktopExternalNav();
}

initInitialUrl();

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

export { getCurrentJobId, showDeepLinkConfirm, update, validateDeepLinkPayload };
