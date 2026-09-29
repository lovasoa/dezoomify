// Browser canvas failure and source URL helpers.

import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { isValidDeepLinkSource } from "../../shared-ui/src/source-url.ts";
import { outputError } from "./failure.ts";

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
): JobError {
  const handoff = desktopHandoffLink(sourceUrl);
  return outputError(
    code,
    message,
    `canvas ${width}x${height} ${stage}; open in the desktop app: ${handoff}`,
  );
}

/** The plan's declared canvas exceeds the browser canvas limits. */
export function canvasTooLargeFailure(
  width: number,
  height: number,
  sourceUrl: string,
  extra?: string,
): JobError {
  const handoff = desktopHandoffLink(sourceUrl);
  const detail = extra
    ? `canvas ${width}x${height} exceeds the browser limit (${extra}); desktop handoff ${handoff}`
    : `canvas ${width}x${height} exceeds the browser limit; desktop handoff ${handoff}`;
  return outputError("PLAN_INVALID", CANVAS_TOO_LARGE_MESSAGE, detail);
}

/** The browser refused to allocate the output canvas at this size. */
export function canvasAllocationFailure(
  width: number,
  height: number,
  sourceUrl: string,
): JobError {
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
export function canvasSurfaceFailure(width: number, height: number, sourceUrl: string): JobError {
  return canvasFailure(
    "OUTPUT_SURFACE_UNAVAILABLE",
    "This browser could not create the output surface.",
    width,
    height,
    sourceUrl,
    "2D context unavailable",
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
