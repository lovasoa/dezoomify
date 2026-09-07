// Crop rectangle math plus plan subset for region selection.
//
// Pure and tainted-safe: coordinates only, never pixel reads, `toBlob`,
// `toDataURL`, or hashing. The preview drag-rect maps screen pixels to
// level pixels through the preview transform (scale/tx/ty); the plan
// subset keeps only intersecting tiles with destinations shifted into the
// cropped canvas (canvas clips the rest, so edge tiles need no source
// surgery). Empty or out-of-bounds crops fail before acquisition with a
// typed error naming the fix. Keep erasable-syntax-only for the `.js`
// mirrors.
import type { PlanTile, TilePlan } from "./session.ts";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropError extends Error {
  code: string;
}

export function cropError(message: string): CropError {
  const error = new Error(message) as CropError;
  error.code = "crop-invalid";
  return error;
}

/** Parse `x,y,w,h` in level pixels. `w`/`h` must be positive integers. */
export function parseCrop(raw: string): CropRect {
  const text = String(raw ?? "").trim();
  const parts = text.split(",");
  if (parts.length !== 4) {
    throw cropError(`invalid crop "${raw}": expected x,y,w,h`);
  }
  const values = parts.map((part) => {
    const t = part.trim();
    if (t === "" || t.startsWith("+")) throw cropError(`invalid crop "${raw}": expected x,y,w,h`);
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0 || n > 4294967295 || !Number.isSafeInteger(n)) {
      throw cropError(`invalid crop "${raw}": expected x,y,w,h`);
    }
    return n;
  });
  const rect: CropRect = { x: values[0] as number, y: values[1] as number, w: values[2] as number, h: values[3] as number };
  if (rect.w <= 0 || rect.h <= 0) {
    throw cropError(`invalid crop "${raw}": width and height must be non-zero`);
  }
  return rect;
}

/** Clamp a crop to the level canvas. Null for empty or out-of-bounds. */
export function clampCrop(rect: CropRect, canvas: { x: number; y: number }): CropRect | null {
  if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y) || !Number.isInteger(rect.w) || !Number.isInteger(rect.h)) return null;
  if (rect.w <= 0 || rect.h <= 0) return null;
  if (!Number.isInteger(canvas.x) || !Number.isInteger(canvas.y) || canvas.x <= 0 || canvas.y <= 0) return null;
  if (rect.x < 0 || rect.y < 0 || rect.x >= canvas.x || rect.y >= canvas.y) return null;
  // Overflow-safe: both sides are safe integers below 2^32, sums fit in f64.
  const w = Math.min(rect.w, canvas.x - rect.x);
  const h = Math.min(rect.h, canvas.y - rect.y);
  if (w <= 0 || h <= 0) return null;
  return { x: rect.x, y: rect.y, w, h };
}

/** True when the tile rectangle intersects the crop (overflow-safe). */
export function tileIntersectsCrop(tileX: number, tileY: number, tileW: number, tileH: number, crop: CropRect): boolean {
  if (![tileX, tileY, tileW, tileH, crop.x, crop.y, crop.w, crop.h].every((n) => Number.isFinite(n))) return false;
  if (!Number.isInteger(tileW) || !Number.isInteger(tileH) || tileW <= 0 || tileH <= 0) return false;
  if (crop.w <= 0 || crop.h <= 0) return false;
  // Widen before adding so u32::MAX corners cannot wrap in f64.
  const tileRight = tileX + tileW;
  const tileBottom = tileY + tileH;
  const cropRight = crop.x + crop.w;
  const cropBottom = crop.y + crop.h;
  if (![tileRight, tileBottom, cropRight, cropBottom].every((n) => Number.isSafeInteger(n))) return false;
  return tileX < cropRight && crop.x < tileRight && tileY < cropBottom && crop.y < tileBottom;
}

