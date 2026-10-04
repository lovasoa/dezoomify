import { getLocale, t } from "@dezoomify/shared-ui";
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

function formatChoices(): Array<{ value: DesktopSettings["output_format"]; label: string }> {
  return [
    { value: "auto", label: t("desktop.quick.auto") },
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "tiff", label: "TIFF" },
    { value: "webp", label: "WebP" },
    { value: "zif", label: "ZIF" },
    { value: "iiif-dir", label: "IIIF folder" },
  ];
}

const profiles: NetworkProfile[] = ["maximum", "balanced", "gentle"];

const sizes = [
  { label: "Full HD", width: 1920, height: 1080 },
  { label: "QHD", width: 2560, height: 1440 },
  { label: "4K", width: 3840, height: 2160 },
  { label: "8K", width: 7680, height: 4320 },
  { label: "16K", width: 15360, height: 8640 },
  { label: "32K", width: 30720, height: 17280 },
  { label: "64K", width: 61440, height: 34560 },
];
type SizePreset = string;

function formatLimit(format: DesktopSettings["output_format"]): number {
  return format === "jpeg" ? 65_535 : format === "webp" ? 16_383 : 1_000_000;
}

// Rounded-up measurements from the native JPEG encoder on the Zoomify painting
// and map fixtures plus Met artwork 437498. Small sample; these are heuristics.
const jpegSizeCoefficients = [
  { quality: 25, bytes: 0.1 },
  { quality: 50, bytes: 0.15 },
  { quality: 75, bytes: 0.2 },
  { quality: 90, bytes: 0.3 },
  { quality: 95, bytes: 0.4 },
  { quality: 98, bytes: 0.45 },
  { quality: 100, bytes: 0.5 },
];

function estimateSize(width: number, height: number, settings: DesktopSettings): string {
  const format = settings.output_format;
  const quality = 100 - settings.compression;
  const jpeg = jpegSizeCoefficients.find((entry) => quality <= entry.quality)?.bytes ?? 0.5;
  const bytesPerPixel =
    format === "auto" || format === "jpeg" || format === "iiif-dir"
      ? jpeg
      : format === "webp"
        ? 1.3
        : format === "png"
          ? 1.6
          : 3;
  const pyramid = format === "zif" || format === "iiif-dir" ? 4 / 3 : 1;
  const pixels = width * height;
  const mb = (pixels * bytesPerPixel * pyramid) / 1_000_000;
  return t("desktop.quick.sizeEstimate", {
    size: new Intl.NumberFormat(getLocale()).format(Math.ceil((mb * 1.1) / 5) * 5),
  });
}

function sizePresetFor(settings: DesktopSettings): SizePreset {
  if (settings.max_width === null && settings.max_height === null) return "full";
  const preset = sizes.find(
    (size) => size.width === settings.max_width && size.height === settings.max_height,
  );
  if (preset) return String(preset.width);
  return "custom";
}

function folderName(path: string | null): string {
  if (!path) return t("desktop.quick.askEachTime");
  return path.split(/[\\/]/).filter(Boolean).pop() ?? t("desktop.quick.chosenFolder");
}

function QuickChoice({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: Array<{ value: string; label: string; hint: string; disabled?: boolean }>;
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
      <summary aria-label={`${label}: ${selected.label}`}>
        <span className="dz-choice-selected">{selected.label}</span>
        <span aria-hidden="true">▾</span>
      </summary>
      <fieldset className="dz-quick-menu" aria-label={label}>
        {choices.map((choice) => (
          <div className="dz-quick-menu-row" key={choice.value}>
            <button
              type="button"
              disabled={choice.disabled}
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
          </div>
        ))}
      </fieldset>
    </details>
  );
}

