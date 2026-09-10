// Deterministic catalog selection for engine hosts.
//
// The extension job tab (and, after migration, the website) drives the Rust
// job engine, whose catalog event carries wire ids (`img:*`, `lvl:*`) plus
// declared geometry. Headless callers may provide a deterministic selection
// rule; this is the shared one: the ready image whose largest declared level
// is biggest, and inside it the largest level that fits the browser canvas
// (falling back to the smallest declared level so the plan gate fails fast,
// mirroring `pickLevel` in `./limits.ts`). Pure: no I/O, no clocks. Keep
// erasable-syntax-only for the browser `.js` mirrors.
import { BROWSER_LIMITS, probeLimits, safeArea } from "./limits.ts";
import type { BrowserLimits } from "./types.ts";
import type { CatalogDto, ImageDto, LevelDto } from "../../protocol-ts/src/generated.ts";

export interface EngineSelection {
  image: string;
  level: string;
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
  const images = Array.isArray(catalog?.images) ? catalog.images : [];
  let bestImage: ImageDto | null = null;
  let bestImageArea = -1;
  for (const image of images) {
    if (image?.readiness && image.readiness !== "ready") continue;
    const levels = Array.isArray(image.levels) ? image.levels : [];
    if (levels.length === 0) continue;
    let imageArea = -1;
    for (const level of levels) {
      const area = levelArea(level) ?? -1;
      if (area >= imageArea) imageArea = area;
    }
    // Probe-driven and adversarial dimensions may not have a safe area yet.
    // They remain selectable; declared geometry is evaluated below.
    if (!bestImage || imageArea >= bestImageArea) {
      bestImage = image;
      bestImageArea = imageArea;
    }
  }
  if (!bestImage) return null;
  const levels = Array.isArray(bestImage.levels) ? bestImage.levels : [];
  let best: LevelDto | null = null;
  let bestArea = -1;
  let smallest: LevelDto | null = null;
  let smallestArea = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    const area = levelArea(level);
    const declared = level.width > 0 && level.height > 0;
    const orderingArea = area ?? Number.POSITIVE_INFINITY;
    if (declared && levelFits(level, limits) && area !== null && area >= bestArea) {
      best = level;
      bestArea = area;
    }
    if (declared && (smallest === null || orderingArea < smallestArea)) {
      smallest = level;
      smallestArea = orderingArea;
    }
  }
  const chosen = best ?? smallest;
  if (!chosen) return null;
  return { image: bestImage.id, level: chosen.id };
}
