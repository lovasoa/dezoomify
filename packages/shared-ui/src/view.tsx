// Modern accessible Shared UI: typed React components.
//
// This module owns presentation only. Hosts keep their effect layers
// (fetch, native IPC, worker) and mount the shared view through the stable
// `renderView(container, state, callbacks, ctx)` entry point; the imperative
// DOM renderer it replaces lived in the same file. `renderView` drives one
// React root per container and flushes synchronously, so hosts observe the
// same "call then inspect the DOM" semantics they had before.
//
// The rendered class names, ids, roles, and visible text are part of the
// product contract (theme CSS, E2E selectors); keep them stable.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ControllerState, StructuredError, AppCapabilities } from "./controller.ts";
import type { HistoryEntry } from "./history.ts";
import { t } from "./i18n.ts";
import {
  renderSaveGuidance,
  renderCompletion,
  formatElapsed,
  getDezoomifyLogoSvg,
} from "./components.ts";

export interface ViewCallbacks {
  onSubmitUrl(url: string): void;
  onCancel(): void;
  onReset(): void;
  onRetrySameUrl?(): void;
  onSave?(): void;
  onOpenOutput?(): void;
  onRevealOutput?(): void;
  onHistorySelect?(entry: HistoryEntry): void;
  onSelectImage?(index: number): void;
  onSelectLevel?(level: number): void;
  onOpenExternalLink?(url: string): void;
  onCopyDiagnostics?(text: string): void;
  onClearHistory?(): void;
  onPause?(): void;
  onResume?(): void;
}

export interface JobActivity {
  url?: string;
  startedAt?: number;
  now?: number;
  stepLabel?: string;
  detail?: string;
  pendingRequests?: number;
  completedRequests?: number;
  failedRequests?: number;
  longestPendingMs?: number;
  timeoutMs?: number;
  lastProgressAt?: number;
  log?: string[];
  diagnostics?: string;
  paused?: boolean;
  pausedAt?: number;
  pausedDurationMs?: number;
}

export interface ViewContext {
  capabilities?: AppCapabilities;
  currentProgress?: {
    current: number;
    total: number;
    active?: number;
    retrying?: number;
    estimatedTotalMs?: number;
    message?: string;
  };
  completedInfo?: { width: number; height: number; mime: string; blobUrl?: string };
  nativeSaved?: { partial: boolean };
  savedOutput?: {
    name: string;
    width: number;
    height: number;
    doneTiles: number;
    totalTiles: number;
    failedTiles: number;
  };
  originClean?: boolean;
  jobActivity?: JobActivity;
  initialUrl?: string;
  imageChoice?: { width?: number; height?: number; tiles?: number };
  sourceUrl?: string;
  desktopHandoffUrl?: string;
  history?: Array<HistoryEntry>;
  paused?: boolean;
}

export interface ModalHost {
  document: Document;
}

export type ViewPhase =
  | "idle"
  | "job"
  | "display-only"
  | "completed"
  | "failed"
  | "cancelled"
  | "generic";

export function getPhaseForStatus(status: ControllerState["status"]): ViewPhase {
  switch (status) {
    case "idle":
      return "idle";
    case "discovering":
    case "choosing-image":
    case "choosing-level":
    case "preflighting":
    case "downloading":
    case "saving":
      return "job";
    case "display-only":
      return "display-only";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "generic";
  }
}

export interface ImagePickerOption {
  index: number;
  title?: string;
  width?: number;
  height?: number;
  tiles?: number;
}

export interface ImagePickerArgs {
  options: ImagePickerOption[];
  onPick(index: number): void;
}

export interface LevelPickerOption {
  index: number;
  width: number;
  height: number;
  tiles: number;
  fits: boolean;
}

export interface LevelPickerArgs {
  options: LevelPickerOption[];
  onPick(index: number): void;
}

export interface ConfirmModalArgs {
  title: string;
  subtitle: string;
  bodyLines: string[];
  confirmLabel: string;
  declineLabel: string;
}

export interface PlatformHints {
  userAgent?: string;
  platform?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (host-neutral, no DOM).
// ---------------------------------------------------------------------------

function truncateMiddle(value: string, max = 90): string {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

/** Display source context without query, fragment, or credentials. */
function displaySourceUrl(value: string): string {
  try {
    const url = new URL(value);
    return truncateMiddle(`${url.host}${url.pathname}`, 90);
  } catch {
    return "source unavailable";
  }
}

/** The website a request is waiting on, for plain-language messages. */
function hostFromUrl(url: string | undefined): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "the server";
  }
}

/**
 * Redacted origin (`scheme://host[:port]/`) for the one-click desktop handoff
 * summary. Prefers the original source URL; falls back to the `src` query
 * inside the `dezoomify://` link. Returns "" for local files or unparseable
 * input. Never includes userinfo, path, query, or fragment.
 */
