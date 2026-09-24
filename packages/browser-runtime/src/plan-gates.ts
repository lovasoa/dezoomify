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

/** Plain sentence shared by every too-large-for-this-tab report. */
export const CANVAS_TOO_LARGE_MESSAGE =
  "This image is too large for this browser tab. Use the desktop app for the full-size image.";

function canvasFailure(
  code: string,
  message: string,
  width: number,
  height: number,
  sourceUrl: string,
  stage: string,
): StructuredFailure {
  const handoff = desktopHandoffLink(sourceUrl);
  return failure(
    code,
    message,
    false,
    `Open in the desktop app: ${handoff}`,
    `canvas ${width}x${height} ${stage}; desktop handoff ${handoff}`,
  );
}

/** The plan's declared canvas exceeds the browser canvas limits. */
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
    CANVAS_TOO_LARGE_MESSAGE,
    false,
    `Open in the desktop app: ${handoff}`,
    technical,
  );
}

/** The browser refused to allocate the output canvas at this size. */
export function canvasAllocationFailure(
  width: number,
  height: number,
  sourceUrl: string,
): StructuredFailure {
  return canvasFailure(
    "OUTPUT_ALLOCATION_FAILED",
    CANVAS_TOO_LARGE_MESSAGE,
    width,
    height,
    sourceUrl,
    "allocation failed",
  );
}

/** The browser gave no 2D context for the output canvas at this size. */
export function canvasSurfaceFailure(
  width: number,
  height: number,
  sourceUrl: string,
): StructuredFailure {
  return canvasFailure(
    "OUTPUT_SURFACE_UNAVAILABLE",
    "This browser could not create the output surface.",
    width,
    height,
    sourceUrl,
    "2D context unavailable",
  );
}

/**
 * True when the recovery for this failure code is the desktop app: hosts set
 * the handoff action beside the report. Codes only, never display strings.
 */
export function wantsDesktopHandoff(code: string): boolean {
  const lower = String(code ?? "").toLowerCase();
  return (
    code === "PLAN_INVALID" ||
    code === "OUTPUT_ALLOCATION_FAILED" ||
    code === "OUTPUT_SURFACE_UNAVAILABLE" ||
    code === "OUTPUT_ENCODE_FAILED" ||
    lower === "output.canvas-limit" ||
    lower === "job.resource-limit"
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
