import {
  errorFromPayload,
  HttpError,
  isJobError,
  NetworkError,
  retryAfterMs,
  unknownDetail,
} from "@dezoomify/browser-runtime";
import type { Error as JobError } from "@dezoomify/wasm-bindings";

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
  drawer?: {
    imageLoader?: ImageLoader;
    loadImage?(src: string, callback: (image: unknown) => void): boolean;
  };
  loadTilesWithAjax?: boolean;
  ajaxHeaders?: Record<string, string>;
  crossOriginPolicy?: string | boolean;
  ajaxWithCredentials?: boolean;
}

/** A failed loader callback is a transport outcome; exceptions thrown by the
 * loader itself are left to the caller as unexpected adapter failures. */
function loadFailure(error: unknown, response: unknown, url: string): JobError {
  if (isJobError(error)) return errorFromPayload(error);
  const xhr = response as XMLHttpRequest | undefined;
  if (xhr && Number.isInteger(xhr.status) && xhr.status >= 400 && xhr.status <= 599)
    return new HttpError(
      {
        status: xhr.status,
        transport: "browser-session",
        request: (xhr.responseURL || url).slice(0, 2048),
        retry_after_ms: retryAfterMs(xhr.getResponseHeader?.("Retry-After")),
        detail: unknownDetail(error),
      },
      { cause: error },
    );
  return new NetworkError(unknownDetail(error), { transport: "browser-session" }, { cause: error });
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
  const loader = image._imageLoader ?? image.imageLoader ?? image.drawer?.imageLoader;
  const legacyDrawer = image.drawer;
  if (!loader && !legacyDrawer?.loadImage)
    throw new Error("OpenSeadragon image loader is unavailable");
  const tile = { level, x, y };
  const url = native.getTileUrl(level, x, y);
  const src = typeof url === "function" ? url.call(tile) : url;
  const data = await new Promise<unknown>((resolve, reject) => {
    const callback = (result: unknown, error?: unknown, response?: unknown) => {
      if (result) resolve(result);
      else reject(loadFailure(error, response, src));
    };
    if (!loader) {
      // 0.9.x exposes a bounded drawer loader rather than a queued ImageLoader.
      if (!legacyDrawer?.loadImage?.(src, callback))
        reject(
          new NetworkError("OpenSeadragon image loader is busy", { transport: "browser-session" }),
        );
      return;
    }
    loader.addJob({
      source,
      tile,
      src,
      postData: native.getTilePostData?.(level, x, y),
      loadWithAjax: image.loadTilesWithAjax,
      ajaxHeaders: { ...image.ajaxHeaders, ...native.getTileAjaxHeaders?.(level, x, y) },
      // A viewer can display a tainted image; downloading requires readable pixels.
      crossOriginPolicy: image.crossOriginPolicy || "Anonymous",
      ajaxWithCredentials: image.ajaxWithCredentials,
      callback,
    });
  });
  return data;
}