export function handoffOriginFor(handoffUrl?: string, sourceUrl?: string): string {
  const candidates: Array<string> = [];
  if (typeof sourceUrl === "string" && sourceUrl !== "") candidates.push(sourceUrl);
  if (typeof handoffUrl === "string" && handoffUrl !== "") {
    try {
      const query = handoffUrl.split("?")[1]?.split("#")[0] ?? "";
      for (const pair of query.split("&")) {
        if (pair.startsWith("src=")) {
          try {
            candidates.push(decodeURIComponent(pair.slice(4).replace(/\+/g, " ")));
          } catch {
            // A malformed src never blocks the summary.
          }
          break;
        }
      }
    } catch {
      // A malformed handoff link never blocks the summary.
    }
  }
  for (const candidate of candidates) {
    try {
      const trimmed = String(candidate).trim();
      if (trimmed.toLowerCase().startsWith("file:")) return "";
      const u = new URL(trimmed);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (!u.hostname) continue;
      return `${u.protocol}//${u.host}/`;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

/** True for local-file sources: handoff carries no link, only the local note. */
export function isFileHandoffSource(sourceUrl?: string): boolean {
  try {
    return new URL(String(sourceUrl ?? "").trim()).protocol === "file:";
  } catch {
    return false;
  }
}

function historyDimsLabel(entry: HistoryEntry): string {
  if (
    typeof entry.width === "number" &&
    typeof entry.height === "number" &&
    entry.width > 0 &&
    entry.height > 0
  ) {
    return t("view.history.dims", { w: entry.width, h: entry.height });
  }
  return "";
}

function historyDateLabel(at: number): string {
  try {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString();
  } catch {
    return "";
  }
}

function defaultStepFor(status: ControllerState["status"]): string {
  switch (status) {
    case "discovering":
      return t("view.step.discovering");
    case "choosing-image":
      return t("view.step.choosingImage");
    case "choosing-level":
      return t("view.step.choosingLevel");
    case "preflighting":
      return t("view.step.preflighting");
    case "downloading":
      return t("view.step.downloading");
    case "saving":
      return t("view.step.saving");
    default:
      return t("view.step.working");
  }
}

function diagnosticsText(
  state: ControllerState,
  ctx?: ViewContext,
  elapsedMs?: number,
  timeoutMs?: number,
): string {
  const a = ctx?.jobActivity ?? {};
  const p = ctx?.currentProgress;
  const lines = [
    `Status: ${state.status}`,
    `Transport: ${state.transport ?? "direct"}`,
    `Elapsed: ${Math.round((elapsedMs ?? 0) / 1000)} s`,
    `Per-request timeout: ${Math.round((timeoutMs ?? a.timeoutMs ?? 30000) / 1000)} s`,
    `Requests: ${a.pendingRequests ?? 0} pending, ${a.completedRequests ?? 0} done, ${a.failedRequests ?? 0} failed`,
  ];
  if (p) lines.push(`Tiles: ${p.current} of ${p.total}`);
  if (p?.active !== undefined) lines.push(`Tiles active: ${p.active}`);
  if (p?.retrying !== undefined) lines.push(`Tiles retrying: ${p.retrying}`);
  if (a.url) lines.push(`Source: ${displaySourceUrl(a.url)}`);
  return lines.join("\n");
}

function errorDiagnosticsText(error: StructuredError): string {
  const base =
    `Code: ${error.code}\n` +
    `Category: ${error.category}\n` +
    `Retryable: ${error.retryable}\n` +
    `Transport: ${error.transport ?? "direct"}\n` +
    `Phase: ${error.phase ?? "discovery"}\n` +
    `Message: ${error.message}`;
  return error.detail ? `${base}\n\n${error.detail}` : base;
}

// ---------------------------------------------------------------------------
// Presentational atoms.
// ---------------------------------------------------------------------------

function Logo() {
  return (
    <h1 className="dz-product-mark">
      <span dangerouslySetInnerHTML={{ __html: getDezoomifyLogoSvg(30) }} />
      <span>Dezoomify</span>
    </h1>
  );
}

function Chevron() {
  return (
    <svg
      className="dz-summary-icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ExtensionGuideButton({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" className="dz-guidance-item" id="dz-card-extension" onClick={onOpen}>
      <div className="dz-guidance-item-header">
        <svg
          className="dz-guidance-icon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
        <span className="dz-guidance-item-title">{t("view.display.extTitle")}</span>
      </div>
      <span className="dz-guidance-item-desc">{t("view.display.extDesc")}</span>
    </button>
  );
}

function DesktopGuideButton({ onOpen, description }: { onOpen(): void; description: string }) {
  return (
    <button type="button" className="dz-guidance-item" id="dz-card-desktop" onClick={onOpen}>
      <div className="dz-guidance-item-header">
        <svg
          className="dz-guidance-icon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
        <span className="dz-guidance-item-title">{t("view.display.deskTitle")}</span>
      </div>
      <span className="dz-guidance-item-desc">{description}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Input / history.
// ---------------------------------------------------------------------------

function HistorySection({
  callbacks,
  ctx,
}: {
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
}) {
  const entries = ctx?.history;
  if (!Array.isArray(entries)) return <div className="dz-history-section" id="dz-history" />;
  return (
    <div className="dz-history-section" id="dz-history">
      <h2 className="dz-history-title">{t("view.history.title")}</h2>
      <p className="dz-history-note">{t("view.history.localOnly")}</p>
      {entries.length === 0 ? (
        <p className="dz-history-empty">{t("view.history.empty")}</p>
      ) : (
        <ul className="dz-history-list">
          {entries.slice(0, 20).map((entry, i) => {
            const parts = [entry.url || entry.origin];
            const dims = historyDimsLabel(entry);
            const date = historyDateLabel(entry.at);
            if (dims !== "") parts.push(dims);
            if (typeof entry.format === "string" && entry.format !== "") parts.push(entry.format);
            if (date !== "") parts.push(date);
            return (
              <li className="dz-history-item" key={`${entry.url}-${i}`}>
                {callbacks.onHistorySelect ? (
                  <button
                    type="button"
                    className="dz-history-main"
                    onClick={() => callbacks.onHistorySelect?.(entry)}
                  >
                    {parts.join(" ")}
                  </button>
                ) : (
                  <span className="dz-history-main">{parts.join(" ")}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {typeof callbacks.onClearHistory === "function" && entries.length > 0 ? (
        <button
          type="button"
          className="dz-btn-secondary"
          id="dz-history-clear"
          onClick={() => {
            try {
              callbacks.onClearHistory?.();
            } catch {
              // Clearing must never break the view.
            }
          }}
        >
          {t("view.history.clear")}
        </button>
      ) : null}
    </div>
  );
}

function IdleView({ callbacks, ctx }: { callbacks: ViewCallbacks; ctx?: ViewContext }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState<boolean>(Boolean(ctx?.initialUrl));

  useEffect(() => {
    const el = inputRef.current;
    if (el && !el.value && ctx?.initialUrl) {
      el.value = ctx.initialUrl;
      setHasValue(true);
    }
  }, [ctx?.initialUrl]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const url = inputRef.current?.value.trim() ?? "";
    if (!url) {
      inputRef.current?.focus();
      return;
    }
    callbacks.onSubmitUrl(url);
  }

  return (
    <div className="dz-view-body dz-fade-in">
      <div className="dz-description">
        <p>{t("view.input.description")}</p>
      </div>
      <form className="dz-form" onSubmit={submit}>
        <div className="dz-input-wrapper">
          <input
            ref={inputRef}
            type="url"
            id="dz-url-input"
            className="dz-input"
            placeholder={t("view.input.placeholder")}
            required
            autoFocus
            defaultValue={ctx?.initialUrl ?? ""}
            aria-label={t("view.input.aria")}
            onChange={(e) => setHasValue(e.currentTarget.value.length > 0)}
          />
          <button
            type="button"
            className="dz-input-clear"
            id="dz-btn-clear"
            title={t("view.idle.clearTitle")}
            aria-label={t("view.idle.clearTitle")}
            style={{ display: hasValue ? "flex" : "none" }}
            onClick={() => {
              const el = inputRef.current;
              if (el) {
                el.value = "";
                setHasValue(false);
                el.focus();
              }
            }}
          >
            ×
          </button>
        </div>
        <div className="dz-button-row">
          <button type="submit" className="dz-btn-tactile">
            <span>{t("view.input.start")}</span>
            <span className="dz-button-key" aria-hidden="true">
              ↵
            </span>
          </button>
        </div>
      </form>
      <HistorySection callbacks={callbacks} ctx={ctx} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live job.
// ---------------------------------------------------------------------------

interface JobDerived {
  paused: boolean;
  step: string;
  sourceUrl: string;
  timeText: string;
  countsText: string;
  determinate: boolean;
  current: number;
  total: number;
  active: number;
  donePct: number;
  activePct: number;
  diagText: string;
  logText: string;
  copiedLog: string;
}

function deriveJob(state: ControllerState, ctx?: ViewContext): JobDerived {
  const activity = ctx?.jobActivity ?? {};
  const current = ctx?.currentProgress?.current ?? 0;
  const total = ctx?.currentProgress?.total ?? 0;
  const determinate = total > 0;
  const donePct = determinate ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
  const active = determinate
    ? Math.max(0, Math.min(ctx?.currentProgress?.active ?? 0, Math.max(0, total - current)))
    : 0;
  const activePct = determinate ? (active / total) * 100 : 0;
  const retrying = Math.max(0, Math.min(ctx?.currentProgress?.retrying ?? 0, active));
  const paused = ctx?.paused === true || activity.paused === true;
  const now = activity.now ?? Date.now();
  const startedAt = activity.startedAt ?? now;
  const timerNow = activity.pausedAt ?? now;
  const elapsedMs = Math.max(0, timerNow - startedAt - (activity.pausedDurationMs ?? 0));
  const elapsed = formatElapsed(elapsedMs);
  const timeoutMs = activity.timeoutMs ?? 30000;
  const lastProgressAt = activity.lastProgressAt ?? startedAt;
  const stalledMs = Math.max(0, timerNow - lastProgressAt);
  const showStalled = stalledMs >= 10000 && state.status !== "saving";
  const step = paused
    ? "Paused"
    : retrying > 0
      ? `Retrying ${retrying} tile${retrying === 1 ? "" : "s"}…`
      : showStalled
        ? `Waiting for ${hostFromUrl(activity.url)}…`
        : activity.stepLabel || ctx?.currentProgress?.message || defaultStepFor(state.status);
  const sourceUrl = activity.url ? displaySourceUrl(activity.url) : "";
  const estimatedTotalMs = ctx?.currentProgress?.estimatedTotalMs ?? (
    determinate && current >= 2 && elapsedMs >= 2000
      ? Math.round((elapsedMs / current) * total)
      : undefined
  );
  const timeText = elapsed
    ? `${elapsed}${typeof estimatedTotalMs === "number" && estimatedTotalMs > elapsedMs ? ` / ~${formatElapsed(estimatedTotalMs)}` : ""}`
    : "";
  const countsText = determinate
    ? `${current} done${active > 0 ? ` + ${active} in progress` : ""} / ${total}`
    : "";
  const diagText = diagnosticsText(state, ctx, elapsedMs, timeoutMs);
  const logText = activity.log && activity.log.length > 0 ? activity.log.slice(-20).join("\n") : "";
  const copiedLog = activity.log && activity.log.length > 0 ? `\n\nEvents\n${activity.log.join("\n")}` : "";
  const copied = `${diagText}${activity.diagnostics ? `\n\n${activity.diagnostics}` : ""}${copiedLog}`;
  return {
    paused,
    step,
    sourceUrl,
    timeText,
    countsText,
    determinate,
    current,
    total,
    active,
    donePct,
    activePct,
    diagText,
    logText,
    copiedLog: copied,
  };
}

function JobView({
  state,
  callbacks,
  ctx,
}: {
  state: ControllerState;
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
}) {
  const d = deriveJob(state, ctx);
  const showPause = !d.paused && typeof callbacks.onPause === "function";
  const showResume = d.paused && typeof callbacks.onResume === "function";
  return (
    <div
      className={`dz-view-body dz-job-section dz-fade-in${d.paused ? " dz-job-paused" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div
        className="dz-job-source-row"
        id="dz-job-source-line"
        style={{ display: d.sourceUrl ? "" : "none" }}
        title={d.sourceUrl}
      >
        <span className="dz-job-source-label">Source</span>
        <span className="dz-source-url" id="dz-job-source-url">
          {d.sourceUrl}
        </span>
        <span className="dz-job-time" id="dz-job-time">
          {d.timeText}
        </span>
      </div>
      <div className="dz-progress-header">
        <span className="dz-progress-status">
          <span className="dz-pulse" aria-hidden="true" />
          <span className="dz-progress-step-text" id="dz-job-step-text">
            {d.step}
          </span>
        </span>
        <span className="dz-progress-count" id="dz-job-counts">
          {d.countsText}
        </span>
      </div>
      <div className="dz-progress-rail">
        <div className="dz-progress-buttons">
          <button
            type="button"
            className="dz-progress-control"
            id="dz-btn-pause"
            style={{ display: showPause ? "" : "none" }}
            aria-label="Pause"
            title="Pause"
            onClick={() => callbacks.onPause?.()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" />
              <rect x="14" y="5" width="4" height="14" />
            </svg>
          </button>
          <button
            type="button"
            className="dz-progress-control"
            id="dz-btn-resume"
            style={{ display: showResume ? "" : "none" }}
            aria-label="Resume"
            title="Resume"
            onClick={() => callbacks.onResume?.()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 5 11 7-11 7z" />
            </svg>
          </button>
          <button
            type="button"
            className="dz-progress-control dz-stop-control"
            id="dz-btn-cancel"
            aria-label="Stop and return to start"
            title="Stop and return to start"
            onClick={() => callbacks.onCancel()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" />
            </svg>
          </button>
        </div>
        <div
          className={`dz-progress-track${d.determinate ? "" : " dz-indeterminate"}`}
          id="dz-job-track"
          role="progressbar"
          aria-valuenow={d.current}
          aria-valuemin={0}
          aria-valuemax={d.total || 100}
          aria-label={d.step}
          aria-valuetext={
            d.determinate
              ? `${d.current} done, ${d.active} in progress, ${Math.max(0, d.total - d.current - d.active)} remaining`
              : d.step
          }
        >
          <div className="dz-progress-done" id="dz-job-bar" style={{ width: d.determinate ? `${d.donePct}%` : "35%" }} />
          <div
            className="dz-progress-active"
            id="dz-job-active"
            style={{
              left: d.determinate ? `${d.donePct}%` : "0%",
              width: d.determinate ? `${d.activePct}%` : "0%",
            }}
          />
        </div>
      </div>
      <details className="dz-details" id="dz-job-details">
        <summary className="dz-summary">
          <span>{t("view.job.techDetails")}</span>
          <Chevron />
        </summary>
        <button
          type="button"
          className="dz-copy-diagnostics"
          id="dz-btn-copy-diagnostics"
          style={{ display: callbacks.onCopyDiagnostics ? "" : "none" }}
          aria-label="Copy technical details"
          title="Copy technical details"
          onClick={() => callbacks.onCopyDiagnostics?.(d.copiedLog)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="10" height="11" rx="1" />
            <path d="M15 9V5H5v11h4" />
          </svg>
        </button>
        <div className="dz-diagnostics" id="dz-job-diagnostics">
          {d.diagText}
        </div>
        <div
          className="dz-diagnostics dz-log"
          id="dz-job-log"
          style={{ display: d.logText ? "" : "none" }}
        >
          {d.logText}
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display-only, completed, failed, cancelled, generic.
// ---------------------------------------------------------------------------

function DisplayOnlyView({ callbacks, ctx }: { callbacks: ViewCallbacks; ctx?: ViewContext }) {
  const guidance = renderSaveGuidance(false);
  const handoffUrl = typeof ctx?.desktopHandoffUrl === "string" ? ctx.desktopHandoffUrl : "";
  const handoffSource = typeof ctx?.sourceUrl === "string" ? ctx.sourceUrl : "";
  const handoffOrigin = handoffOriginFor(handoffUrl, handoffSource);
  const handoffLabel =
    handoffOrigin !== "" ? t("view.handoff.sendOrigin", { origin: handoffOrigin }) : t("view.handoff.send");
  const hostDoc = globalThis.document;
  return (
    <div className="dz-view-body dz-notice-section dz-fade-in">
      <div className="dz-notice-header">
        <svg
          className="dz-notice-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div>
          <h2 className="dz-notice-title">{t("view.display.title")}</h2>
          <p className="dz-notice-message">{guidance}</p>
        </div>
      </div>
      <div className="dz-guidance-section">
        <h3 className="dz-guidance-title">{t("view.display.waysTitle")}</h3>
        <div className="dz-guidance-grid">
          <ExtensionGuideButton onOpen={() => showExtensionGuidance(hostDoc)} />
          <DesktopGuideButton
            onOpen={() => showDesktopAppGuidance(hostDoc)}
            description={t("view.display.deskDescClean")}
          />
        </div>
      </div>
      <div className="dz-actions-row">
        <button type="button" className="dz-btn-secondary" id="dz-btn-reset" onClick={() => callbacks.onReset()}>
          {t("view.display.startOver")}
        </button>
        {handoffUrl !== "" ? (
          <a
            className="dz-btn-secondary"
            id="dz-btn-desktop-handoff"
            href={handoffUrl}
            onClick={() => {
              try {
                callbacks.onOpenExternalLink?.(handoffUrl);
              } catch {
                // Handoff navigation must never break display.
              }
            }}
          >
            {handoffLabel}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function CompletedView({ callbacks, ctx }: { callbacks: ViewCallbacks; ctx?: ViewContext }) {
  const info = ctx?.completedInfo;
  const saved = ctx?.savedOutput;
  const isClean = ctx?.originClean ?? true;
  let title = t("view.done.readyTitle");
  let summary = info ? renderCompletion(info.width, info.height, info.mime) : t("view.done.ready");
  let showSaveButton = isClean && !!callbacks.onSave;
  if (saved) {
    const partial = saved.failedTiles > 0;
    title = partial ? t("view.done.gaps") : t("view.done.savedFile");
    summary = partial
      ? t("view.done.savedPartial", {
          name: saved.name,
          w: saved.width,
          h: saved.height,
          done: saved.doneTiles,
          total: saved.totalTiles,
          failed: saved.failedTiles,
        })
      : t("view.done.savedFull", { name: saved.name, w: saved.width, h: saved.height });
    showSaveButton = false;
  }
  if (ctx?.nativeSaved) {
    title = t(ctx.nativeSaved.partial ? "desktop.done.partial" : "desktop.done.title");
    summary = info
      ? t("desktop.done.size", { width: info.width, height: info.height })
      : t("desktop.done.saved");
    showSaveButton = false;
  }
  const guidance = ctx?.nativeSaved ? t("desktop.done.saved") : saved ? "" : renderSaveGuidance(isClean);
  return (
    <div className="dz-view-body dz-completed-section dz-fade-in">
      <div className="dz-completed-header">
        <svg
          className="dz-completed-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <div>
          <h2 className="dz-completed-title">{title}</h2>
          <p className="dz-completed-summary">{summary}</p>
        </div>
      </div>
      <p className="dz-completed-guidance">{guidance}</p>
      <div className="dz-actions-row">
        {callbacks.onOpenOutput ? (
          <button type="button" className="dz-btn-tactile" id="dz-btn-open" onClick={() => callbacks.onOpenOutput?.()}>
            {t("desktop.done.open")}
          </button>
        ) : null}
        {callbacks.onRevealOutput ? (
          <button
            type="button"
            className="dz-btn-secondary"
            id="dz-btn-reveal"
            onClick={() => callbacks.onRevealOutput?.()}
          >
            {t("desktop.done.reveal")}
          </button>
        ) : null}
        {showSaveButton ? (
          <button
            type="button"
            className="dz-btn-tactile"
            id="dz-btn-save"
            style={{ minWidth: "180px" }}
            onClick={() => callbacks.onSave?.()}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t("view.done.saveNow")}
          </button>
        ) : null}
        <button type="button" className="dz-btn-secondary" id="dz-btn-another" onClick={() => callbacks.onReset()}>
          {t("view.done.another")}
        </button>
      </div>
    </div>
  );
}

function FailedView({
  state,
  callbacks,
  ctx,
}: {
  state: ControllerState;
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
}) {
  const error: StructuredError = state.error ?? {
    code: "UNKNOWN",
    category: "unknown",
    retryable: true,
    message: t("view.fail.fallback"),
  };
  const handoffUrl = typeof ctx?.desktopHandoffUrl === "string" ? ctx.desktopHandoffUrl : "";
  const source = typeof ctx?.sourceUrl === "string"
    ? ctx.sourceUrl
    : (typeof ctx?.jobActivity?.url === "string" ? ctx.jobActivity.url : "");
  const isFile = isFileHandoffSource(source);
  const origin = isFile ? "" : handoffOriginFor(handoffUrl, source);
  const label = origin !== "" ? t("view.handoff.sendOrigin", { origin }) : t("view.handoff.send");
  const hostDoc = globalThis.document;
  return (
    <div className="dz-view-body dz-error-section dz-fade-in">
      <div className="dz-error-header">
        <svg
          className="dz-error-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div>
          <h2 className="dz-error-title">{t("view.fail.title")}</h2>
          <p className="dz-error-message" id="dz-error-message">
            {error.message}
          </p>
        </div>
      </div>
      <div className="dz-guidance-section">
        <h3 className="dz-guidance-title">{t("view.display.waysTitle")}</h3>
        <div className="dz-guidance-grid">
          <ExtensionGuideButton onOpen={() => showExtensionGuidance(hostDoc)} />
          <DesktopGuideButton
            onOpen={() => showDesktopAppGuidance(hostDoc)}
            description={t("view.fail.deskDescLimits")}
          />
          <a className="dz-guidance-item" href="./help/finding-the-image-address.html" target="_blank" rel="noopener">
            <div className="dz-guidance-item-header">
              <svg
                className="dz-guidance-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="dz-guidance-item-title">{t("view.fail.helpTitle")}</span>
            </div>
            <span className="dz-guidance-item-desc">{t("view.fail.helpDesc")}</span>
          </a>
        </div>
      </div>
      <details className="dz-details">
        <summary className="dz-summary">
          <span>{t("view.fail.techDetails")}</span>
          <Chevron />
        </summary>
        <div className="dz-diagnostics" id="dz-error-diagnostics">
          {errorDiagnosticsText(error)}
        </div>
        <div className="dz-diagnostics-report">
          <a
            href="https://github.com/lovasoa/dezoomify/issues/new?template=1_bug_report.md"
            target="_blank"
            rel="noopener"
          >
            {t("view.fail.reportBug")}
          </a>
        </div>
      </details>
      <div className="dz-actions-row">
        <button
          type="button"
          className="dz-btn-tactile"
          id="dz-btn-try-again"
          style={{ minWidth: "140px" }}
          onClick={() => (callbacks.onRetrySameUrl ?? callbacks.onReset)()}
        >
          {t("view.fail.retry")}
        </button>
        <button type="button" className="dz-btn-secondary" id="dz-btn-start-over" onClick={() => callbacks.onReset()}>
          {t("view.display.startOver")}
        </button>
        {handoffUrl !== "" && !isFile ? (
          <a
            className="dz-btn-secondary"
            id="dz-btn-desktop-handoff"
            href={handoffUrl}
            onClick={() => {
              try {
                callbacks.onOpenExternalLink?.(handoffUrl);
              } catch {
                // Handoff navigation must never break the error view.
              }
            }}
          >
            {label}
          </a>
        ) : null}
      </div>
      {handoffUrl !== "" && !isFile && origin !== "" ? (
        <p className="dz-notice-message" id="dz-handoff-consent">
          {t("view.handoff.summary", { origin })}
        </p>
      ) : null}
      {isFile ? (
        <p className="dz-notice-message" id="dz-handoff-local">
          {t("view.handoff.localNote")}
        </p>
      ) : null}
    </div>
  );
}

function CancelledView({ callbacks }: { callbacks: ViewCallbacks }) {
  return (
    <div className="dz-view-body dz-notice-section dz-fade-in">
      <h2 className="dz-notice-title" style={{ color: "var(--dz-text-primary)" }}>
        {t("view.cancel.title")}
      </h2>
      <p className="dz-notice-message">{t("view.cancel.message")}</p>
      <div className="dz-actions-row">
        <button type="button" className="dz-btn-secondary" id="dz-btn-reset" onClick={() => callbacks.onReset()}>
          {t("view.display.startOver")}
        </button>
      </div>
    </div>
  );
}

function GenericView({ state, callbacks }: { state: ControllerState; callbacks: ViewCallbacks }) {
  return (
    <div className="dz-view-body dz-fade-in" style={{ padding: "1rem 0" }}>
      <p style={{ color: "var(--dz-text-secondary)" }}>
        Status: <strong>{state.status}</strong>
      </p>
      <button type="button" className="dz-btn-secondary" id="dz-btn-reset" onClick={() => callbacks.onReset()}>
        {t("view.generic.reset")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root renderer.
// ---------------------------------------------------------------------------

function SharedView({
  state,
  callbacks,
  ctx,
}: {
  state: ControllerState;
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
}) {
  const phase = getPhaseForStatus(state.status);
  return (
    <div className="dz-card" data-view-phase={phase}>
      <div className="dz-header" style={{ display: phase === "idle" ? "" : "none" }}>
        <Logo />
      </div>
      {phase === "idle" ? <IdleView callbacks={callbacks} ctx={ctx} /> : null}
      {phase === "job" ? <JobView state={state} callbacks={callbacks} ctx={ctx} /> : null}
      {phase === "display-only" ? <DisplayOnlyView callbacks={callbacks} ctx={ctx} /> : null}
      {phase === "completed" ? <CompletedView callbacks={callbacks} ctx={ctx} /> : null}
      {phase === "failed" ? <FailedView state={state} callbacks={callbacks} ctx={ctx} /> : null}
      {phase === "cancelled" ? <CancelledView callbacks={callbacks} /> : null}
      {phase === "generic" ? <GenericView state={state} callbacks={callbacks} /> : null}
    </div>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

function renderInto(container: HTMLElement, node: ReactElement): void {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  flushSync(() => root!.render(node));
}

export function renderView(
  container: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  renderInto(container, <SharedView state={state} callbacks={callbacks} ctx={ctx} />);
}

// ---------------------------------------------------------------------------
// Overlays (guidance modal, choosers, consent).
// ---------------------------------------------------------------------------

function ModalCard({
  title,
  subtitle,
  body,
  actions,
  showClose = true,
  onClose,
}: {
  title: string;
  subtitle?: string;
  body: ReactNode;
  actions?: ReactNode;
  showClose?: boolean;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="dz-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dz-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dz-modal-card">
        {showClose ? (
          <button
            type="button"
            className="dz-modal-close"
            aria-label={t("view.modal.closeDialog")}
            title={t("view.modal.closeTitle")}
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
        <h2 id="dz-modal-title" className="dz-modal-title">
          {title}
        </h2>
        {subtitle ? <p className="dz-modal-subtitle">{subtitle}</p> : null}
        <div className="dz-modal-body">{body}</div>
        {actions ? <div className="dz-modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

let activeOverlay: { close(): void } | null = null;

function mountOverlay(hostDocument: Document, render: (close: () => void) => ReactElement): { close(): void } {
  activeOverlay?.close();
  const host = hostDocument.createElement("div");
  hostDocument.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (activeOverlay === controller) activeOverlay = null;
    // Detach and unmount synchronously: `close` only runs from an overlay's
    // own event handlers or before the next overlay mounts, never during a
    // render, so the next overlay replaces this one immediately.
    host.remove();
    root.unmount();
  };
  const controller = { close };
  activeOverlay = controller;
  flushSync(() => root.render(render(close)));
  return controller;
}

export function openModal(
  hostDocument: Document,
  title: string,
  subtitle: string,
  contentHtml: string,
): void {
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={title}
      subtitle={subtitle}
      onClose={close}
      body={<div dangerouslySetInnerHTML={{ __html: contentHtml }} />}
      actions={
        <button type="button" className="dz-btn-tactile dz-modal-ok" style={{ minWidth: "100px" }} onClick={close}>
          {t("view.modal.ok")}
        </button>
      }
    />
  ));
}

/** Image picker dialog: explicit choice among discovered images. */
export function openImagePicker(hostDocument: Document, args: ImagePickerArgs): boolean {
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={t("view.pick.imageTitle")}
      onClose={close}
      body={
        <div className="dz-choice-group" role="radiogroup" aria-label={t("view.pick.imageGroup")}>
          {args.options.map((option) => {
            const label =
              option.title ??
              `Image ${option.index + 1}${option.width && option.height ? ` (${option.width}x${option.height})` : ""}`;
            return (
              <button
                key={option.index}
                type="button"
                className="dz-btn-secondary dz-choice-option"
                aria-label={label}
                onClick={() => {
                  close();
                  args.onPick(option.index);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      }
    />
  ));
  return true;
}

/** Level picker dialog: explicit choice among resolutions. */
export function openLevelPicker(hostDocument: Document, args: LevelPickerArgs): boolean {
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={t("view.pick.levelTitle")}
      onClose={close}
      body={
        <div className="dz-choice-group" role="radiogroup" aria-label={t("view.pick.levelGroup")}>
          {args.options.map((option) => {
            const label = `Level ${option.index + 1} (${option.width}x${option.height}, ${option.tiles} tiles${option.fits ? "" : ", too large"})`;
            return (
              <button
                key={option.index}
                type="button"
                className="dz-btn-secondary dz-choice-option"
                aria-label={label}
                onClick={() => {
                  close();
                  args.onPick(option.index);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      }
    />
  ));
  return true;
}

/**
 * Explicit confirm/decline dialog (extension handoff consent). Site-influenced
 * lines render as text, never markup. Initial focus fails safe on decline.
 */
export function openConfirmModal(hostDocument: Document, args: ConfirmModalArgs): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    mountOverlay(hostDocument, (close) => (
      <ConfirmDialog args={args} close={close} resolve={resolve} />
    ));
  });
}

function ConfirmDialog({
  args,
  close,
  resolve,
}: {
  args: ConfirmModalArgs;
  close(): void;
  resolve(value: boolean): void;
}) {
  const declineRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    declineRef.current?.focus();
  }, []);
  const decide = (value: boolean) => {
    close();
    resolve(value);
  };
  return (
    <ModalCard
      title={args.title}
      subtitle={args.subtitle}
      showClose={false}
      onClose={() => decide(false)}
      body={
        <>
          {args.bodyLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </>
      }
      actions={
        <>
          <button
            ref={declineRef}
            type="button"
            className="dz-btn-secondary dz-modal-decline"
            onClick={() => decide(false)}
          >
            {args.declineLabel}
          </button>
          <button
            type="button"
            className="dz-btn-tactile dz-modal-confirm"
            onClick={() => decide(true)}
          >
            {args.confirmLabel}
          </button>
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Guidance dialogs.
// ---------------------------------------------------------------------------

function detectPlatform(hints?: PlatformHints): { name: string; hasInstaller: boolean } {
  const ua = (hints?.userAgent ?? "").toLowerCase();
  const platform = (hints?.platform ?? "").toLowerCase();
  if (ua.includes("win") || platform.includes("win")) return { name: "Windows", hasInstaller: false };
  if (ua.includes("mac") || platform.includes("mac")) return { name: "macOS", hasInstaller: false };
  if (ua.includes("linux") || platform.includes("linux")) return { name: "Linux", hasInstaller: true };
  return { name: "All Platforms", hasInstaller: false };
}

const RELEASES_URL = "https://github.com/lovasoa/dezoomify/releases";

export function showDesktopAppGuidance(hostDocument: Document, hints?: PlatformHints): void {
  const p = detectPlatform(hints);
  const releases = (
    <a href={RELEASES_URL} target="_blank" rel="noopener">
      GitHub Releases
    </a>
  );
  const downloadNote = p.hasInstaller
    ? (
        <>
          Linux installer (.deb, unsigned) is on {releases}. Verify SHA256SUMS and GPG signatures before
          installing. No auto-update; check Releases manually.
        </>
      )
    : (
        <>
          No installer ships for {p.name} yet. Only Linux has a .deb (unsigned) on {releases}.
        </>
      );
  const stepOne = p.hasInstaller
    ? "Save the Linux .deb (unsigned) from our GitHub Releases page, verify SHA256SUMS and signatures, then install it. There is no auto-update."
    : `No installer ships for ${p.name} yet; only Linux has an unsigned .deb on our GitHub Releases page. Meanwhile use the website or CLI.`;
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={t("view.desktop.title")}
      subtitle={t("view.desktop.subtitle")}
      onClose={close}
      body={
        <>
          <div className="dz-modal-download-box">
            <div style={{ fontSize: "0.9rem", color: "var(--dz-text-muted)" }}>{downloadNote}</div>
          </div>
          <div className="dz-modal-section">
            <div className="dz-modal-section-title">{t("view.desktop.whyTitle")}</div>
            <ul className="dz-modal-list">
              <li>
                <strong>{t("view.desktop.why1Title")}</strong> {t("view.desktop.why1Body")}
              </li>
              <li>
                <strong>{t("view.desktop.why2Title")}</strong> {t("view.desktop.why2Body")}
              </li>
              <li>
                <strong>{t("view.desktop.why3Title")}</strong> {t("view.desktop.why3Body")}
              </li>
            </ul>
          </div>
          <div className="dz-modal-section">
            <div className="dz-modal-section-title">{t("view.desktop.howTitle")}</div>
            <div className="dz-modal-steps">
              <div className="dz-modal-step">
                <span className="dz-modal-step-num">1</span>
                <div>{stepOne}</div>
              </div>
              <div className="dz-modal-step">
                <span className="dz-modal-step-num">2</span>
                <div>{t("view.desktop.step2")}</div>
              </div>
              <div className="dz-modal-step">
                <span className="dz-modal-step-num">3</span>
                <div>{t("view.desktop.step3")}</div>
              </div>
            </div>
          </div>
          <div className="dz-modal-cli-box">
            <div className="dz-modal-cli-header">
              <strong>{t("view.desktop.cliTitle")}</strong>
            </div>
            <p className="dz-modal-cli-desc">{t("view.desktop.cliDesc")}</p>
            <div className="dz-modal-cli-links">
              <a
                href="https://github.com/lovasoa/dezoomify/releases/latest"
                target="_blank"
                rel="noopener"
                className="dz-btn-secondary"
                style={{ height: "32px", fontSize: "0.85rem" }}
              >
                {t("view.desktop.cliLink")}
              </a>
              <code
                style={{
                  fontFamily: "var(--dz-font-mono)",
                  fontSize: "0.82rem",
                  padding: "0.35rem 0.6rem",
                  background: "rgba(0,0,0,0.04)",
                  borderRadius: "4px",
                  border: "1px solid var(--dz-surface-border)",
                }}
              >
                cargo install dezoomify-cli
              </code>
            </div>
          </div>
        </>
      }
    />
  ));
}

const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm";

export function showExtensionGuidance(hostDocument: Document): void {
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={t("view.ext.title")}
      subtitle={t("view.ext.subtitle")}
      onClose={close}
      body={
        <>
          <div className="dz-modal-stores">
            <a href={CHROME_STORE_URL} target="_blank" rel="noopener" className="dz-btn-store">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="4" />
                <line x1="21.17" y1="8" x2="12" y2="8" />
                <line x1="3.95" y1="6.06" x2="8.54" y2="14" />
                <line x1="10.88" y1="21.94" x2="15.46" y2="14" />
              </svg>
              <div>
                <div style={storeLabelStyle}>{t("view.ext.availableOn")}</div>
                <div style={storeNameStyle}>{t("view.ext.chromeStore")}</div>
              </div>
            </a>
            <div className="dz-btn-store" aria-disabled="true">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a10 10 0 0 1 10 10c0 5.52-4.48 10-10 10S2 17.52 2 12c0-2.5 1-4.8 2.6-6.5C7.2 9 8 13 12 14c0-2 1-3.5 2.5-4.5C13 8 11.5 6 12 2z" />
              </svg>
              <div>
                <div style={storeLabelStyle}>{t("view.ext.firefoxVersion")}</div>
                <div style={storeNameStyle}>{t("view.ext.firefoxSoon")}</div>
              </div>
            </div>
          </div>
          <div className="dz-modal-section">
            <div className="dz-modal-section-title">{t("view.ext.whyTitle")}</div>
            <ul className="dz-modal-list">
              <li>
                <strong>{t("view.ext.why1Title")}</strong> {t("view.ext.why1Body")}
              </li>
              <li>
                <strong>{t("view.ext.why2Title")}</strong> {t("view.ext.why2Body")}
              </li>
              <li>
                <strong>{t("view.ext.why3Title")}</strong> {t("view.ext.why3Body")}
              </li>
            </ul>
          </div>
          <div className="dz-modal-section">
            <div className="dz-modal-section-title">{t("view.ext.howTitle")}</div>
            <div className="dz-modal-steps">
              <div className="dz-modal-step">
                <span className="dz-modal-step-num">1</span>
                <div>{t("view.ext.step1")}</div>
              </div>
              <div className="dz-modal-step">
                <span className="dz-modal-step-num">2</span>
                <div>{t("view.ext.step2")}</div>
              </div>
              <div className="dz-modal-step">
                <span className="dz-modal-step-num">3</span>
                <div>{t("view.ext.step3")}</div>
              </div>
            </div>
          </div>
        </>
      }
    />
  ));
}

const storeLabelStyle = { fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.8 } as const;
const storeNameStyle = { fontWeight: 700, fontSize: "0.98rem" } as const;
