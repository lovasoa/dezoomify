import {
  SizeLimitError,
  SOURCE_FETCH_BYTE_LIMIT,
  type TilePixels,
  tileError,
  VIEWER_TILE_BYTE_LIMIT,
} from "@dezoomify/browser-runtime";
import type { Size } from "@dezoomify/wasm-bindings";
import type { ViewerDrawable } from "./session.ts";

const DRAWABLE_BYTE_LIMIT = 64 * 1024 * 1024;

async function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  if (blob.size > SOURCE_FETCH_BYTE_LIMIT) throw new SizeLimitError(SOURCE_FETCH_BYTE_LIMIT);
  try {
    return await createImageBitmap(blob);
  } catch (error) {
    throw tileError("decode-failed", error);
  }
}

/** The core's grid extent can be smaller than the viewer's padded drawable.
 * Scaling to that extent would shift tile boundaries. */
export async function readTilePixels(
  tile: ViewerDrawable,
  extent: Size,
  signal: AbortSignal,
): Promise<TilePixels> {
  const value = tile.image;
  let decoded: ImageBitmap | undefined;
  try {
    signal.throwIfAborted();
    if (Object.prototype.toString.call(value) === "[object Blob]") {
      decoded = await decodeBlob(value as Blob);
      signal.throwIfAborted();
    }
    const image = (decoded ??
      (value as { canvas?: HTMLCanvasElement })?.canvas ??
      value) as CanvasImageSource & {
      width: number;
      height: number;
      naturalWidth?: number;
      naturalHeight?: number;
    };
    const imageWidth = image?.naturalWidth ?? image?.width;
    const imageHeight = image?.naturalHeight ?? image?.height;
    if (
      ![imageWidth, imageHeight, extent.width, extent.height].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      (!decoded && (imageWidth < extent.width || imageHeight < extent.height))
    )
      throw new Error("viewer returned an invalid tile size");
    const width = Math.min(imageWidth, extent.width);
    const height = Math.min(imageHeight, extent.height);
    if (imageWidth * imageHeight * 4 > DRAWABLE_BYTE_LIMIT)
      throw new SizeLimitError(DRAWABLE_BYTE_LIMIT);
    if (width * height * 4 > VIEWER_TILE_BYTE_LIMIT)
      throw new SizeLimitError(VIEWER_TILE_BYTE_LIMIT);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("viewer tile canvas is unavailable");
    context.drawImage(image, 0, 0);
    return { width, height, buffer: context.getImageData(0, 0, width, height).data.buffer };
  } finally {
    decoded?.close();
    if (
      tile.ownership === "transferred" &&
      Object.prototype.toString.call(value) === "[object ImageBitmap]"
    )
      (value as ImageBitmap).close();
  }
}
