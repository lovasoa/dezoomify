// Minimal host-neutral shared-ui helpers (no React, no browser globals).
export function renderSaveGuidance(originClean: boolean): string {
  if (originClean) {
    return (
      "You can save this picture in the format and name shown below. " +
      "Colors may shift slightly: the browser save does not keep the original " +
      "color profile. For exact colors, use the desktop app."
    );
  }
  return (
    "Your image should appear below. In order to persist it as a file on " +
    'your computer, right-click on it and select "Save Image As...". ' +
    "For faster saves that automatically create files in the format " +
    "you choose, use the desktop app."
  );
}

export function renderCompletion(width: number, height: number, mime: string): string {
  return `Finished. Your picture is ${width} by ${height} pixels (${mime}).`;
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

/** Remaining time against the per-request timeout, for pending requests. */
export function formatRemaining(elapsedMs: number, timeoutMs: number): string {
  const remaining = Math.max(0, timeoutMs - elapsedMs);
  const s = Math.ceil(remaining / 1000);
  return `${s} s left`;
}
