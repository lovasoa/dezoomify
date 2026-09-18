// Deterministic catalog selection for engine hosts.
//
// The extension job tab drives the Rust job engine, whose catalog event
// carries an immutable ordered catalog. Headless callers may provide a deterministic selection
// rule; this is the shared one: the ready image whose largest declared level
// is biggest, and inside it the largest level that fits the browser canvas
// (falling back to the smallest declared level so the plan gate fails fast,
// mirroring `pickLevel` in `./limits.ts`). When no ready image is selectable,
// `pickDeferredUri` surfaces the first still-deferred entry so the host can
// follow it with a fresh bounded attempt, mirroring the native driver. Pure:
// no I/O, no clocks.
import { BROWSER_LIMITS, probeLimits, safeArea } from "./limits.ts";
import type { BrowserLimits } from "./types.ts";
import type { CatalogDto, ImageDto, LevelDto } from "@dezoomify/wasm-bindings";

/**
 * Deferred-resolution bound: the initial discovery plus this many deferred
 * follows, matching the native driver's `MAX_DEFERRED_FOLLOWS`.
 */
export const MAX_DEFERRED_FOLLOWS = 10;

export interface EngineSelection {
  image: number;
  level: number;
  /** Optional core-extracted title, never a UI fallback. */
  title?: string;
}

function levelArea(level: LevelDto): number | null {
  return safeArea(level.width, level.height);
}

function levelFits(level: LevelDto, limits: BrowserLimits): boolean {
  return probeLimits({ width: level.width, height: level.height }, limits).verdict === "ok";
}

/**
 * Deterministic selection over an engine catalog. Returns null when no
 * ready image declares a selectable level (the caller renders a typed
 * failure; the engine never guesses silently).
 */
export function pickEngineSelection(
  catalog: CatalogDto | undefined,
  limits: BrowserLimits = BROWSER_LIMITS,
): EngineSelection | null {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  let bestImage: ImageDto | null = null;
  let bestImageIndex = -1;
  let bestImageArea = -1;
  for (const [imageIndex, entry] of entries.entries()) {
    if (!entry || entry.kind !== "image") continue;
    const levels = Array.isArray(entry.levels) ? entry.levels : [];
    if (levels.length === 0) continue;
    let imageArea = -1;
    for (const level of levels) {
      const area = levelArea(level) ?? -1;
      if (area >= imageArea) imageArea = area;
    }
    // Probe-driven and adversarial dimensions may not have a safe area yet.
    // They remain selectable; declared geometry is evaluated below.
    if (!bestImage || imageArea >= bestImageArea) {
      bestImage = entry;
      bestImageIndex = imageIndex;
      bestImageArea = imageArea;
    }
  }
  if (!bestImage) return null;
  const levels = Array.isArray(bestImage.levels) ? bestImage.levels : [];
  let best: LevelDto | null = null;
  let bestIndex = -1;
  let bestArea = -1;
  let smallest: LevelDto | null = null;
  let smallestIndex = -1;
  let smallestArea = Number.POSITIVE_INFINITY;
  for (const [levelIndex, level] of levels.entries()) {
    const area = levelArea(level);
    const declared = level.width > 0 && level.height > 0;
    const orderingArea = area ?? Number.POSITIVE_INFINITY;
    if (declared && levelFits(level, limits) && area !== null && area >= bestArea) {
      best = level;
      bestIndex = levelIndex;
      bestArea = area;
    }
    if (declared && (smallest === null || orderingArea < smallestArea)) {
      smallest = level;
      smallestIndex = levelIndex;
      smallestArea = orderingArea;
    }
  }
  const chosen = best ?? smallest;
  if (!chosen) return null;
  return {
    image: bestImageIndex,
    level: best ? bestIndex : smallestIndex,
    ...(typeof bestImage.title === "string" ? { title: bestImage.title } : {}),
  };
}

/**
 * Follow-up URI of the first still-deferred catalog entry, or null when the
 * catalog has none. The caller follows it with a fresh bounded attempt; the
 * engine never resolves deferred metadata silently.
 */
export function pickDeferredUri(catalog: CatalogDto | undefined): string | null {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  for (const entry of entries) {
    if (
      entry?.kind === "image-request"
      && typeof entry.uri === "string"
      && entry.uri !== ""
    ) {
      return entry.uri;
    }
  }
  return null;
}
