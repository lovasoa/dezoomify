import { t } from "@dezoomify/shared-ui";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { DesktopSettings, NetworkProfile } from "./settings.ts";
import { headersToEditableText, pickDirectory } from "./settings.ts";

interface Props {
  settings: DesktopSettings;
  error: string | null;
  onChange(settings: DesktopSettings): void;
  onReset(): void;
}

const formats: Array<{ value: DesktopSettings["output_format"]; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "tiff", label: "TIFF" },
  { value: "webp", label: "WebP" },
  { value: "zif", label: "ZIF" },
  { value: "iiif-dir", label: "IIIF folder" },
];

const profiles: NetworkProfile[] = ["maximum", "balanced", "gentle"];

const sizes = [1024, 2048, 3840, 7680, 15360, 30720];
type SizePreset = string;

function estimateSize(width: number, settings: DesktopSettings): string {
  const format = settings.output_format;
  const quality = (100 - settings.compression) / 100;
  const jpeg = [0.15 + 0.45 * quality ** 3, 0.35 + 1.15 * quality ** 3];
  const bytesPerPixel =
    format === "auto" || format === "jpeg" || format === "iiif-dir"
      ? jpeg
      : format === "webp"
        ? [1, 2.5]
        : [1.5, 3];
  const pyramid = format === "zif" || format === "iiif-dir" ? 4 / 3 : 1;
  const pixels = width * width * 0.75;
  const mb = bytesPerPixel.map((bytes) => (pixels * bytes * pyramid) / 1_000_000);
  return `≈${mb[0].toFixed(1)}–${mb[1].toFixed(1)} MB`;
}

function sizePresetFor(settings: DesktopSettings): SizePreset {
  if (settings.max_width === null && settings.max_height === null) return "full";
  if (sizes.includes(settings.max_width ?? 0) && settings.max_height === null)
    return String(settings.max_width);
  return "custom";
}

function folderName(path: string | null): string {
  if (!path) return t("desktop.quick.askEachTime");
  return path.split(/[\\/]/).filter(Boolean).pop() ?? t("desktop.quick.chosenFolder");
}

function Info({ text }: { text: string }) {
  return (
    <details className="dz-quick-info">
      <summary aria-label={t("desktop.quick.info")}>ⓘ</summary>
      <p>{text}</p>
    </details>
  );
}

function QuickChoice({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: Array<{ value: string; label: string; hint: string; info: string }>;
  onChange(value: string): void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const selected = choices.find((choice) => choice.value === value) ?? choices[0];
  return (
    <details
      className="dz-quick-choice"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current) {
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
    >
      <summary aria-label={label}>
        <span className="dz-choice-selected">{selected.label}</span>
        <span aria-hidden="true">▾</span>
      </summary>
      <fieldset className="dz-quick-menu" aria-label={label}>
        {choices.map((choice) => (
          <div className="dz-quick-menu-row" key={choice.value}>
            <button
              type="button"
              aria-pressed={value === choice.value}
              onClick={() => {
                onChange(choice.value);
                if (ref.current) {
                  ref.current.open = false;
                  ref.current.querySelector("summary")?.focus();
                }
              }}
            >
              <span>{choice.label}</span>
              <span className="dz-choice-hint">{choice.hint}</span>
            </button>
            <Info text={choice.info} />
          </div>
        ))}
      </fieldset>
    </details>
  );
}

function QuickOption({
  label,
  info,
  children,
}: {
  label: string;
  info: string;
  children: ReactNode;
}) {
  return (
    <div className="dz-quick-option">
      <span>{label}</span>
      {children}
      <Info text={info} />
    </div>
  );
}

function PreferenceRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="dz-preference-row">
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      {children}
    </div>
  );
}

