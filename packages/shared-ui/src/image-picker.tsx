import type { Catalog } from "@dezoomify/wasm-bindings";
import { useEffect, useRef } from "react";
import { t } from "./i18n.ts";

/** Hosts own the choice lifetime, previews, and optional batch action over the catalog. */
export function ImagePicker({
  catalog,
  previews,
  sourceUrl,
  onChoose,
  onDownloadAll,
  onCancel,
  disabled = false,
}: {
  catalog: Catalog;
  previews: ReadonlyMap<number, string>;
  sourceUrl: string;
  onChoose(index: number): void;
  onDownloadAll?(): void;
  onCancel(): void;
  disabled?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (catalog.entries.length) heading.current?.focus();
  }, [catalog]);
  return (
    <section className="dz-image-picker" aria-labelledby="dz-image-picker-title">
      <header className="dz-image-picker-head">
        <div>
          <h2 id="dz-image-picker-title" tabIndex={-1} ref={heading}>
            {t("view.images.title")}
          </h2>
          {onDownloadAll && (
            <p className="dz-image-catalog-count">
              {t("view.images.count", { count: catalog.entries.length })}
            </p>
          )}
        </div>
        {onDownloadAll && (
          <button
            type="button"
            id="dz-btn-download-all"
            className="dz-btn-tactile"
            disabled={disabled}
            onClick={onDownloadAll}
          >
            {t("view.images.downloadAll")}
          </button>
        )}
      </header>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable catalog needs keyboard access even while its buttons are disabled. */}
      <ul className="dz-image-list" tabIndex={0} aria-labelledby="dz-image-picker-title">
        {catalog.entries.map((entry, index) => {
          const title = entry.title?.trim() || t("view.images.untitled", { number: index + 1 });
          const url = entry.kind === "image-request" ? entry.uri : entry.sourceUrl || sourceUrl;
          const preview = previews.get(index);
          return (
            // Catalog positions identify distinct images, including otherwise identical entries.
            // biome-ignore lint/suspicious/noArrayIndexKey: immutable ordered catalog slots
            <li key={index} className="dz-image-row">
              <div className="dz-image-thumbnail">
                {preview ? (
                  <img src={preview} alt="" />
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    width="28"
                    height="28"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    role="img"
                    aria-label={t("view.images.noPreview")}
                  >
                    <title>{t("view.images.noPreview")}</title>
                    <rect x="3" y="3" width="18" height="18" rx="1" />
                    <circle cx="8" cy="8" r="2" />
                    <path d="m3 18 6-6 4 4 3-3 5 5" />
                  </svg>
                )}
              </div>
              <div className="dz-image-description">
                <h3 title={title}>{title}</h3>
                <span className="dz-image-url" title={url}>
                  {url}
                </span>
                <span className="dz-image-size">
                  {entry.size
                    ? `${entry.size.width} × ${entry.size.height} px`
                    : t("view.images.unknownSize")}
                </span>
                <button
                  type="button"
                  className={onDownloadAll ? "dz-btn-secondary" : "dz-btn-tactile"}
                  data-dz-image-index={index}
                  disabled={disabled}
                  aria-label={t("view.images.chooseNamed", { title, number: index + 1 })}
                  onClick={() => onChoose(index)}
                >
                  {t("view.images.choose")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="dz-image-picker-foot">
        <button
          type="button"
          id="dz-btn-cancel"
          className="dz-btn-secondary"
          disabled={disabled}
          onClick={onCancel}
        >
          {t("view.images.cancel")}
        </button>
      </div>
    </section>
  );
}
