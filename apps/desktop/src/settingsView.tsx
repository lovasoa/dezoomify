import { useState } from "react";
import type { ReactElement } from "react";
import { t } from "@dezoomify/shared-ui";
import { headersToEditableText, parseHeadersText, pickDirectory, validateSettings } from "./settings.ts";
import type { DesktopSettings, DesktopOutputFormat, NetworkProfile } from "./settings.ts";

type Props = { settings: DesktopSettings; error: string | null; onChange(settings: DesktopSettings): void; onReset(): void };
const formats: DesktopOutputFormat[] = ["png", "jpeg", "tiff", "zif", "webp", "iiif-dir"];
const profiles: NetworkProfile[] = ["maximum", "balanced", "gentle"];

/** Desktop-only settings entry point. It owns draft input values and emits only validated settings. */
export function DesktopSettingsView({ settings, error, onChange, onReset }: Props): ReactElement {
  const [advanced, setAdvanced] = useState(false);
  const commit = (patch: Partial<DesktopSettings>) => {
    const candidate = validateSettings({ ...settings, ...patch });
    if (candidate.settings) onChange(candidate.settings);
  };
  const choose = async (key: "outputDir" | "cacheDir") => {
    const value = await pickDirectory(settings[key]);
    if (value) commit({ [key]: value });
  };
  return <section id="dz-desktop-settings" className="dz-view-body dz-desktop-settings" aria-label="Job options">
    <div className="dz-quick-options">
      <label className="dz-quick-option"><span>{t("desktop.quick.folder")}</span><button type="button" className="dz-quick-button" onClick={() => void choose("outputDir")}>{settings.outputDir?.split(/[\\/]/).pop() ?? t("desktop.quick.askEachTime")}</button></label>
      <label className="dz-quick-option"><span>{t("desktop.quick.format")}</span><select value={settings.outputFormat} onChange={(e) => commit({ outputFormat: e.currentTarget.value as DesktopOutputFormat })}>{formats.map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label>
      <label className="dz-quick-option"><span>{t("desktop.quick.network")}</span><select value={settings.networkProfile} onChange={(e) => commit({ networkProfile: e.currentTarget.value as NetworkProfile })}>{profiles.map((profile) => <option key={profile} value={profile}>{t(`desktop.quick.${profile === "maximum" ? "fast" : profile}`)}</option>)}</select></label>
      <button type="button" className="dz-settings-more" aria-label={t("desktop.quick.more")} onClick={() => setAdvanced(!advanced)}>⚙</button>
    </div>
    {advanced ? <div className="dz-settings-sheet">
      <label>{t("desktop.advanced.dimensions")}<span className="dz-size-control"><input type="number" min="1" value={settings.maxWidth ?? ""} onChange={(e) => commit({ maxWidth: e.currentTarget.value ? Number(e.currentTarget.value) : null })} /><span>×</span><input type="number" min="1" value={settings.maxHeight ?? ""} onChange={(e) => commit({ maxHeight: e.currentTarget.value ? Number(e.currentTarget.value) : null })} /></span></label>
      <label>{t("desktop.advanced.retries")}<input type="number" min="0" max="100" value={settings.retries} onChange={(e) => commit({ retries: Number(e.currentTarget.value) })} /></label>
      <label>{t("desktop.advanced.resumeCache")}<button type="button" onClick={() => void choose("cacheDir")}>{settings.cacheDir ? t("desktop.advanced.change") : t("desktop.advanced.choose")}</button></label>
      <label>{t("desktop.advanced.headers")}<textarea rows={3} value={headersToEditableText(settings.headers)} onChange={(e) => { const parsed = parseHeadersText(e.currentTarget.value); if (!parsed.errors.length) commit({ headers: parsed.headers }); }} /></label>
      {error ? <p id="dz-settings-error" role="alert">{error}</p> : null}
      <button type="button" className="dz-settings-reset" onClick={onReset}>{t("desktop.settings.reset")}</button>
    </div> : null}
  </section>;
}