/** Desktop job preferences: the quick strip plus the advanced settings dialog. */
export function DesktopSettingsView({ settings, error, onChange, onReset }: Props): ReactElement {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [headersDraft, setHeadersDraft] = useState(() => headersToEditableText(settings.headers));
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setHeadersDraft(headersToEditableText(settings.headers));
  }, [settings.headers]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const isOpen = dialog.open || dialog.hasAttribute("open");
    if (advancedOpen && !isOpen) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!advancedOpen && isOpen) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [advancedOpen]);

  // Raw values are submitted as typed; Rust validates on save and its typed
  // rejection reason arrives through `error`.
  const commit = (patch: Partial<DesktopSettings>) => {
    onChange({ ...settings, ...patch });
  };

  const chooseDirectory = async (key: "output_dir" | "cache_dir") => {
    const value = await pickDirectory(settings[key]);
    if (value) commit({ [key]: value });
  };

  const chooseSize = (preset: SizePreset) => {
    if (preset === "full") commit({ max_width: null, max_height: null });
    else if (sizes.includes(Number(preset)))
      commit({ max_width: Number(preset), max_height: null });
    else setAdvancedOpen(true);
  };

  const jpeg = settings.output_format === "jpeg" || settings.output_format === "auto";
  const showCompression =
    settings.output_format !== "webp" && settings.output_format !== "iiif-dir";
  const compressionValue = jpeg ? 100 - settings.compression : settings.compression;
  const compressionLabel = jpeg
    ? t("desktop.advanced.jpegQuality")
    : t("desktop.advanced.compressionEffort");

  return (
    <section
      id="dz-desktop-settings"
      className="dz-view-body dz-desktop-settings"
      aria-label="Job options"
    >
      <div className="dz-quick-options">
        <QuickOption label={t("desktop.quick.folder")} info={t("desktop.quick.folderInfo")}>
          <button
            type="button"
            className="dz-quick-button"
            title={settings.output_dir ?? t("desktop.quick.chooseFolder")}
            onClick={() => void chooseDirectory("output_dir")}
          >
            {folderName(settings.output_dir)}
          </button>
        </QuickOption>

        <QuickOption label={t("desktop.quick.format")} info={t("desktop.quick.formatInfo")}>
          <QuickChoice
            label={t("desktop.quick.format")}
            value={settings.output_format}
            onChange={(value) =>
              commit({ output_format: value as DesktopSettings["output_format"] })
            }
            choices={formats.map((format) => ({
              ...format,
              hint: t(
                `desktop.quick.hint.${format.value === "iiif-dir" ? "iiifDir" : format.value}`,
              ),
              info: t(
                `desktop.quick.format.${format.value === "iiif-dir" ? "iiifDir" : format.value}`,
              ),
            }))}
          />
        </QuickOption>

        <QuickOption label={t("desktop.quick.size")} info={t("desktop.quick.sizeInfo")}>
          <QuickChoice
            label={t("desktop.quick.size")}
            value={sizePresetFor(settings)}
            onChange={chooseSize}
            choices={[
              {
                value: "full",
                label: t("desktop.quick.fullResolution"),
                hint: t("desktop.quick.source"),
                info: t("desktop.quick.sizeInfo"),
              },
              ...sizes.map((width, index) => ({
                value: String(width),
                label: t("desktop.quick.upTo", { size: 2 ** index }),
                hint: estimateSize(width, settings),
                info: t("desktop.quick.sizeInfo"),
              })),
              {
                value: "custom",
                label: t("desktop.quick.custom"),
                hint: t("desktop.quick.exact"),
                info: t("desktop.advanced.dimensionsDesc"),
              },
            ]}
          />
        </QuickOption>

        <QuickOption label={t("desktop.quick.network")} info={t("desktop.quick.networkInfo")}>
          <QuickChoice
            label={t("desktop.quick.network")}
            value={settings.network_profile}
            onChange={(value) => commit({ network_profile: value as NetworkProfile })}
            choices={profiles.map((profile) => ({
              value: profile,
              label: t(`desktop.quick.${profile === "maximum" ? "fast" : profile}`),
              hint: t(`desktop.quick.rate.${profile}`),
              info: t("desktop.quick.networkInfo"),
            }))}
          />
        </QuickOption>

        <button
          type="button"
          className="dz-settings-more"
          aria-label={t("desktop.quick.more")}
          onClick={() => setAdvancedOpen(true)}
        >
          ⚙
        </button>
      </div>

      <dialog
        ref={dialogRef}
        className="dz-settings-dialog"
        aria-labelledby="dz-settings-dialog-title"
        onClose={() => setAdvancedOpen(false)}
        onCancel={() => setAdvancedOpen(false)}
      >
        <div className="dz-settings-sheet">
          <header className="dz-settings-sheet-head">
            <h2 id="dz-settings-dialog-title">{t("desktop.advanced.title")}</h2>
            <button
              type="button"
              className="dz-settings-close"
              onClick={() => setAdvancedOpen(false)}
            >
              {t("desktop.advanced.done")}
            </button>
          </header>

          {showCompression ? (
            <PreferenceRow
              title={compressionLabel}
              description={
                jpeg
                  ? t("desktop.advanced.jpegQualityDesc")
                  : t("desktop.advanced.compressionEffortDesc")
              }
            >
              <div className="dz-slider-control">
                <input
                  type="range"
                  min="0"
                  max="100"
                  aria-label={compressionLabel}
                  value={compressionValue}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    commit({ compression: jpeg ? 100 - value : value });
                  }}
                />
                <output>{jpeg ? `${compressionValue}%` : compressionValue}</output>
              </div>
            </PreferenceRow>
          ) : null}

          <PreferenceRow
            title={t("desktop.advanced.dimensions")}
            description={t("desktop.advanced.dimensionsDesc")}
          >
            <div className="dz-size-control">
              <input
                type="number"
                min="1"
                max="1000000"
                placeholder={t("desktop.advanced.width")}
                aria-label={t("desktop.advanced.width")}
                value={settings.max_width ?? ""}
                onChange={(event) =>
                  commit({
                    max_width: event.currentTarget.value ? Number(event.currentTarget.value) : null,
                  })
                }
              />
              <span aria-hidden="true">×</span>
              <input
                type="number"
                min="1"
                max="1000000"
                placeholder={t("desktop.advanced.height")}
                aria-label={t("desktop.advanced.height")}
                value={settings.max_height ?? ""}
                onChange={(event) =>
                  commit({
                    max_height: event.currentTarget.value
                      ? Number(event.currentTarget.value)
                      : null,
                  })
                }
              />
            </div>
          </PreferenceRow>

          <PreferenceRow
            title={t("desktop.advanced.retries")}
            description={t("desktop.advanced.retriesDesc")}
          >
            <input
              className="dz-number-control"
              type="number"
              min="0"
              max="100"
              aria-label={t("desktop.advanced.retries")}
              value={settings.retries}
              onChange={(event) => commit({ retries: Number(event.currentTarget.value) })}
            />
          </PreferenceRow>

          <PreferenceRow
            title={t("desktop.advanced.resumeCache")}
            description={t("desktop.advanced.resumeCacheDesc")}
          >
            <button
              type="button"
              className="dz-compact-action"
              title={settings.cache_dir ?? undefined}
              onClick={() => void chooseDirectory("cache_dir")}
            >
              {settings.cache_dir ? t("desktop.advanced.change") : t("desktop.advanced.choose")}
            </button>
          </PreferenceRow>

          <details className="dz-headers-disclosure">
            <summary>{t("desktop.advanced.headers")}</summary>
            <p>{t("desktop.advanced.headersDesc")}</p>
            <textarea
              rows={3}
              placeholder="Referer: https://example.com/viewer"
              value={headersDraft}
              onChange={(event) => {
                const draft = event.currentTarget.value;
                setHeadersDraft(draft);
                commit({ headers: draft.split("\n") });
              }}
            />
          </details>

          {error ? (
            <p id="dz-settings-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="button" className="dz-settings-reset" onClick={onReset}>
            {t("desktop.settings.reset")}
          </button>
        </div>
      </dialog>
    </section>
  );
}
