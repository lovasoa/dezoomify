import { canvasToPngBlob } from "@dezoomify/browser-runtime";

interface TileSource {
  getTileUrl(level: number, x: number, y: number): string | (() => string);
  getTilePostData?(level: number, x: number, y: number): unknown;
  getTileAjaxHeaders?(level: number, x: number, y: number): Record<string, string>;
}

interface ImageLoader {
  addJob(options: Record<string, unknown>): void;
}

interface TiledImage {
  _imageLoader?: ImageLoader;
  imageLoader?: ImageLoader;
  loadTilesWithAjax?: boolean;
  ajaxHeaders?: Record<string, string>;
  crossOriginPolicy?: string | boolean;
  ajaxWithCredentials?: boolean;
}

/** Use the viewer's loader, including its version-specific job API and retry policy.
 * Cancellation bounds the extension's wait; it does not clear the viewer's queue.
 * No OpenSeadragon global is needed: bundled viewers often hide their namespace.
 */
export async function loadOpenSeadragonTile(
  source: object,
  item: object,
  level: number,
  x: number,
  y: number,
) {
  const native = source as TileSource;
  const image = item as TiledImage;
  const loader = image._imageLoader ?? image.imageLoader;
  if (!loader) throw new Error("OpenSeadragon image loader is unavailable");
  const tile = { level, x, y };
  const url = native.getTileUrl(level, x, y);
  const data = await new Promise<unknown>((resolve, reject) => {
    loader.addJob({
      source,
      tile,
      src: typeof url === "function" ? url.call(tile) : url,
      postData: native.getTilePostData?.(level, x, y),
      loadWithAjax: image.loadTilesWithAjax,
      ajaxHeaders: { ...image.ajaxHeaders, ...native.getTileAjaxHeaders?.(level, x, y) },
      // A viewer can display a tainted image; downloading requires readable pixels.
      crossOriginPolicy: image.crossOriginPolicy || "Anonymous",
      ajaxWithCredentials: image.ajaxWithCredentials,
      callback: (result: unknown, error: unknown) => (result ? resolve(result) : reject(error)),
    });
  });
  return imageBlob(data);
}

/** Loader callbacks return encoded Blobs or decoded drawables, possibly from a child realm. */
async function imageBlob(value: unknown): Promise<Blob> {
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
    if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error("OpenSeadragon returned an invalid tile size");
    if (width * height > 16 * 1024 * 1024)
      throw { kind: "size-limit", max_bytes: 64 * 1024 * 1024 };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("OpenSeadragon tile canvas is unavailable");
    context.drawImage(image, 0, 0);
    return await canvasToPngBlob(canvas);
  } finally {
    if (Object.prototype.toString.call(value) === "[object ImageBitmap]")
      (value as ImageBitmap).close();
  }
}
