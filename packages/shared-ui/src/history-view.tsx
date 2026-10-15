import { detailOf } from "./failure.ts";
import { HISTORY_MAX, type HistoryEntry, type HistoryRow } from "./history.ts";
import { getLocale, t } from "./i18n.ts";
import type { ViewCallbacks, ViewContext } from "./view-types.ts";

function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 86400],
    ["month", 30 * 86400],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const [unit, duration] = units.find(([, duration]) => seconds >= duration) ?? ["second", 1];
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(
    -Math.floor(seconds / duration),
    unit,
  );
}

export function HistorySection({
  callbacks,
  ctx,
  onSelect,
}: {
  callbacks: ViewCallbacks;
  ctx?: ViewContext;
  onSelect(entry: HistoryEntry): void;
}) {
  const entries = ctx?.history;
  if (!entries) return <div className="dz-history-section" id="dz-history" />;
  return (
    <section className="dz-history-section" id="dz-history" aria-labelledby="dz-history-title">
      <h2 className="dz-history-title" id="dz-history-title">
        {t("view.history.title")}
      </h2>
      <p className="dz-history-note">{t("view.history.localOnly")}</p>
      {entries.length === 0 ? (
        <p className="dz-history-empty">{t("view.history.empty")}</p>
      ) : (
        <div className="dz-history-scroll">
          <table className="dz-history-table" aria-labelledby="dz-history-title">
            <thead>
              <tr>
                <th scope="col">{t("view.history.source")}</th>
                <th scope="col">{t("view.history.time")}</th>
                <th scope="col">{t("view.history.size")}</th>
                <th scope="col">{t("view.history.result")}</th>
                <th scope="col" aria-label={t("view.history.remove")} />
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, HISTORY_MAX).map((entry) => (
                <HistoryEntryRow
                  key={`${entry.at}-${entry.url}`}
                  entry={entry}
                  callbacks={callbacks}
                  now={ctx?.historyNow}
                  onSelect={onSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {callbacks.onClearHistory && entries.length > 0 ? (
        <button
          type="button"
          className="dz-history-clear"
          id="dz-history-clear"
          onClick={callbacks.onClearHistory}
        >
          {t("view.history.clear")}
        </button>
      ) : null}
    </section>
  );
}

function HistoryEntryRow({
  entry,
  callbacks,
  now,
  onSelect,
}: {
  entry: HistoryRow;
  callbacks: ViewCallbacks;
  now?: number;
  onSelect(entry: HistoryEntry): void;
}) {
  const label = entry.title || entry.url;
  return (
    <tr>
      <td>
        <button
          type="button"
          className="dz-history-main"
          title={entry.url}
          onClick={() => onSelect(entry)}
        >
          {label}
        </button>
      </td>
      <td>
        <time
          dateTime={new Date(entry.at).toISOString()}
          title={new Date(entry.at).toLocaleString(getLocale())}
        >
          {now === undefined ? "–" : timeAgo(entry.at, now)}
        </time>
      </td>
      <td>{entry.width && entry.height ? `${entry.width} × ${entry.height}` : "–"}</td>
      <HistoryResultCell entry={entry} onOpen={callbacks.onOpenHistory} />
      <td>
        <RemoveHistoryButton
          entry={entry}
          label={label || entry.url}
          onRemove={callbacks.onRemoveHistory}
        />
      </td>
    </tr>
  );
}

function historyResultStatus(entry: HistoryRow, file: boolean) {
  if (entry.opening) return "opening";
  if (file)
    return entry.outputState === "available" ? undefined : (entry.outputState ?? "checking");
  return entry.status;
}

function HistoryResultCell({
  entry,
  onOpen,
}: {
  entry: HistoryRow;
  onOpen: ViewCallbacks["onOpenHistory"];
}) {
  const saved = onOpen ? entry.savedOutput : undefined;
  const status = historyResultStatus(entry, Boolean(saved));
  return (
    <td title={entry.outputError ? detailOf(entry.outputError) : undefined}>
      {saved ? (
        <button
          type="button"
          className="dz-history-output"
          title={saved.filename}
          disabled={entry.opening || entry.outputState === "deleted"}
          aria-label={t("view.history.openImage", { image: saved.filename })}
          onClick={() => void onOpen?.(entry)}
        >
          {saved.filename}
        </button>
      ) : null}
      {status ? <span>{t(`view.history.status.${status}`)}</span> : saved ? null : "–"}
      {entry.outputError && entry.outputState !== "unavailable" ? (
        <span role="alert" title={detailOf(entry.outputError)}>
          {t("view.history.openFailed")}
        </span>
      ) : null}
    </td>
  );
}

function RemoveHistoryButton({
  entry,
  label,
  onRemove,
}: {
  entry: HistoryRow;
  label: string;
  onRemove: ViewCallbacks["onRemoveHistory"];
}) {
  if (!onRemove) return null;
  return (
    <button
      type="button"
      className="dz-history-remove"
      aria-label={t("view.history.removeImage", { image: label })}
      title={t("view.history.remove")}
      onClick={(event) => {
        event.stopPropagation();
        onRemove(entry);
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
      </svg>
    </button>
  );
}
