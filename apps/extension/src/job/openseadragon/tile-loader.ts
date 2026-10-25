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
  return data;
}