function QuickOption({
  label,
  onInfo,
  children,
}: {
  label: string;
  onInfo(): void;
  children: ReactNode;
}) {
  return (
    <div className="dz-quick-option">
      <span className="dz-quick-label">
        {label}
        <button
          type="button"
          className="dz-quick-info"
          aria-label={`${label}: ${t("desktop.quick.info")}`}
          onClick={onInfo}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" />
            <path d="M8 7v4M8 4.5v.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </span>
      {children}
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
  const formats = formatChoices();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [help, setHelp] = useState<"folder" | "format" | "size" | "network" | null>(null);
  const [headersDraft, setHeadersDraft] = useState(() => headersToEditableText(settings.headers));
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setHeadersDraft(headersToEditableText(settings.headers));
  }, [settings.headers]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const isOpen = dialog.open || dialog.hasAttribute("open");
    if ((advancedOpen || help) && !isOpen) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!advancedOpen && !help && isOpen) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [advancedOpen, help]);

  // These caps select source levels, not resized output dimensions. The smallest
  // available level may exceed them; native encoding validates the actual canvas.
  // This guard only prevents combinations whose requested bounds already exceed
  // the encoder limit. Estimates assume those bounds and cannot guarantee a size.
  const commit = (patch: Partial<DesktopSettings>) => {
    const next = { ...settings, ...patch };
    if (
      ("output_format" in patch || "max_width" in patch || "max_height" in patch) &&
      Math.max(next.max_width ?? 0, next.max_height ?? 0) > formatLimit(next.output_format)
    )
      return;
    onChange(next);
  };

  const chooseDirectory = async (key: "output_dir" | "cache_dir") => {
    const value = await pickDirectory(settings[key]);
    if (value) commit({ [key]: value });
  };

  const chooseSize = (preset: SizePreset) => {
    const size = sizes.find((size) => String(size.width) === preset);
    if (preset === "full") commit({ max_width: null, max_height: null });
    else if (size) commit({ max_width: size.width, max_height: size.height });
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
        <QuickOption label={t("desktop.quick.folder")} onInfo={() => setHelp("folder")}>
          <button
            type="button"
            className="dz-quick-button"
            title={settings.output_dir ?? t("desktop.quick.chooseFolder")}
            onClick={() => void chooseDirectory("output_dir")}
          >
            {folderName(settings.output_dir)}
          </button>
        </QuickOption>

        <QuickOption label={t("desktop.quick.format")} onInfo={() => setHelp("format")}>
          <QuickChoice
            label={t("desktop.quick.format")}
            value={settings.output_format}
            onChange={(value) =>
              commit({ output_format: value as DesktopSettings["output_format"] })
            }
            choices={formats.map((format) => ({
              ...format,
              disabled:
                Math.max(settings.max_width ?? 0, settings.max_height ?? 0) >
                formatLimit(format.value),
              hint: t(
                `desktop.quick.hint.${format.value === "iiif-dir" ? "iiifDir" : format.value}`,
              ),
            }))}
          />
        </QuickOption>

        <QuickOption label={t("desktop.quick.size")} onInfo={() => setHelp("size")}>
          <QuickChoice
            label={t("desktop.quick.size")}
            value={sizePresetFor(settings)}
            onChange={chooseSize}
            choices={[
              {
                value: "full",
                label: t("desktop.quick.fullResolution"),
                hint: t("desktop.quick.source"),
              },
              ...sizes.map(({ label, width, height }) => ({
                value: String(width),
                label,
                hint: estimateSize(width, height, settings),
                disabled: Math.max(width, height) > formatLimit(settings.output_format),
              })),
              {
                value: "custom",
                label: t("desktop.quick.custom"),
                hint: t("desktop.quick.exact"),
              },
            ]}
          />
        </QuickOption>

        <QuickOption label={t("desktop.quick.network")} onInfo={() => setHelp("network")}>
          <QuickChoice
            label={t("desktop.quick.network")}
            value={settings.network_profile}
            onChange={(value) => commit({ network_profile: value as NetworkProfile })}
            choices={profiles.map((profile) => ({
              value: profile,
              label: t(`desktop.quick.${profile === "maximum" ? "fast" : profile}`),
              hint: t(`desktop.quick.rate.${profile}`),
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
        onClose={() => {
          setAdvancedOpen(false);
          setHelp(null);
        }}
        onCancel={() => {
          setAdvancedOpen(false);
          setHelp(null);
        }}
      >
        <div className="dz-settings-sheet">
          <header className="dz-settings-sheet-head">
            <h2 id="dz-settings-dialog-title">
              {help ? t(`desktop.quick.${help}`) : t("desktop.advanced.title")}
            </h2>
            <button
              type="button"
              className="dz-settings-close"
              onClick={() => {
                setAdvancedOpen(false);
                setHelp(null);
              }}
            >
              {t("desktop.advanced.done")}
            </button>
          </header>

          {help ? (
            <div className="dz-settings-explanation">
              <p>{t(`desktop.quick.${help}Info`)}</p>
              {help === "format" ? (
                <dl>
                  {formats.map((format) => (
                    <div key={format.value}>
                      <dt>{format.label}</dt>
                      <dd>
                        {t(
                          `desktop.quick.format.${format.value === "iiif-dir" ? "iiifDir" : format.value}`,
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {help === "size" ? (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("desktop.quick.size")}</th>
                      <th scope="col">{t("desktop.quick.maxWidth")}</th>
                      <th scope="col">{t("desktop.quick.maxHeight")}</th>
                      <th scope="col">
                        {t("desktop.quick.estimatedSize", {
                          format:
                            formats.find((format) => format.value === settings.output_format)
                              ?.label ?? "",
                        })}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">{t("desktop.quick.fullResolution")}</th>
                      <td>{t("desktop.quick.original")}</td>
                      <td>{t("desktop.quick.original")}</td>
                      <td>{t("desktop.quick.source")}</td>
                    </tr>
                    {sizes.map(({ label, width, height }) => (
                      <tr key={width}>
                        <th scope="row">{label}</th>
                        <td>{width.toLocaleString(getLocale())} px</td>
                        <td>{height.toLocaleString(getLocale())} px</td>
                        <td>{estimateSize(width, height, settings)}</td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row">{t("desktop.quick.custom")}</th>
                      <td>{t("desktop.quick.userDefined")}</td>
                      <td>{t("desktop.quick.userDefined")}</td>
                      <td>{t("desktop.quick.source")}</td>
                    </tr>
                  </tbody>
                </table>
              ) : null}
              {help === "network" ? (
                <dl>
                  {profiles.map((profile) => (
                    <div key={profile}>
                      <dt>{t(`desktop.quick.${profile === "maximum" ? "fast" : profile}`)}</dt>
                      <dd>{t(`desktop.quick.rate.${profile}`)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          ) : (
            <>
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
                    max={formatLimit(settings.output_format)}
                    placeholder={t("desktop.advanced.width")}
                    aria-label={t("desktop.advanced.width")}
                    value={settings.max_width ?? ""}
                    onChange={(event) =>
                      commit({
                        max_width: event.currentTarget.value
                          ? Number(event.currentTarget.value)
                          : null,
                      })
                    }
                  />
                  <span aria-hidden="true">×</span>
                  <input
                    type="number"
                    min="1"
                    max={formatLimit(settings.output_format)}
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
            </>
          )}
        </div>
      </dialog>
    </section>
  );
}
