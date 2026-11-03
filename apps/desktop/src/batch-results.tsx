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
  return (
    <section className="dz-batch-results" aria-labelledby={titleId}>
      <h2 id={titleId}>
        {t(
          running
            ? "desktop.batch.runningTitle"
            : batch.cancelled
              ? "desktop.batch.cancelledTitle"
              : "desktop.batch.title",
        )}
      </h2>
      <div className="dz-batch-totals" role="status" aria-live="polite">
        <p className="dz-batch-saved-total">
          {t("desktop.batch.savedSummary", { saved: count("saved"), total: batch.items.length })}
        </p>
        <p className="dz-batch-status-total">
          {t("desktop.batch.statusSummary", {
            failed: count("failed"),
            cancelled: count("cancelled"),
            remaining: count("pending") + count("running"),
          })}
        </p>
      </div>
      <ol className="dz-batch-list">
        {batch.items.map((item, index) => (
          <BatchItem key={item.id} item={item} number={index + 1} onOpen={onOpen} />
        ))}
      </ol>
      {!running && (
        <div className="dz-actions-row">
          <button type="button" className="dz-btn-secondary" onClick={onReset}>
            {t("view.done.another")}
          </button>
        </div>
      )}
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
    <li className="dz-batch-item" data-batch-item={item.id}>
      <h3>{title}</h3>
      {item.source_url && <p className="dz-batch-source">{item.source_url}</p>}
      <p className="dz-batch-status">{t(`desktop.batch.${item.state.kind}`)}</p>
      {item.state.kind === "failed" && (
        <p className="dz-batch-error">
          {plainMessageFor(item.state.error, hostFromUrl(item.source_url ?? ""), "desktop")}
        </p>
      )}
      {saved && (
        <>
          <p className="dz-batch-filename">{saved.filename}</p>
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
        </>
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