/** Validate a crop against the level size before acquisition. Throws typed. */
export function assertCropFits(requested: CropRect, canvas: { x: number; y: number }): CropRect {
  const clamped = clampCrop(requested, canvas);
  if (!clamped) {
    throw cropError(
      `crop ${requested.w}x${requested.h} at ${requested.x},${requested.y} is empty or outside the ${canvas.x}x${canvas.y} image; choose x,y,w,h inside the level size`,
    );
  }
  return clamped;
}

/** Subset a tile plan to the clamped crop, shifting destinations into the cropped canvas. */
export function subsetPlanForCrop(plan: TilePlan, crop: CropRect): TilePlan {
  const canvas = plan.canvas;
  const clamped = canvas ? clampCrop(crop, canvas) : { ...crop };
  if (!clamped) {
    throw cropError(
      `crop ${crop.w}x${crop.h} at ${crop.x},${crop.y} is empty or outside the ${canvas ? `${canvas.x}x${canvas.y}` : "unknown-size"} image; choose x,y,w,h inside the level size`,
    );
  }
  const kept: PlanTile[] = [];
  for (const tile of plan.tiles) {
    const w = typeof tile.w === "number" && tile.w > 0 ? tile.w : 0;
    const h = typeof tile.h === "number" && tile.h > 0 ? tile.h : 0;
    // Unknown extents are kept conservatively; the canvas clips them.
    if (w > 0 && h > 0 && !tileIntersectsCrop(tile.x, tile.y, w, h, clamped)) continue;
    kept.push({ ...tile, x: tile.x - clamped.x, y: tile.y - clamped.y });
  }
  if (kept.length === 0) {
    throw cropError(
      `crop ${clamped.w}x${clamped.h} at ${clamped.x},${clamped.y} matches no tiles; choose a region inside the image`,
    );
  }
  return { canvas: { x: clamped.w, y: clamped.h }, tiles: kept };
}

/** Live size estimate for the crop inputs (`800x600`, no byte math). */
export function cropSizeLabel(rect: CropRect): string {
  return `${rect.w}x${rect.h}`;
}

/** Estimated RGBA bytes for a crop (`w*h*4`, null on overflow/invalid). */
export function cropByteEstimate(rect: CropRect): number | null {
  if (!Number.isInteger(rect.w) || !Number.isInteger(rect.h) || rect.w <= 0 || rect.h <= 0) return null;
  if (rect.w > Number.MAX_SAFE_INTEGER / rect.h) return null;
  const pixels = rect.w * rect.h;
  if (!Number.isSafeInteger(pixels)) return null;
  if (pixels > Number.MAX_SAFE_INTEGER / 4) return null;
  return pixels * 4;
}

/**
 * Map a screen-space drag rectangle to level pixels through the preview
 * transform (`translate(tx,ty) scale(s)` with `transform-origin: 0 0`).
 * `canvasSize` is the full level size; the result is clamped to it (null
 * when the drag has no area inside). Tainted-safe: arithmetic only.
 */
export function screenRectToLevel(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  transform: { scale: number; tx: number; ty: number },
  canvasSize: { x: number; y: number },
): CropRect | null {
  const scale = typeof transform.scale === "number" && Number.isFinite(transform.scale) && transform.scale > 0 ? transform.scale : 1;
  const tx = Number.isFinite(transform.tx) ? transform.tx : 0;
  const ty = Number.isFinite(transform.ty) ? transform.ty : 0;
  const x0 = (Math.min(startX, endX) - tx) / scale;
  const y0 = (Math.min(startY, endY) - ty) / scale;
  const x1 = (Math.max(startX, endX) - tx) / scale;
  const y1 = (Math.max(startY, endY) - ty) / scale;
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  const w = Math.floor(x1) - x;
  const h = Math.floor(y1) - y;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(w) || !Number.isSafeInteger(h)) return null;
  if (w <= 0 || h <= 0) return null;
  return clampCrop({ x: Math.max(0, x), y: Math.max(0, y), w, h }, canvasSize);
}
