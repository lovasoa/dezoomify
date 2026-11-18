import type { Size } from "@dezoomify/wasm-bindings";

// Leave room for the reply envelope within the browser's 64 MiB message limit.
export const VIEWER_TILE_BYTE_LIMIT = 64 * 1024 * 1024 - 1024;

/** Tightly packed, unpremultiplied 8-bit sRGB RGBA pixels in row-major order. */
export interface TilePixels extends Size {
  buffer: ArrayBuffer;
}

export type TileRaster = ArrayBuffer | TilePixels;
