// Browser plan gates (todo 2.2 home, moved from `src/main.ts`).
//
// Declared sizes fail fast with a desktop handoff link without planning, so
// the worker never serializes a trillion-tile plan. Undeclared sizes skip
// the declared gate (probe-driven) and rely on the worker `limit-exceeded`
// guard plus the post-plan gates. Pure: limits come from `./limits.ts`, the
// structured failure from `./session.ts`. Keep erasable-syntax-only.
import { failure } from "./failure.ts";
import type { StructuredFailure } from "./failure.ts";
import {
  BROWSER_LIMITS,
  BROWSER_MAX_PLAN_TILES,
  estimateTileCount,
  probeLimits,
} from "./limits.ts";

/** Desktop handoff link for images beyond the browser tab (`dezoomify://`).
 * Returns "" for non-http(s) sources (for example local `file:` URLs): the
 * desktop deep link only carries bounded http(s) input, so local files show
 * the local-only note instead of a broken link. */
export function desktopHandoffLink(sourceUrl: string): string {
  try {
    const u = new URL(String(sourceUrl ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  } catch {
    return "";
  }
  return `dezoomify://open?v=2&src=${encodeURIComponent(sourceUrl)}`;
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

/** Whether a declared size fits the browser tab plus the plan tile cap. */
export function levelFitsBrowser(width: number, height: number): boolean {
  if (probeLimits({ width, height }, BROWSER_LIMITS).verdict !== "ok") return false;
  const estimate = estimateTileCount(width, height);
  return estimate !== null && estimate <= BROWSER_MAX_PLAN_TILES;
}

export interface DeclaredSize {
  x: number;
  y: number;
}

/**
 * Pre-plan gate (todo 5.3): declared sizes fail fast with desktop handoff
 * guidance. Returns null when the size fits (or is undeclared, letting the
 * probe-driven path continue); otherwise the structured failure to throw.
 */
export function assertDeclaredSizeFitsBrowser(
  size: DeclaredSize | undefined,
  sourceUrl: string,
): StructuredFailure | null {
  if (!size) return null;
  if (probeLimits({ width: size.x, height: size.y }, BROWSER_LIMITS).verdict !== "ok") {
    return canvasTooLargeFailure(size.x, size.y, sourceUrl);
  }
  const estimate = estimateTileCount(size.x, size.y);
  if (estimate === null || estimate > BROWSER_MAX_PLAN_TILES) {
    return canvasTooLargeFailure(
      size.x,
      size.y,
      sourceUrl,
      estimate === null
        ? "tile-count estimate overflow"
        : `estimated ${estimate} tiles exceeds the ${BROWSER_MAX_PLAN_TILES}-tile browser plan limit`,
    );
  }
  return null;
}

/**
 * Post-plan gate: the materialized canvas plus tile count must fit the tab.
 * Returns null when the plan fits; otherwise the structured failure to throw.
 */
export function assertPlanFitsBrowser(
  width: number,
  height: number,
  tileCount: number,
  sourceUrl: string,
): StructuredFailure | null {
  if (!(width > 0 && height > 0)) {
    return failure(
      "PLAN_INVALID",
      "The image size could not be determined.",
      false,
      undefined,
      `invalid tile plan: canvas ${width}x${height}`,
    );
  }
  if (probeLimits({ width, height }, BROWSER_LIMITS).verdict !== "ok") {
    return canvasTooLargeFailure(width, height, sourceUrl);
  }
  if (tileCount > BROWSER_MAX_PLAN_TILES) {
    return canvasTooLargeFailure(
      width,
      height,
      sourceUrl,
      `${tileCount} tiles exceeds the ${BROWSER_MAX_PLAN_TILES}-tile browser plan limit`,
    );
  }
  return null;
}

/**
 * Map the worker allocation guard (wasm MAX_PLAN_TILES surfaces as the
 * stable `limit-exceeded` code inside the detail string) to the same desktop
 * handoff so probe-driven huge levels fail as PLAN_INVALID instead of
 * generic WORKER_FAILED. Returns the mapped failure, or null to rethrow.
 */
export function mapWorkerLimitExceeded(
  error: unknown,
  fallbackWidth: number,
  fallbackHeight: number,
  sourceUrl: string,
): StructuredFailure | null {
  const structured = error as { code?: string; detail?: string; technical?: string };
  const hay = `${structured?.code ?? ""} ${structured?.detail ?? ""} ${structured?.technical ?? ""}`;
  if (hay.includes("limit-exceeded")) {
    return canvasTooLargeFailure(
      fallbackWidth,
      fallbackHeight,
      sourceUrl,
      "tile plan exceeds the browser plan limit",
    );
  }
  return null;
}

export function isAllowedSourceUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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

/** Stable error classification derived from the code, never from text. */
export function categoryFor(code: unknown): string {
  if (typeof code !== "string") return "transport";
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code === "INVALID_URL") return "validation";
  if (code.startsWith("OUTPUT_")) return "output";
  if (code === "WORKER_FAILED" || code === "PLAN_INVALID") return "internal";
  return "transport";
}

export function phaseFor(code: unknown): string {
  if (typeof code !== "string") return "acquisition";
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.startsWith("OUTPUT_")) return "output";
  return "acquisition";
}
