import { detailOf } from "./failure.ts";
import { HISTORY_MAX, type HistoryEntry } from "./history.ts";
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
  function activate(entry: NonNullable<ViewContext["history"]>[number]) {
    if (entry.savedOutput && callbacks.onOpenHistory) {
      if (!entry.opening && entry.outputState !== "deleted") void callbacks.onOpenHistory(entry);
    } else onSelect(entry);
  }
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
                <th scope="col">{t("view.history.image")}</th>
                <th scope="col">{t("view.history.time")}</th>
                <th scope="col">{t("view.history.size")}</th>
                <th scope="col">{t("view.history.status")}</th>
                <th scope="col" aria-label={t("view.history.remove")} />
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, HISTORY_MAX).map((entry) => {
                const file = entry.savedOutput && callbacks.onOpenHistory;
                const label = file ? entry.savedOutput?.filename : entry.title || entry.url;
                const fileStatus =
                  file && entry.outputState !== "available"
                    ? (entry.outputState ?? "checking")
                    : undefined;
                const status = entry.opening ? "opening" : (fileStatus ?? entry.status);
                return (
                  <tr key={`${entry.at}-${entry.url}`} onClick={() => activate(entry)}>
                    <td>
                      <button
                        type="button"
                        className="dz-history-main"
                        title={entry.url}
                        disabled={entry.opening || entry.outputState === "deleted"}
                        aria-label={
                          entry.savedOutput && callbacks.onOpenHistory
                            ? t("view.history.openImage", { image: entry.savedOutput.filename })
                            : undefined
                        }
                      >
                        {label}
                      </button>
                    </td>
                    <td>
                      <time
                        dateTime={new Date(entry.at).toISOString()}
                        title={new Date(entry.at).toLocaleString(getLocale())}
                      >
                        {ctx?.historyNow === undefined ? "–" : timeAgo(entry.at, ctx.historyNow)}
                      </time>
                    </td>
                    <td>
                      {entry.width && entry.height ? `${entry.width} × ${entry.height}` : "–"}
                    </td>
                    <td title={entry.outputError ? detailOf(entry.outputError) : undefined}>
                      {status ? t(`view.history.status.${status}`) : "–"}
                      {entry.outputError && entry.outputState !== "unavailable" ? (
                        <span role="alert" title={detailOf(entry.outputError)}>
                          {t("view.history.openFailed")}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {callbacks.onRemoveHistory ? (
                        <button
                          type="button"
                          className="dz-history-remove"
                          aria-label={t("view.history.removeImage", {
                            image: label || entry.url,
                          })}
                          title={t("view.history.remove")}
                          onClick={(event) => {
                            event.stopPropagation();
                            callbacks.onRemoveHistory?.(entry);
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
                      ) : null}
                    </td>
                  </tr>
                );
              })}
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
