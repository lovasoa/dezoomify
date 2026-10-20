import type { Catalog } from "@dezoomify/wasm-bindings";
import { useEffect, useRef } from "react";
import { t } from "./i18n.ts";

/** Hosts own the choice lifetime and preview resources; this view only presents them. */
export function ImagePicker({
  catalog,
  previews,
  sourceUrl,
  onChoose,
  onCancel,
  disabled = false,
}: {
  catalog: Catalog;
  previews: ReadonlyMap<number, string>;
  sourceUrl: string;
  onChoose(index: number): void;
  onCancel(): void;
  disabled?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (catalog.entries.length) heading.current?.focus();
  }, [catalog]);
  return (
    <section className="dz-image-picker" aria-labelledby="dz-image-picker-title">
      <h2 id="dz-image-picker-title" tabIndex={-1} ref={heading}>
        {t("view.images.title")}
      </h2>
      <ul className="dz-image-list">
        {catalog.entries.map((entry, index) => {
          const title = entry.title?.trim() || t("view.images.untitled", { number: index + 1 });
          const url = entry.kind === "image-request" ? entry.uri : entry.sourceUrl || sourceUrl;
          const preview = previews.get(index);
          return (
            // Catalog positions identify distinct images, including otherwise identical entries.
            // biome-ignore lint/suspicious/noArrayIndexKey: immutable ordered catalog slots
            <li key={index} className="dz-image-row">
              <div className="dz-image-thumbnail">
                {preview ? <img src={preview} alt="" /> : <span>{t("view.images.noPreview")}</span>}
              </div>
              <div className="dz-image-description">
                <h3>{title}</h3>
                <span className="dz-image-url">{url}</span>
                <span className="dz-image-size">
                  {entry.size
                    ? `${entry.size.width} × ${entry.size.height} px`
                    : t("view.images.unknownSize")}
                </span>
                <button
                  type="button"
                  className="dz-btn-tactile"
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
      <button type="button" id="dz-btn-cancel" className="dz-btn-secondary" onClick={onCancel}>
        {t("view.images.cancel")}
      </button>
    </section>
  );
}
