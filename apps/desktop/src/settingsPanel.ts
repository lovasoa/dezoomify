// Desktop settings state helpers. Rendering lives in settingsView.tsx.
import { loadSettings, saveSettings, validateSettings } from "./settings.ts";
import type { DesktopSettings } from "./settings.ts";

export function getEffectiveSettings(fallback: DesktopSettings) {
  const validated = validateSettings(fallback);
  return validated.ok && validated.settings
    ? { ok: true as const, settings: validated.settings, errors: [] as string[] }
    : { ok: false as const, settings: null, errors: validated.errors };
}

export function resetDesktopSettings(): DesktopSettings {
  const settings = validateSettings(null).settings ?? loadSettings();
  saveSettings(settings);
  return settings;
}
