// Host-neutral React views for progress, interaction, and output.

import type { Error as JobError } from "@dezoomify/wasm-bindings";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { JobActivity } from "./activity.ts";
import { canRetry, httpStatusOf, plainMessageFor } from "./failure.ts";
import type { HistoryEntry } from "./history.ts";
import type { Presentation, ResolutionChoice } from "./presentation.ts";
import {
  displaySourceUrl,
  handoffOriginFor,
  hostFromUrl,
  isFileHandoffSource,
} from "./view-helpers.ts";
import type {
  ConfirmModalArgs,
  PlatformHints,
  ViewCallbacks,
  ViewContext,
  ViewRenderOptions,
} from "./view-types.ts";

export {
  DEFAULT_PAGE_TITLE,
  handoffOriginFor,
  isFileHandoffSource,
  jobPageTitle,
} from "./view-helpers.ts";
export type {
  ConfirmModalArgs,
  PlatformHints,
  ViewCallbacks,
  ViewContext,
  ViewPhase,
  ViewRenderOptions,
} from "./view-types.ts";

import { formatElapsed, renderCompletion, renderSaveGuidance } from "./components.ts";
import { DiagnosticDetails } from "./diagnostic-details.tsx";
import { t } from "./i18n.ts";
import { UrlInput } from "./url-input.tsx";

// Pure helpers (host-neutral, no DOM).

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

// Presentational atoms.

