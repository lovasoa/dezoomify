import { canvasToPngBlob, SizeLimitError } from "@dezoomify/browser-runtime";
import type { Size } from "@dezoomify/wasm-bindings";
import type { ViewerDrawable } from "./session.ts";

/** The core's grid extent can be smaller than the viewer's padded drawable.
 * Scaling to that extent would shift tile boundaries. */
export async function imageBlob(tile: ViewerDrawable, extent: Size): Promise<Blob> {
  const value = tile.image;
  if (Object.prototype.toString.call(value) === "[object Blob]") return value as Blob;
  const image = ((value as { canvas?: HTMLCanvasElement })?.canvas ??
    value) as CanvasImageSource & {
    width: number;
    height: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  try {
    const width = image?.naturalWidth ?? image?.width;
    const height = image?.naturalHeight ?? image?.height;
    if (
      ![width, height, extent.width, extent.height].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      width < extent.width ||
      height < extent.height
    )
      throw new Error("viewer returned an invalid tile size");
    if (width * height > 16 * 1024 * 1024) throw new SizeLimitError(64 * 1024 * 1024);
    if (tile.originalJpeg && width === extent.width && height === extent.height)
      return tile.originalJpeg;
    const canvas = document.createElement("canvas");
    canvas.width = extent.width;
    canvas.height = extent.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("viewer tile canvas is unavailable");
    context.drawImage(image, 0, 0);
    return await canvasToPngBlob(canvas);
  } finally {
    if (
      tile.ownership === "transferred" &&
      Object.prototype.toString.call(value) === "[object ImageBitmap]"
    )
      (value as ImageBitmap).close();
  }
}
