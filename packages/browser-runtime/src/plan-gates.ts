// Browser canvas failure and source URL helpers.

import { isValidDeepLinkSource } from "@dezoomify/app-model";
import type { StructuredFailure } from "./failure.ts";
import { failure } from "./failure.ts";

/** Desktop handoff link for images beyond the browser tab (`dezoomify://`).
 * Returns "" for non-http(s) sources (for example local `file:` URLs): the
 * desktop deep link only carries bounded http(s) input, so local files show
 * the local-only note instead of a broken link. */
export function desktopHandoffLink(sourceUrl: string): string {
  if (!isValidDeepLinkSource(sourceUrl)) return "";
  return `dezoomify://open?v=2&src=${encodeURIComponent(sourceUrl.trim())}`;
}

export function canvasTooLargeFailure(
  width: number,
  height: number,
  sourceUrl: string,
  extra?: string,
): StructuredFailure {
  const handoff = desktopHandoffLink(sourceUrl);
  const technical = extra
    ? `canvas ${width}x${height} exceeds the browser limit (${extra}); desktop handoff ${handoff}`
    : `canvas ${width}x${height} exceeds the browser limit; desktop handoff ${handoff}`;
  return failure(
    "PLAN_INVALID",
    "This image is too large for this browser tab. Use the desktop app for the full-size image.",
    false,
    `Open in the desktop app: ${handoff}`,
    technical,
  );
}

/** True for `file:` URLs pasted into the website input. The website cannot
 * read local files from the browser, so these are accepted-then-explained
 * (desktop-app handoff) instead of rejected as a silent invalid URL. */
export function isLocalFileUrl(urlString: string): boolean {
  try {
    return new URL(String(urlString ?? "").trim()).protocol === "file:";
  } catch {
    return false;
  }
}
