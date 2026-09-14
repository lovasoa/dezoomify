import { useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";
import { t } from "@dezoomify/shared-ui";
import type { ControllerState, ViewRenderOptions } from "@dezoomify/shared-ui";
import { NATIVE_FORMATS } from "./desktopIntegration.ts";
import type { NativeFormat } from "./desktopIntegration.ts";
import { formatMissingSummary } from "./errorCopy.ts";
import type { PendingDecision } from "./jobController.ts";
import { summarizeDesktopQueue } from "./queue.ts";
import type { DesktopQueue, DesktopQueueEntry, DesktopQueueStatus } from "./queue.ts";
import type { DesktopSettings } from "./settings.ts";
import { DesktopSettingsView } from "./settingsView.tsx";

const FORMAT_LABELS: Record<NativeFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  tiff: "TIFF",
  zif: "ZIF",
  webp: "WebP",
  "iiif-dir": "IIIF folder",
};

function OutputFormatField({
  value,
  onChange,
}: {
  value: NativeFormat;
  onChange(value: NativeFormat): void;
}) {
  return (
    <fieldset id="dz-output-format-group" className="dz-output-format">
      <legend className="dz-notice-message">{t("desktop.panel.outputFormat")}</legend>
      {NATIVE_FORMATS.map((format) => (
        <label className="dz-output-format-option" key={format}>
          <input
            type="radio"
            name="dz-output-format"
            value={format}
            checked={value === format}
            onChange={() => onChange(format)}
          />
          <span>{FORMAT_LABELS[format]}</span>
        </label>
      ))}
    </fieldset>
  );
}

function queueStatusLabel(status: DesktopQueueStatus): string {
  const keys = {
    active: "desktop.queue.statusActive",
    done: "desktop.queue.statusDone",
    failed: "desktop.queue.statusFailed",
    cancelled: "desktop.queue.statusCancelled",
    queued: "desktop.queue.statusQueued",
  } as const;
  return t(keys[status]);
}

function QueueEntryLabel({ entry }: { entry: DesktopQueueEntry }) {
  return (
    <span className="dz-queue-label">
      {entry.origin || t("desktop.queue.unknownOrigin")} - {queueStatusLabel(entry.status)}
      {entry.status === "active" && entry.progress.total > 0
        ? ` - ${t("desktop.queue.progress", {
            current: entry.progress.acquired,
            total: entry.progress.total,
          })}`
        : null}
      {entry.status === "failed" && entry.errorCode ? ` - ${entry.errorCode}` : null}
    </span>
  );
}

function QueueEntryActions({
  entry,
  onCancel,
  onRetry,
}: {
  entry: DesktopQueueEntry;
  onCancel(id: string): void;
  onRetry(id: string): void;
}) {
  if (entry.status === "queued" || entry.status === "active") {
    return (
      <div className="dz-actions-row">
        <button type="button" className="dz-btn-secondary" onClick={() => onCancel(entry.id)}>
          {t("desktop.queue.cancel")}
        </button>
      </div>
    );
  }
  if (entry.status === "failed" || entry.status === "cancelled") {
    return (
      <div className="dz-actions-row">
        <button type="button" className="dz-btn-tactile" onClick={() => onRetry(entry.id)}>
          {t("desktop.queue.retry")}
        </button>
      </div>
    );
  }
  return null;
}

