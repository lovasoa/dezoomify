import { t } from "@dezoomify/shared-ui";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { DesktopOutputFormat, DesktopSettings, NetworkProfile } from "./settings.ts";
import {
  headersToEditableText,
  parseHeadersText,
  pickDirectory,
  validateSettings,
} from "./settings.ts";

interface Props {
  settings: DesktopSettings;
  error: string | null;
  onChange(settings: DesktopSettings): void;
  onReset(): void;
}

const formats: Array<{ value: DesktopOutputFormat; label: string }> = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "tiff", label: "TIFF" },
  { value: "webp", label: "WebP" },
  { value: "zif", label: "ZIF" },
  { value: "iiif-dir", label: "IIIF folder" },
];

const profiles: NetworkProfile[] = ["maximum", "balanced", "gentle"];

type SizePreset = "full" | "3840" | "2048" | "custom";

function sizePresetFor(settings: DesktopSettings): SizePreset {
  if (settings.max_width === null && settings.max_height === null) return "full";
  if (settings.max_width === 3840 && settings.max_height === null) return "3840";
  if (settings.max_width === 2048 && settings.max_height === null) return "2048";
  return "custom";
}

function folderName(path: string | null): string {
  if (!path) return t("desktop.quick.askEachTime");
  return path.split(/[\\/]/).filter(Boolean).pop() ?? t("desktop.quick.chosenFolder");
}

function QuickOption({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dz-quick-option">
      <span>{label}</span>
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

  const commit = (patch: Partial<DesktopSettings>) => {
    const candidate = validateSettings({ ...settings, ...patch });
    if (candidate.settings) onChange(candidate.settings);
  };

  const chooseDirectory = async (key: "output_dir" | "cache_dir") => {
    const value = await pickDirectory(settings[key]);
    if (value) commit({ [key]: value });
  };

  const chooseSize = (preset: SizePreset) => {
    if (preset === "full") commit({ max_width: null, max_height: null });
    else if (preset === "3840") commit({ max_width: 3840, max_height: null });
    else if (preset === "2048") commit({ max_width: 2048, max_height: null });
    else setAdvancedOpen(true);
  };

  const jpeg = settings.output_format === "jpeg";
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
        <QuickOption label={t("desktop.quick.folder")}>
          <button
            type="button"
            className="dz-quick-button"
            title={settings.output_dir ?? t("desktop.quick.chooseFolder")}
            onClick={() => void chooseDirectory("output_dir")}
          >
            {folderName(settings.output_dir)}
          </button>
        </QuickOption>

        <QuickOption label={t("desktop.quick.format")}>
          <select
            aria-label={t("desktop.quick.format")}
            value={settings.output_format}
            onChange={(event) =>
              commit({ output_format: event.currentTarget.value as DesktopOutputFormat })
            }
          >
            {formats.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label}
              </option>
            ))}
          </select>
        </QuickOption>

        <QuickOption label={t("desktop.quick.size")}>
          <select
            aria-label={t("desktop.quick.size")}
            value={sizePresetFor(settings)}
            onChange={(event) => chooseSize(event.currentTarget.value as SizePreset)}
          >
            <option value="full">{t("desktop.quick.fullResolution")}</option>
            <option value="3840">{t("desktop.quick.upTo4k")}</option>
            <option value="2048">{t("desktop.quick.upTo2k")}</option>
            <option value="custom">{t("desktop.quick.custom")}</option>
          </select>
        </QuickOption>

        <QuickOption label={t("desktop.quick.network")}>
          <select
            aria-label={t("desktop.quick.network")}
            value={settings.network_profile}
            onChange={(event) =>
              commit({ network_profile: event.currentTarget.value as NetworkProfile })
            }
          >
            {profiles.map((profile) => (
              <option key={profile} value={profile}>
                {t(`desktop.quick.${profile === "maximum" ? "fast" : profile}`)}
              </option>
            ))}
          </select>
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
                const parsed = parseHeadersText(draft);
                if (parsed.errors.length === 0) commit({ headers: parsed.headers });
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
