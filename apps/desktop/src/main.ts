import {
  copyDiagnosticText,
  createAttemptDiagnostics,
  saveDiagnosticReport,
} from "@dezoomify/browser-runtime";
import type { ViewContext } from "@dezoomify/shared-ui";
import {
  boundDiagnosticReport,
  causeOf,
  createHistory,
  detailOf,
  formatMissingSummary,
  getLocale,
  HISTORY_KEY_DESKTOP,
  type HistoryEntry,
  isJobError,
  isValidInputUrl,
  PartialDecisionActions,
  type Presentation,
  pickLocale,
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
  readInitialUrl,
  renderView,
  setLocale,
  t,
  trimTechnical,
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
  type NativeInvocation,
  openExternalLink,
  readNativeDiagnostics,
  validateSettings,
} from "./native.ts";
import type { DesktopSettings } from "./settings.ts";
import { defaultOutputDirectory, loadSettings, resetSettings, saveSettings } from "./settings.ts";
import { DesktopSettingsView } from "./settingsView.tsx";

setLocale(
  pickLocale(
    typeof navigator === "undefined"
      ? undefined
      : navigator.languages?.length
        ? navigator.languages
        : navigator.language,
  ),
);
if (typeof document !== "undefined") document.documentElement.lang = getLocale();

const root = typeof document !== "undefined" ? document.getElementById("root") : null;

const DESKTOP_DOCS_BASE = "https://dezoomify.ophir.dev";

const REQUEST_TIMEOUT_MS = 30000;

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
    historyEntry: null as HistoryEntry | null,
    heartbeatTimer: null as ReturnType<typeof setInterval> | null,
    viewCtx: {} as ViewContext,
  };
}
type DesktopAttempt = ReturnType<typeof newAttempt>;
let currentAttempt = newAttempt();
function owns(attempt: DesktopAttempt): boolean {
  return currentAttempt === attempt && !attempt.retired;
}

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
const desktopHistory = createHistory(desktopHistoryStore, HISTORY_KEY_DESKTOP, Date.now);

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

function failLocally(error: JobError): void {
  const base = detailOf(error);
  currentAttempt.localFailure = {
    ...error,
    ...(base ? { detail: trimTechnical(base) } : {}),
  };
  currentAttempt.diagnostics.finish("failed", { error: currentAttempt.localFailure });
  stopHeartbeat();
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
    failLocally({ kind: "invalid-url" });
    return;
  }
  retireActiveJob();
  launchNativeJob(trimmed);
}

/** Stop following the current job; its late events can never move the view. */
function retireActiveJob(): void {
  if (!isTerminalNow()) desktopHistory.update(currentAttempt.historyEntry, { status: "cancelled" });
  const diagnostics = currentAttempt.diagnostics;
  diagnostics.finish("retired", { reason: "replaced-or-reset" });
  currentAttempt.retired = true;
  const handle = currentAttempt.activeHandle;
  currentAttempt.activeHandle = null;
  currentAttempt.progress = null;
  currentAttempt.output = null;
  currentAttempt.partial = null;
  currentAttempt.localFailure = null;
  clearJobViewState();
  if (handle) void handle.dispose().catch(() => undefined);
  currentAttempt = newAttempt();
}

function launchNativeJob(trimmed: string): void {
  const attempt = currentAttempt;
  attempt.lastInputUrl = trimmed;
  attempt.historyEntry = desktopHistory.start(trimmed);
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
      desktopHistory.progress(attempt.historyEntry, progress);
      attempt.diagnostics.observe(progress);
      touchProgress();
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
      desktopHistory.complete(attempt.historyEntry, output);
      update();
    })
    .catch((error: unknown) => {
      if (!owns(attempt)) return;
      attempt.settled = true;
      attempt.partial = null;
      if (isJobError(error) && causeOf(error).kind === "cancelled") {
        desktopHistory.update(attempt.historyEntry, { status: "cancelled" });
        stopHeartbeat();
        update();
        return;
      }
      desktopHistory.update(attempt.historyEntry, { status: "failed" });
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
  if (!showPartialDone && !showCancelledNote) return;
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
      onOpenExternalLink(url: string) {
        handleOpenExternalLink(url);
      },
      onClearHistory() {
        desktopHistory.clear();
        update();
      },
      onRemoveHistory(entry: HistoryEntry) {
        desktopHistory.remove(entry);
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
      history: desktopHistory.entries(),
      historyNow: Date.now(),
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

export { getCurrentJobId, update };
