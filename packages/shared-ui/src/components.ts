// Minimal host-neutral shared-ui helpers (no React, no browser globals).
import { t } from "./i18n.ts";

export function renderSaveGuidance(originClean: boolean): string {
  return t(originClean ? "view.done.guidance" : "view.display.guidance");
}

export function renderCompletion(width: number, height: number, mime: string): string {
  return t("view.done.summary", { width, height, mime });
}

/** Short human elapsed time: "3 s", "1 min 5 s". Empty for sub-second noise. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 2000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}
