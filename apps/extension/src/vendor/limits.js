// GENERATED from packages/browser-runtime/src/limits.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/limits.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Browser resource limits with overflow-safe arithmetic.

/** Largest canvas a browser tab can hold (16384 x 16384, legacy parity). */
export const BROWSER_MAX_CANVAS_AREA = 268435456;

/** Browser canvas side limit: 16384 px per side, no policy widening. */
export const BROWSER_MAX_CANVAS_SIDE = 16384;

export const BROWSER_LIMITS                = {
  maxWidth: BROWSER_MAX_CANVAS_SIDE,
  maxHeight: BROWSER_MAX_CANVAS_SIDE,
  maxArea: BROWSER_MAX_CANVAS_AREA,
  maxBytes: BROWSER_MAX_CANVAS_AREA * 4,
};

/** Upper bound on tiles materialized into one website plan (allocation guard). */
export const BROWSER_MAX_PLAN_TILES = 100_000;

export function safeArea(width        , height        )                {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  // Overflow-safe: check division before multiplying. JS is float64 but we
  // guard against exceeding MAX_SAFE_INTEGER as well.
  if (width > Number.MAX_SAFE_INTEGER / height) return null;
  return width * height;
}

export function probeLimits(
  req                                                            ,
  limits               ,
)                {
  const { width, height, estimatedBytes } = req;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { verdict: "native-required", reason: "zero-or-invalid-dimension", area: null };
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { verdict: "native-required", reason: "non-integer-dimension", area: null };
  }
  if (width > limits.maxWidth) {
    return { verdict: "native-required", reason: "width-exceeds-limit", area: null };
  }
  if (height > limits.maxHeight) {
    return { verdict: "native-required", reason: "height-exceeds-limit", area: null };
  }
  // Overflow-safe area comparison without multiplying first.
  if (limits.maxArea >= 0 && height !== 0 && width > limits.maxArea / height) {
    return { verdict: "native-required", reason: "area-exceeds-limit", area: null };
  }
  const area = width * height;
  if (!Number.isSafeInteger(area) || area > limits.maxArea) {
    return { verdict: "native-required", reason: "area-exceeds-limit", area: null };
  }
  if (
    estimatedBytes !== undefined &&
    Number.isFinite(estimatedBytes) &&
    estimatedBytes > limits.maxBytes
  ) {
    return { verdict: "browser-risk", reason: "memory-uncertain", area };
  }
  return { verdict: "ok", reason: "within-limits", area };
}

/**
 * Tile-count estimate for a declared size assuming 256 px tiles (todo 5.3).
 * 256 px is the smallest common tile, so the estimate is a conservative
 * upper bound. Overflow-safe: returns null for invalid sizes or when the
 * multiply would exceed MAX_SAFE_INTEGER.
 */
export function estimateTileCount(
  width        ,
  height        ,
  tileSide         = 256,
)                {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  if (!Number.isInteger(tileSide) || tileSide <= 0) return null;
  const cols = Math.floor((width + tileSide - 1) / tileSide);
  const rows = Math.floor((height + tileSide - 1) / tileSide);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols <= 0 || rows <= 0) {
    return null;
  }
  if (cols > Number.MAX_SAFE_INTEGER / rows) return null;
  return cols * rows;
}

/**
 * Largest declared level that fits the browser canvas wins (overflow-safe
 * via `probeLimits`). Levels without a declared size keep the old behavior
 * (last wins). When declared levels exist but none fits, the smallest
 * declared level is returned so the pre-plan gate fails fast.
 */
export function pickLevel(image

 )              {
  let best                     = null;
  let bestArea = -1;
  let smallest                     = null;
  let smallestArea = Number.POSITIVE_INFINITY;
  let sawDeclared = false;
  let lastUndeclared                     = null;
  for (const level of image.levels) {
    const size = level.imageSize;
    if (!size) {
      lastUndeclared = { index: level.index };
      continue;
    }
    sawDeclared = true;
    const fits = probeLimits({ width: size.x, height: size.y }, BROWSER_LIMITS).verdict === "ok";
    const area = safeArea(size.x, size.y) ?? Number.POSITIVE_INFINITY;
    if (fits && area >= bestArea) {
      best = { index: level.index };
      bestArea = area;
    }
    if (area < smallestArea) {
      smallest = { index: level.index };
      smallestArea = area;
    }
  }
  if (best) return best;
  if (sawDeclared) return smallest ?? { index: 0 };
  return lastUndeclared ?? { index: 0 };
}
