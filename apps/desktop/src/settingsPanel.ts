// Desktop settings state helpers. Rendering lives in settingsView.tsx.
import { saveSettings, validateSettings } from "./settings.ts";
import type { DesktopSettings } from "./settings.ts";

export function getEffectiveSettings(_root: Element | null, fallback: DesktopSettings) {
  const validated = validateSettings(fallback);
  return validated.ok && validated.settings
    ? { ok: true as const, settings: validated.settings, errors: [] as string[] }
    : { ok: false as const, settings: null, errors: validated.errors };
}

export interface SettingsPanelEnv {
  getSettings(): DesktopSettings;
  setSettings(settings: DesktopSettings): void;
  setError(error: string | null): void;
  pushLog(line: string): void;
  update(): void;
}

export function resetDesktopSettings(env: SettingsPanelEnv): void {
  const settings = validateSettings(null).settings ?? env.getSettings();
  env.setSettings(settings);
  env.setError(null);
  saveSettings(settings);
  env.pushLog("Settings reset to defaults");
  env.update();
}
