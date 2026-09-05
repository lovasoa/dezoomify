// Readable canvas surface: decoded bytes only, origin-clean invariant.
// All pixel/save operations fail closed when originClean is false.
import { SAVE_REQUIRES_READABLE_BYTES } from "./types.ts";
import type { TileSurface } from "./types.ts";

export interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export type DecodeFn = (bytes: ArrayBuffer) => Promise<DecodedImage> | DecodedImage;

export interface ReadableSurfaceHooks {
  createObjectURL?: (bytes: ArrayBuffer) => string;
  revokeObjectURL?: (url: string) => void;
  closeBitmap?: (bitmap: unknown) => void;
}

export interface ReadableCanvasSurface extends TileSurface {
  readonly width: number;
  readonly height: number;
  compositeTile(bytes: ArrayBuffer, dx: number, dy: number): Promise<void>;
  readPixels(): Uint8ClampedArray;
  processPixels(fn: (pixels: Uint8ClampedArray) => void): void;
  hashPixels(): string;
  markTainted(): void;
}

let urlCounter = 0;

function fnv1aHex(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function guardClean(originClean: boolean, op: string): void {
  if (!originClean) {
    const err = new Error(`${op} blocked: tainted canvas (${SAVE_REQUIRES_READABLE_BYTES})`) as Error & {
      code: string;
    };
    err.code = SAVE_REQUIRES_READABLE_BYTES;
    throw err;
  }
}

export function createReadableCanvasSurface(opts: {
  width: number;
  height: number;
  decode: DecodeFn;
  hooks?: ReadableSurfaceHooks;
}): ReadableCanvasSurface {
  const { width, height, decode, hooks } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("invalid canvas dimensions");
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  let originClean = true;
  let disposed = false;
  const liveUrls: string[] = [];
  const liveBitmaps: unknown[] = [];

  function ensureLive(): void {
    if (disposed) throw new Error("surface disposed");
  }

  async function compositeTile(bytes: ArrayBuffer, dx: number, dy: number): Promise<void> {
    ensureLive();
    guardClean(originClean, "compositeTile");
    // Local transient marker only (never a real blob URL): tracks the pending
    // decode for cleanup accounting when no createObjectURL hook is injected
    // (unit tests). Production callers inject a real hook; nothing here is
    // exposed as a savable URL.
    const url = hooks?.createObjectURL
      ? hooks.createObjectURL(bytes)
      : `local:transient-${(urlCounter += 1)}`;
    liveUrls.push(url);
    let decoded: DecodedImage;
    try {
      decoded = await decode(bytes);
    } catch (err) {
      try {
        hooks?.revokeObjectURL?.(url);
      } catch {
        // ignore hook errors
      }
      throw err;
    }
    // Deterministic row-major composite with clipping.
    for (let y = 0; y < decoded.height; y++) {
      const destY = dy + y;
      if (destY < 0 || destY >= height) continue;
      for (let x = 0; x < decoded.width; x++) {
        const destX = dx + x;
        if (destX < 0 || destX >= width) continue;
        const srcIdx = (y * decoded.width + x) * 4;
        const dstIdx = (destY * width + destX) * 4;
        pixels[dstIdx] = decoded.pixels[srcIdx] ?? 0;
        pixels[dstIdx + 1] = decoded.pixels[srcIdx + 1] ?? 0;
        pixels[dstIdx + 2] = decoded.pixels[srcIdx + 2] ?? 0;
        pixels[dstIdx + 3] = decoded.pixels[srcIdx + 3] ?? 255;
      }
    }
    // Cleanup: revoke URL and close bitmap via injected hooks (counted in tests).
    try {
      hooks?.revokeObjectURL?.(url);
    } catch {
      // ignore
    }
    const bitmapMarker = { url, w: decoded.width, h: decoded.height };
    liveBitmaps.push(bitmapMarker);
    try {
      hooks?.closeBitmap?.(bitmapMarker);
    } catch {
      // ignore
    }
  }

  function readPixels(): Uint8ClampedArray {
    guardClean(originClean, "readPixels");
    ensureLive();
    return new Uint8ClampedArray(pixels);
  }

  function processPixels(fn: (p: Uint8ClampedArray) => void): void {
    guardClean(originClean, "processPixels");
    ensureLive();
    fn(pixels);
  }

  function hashPixels(): string {
    guardClean(originClean, "hashPixels");
    ensureLive();
    return fnv1aHex(pixels);
  }

  function markTainted(): void {
    originClean = false;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const u of liveUrls) {
      try {
        hooks?.revokeObjectURL?.(u);
      } catch {
        // ignore
      }
    }
    for (const b of liveBitmaps) {
      try {
        hooks?.closeBitmap?.(b);
      } catch {
        // ignore
      }
    }
    liveUrls.length = 0;
    liveBitmaps.length = 0;
  }

  return {
    get originClean(): boolean {
      return originClean;
    },
    saveGuidance:
      "Readable pixels are available. You can process and save this image.",
    get width(): number {
      return width;
    },
    get height(): number {
      return height;
    },
    compositeTile,
    readPixels,
    processPixels,
    hashPixels,
    markTainted,
    dispose,
  };
}
