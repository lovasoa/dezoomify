import { hostFromUrl, isJobError, plainMessageFor, t } from "@dezoomify/shared-ui";
import type { DesktopBatch, DesktopBatchItem, SavedOutput } from "@dezoomify/wasm-bindings";
import { useId, useState } from "react";

/** Hosts retain batch results and open saved IDs independently of completed job lifetimes. */
export function BatchResults({
  batch,
  running,
  onOpen,
  onReset,
}: {
  batch: DesktopBatch;
  running: boolean;
  onOpen(saved: SavedOutput, reveal: boolean): Promise<void>;
  onReset(): void;
}) {
  const titleId = useId();
  const count = (kind: DesktopBatchItem["state"]["kind"]) =>
    batch.items.filter((item) => item.state.kind === kind).length;
  const saved = count("saved");
  const failed = count("failed");
  const cancelled = count("cancelled");
  const remaining = count("pending") + count("running");
  const settled = batch.items.length - remaining;
  return (
    <section className="dz-batch-results" aria-labelledby={titleId} data-running={running}>
      <header className="dz-batch-head">
        <h2 id={titleId}>
          {t(
            running
              ? "desktop.batch.runningTitle"
              : batch.cancelled
                ? "desktop.batch.cancelledTitle"
                : "desktop.batch.title",
          )}
        </h2>
        {!running && (
          <div className="dz-actions-row">
            <button type="button" className="dz-btn-secondary" onClick={onReset}>
              {t("view.done.another")}
            </button>
          </div>
        )}
      </header>
      <div className="dz-batch-totals" role="status" aria-live="polite">
        <p className="dz-batch-saved-total">
          {t("desktop.batch.savedSummary", { saved, total: batch.items.length })}
        </p>
        {running && failed === 0 && cancelled === 0 && (
          <p className="dz-batch-status-total">
            {t("desktop.batch.remainingSummary", { remaining })}
          </p>
        )}
        {(failed > 0 || cancelled > 0) && (
          <p className="dz-batch-status-total">
            {t("desktop.batch.statusSummary", { failed, cancelled, remaining })}
          </p>
        )}
      </div>
      {running && (
        <progress
          className="dz-batch-progress"
          value={settled}
          max={batch.items.length || 1}
          aria-label={t("desktop.batch.runningTitle")}
        />
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll waiting items in the native webview. */}
      <ol className="dz-batch-list" tabIndex={0} aria-labelledby={titleId}>
        {batch.items.map((item, index) => (
          <BatchItem key={item.id} item={item} number={index + 1} onOpen={onOpen} />
        ))}
      </ol>
    </section>
  );
}

function BatchItem({
  item,
  number,
  onOpen,
}: {
  item: DesktopBatchItem;
  number: number;
  onOpen(saved: SavedOutput, reveal: boolean): Promise<void>;
}) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<"open" | "folder" | "missing" | null>(null);
  const title = item.title?.trim() || t("view.images.untitled", { number });
  const saved = item.state.kind === "saved" ? item.state.result.saved_output : undefined;
  async function open(reveal: boolean) {
    if (!saved || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      await onOpen(saved, reveal);
    } catch (error) {
      setOpenError(
        isJobError(error) && error.kind === "output-not-found"
          ? "missing"
          : reveal
            ? "folder"
            : "open",
      );
    } finally {
      setOpening(false);
    }
  }
  return (
    <li className="dz-batch-item" data-batch-item={item.id} data-state={item.state.kind}>
      <span className="dz-batch-icon" aria-hidden="true">
        <BatchIcon state={item.state.kind} />
      </span>
      <div className="dz-batch-description">
        <h3 title={title}>{title}</h3>
        {saved && (
          <p className="dz-batch-filename" title={saved.filename}>
            {saved.filename}
          </p>
        )}
        {item.source_url && (
          <p className="dz-batch-source" title={item.source_url}>
            {item.source_url}
          </p>
        )}
      </div>
      <p className="dz-batch-status">{t(`desktop.batch.${item.state.kind}`)}</p>
      {item.state.kind === "failed" && (
        <p className="dz-batch-error">
          {plainMessageFor(item.state.error, hostFromUrl(item.source_url ?? ""), "desktop")}
        </p>
      )}
      {saved && (
        <div className="dz-batch-actions">
          <button
            type="button"
            className="dz-btn-secondary"
            disabled={opening}
            aria-label={t("desktop.batch.openNamed", { title, number })}
            onClick={() => void open(false)}
          >
            {t("desktop.done.open")}
          </button>
          <button
            type="button"
            className="dz-btn-secondary"
            disabled={opening}
            aria-label={t("desktop.batch.revealNamed", { title, number })}
            onClick={() => void open(true)}
          >
            {t("desktop.done.reveal")}
          </button>
        </div>
      )}
      {openError && (
        <p className="dz-batch-error" role="alert">
          {t(
            openError === "missing"
              ? "desktop.done.missingError"
              : openError === "folder"
                ? "desktop.done.folderError"
                : "desktop.done.openError",
          )}
        </p>
      )}
    </li>
  );
}

function BatchIcon({ state }: { state: DesktopBatchItem["state"]["kind"] }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {state === "saved" ? (
        <path d="m5 12 4 4L19 6" />
      ) : state === "failed" || state === "cancelled" ? (
        <path d="m7 7 10 10M17 7 7 17" />
      ) : state === "running" ? (
        <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />
      ) : (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </>
      )}
    </svg>
  );
}