function DesktopQueuePanel({
  queue,
  onCancel,
  onRetry,
  onCancelAll,
}: {
  queue: DesktopQueue;
  onCancel(id: string): void;
  onRetry(id: string): void;
  onCancelAll(): void;
}) {
  const summary = summarizeDesktopQueue(queue);
  return (
    <section className="dz-queue-panel" aria-labelledby="dz-queue-title">
      <h2 className="dz-notice-title" id="dz-queue-title">
        {t("desktop.queue.title")}
      </h2>
      <p className="dz-notice-message" role="status" aria-live="polite">
        {t("desktop.queue.summary", {
          succeeded: summary.succeeded,
          failed: summary.failed,
          total: summary.total,
        })}
      </p>
      <ul className="dz-queue-list">
        {queue.entries.map((entry) => (
          <li className="dz-queue-item" key={entry.id}>
            <QueueEntryLabel entry={entry} />
            <QueueEntryActions entry={entry} onCancel={onCancel} onRetry={onRetry} />
          </li>
        ))}
      </ul>
      {summary.pending > 0 ? (
        <div className="dz-actions-row">
          <button type="button" className="dz-btn-secondary" onClick={onCancelAll}>
            {t("desktop.queue.cancelAll")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function MissingTiles({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  const shown = missing.slice(0, 20).join(", ");
  const rest = missing.length > 20 ? t("desktop.rec.more", { n: missing.length - 20 }) : "";
  return (
    <p className="dz-notice-message dz-missing-list">
      {t("desktop.rec.missing", { shown, rest })}
    </p>
  );
}

function useRecoveryFocus() {
  const dialogRef = useRef<HTMLElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryActionRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);
  return {
    dialogRef,
    primaryActionRef,
    onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
      if (event.key === "Escape") {
        event.preventDefault();
        document.getElementById("dz-btn-cancel")?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const actions = Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
      );
      if (actions.length === 0) return;
      const first = actions[0];
      const last = actions.at(-1)!;
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    },
  };
}

function RecoveryPanel({
  decision,
  onChooseOutput,
  onRetry,
  onPartialChoice,
}: {
  decision: PendingDecision;
  onChooseOutput(): void;
  onRetry(): void;
  onPartialChoice(keep: boolean): void;
}) {
  const recoveryFocus = useRecoveryFocus();
  const partial = decision.kind === "partial-recovery";
  const missing = decision.missingTiles ?? [];
  const title = partial
    ? t("desktop.rec.partialTitle")
    : decision.kind === "destination-recovery"
      ? t("desktop.rec.destTitle")
      : t("desktop.rec.chooseTitle");
  const description = partial
    ? t("desktop.rec.partialDesc", {
        summary: formatMissingSummary(missing, decision.failedCount),
      })
    : decision.kind === "destination-recovery"
      ? t("desktop.rec.destDesc")
      : t("desktop.rec.chooseDesc");

  return (
    <section
      ref={recoveryFocus.dialogRef}
      className="dz-recovery-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby="dz-recovery-title"
      aria-describedby="dz-recovery-desc"
      onKeyDown={recoveryFocus.onKeyDown}
    >
      <h2 className="dz-notice-title" id="dz-recovery-title">{title}</h2>
      <p className="dz-notice-message" id="dz-recovery-desc" aria-live="assertive">
        {description}
      </p>
      {partial ? <MissingTiles missing={missing} /> : null}
      <div className="dz-actions-row">
        {partial ? (
          <>
            <button ref={recoveryFocus.primaryActionRef} type="button" className="dz-btn-tactile" onClick={() => onPartialChoice(true)}>
              {t("desktop.rec.keep")}
            </button>
            <button type="button" className="dz-btn-secondary" onClick={() => onPartialChoice(false)}>
              {t("desktop.rec.discard")}
            </button>
            <button type="button" className="dz-btn-secondary" onClick={onRetry}>
              {t("desktop.rec.retryTiles")}
            </button>
          </>
        ) : (
          <>
            <button ref={recoveryFocus.primaryActionRef} type="button" className="dz-btn-tactile" onClick={onChooseOutput}>
              {t("desktop.rec.chooseOutput")}
            </button>
            {decision.kind === "destination-recovery" ? (
              <button type="button" className="dz-btn-secondary" onClick={onRetry}>
                {t("desktop.rec.tryAgain")}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function PartialCompletionNotice({ missing, sibling }: { missing: string[]; sibling: string | null }) {
  const missingSummary = formatMissingSummary(missing, missing.length);
  const summary = sibling ? `${missingSummary} File: ${sibling}.` : missingSummary;
  return (
    <section className="dz-partial-note" role="status" aria-live="polite">
      <h2 className="dz-notice-title">{t("desktop.done.partialTitle")}</h2>
      <p className="dz-notice-message">{t("desktop.done.partialDesc", { summary })}</p>
      <MissingTiles missing={missing} />
    </section>
  );
}

function OutputActionError({ action, code }: { action: "open" | "folder"; code: string }) {
  const message = code === "output.not-found"
    ? t("desktop.done.missingError")
    : action === "folder"
      ? t("desktop.done.folderError")
      : t("desktop.done.openError");
  return <p id="dz-open-error" role="alert">{message} ({code})</p>;
}

export interface DesktopJobViewProps {
  status: ControllerState["status"];
  decision: PendingDecision | null;
  format: NativeFormat;
  queue: DesktopQueue;
  queueEnabled: boolean;
  completedPartial: boolean;
  completedMissing: string[];
  completedSibling: string | null;
  outputActionError?: { action: "open" | "folder"; code: string };
  onFormatChange(format: NativeFormat): void;
  onChooseOutput(): void;
  onRecoveryRetry(): void;
  onPartialChoice(keep: boolean): void;
  onQueueCancel(id: string): void;
  onQueueRetry(id: string): void;
  onQueueCancelAll(): void;
}

export function DesktopJobView(props: DesktopJobViewProps): ReactElement | null {
  const showQueue = props.queueEnabled && props.status !== "completed" && props.queue.entries.length > 1;
  const showPartialCompletion = props.status === "completed" && props.completedPartial;
  const showCancellation = props.status === "cancelled";
  const showOutputError = props.status === "completed" && props.outputActionError;
  if (!props.decision && !showQueue && !showPartialCompletion && !showCancellation && !showOutputError) return null;

  const decisionKey = props.decision
    ? [
        props.decision.kind,
        props.decision.reason,
        props.decision.attempt ?? "",
        (props.decision.missingTiles ?? []).join(","),
        props.decision.failedCount ?? "",
        props.decision.totalCount ?? "",
      ].join(":")
    : undefined;
  return (
    <div id="dz-desktop-job-panel" className="dz-view-body dz-desktop-job-panel" role="region" aria-label={t("desktop.panel.jobActions")}>
      {props.decision && props.decision.kind !== "partial-recovery" ? (
        <OutputFormatField value={props.format} onChange={props.onFormatChange} />
      ) : null}
      {props.decision ? (
        <RecoveryPanel key={decisionKey} decision={props.decision} onChooseOutput={props.onChooseOutput} onRetry={props.onRecoveryRetry} onPartialChoice={props.onPartialChoice} />
      ) : null}
      {showPartialCompletion ? <PartialCompletionNotice missing={props.completedMissing} sibling={props.completedSibling} /> : null}
      {showOutputError && props.outputActionError ? <OutputActionError {...props.outputActionError} /> : null}
      {showCancellation ? (
        <p className="dz-notice-message" id="dz-cancel-cleanup-note" role="status" aria-live="polite">
          {t("desktop.cancel.note")}
        </p>
      ) : null}
      {showQueue ? <DesktopQueuePanel queue={props.queue} onCancel={props.onQueueCancel} onRetry={props.onQueueRetry} onCancelAll={props.onQueueCancelAll} /> : null}
    </div>
  );
}

export function createDesktopViewOptions(args: {
  status: ControllerState["status"];
  settings: DesktopSettings;
  settingsError: string | null;
  onSettingsChange(settings: DesktopSettings): void;
  onSettingsReset(): void;
  job: DesktopJobViewProps;
}): ViewRenderOptions {
  return {
    idleBeforeHistory: args.status === "idle"
      ? <DesktopSettingsView settings={args.settings} error={args.settingsError} onChange={args.onSettingsChange} onReset={args.onSettingsReset} />
      : undefined,
    after: args.status === "idle" ? undefined : <DesktopJobView {...args.job} />,
  };
}
