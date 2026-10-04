// Host-neutral React views for progress, interaction, and output.

import type { Error as JobError } from "@dezoomify/wasm-bindings";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { JobActivity } from "./activity.ts";
import { canRetry, httpStatusOf, plainMessageFor } from "./failure.ts";
import { HistorySection } from "./history-view.tsx";
import type { Presentation, ResolutionChoice } from "./presentation.ts";
import { displaySourceUrl, hostFromUrl } from "./view-helpers.ts";
import type { PlatformHints, ViewCallbacks, ViewContext, ViewRenderOptions } from "./view-types.ts";

export { DEFAULT_PAGE_TITLE, jobPageTitle } from "./view-helpers.ts";
export type {
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

// Presentational atoms.

function Logo() {
  const gradientId = useId();
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
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="251.05606"
            y1="282.41232"
            x2="293.92065"
            y2="241.85672"
          >
            <stop offset="0" stopColor="#58a1bf" />
            <stop offset="1" stopColor="#a2c9de" stopOpacity="0.90588236" />
          </linearGradient>
        </defs>
        <path
          fill="#6c5353"
          fillOpacity="0.11594203"
          transform="translate(0,-698.0315)"
          d="M 83.710606,948.58088 A 122.13954,122.13954 0 0 1 37.901269,782.15626 122.13954,122.13954 0 0 1 204.26357,736.12113 122.13954,122.13954 0 0 1 250.52441,902.42081 122.13954,122.13954 0 0 1 84.287665,948.90728"
        />
        <path
          fill="#4197a6"
          d="m 154.32031,21.091797 0,100.894533 108.07422,0 C 256.62352,85.756403 234.66245,54.12864 202.73242,36.0625 187.83856,27.697292 171.33637,22.594244 154.32031,21.091797 Z m -30,0.900391 C 88.197456,27.781284 56.660431,49.666787 38.597656,81.480469 31.501875,94.028417 26.715096,107.74774 24.464844,121.98633 l 99.855466,0 z M 23.550781,151.98633 c 3.575842,39.19425 26.066341,74.1725 60.242188,93.6914 L 84.363281,246 c 12.398491,6.93578 25.925759,11.6245 39.957029,13.84961 l 0,-107.86328 z"
        />
        <path
          fill={`url(#${gradientId})`}
          d="M 140.3457 8.6230469 C 56.270852 8.3744884 -10.235031 100.61646 17.734375 180.42383 C 38.056167 255.25884 129.99325 294.54279 198.59375 262.98438 C 225.21791 289.4878 251.60761 316.23724 278.37891 342.58594 C 290.08216 352.81624 307.73827 347.85209 316.35547 336.21289 C 325.52592 327.01519 338.33053 317.14224 334.73828 302.33594 C 331.18645 288.66717 318.0239 281.06875 309.24219 270.84375 C 290.84223 252.44381 272.44097 234.04254 254.04102 215.64258 C 305.83251 145.35252 264.77782 33.617236 179.82031 13.535156 C 168.29224 10.331886 156.32486 8.7030181 144.36328 8.7050781 C 143.02021 8.6541064 141.68022 8.6269922 140.3457 8.6230469 z M 149.70703 25.470703 A 115.05109 115.05109 0 0 1 201.13867 40.261719 A 115.05109 115.05109 0 0 1 244.71484 196.91016 A 115.05109 115.05109 0 0 1 88.125 240.69922 L 87.582031 240.39062 A 115.05109 115.05109 0 0 1 44.429688 83.625 A 115.05109 115.05109 0 0 1 149.70703 25.470703 z "
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

function IdleView({
  callbacks,
  ctx,
  options,
}: {
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
  options?: ViewRenderOptions;
}) {
  const [selection, setSelection] = useState<{ url: string }>();
  return (
    <>
      <div className="dz-view-body dz-fade-in">
        <div className="dz-description">
          <p>{t("view.input.description")}</p>
        </div>
        <UrlInput
          initialUrl={ctx?.initialUrl}
          selection={selection}
          onSubmit={callbacks.onSubmitUrl}
        />
      </div>
      {options?.idleBeforeHistory}
      <HistorySection
        callbacks={callbacks}
        ctx={ctx}
        onSelect={(entry) => setSelection({ url: entry.url })}
      />
    </>
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
  hostDocument,
}: {
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
  hostDocument: Document;
}) {
  const guidance = renderSaveGuidance(false);
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
  const source =
    typeof ctx?.sourceUrl === "string"
      ? ctx.sourceUrl
      : typeof ctx?.jobActivity?.url === "string"
        ? ctx.jobActivity.url
        : "";
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
            {plainMessageFor(error, hostFromUrl(source))}
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
      </div>
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
      error={presentation.error}
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
      {phase === "idle" ? <IdleView callbacks={callbacks} ctx={ctx} options={options} /> : null}
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
