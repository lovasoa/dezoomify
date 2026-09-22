// Minimal host-neutral shared-ui helpers (no React, no browser globals).
import type { StructuredError } from "./snapshot-view.ts";

/** Product capabilities the shared view and guidance copy read. */
export interface AppCapabilities {
  extensionAvailable?: boolean;
  nativeAvailable?: boolean;
  proxyAllowed?: boolean;
  browserCanSave?: boolean;
}

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

export function renderErrorSummary(error: StructuredError): string {
  const action = error.retryable ? "Please try again." : "Please try a different picture or app.";
  return `${error.message} ${action}`;
}

/**
 * Plain-language app-choice guidance rendered from capabilities.
 * No jargon: avoid technical terms so tests can assert absence.
 */
export function renderAppChoice(cap: AppCapabilities): string {
  const lines: string[] = [];
  lines.push("Best next step:");
  if (cap.nativeAvailable) {
    lines.push(
      "For very large pictures, use the desktop app on your computer. It can handle bigger files.",
    );
  } else if (cap.extensionAvailable) {
    lines.push(
      "You can also try the browser add-on. It can open pictures that need you to be signed in.",
    );
  } else if (cap.browserCanSave === false) {
    lines.push(
      "This preview can only be viewed here. To keep a full copy, try the desktop app on your computer.",
    );
  } else {
    lines.push("You can continue in this browser. No extra steps are needed.");
  }
  lines.push("What each choice can do:");
  lines.push("- This browser works for most public pictures you can already see.");
  if (cap.extensionAvailable) {
    lines.push("- The browser add-on helps when a picture needs you to be signed in.");
  } else {
    lines.push("- The browser add-on is not connected right now.");
  }
  if (cap.nativeAvailable) {
    lines.push("- The desktop app is ready and handles the largest pictures.");
  } else {
    lines.push("- The desktop app is not connected right now.");
  }
  return lines.join("\n");
}

export function renderProgress(current: number, total: number): string {
  if (total <= 0) return `Working: ${current} done.`;
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  return `Working: ${current} of ${total} done (${pct} percent).`;
}

/**
 * Missing-tile ledger behind a kept partial (gap map data, no user copy).
 * Splits the ledger into the ids shown inline plus the overflow count, so
 * every app (website, desktop app, extension) renders the same gap map
 * instead of silent gaps. Pure data: callers compose the sentence through
 * their own dictionary (`view.done.gapMap` in shared UI). Ids are short
 * plan tokens; URLs and paths never belong here (hosts filter them out).
 */
export function splitGapLedger(
  missingTiles: Array<string>,
  maxShown = 20,
): { shown: string; rest: number; count: number } {
  const ids = (Array.isArray(missingTiles) ? missingTiles : []).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  const shown = ids.slice(0, maxShown).join(", ");
  return { shown, rest: Math.max(0, ids.length - maxShown), count: ids.length };
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