function Logo() {
  return (
    <h1 className="dz-product-mark">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 355 355"
        width="30"
        height="30"
        aria-hidden="true"
        style={{ verticalAlign: "middle", display: "inline-block" }}
      >
        <path
          fill="#ff8080"
          d="m154.32 21.09v100.89h108.07c-5.77-36.22-27.73-67.85-59.66-85.92-14.89-8.36-31.39-13.47-48.41-14.97Zm-30 .9C88.2 27.78 56.66 49.67 38.6 81.48c-7.1 12.55-11.88 26.27-14.14 40.51h99.86ZM23.55 151.99c3.58 39.19 26.07 74.17 60.24 93.69l.57.32c12.4 6.94 25.93 11.62 39.96 13.85V151.99Z"
        />
        <path
          fill="#3c7bff"
          d="M140.35 8.62C56.27 8.37-10.24 100.62 17.73 180.42c20.33 74.84 112.26 114.12 180.86 82.56 26.63 26.51 53.02 53.26 79.79 79.61 11.7 10.23 29.36 5.26 37.98-6.38 9.17-9.19 21.97-19.07 18.38-33.87-3.55-13.67-16.72-21.27-25.5-31.5l-55.2-55.2c51.79-70.29 10.74-182.01-74.22-202.1a134.2 134.2 0 0 0-39.47-4.92Zm9.36 16.85a115.05 115.05 0 0 1 51.43 14.79 115.05 115.05 0 0 1 43.58 156.65 115.05 115.05 0 0 1-156.59 43.79l-.54-.31A115.05 115.05 0 0 1 44.43 83.63 115.05 115.05 0 0 1 149.71 25.47Z"
        />
      </svg>
      <span>Dezoomify</span>
    </h1>
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

/**
 * Browser-limits notice: automatic selection took a smaller known level, so
 * the banner names the selected and maximum resolutions and offers the
 * desktop app, a maximum retry, and (while the job runs) stop. Hosts opt in
 * by supplying `onTryMaximum`; the desktop product never does.
 */
function ResolutionNotice({
  choice,
  callbacks,
  running,
  hostDocument,
}: {
  choice: ResolutionChoice;
  callbacks: ViewCallbacks;
  running: boolean;
  hostDocument: Document;
}) {
  const dims = (size: { width: number; height: number }) => `${size.width}×${size.height}`;
  return (
    <div className="dz-resolution-notice" id="dz-resolution-notice">
      <svg
        className="dz-notice-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div className="dz-resolution-text">
        <p className="dz-notice-message" id="dz-resolution-message">
          {t("view.resolution.notice")}
        </p>
        <p className="dz-resolution-sizes" id="dz-resolution-sizes">
          {t("view.resolution.sizes", {
            selected: dims(choice.selected),
            maximum: dims(choice.maximum),
          })}
        </p>
      </div>
      <div className="dz-resolution-actions">
        <button
          type="button"
          className="dz-resolution-download"
          id="dz-btn-download-desktop"
          onClick={() => showDesktopAppGuidance(hostDocument)}
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
          {t("view.resolution.download")}
        </button>
        <button
          type="button"
          className="dz-btn-secondary"
          id="dz-btn-try-maximum"
          onClick={() => callbacks.onTryMaximum?.()}
        >
          {t("view.resolution.tryMaximum")}
        </button>
        {running ? (
          <button
            type="button"
            className="dz-btn-secondary dz-resolution-stop"
            id="dz-btn-resolution-stop"
            onClick={() => callbacks.onCancel()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" />
            </svg>
            {t("view.resolution.stop")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Resolution notice for hosts that offer "Try maximum" (website and extension). */
function resolutionNoticeOf(
  presentation: Presentation,
  callbacks: ViewCallbacks,
  running: boolean,
  hostDocument: Document,
): ReactElement | null {
  const choice = callbacks.onTryMaximum ? presentation.resolution : undefined;
  if (!choice) return null;
  return (
    <ResolutionNotice
      choice={choice}
      callbacks={callbacks}
      running={running}
      hostDocument={hostDocument}
    />
  );
}

// Input / history.

function HistorySection({ callbacks, ctx }: { callbacks: ViewCallbacks; ctx?: ViewContext }) {
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
          {entries.slice(0, 20).map((entry) => {
            const parts = [entry.url || entry.origin];
            const dims = historyDimsLabel(entry);
            const date = historyDateLabel(entry.at);
            if (dims !== "") parts.push(dims);
            if (typeof entry.format === "string" && entry.format !== "") parts.push(entry.format);
            if (date !== "") parts.push(date);
            return (
              <li className="dz-history-item" key={`${entry.at}-${entry.url}`}>
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
  return (
    <div className="dz-view-body dz-fade-in">
      <div className="dz-description">
        <p>{t("view.input.description")}</p>
      </div>
      <UrlInput initialUrl={ctx?.initialUrl} onSubmit={callbacks.onSubmitUrl} />
    </div>
  );
}

// Live job.

interface JobDerived {
  paused: boolean;
  step: string;
  detail?: string;
  sourceUrl: string;
  timeText: string;
  countsText: string;
  determinate: boolean;
  current: number;
  total: number;
  active: number;
  donePct: number;
  activePct: number;
}

function deriveJob(presentation: Presentation, ctx?: ViewContext): JobDerived {
  // Clock readings are host-injected through `jobActivity.now`; the view never
  // reads a global clock. Hosts without job timing get the zero epoch.
  const activity: JobActivity = ctx?.jobActivity ?? { now: 0 };
  const current = presentation.progress?.current ?? 0;
  const total = presentation.progress?.total ?? 0;
  const determinate = total > 0;
  const donePct = determinate ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
  const active = determinate
    ? Math.max(0, Math.min(ctx?.currentProgress?.active ?? 0, Math.max(0, total - current)))
    : 0;
  const activePct = determinate ? (active / total) * 100 : 0;
  const retrying = Math.max(0, Math.min(ctx?.currentProgress?.retrying ?? 0, active));
  const paused = presentation.paused || activity.paused === true;
  const now = activity.now;
  const startedAt = activity.startedAt ?? now;
  const timerNow = activity.pausedAt ?? now;
  const elapsedMs = Math.max(0, timerNow - startedAt - (activity.pausedDurationMs ?? 0));
  const elapsed = formatElapsed(elapsedMs);
  const lastProgressAt = activity.lastProgressAt ?? startedAt;
  const stalledMs = Math.max(0, timerNow - lastProgressAt);
  const showStalled = stalledMs >= 10000 && presentation.headlineKey !== "view.step.saving";
  const detail = presentation.detailKey
    ? t(presentation.detailKey, presentation.detailVars)
    : undefined;
  const step = paused
    ? t("view.job.paused")
    : retrying > 0
      ? t("view.job.retryingTiles", { count: retrying })
      : showStalled
        ? t("view.job.waiting", { host: hostFromUrl(activity.url) })
        : t(presentation.headlineKey, presentation.headlineVars);
  const sourceUrl = activity.url ? displaySourceUrl(activity.url) : "";
  const estimatedTotalMs =
    ctx?.currentProgress?.estimatedTotalMs ??
    (determinate && current >= 2 && elapsedMs >= 2000
      ? Math.round((elapsedMs / current) * total)
      : undefined);
  const timeText = elapsed
    ? `${elapsed}${typeof estimatedTotalMs === "number" && estimatedTotalMs > elapsedMs ? ` / ~${formatElapsed(estimatedTotalMs)}` : ""}`
    : "";
  const countsText = determinate
    ? active > 0
      ? t("view.job.countsActive", { current, total, active })
      : t("view.job.countsFull", { current, total })
    : "";
  return {
    paused,
    step,
    ...(detail ? { detail } : {}),
    sourceUrl,
    timeText,
    countsText,
    determinate,
    current,
    total,
    active,
    donePct,
    activePct,
  };
}

function JobView({
  presentation,
  callbacks,
  ctx,
  hostDocument,
}: {
  presentation: Presentation;
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
  hostDocument: Document;
}) {
  const d = deriveJob(presentation, ctx);
  if (presentation.decision) {
    const missing = presentation.decision?.missing ?? [];
    const refused =
      missing.length > 0 &&
      missing.every(({ failures }) => {
        const failure = failures.at(-1);
        const status = failure ? httpStatusOf(failure) : undefined;
        return status === 401 || status === 403;
      });
    return (
      <section className="dz-view-body dz-partial-section" aria-labelledby="dz-partial-title">
        <h2 id="dz-partial-title">{t("view.partial.title")}</h2>
        <p>{t("view.partial.summary", { done: d.current, total: d.total })}</p>
        <p>{t(refused ? "view.partial.refused" : "view.partial.gaps")}</p>
      </section>
    );
  }
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
        <span className="dz-job-source-label">{t("view.job.sourceLabel")}</span>
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
          {d.detail ? (
            <span className="dz-progress-step-detail" id="dz-job-step-detail">
              {d.detail}
            </span>
          ) : null}
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
            aria-label={t("view.job.pause")}
            title={t("view.job.pause")}
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
            aria-label={t("view.job.resume")}
            title={t("view.job.resume")}
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
            aria-label={t("view.job.stopReturn")}
            title={t("view.job.stopReturn")}
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
              ? t("view.job.progressValue", {
                  done: d.current,
                  active: d.active,
                  remaining: Math.max(0, d.total - d.current - d.active),
                })
              : d.step
          }
        >
          <div
            className="dz-progress-done"
            id="dz-job-bar"
            style={{ width: d.determinate ? `${d.donePct}%` : "35%" }}
          />
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
      {resolutionNoticeOf(presentation, callbacks, true, hostDocument)}
    </div>
  );
}

// Display-only, completed, failed, cancelled, generic.

function DisplayOnlyView({
  callbacks,
  ctx,
  hostDocument,
}: {
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
  hostDocument: Document;
}) {
  const guidance = renderSaveGuidance(false);
  const handoffUrl = typeof ctx?.desktopHandoffUrl === "string" ? ctx.desktopHandoffUrl : "";
  const handoffSource = typeof ctx?.sourceUrl === "string" ? ctx.sourceUrl : "";
  const handoffOrigin = handoffOriginFor(handoffUrl, handoffSource);
  const handoffLabel =
    handoffOrigin !== ""
      ? t("view.handoff.sendOrigin", { origin: handoffOrigin })
      : t("view.handoff.send");
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
          <ExtensionGuideButton onOpen={() => showExtensionGuidance(hostDocument)} />
          <DesktopGuideButton
            onOpen={() => showDesktopAppGuidance(hostDocument)}
            description={t("view.display.deskDescClean")}
          />
        </div>
      </div>
      <div className="dz-actions-row">
        {callbacks.onReset ? (
          <button
            type="button"
            className="dz-btn-secondary"
            id="dz-btn-reset"
            onClick={() => callbacks.onReset?.()}
          >
            {t("view.display.startOver")}
          </button>
        ) : null}
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

function CompletedView({
  presentation,
  callbacks,
  hostDocument,
}: {
  presentation: Presentation;
  callbacks: ViewCallbacks;
  hostDocument: Document;
}) {
  const [outputAction, setOutputAction] = useState<"open" | "folder" | null>(null);
  const [outputError, setOutputError] = useState<{
    action: "open" | "folder";
    kind: string;
  } | null>(null);
  async function runOutputAction(action: "open" | "folder", callback?: () => Promise<void>) {
    if (!callback || outputAction) return;
    setOutputError(null);
    setOutputAction(action);
    try {
      await callback();
    } catch (error) {
      const kind =
        error && typeof error === "object" && "kind" in error && typeof error.kind === "string"
          ? error.kind
          : "invoke-failed";
      setOutputError({ action, kind });
    } finally {
      setOutputAction(null);
    }
  }
  const output = presentation.output;
  const canvas = output?.canvas;
  const saved =
    output?.disposition === "native-publication" ||
    output?.disposition === "browser-save-initiated";
  const title = saved
    ? t(output.missing.length === 0 ? "desktop.done.title" : "desktop.done.partial")
    : t("view.done.readyTitle");
  const summary = saved
    ? canvas
      ? t("desktop.done.size", { width: canvas.width, height: canvas.height })
      : t("desktop.done.saved")
    : canvas
      ? renderCompletion(canvas.width, canvas.height, `image/${output.format}`)
      : t("view.done.ready");
  const showSaveButton = output?.disposition === "browser-save-ready" && !!callbacks.onSave;
  const guidance = saved ? t("desktop.done.saved") : renderSaveGuidance(true);
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
      {resolutionNoticeOf(presentation, callbacks, false, hostDocument)}
      <div className="dz-actions-row">
        {callbacks.onOpenOutput ? (
          <button
            type="button"
            className="dz-btn-tactile"
            id="dz-btn-open"
            disabled={outputAction !== null}
            onClick={() => void runOutputAction("open", callbacks.onOpenOutput)}
          >
            {t("desktop.done.open")}
          </button>
        ) : null}
        {callbacks.onRevealOutput ? (
          <button
            type="button"
            className="dz-btn-secondary"
            id="dz-btn-reveal"
            disabled={outputAction !== null}
            onClick={() => void runOutputAction("folder", callbacks.onRevealOutput)}
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
        {callbacks.onReset ? (
          <button
            type="button"
            className="dz-btn-secondary"
            id="dz-btn-another"
            onClick={() => callbacks.onReset?.()}
          >
            {t("view.done.another")}
          </button>
        ) : null}
      </div>
      {outputError ? (
        <p id="dz-open-error" role="alert">
          {t(
            outputError.kind === "output-not-found"
              ? "desktop.done.missingError"
              : outputError.action === "folder"
                ? "desktop.done.folderError"
                : "desktop.done.openError",
          )}{" "}
          ({outputError.kind})
        </p>
      ) : null}
    </div>
  );
}

function FailedView({
  presentation,
  callbacks,
  ctx,
  hostDocument,
}: {
  presentation: Presentation;
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
  hostDocument: Document;
}) {
  const error: JobError = presentation.error ?? { kind: "internal" };
  const handoffUrl = typeof ctx?.desktopHandoffUrl === "string" ? ctx.desktopHandoffUrl : "";
  const source =
    typeof ctx?.sourceUrl === "string"
      ? ctx.sourceUrl
      : typeof ctx?.jobActivity?.url === "string"
        ? ctx.jobActivity.url
        : "";
  const isFile = isFileHandoffSource(source);
  const origin = isFile ? "" : handoffOriginFor(handoffUrl, source);
  const label = origin !== "" ? t("view.handoff.sendOrigin", { origin }) : t("view.handoff.send");
  if (error.kind === "no-usable-tiles") {
    const status = httpStatusOf(error);
    const refused = status === 401 || status === 403;
    return (
      <section className="dz-view-body dz-error-section">
        <h2>{t(refused ? "view.partial.accessDenied" : "view.partial.empty")}</h2>
        <p>{t("view.partial.noneSaved")}</p>
        {callbacks.onOpenSource ? <p>{t("view.partial.checkSource")}</p> : null}
        <div className="dz-actions-row">
          {callbacks.onOpenSource ? (
            <button type="button" className="dz-btn-tactile" onClick={callbacks.onOpenSource}>
              {t("view.partial.openSource")}
            </button>
          ) : null}
          {canRetry(error) && callbacks.onRetrySameUrl ? (
            <button type="button" className="dz-btn-secondary" onClick={callbacks.onRetrySameUrl}>
              {t("view.fail.retry")}
            </button>
          ) : null}
          {callbacks.onReset ? (
            <button type="button" className="dz-btn-secondary" onClick={callbacks.onReset}>
              {t("view.display.startOver")}
            </button>
          ) : null}
        </div>
      </section>
    );
  }
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
            {plainMessageFor(error, hostFromUrl(source), source)}
          </p>
        </div>
      </div>
      <div className="dz-guidance-section">
        <h3 className="dz-guidance-title">{t("view.display.waysTitle")}</h3>
        <div className="dz-guidance-grid">
          <ExtensionGuideButton onOpen={() => showExtensionGuidance(hostDocument)} />
          <DesktopGuideButton
            onOpen={() => showDesktopAppGuidance(hostDocument)}
            description={t("view.fail.deskDescLimits")}
          />
          <a
            className="dz-guidance-item"
            href="./help/finding-the-image-address.html"
            target="_blank"
            rel="noopener"
          >
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
      <div className="dz-actions-row">
        {canRetry(error) && callbacks.onRetrySameUrl ? (
          <button
            type="button"
            className="dz-btn-tactile"
            id="dz-btn-try-again"
            style={{ minWidth: "140px" }}
            onClick={() => callbacks.onRetrySameUrl?.()}
          >
            {t("view.fail.retry")}
          </button>
        ) : null}
        {callbacks.onReset ? (
          <button
            type="button"
            className="dz-btn-secondary"
            id="dz-btn-start-over"
            onClick={() => callbacks.onReset?.()}
          >
            {t("view.display.startOver")}
          </button>
        ) : null}
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
        {callbacks.onReset ? (
          <button
            type="button"
            className="dz-btn-secondary"
            id="dz-btn-reset"
            onClick={() => callbacks.onReset?.()}
          >
            {t("view.display.startOver")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Root renderer.

function SharedView({
  presentation,
  callbacks,
  ctx,
  options,
  hostDocument,
}: {
  presentation: Presentation;
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
  options?: ViewRenderOptions;
  hostDocument: Document;
}) {
  const phase = presentation.phase;
  const diagnostics = ctx?.diagnosticReport ? (
    <DiagnosticDetails
      key={ctx.diagnosticReport.id}
      report={ctx.diagnosticReport}
      callbacks={callbacks}
    />
  ) : null;
  if (options?.replace)
    return (
      <>
        {options.replace}
        {diagnostics}
      </>
    );
  return (
    <div className="dz-card" data-view-phase={phase}>
      <div className="dz-header" style={{ display: phase === "idle" ? "" : "none" }}>
        <Logo />
      </div>
      {phase === "idle" ? <IdleView callbacks={callbacks} ctx={ctx} /> : null}
      {phase === "idle" ? options?.idleBeforeHistory : null}
      {phase === "idle" ? <HistorySection callbacks={callbacks} ctx={ctx} /> : null}
      {phase === "job" ? (
        <JobView
          presentation={presentation}
          callbacks={callbacks}
          ctx={ctx}
          hostDocument={hostDocument}
        />
      ) : null}
      {phase === "display-only" ? (
        <DisplayOnlyView callbacks={callbacks} ctx={ctx} hostDocument={hostDocument} />
      ) : null}
      {phase === "completed" ? (
        <CompletedView
          key={ctx?.outputKey}
          presentation={presentation}
          callbacks={callbacks}
          hostDocument={hostDocument}
        />
      ) : null}
      {phase === "failed" ? (
        <FailedView
          presentation={presentation}
          callbacks={callbacks}
          ctx={ctx}
          hostDocument={hostDocument}
        />
      ) : null}
      {phase === "cancelled" ? <CancelledView callbacks={callbacks} /> : null}
      {options?.after}
      {phase !== "idle" ? diagnostics : null}
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
  flushSync(() => root?.render(node));
}

export function renderView(
  container: HTMLElement,
  presentation: Presentation,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
  options?: ViewRenderOptions,
): void {
  renderInto(
    container,
    <SharedView
      presentation={presentation}
      callbacks={callbacks}
      ctx={ctx}
      options={options}
      hostDocument={container.ownerDocument}
    />,
  );
}

// Overlays (guidance modal, choosers, consent).

function ModalCard({
  id,
  title,
  subtitle,
  body,
  actions,
  hostDocument,
  showClose = true,
  onClose,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  body: ReactNode;
  actions?: ReactNode;
  hostDocument: Document;
  showClose?: boolean;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    hostDocument.addEventListener("keydown", onKey);
    return () => hostDocument.removeEventListener("keydown", onKey);
  }, [hostDocument, onClose]);
  return (
    <div
      id={id}
      className="dz-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dz-modal-title"
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

function mountOverlay(
  hostDocument: Document,
  render: (close: () => void) => ReactElement,
): { close(): void } {
  activeOverlay?.close();
  const host = hostDocument.createElement("div");
  hostDocument.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (activeOverlay === overlay) activeOverlay = null;
    // Detach and unmount synchronously: `close` only runs from an overlay's
    // own event handlers or before the next overlay mounts, never during a
    // render, so the next overlay replaces this one immediately.
    host.remove();
    root.unmount();
  };
  const overlay = { close };
  activeOverlay = overlay;
  flushSync(() => root.render(render(close)));
  return overlay;
}

export function openModal(
  hostDocument: Document,
  title: string,
  subtitle: string,
  content: ReactNode,
): void {
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={title}
      subtitle={subtitle}
      hostDocument={hostDocument}
      onClose={close}
      body={<div>{content}</div>}
      actions={
        <button
          type="button"
          className="dz-btn-tactile dz-modal-ok"
          style={{ minWidth: "100px" }}
          onClick={close}
        >
          {t("view.modal.ok")}
        </button>
      }
    />
  ));
}

/**
 * Explicit confirm/decline dialog for untrusted incoming deep links.
 * Site-influenced lines render as text, never markup. Initial focus fails
 * safe on decline.
 */
export function openConfirmModal(hostDocument: Document, args: ConfirmModalArgs): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    mountOverlay(hostDocument, (close) => (
      <ConfirmDialog args={args} close={close} resolve={resolve} hostDocument={hostDocument} />
    ));
  });
}

function ConfirmDialog({
  args,
  close,
  resolve,
  hostDocument,
}: {
  args: ConfirmModalArgs;
  close(): void;
  resolve(value: boolean): void;
  hostDocument: Document;
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
      id={args.id}
      title={args.title}
      subtitle={args.subtitle}
      hostDocument={hostDocument}
      showClose={false}
      onClose={() => decide(false)}
      body={args.bodyLines.map((line) => <p key={line}>{line}</p>)}
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

// Guidance dialogs.

function detectPlatform(hints?: PlatformHints): { name: string; installer: string } {
  const ua = (hints?.userAgent ?? "").toLowerCase();
  const platform = (hints?.platform ?? "").toLowerCase();
  if (ua.includes("win") || platform.includes("win"))
    return { name: "Windows", installer: t("view.desktop.installerMsi") };
  if (ua.includes("mac") || platform.includes("mac"))
    return { name: "macOS", installer: t("view.desktop.installerDmg") };
  if (ua.includes("linux") || platform.includes("linux"))
    return { name: "Linux", installer: t("view.desktop.installerDeb") };
  return {
    name: t("view.desktop.platformGeneric"),
    installer: t("view.desktop.installerGeneric"),
  };
}

const RELEASES_URL = "https://github.com/lovasoa/dezoomify/releases/latest";

export function showDesktopAppGuidance(hostDocument: Document, hints?: PlatformHints): void {
  const p = detectPlatform(hints);
  const releases = (
    <a href={RELEASES_URL} target="_blank" rel="noopener">
      {t("view.desktop.releasesLink")}
    </a>
  );
  const downloadNote = (
    <>
      {t("view.desktop.installer", { platform: p.name, installer: p.installer })} {releases}.{" "}
      {t("view.desktop.releasesNote")}
    </>
  );
  const stepOne = t("view.desktop.step1", { platform: p.name, installer: p.installer });
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={t("view.desktop.title")}
      subtitle={t("view.desktop.subtitle")}
      hostDocument={hostDocument}
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
const FIREFOX_STORE_URL = "https://addons.mozilla.org/en-US/firefox/addon/dezoomify/";

export function showExtensionGuidance(hostDocument: Document): void {
  mountOverlay(hostDocument, (close) => (
    <ModalCard
      title={t("view.ext.title")}
      subtitle={t("view.ext.subtitle")}
      hostDocument={hostDocument}
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
            <a href={FIREFOX_STORE_URL} target="_blank" rel="noopener" className="dz-btn-store">
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
                <div style={storeLabelStyle}>{t("view.ext.availableOn")}</div>
                <div style={storeNameStyle}>{t("view.ext.firefoxStore")}</div>
              </div>
            </a>
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

const storeLabelStyle = {
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.8,
} as const;
const storeNameStyle = { fontWeight: 700, fontSize: "0.98rem" } as const;
