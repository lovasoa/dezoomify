import {
  errorFromPayload,
  HttpError,
  isJobError,
  NetworkError,
  readResponseBytes,
  retryAfterMs,
  SOURCE_FETCH_BYTE_LIMIT,
  unknownDetail,
} from "@dezoomify/browser-runtime";
import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { PageObject } from "../viewers/page-object.ts";
import type { ViewerTile } from "../viewers/session.ts";

interface TileSource {
  getTileUrl(level: number, x: number, y: number): string | (() => string);
  getTilePostData?(level: number, x: number, y: number): unknown;
  getTileAjaxHeaders?(level: number, x: number, y: number): Record<string, string>;
  downloadTileStart?: unknown;
}

interface ImageLoader {
  addJob(options: Record<string, unknown>): void;
}

interface TileRequest {
  src: string;
  postData: unknown;
  ajaxHeaders: Record<string, string>;
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

/** Resolve ordinary image URLs lazily and read standard AJAX GETs as encoded
 * bytes. Other requests keep the viewer's version-specific loader and retry policy.
 * Cancellation bounds the extension's wait; it does not clear the viewer's queue.
 * No OpenSeadragon global is needed: bundled viewers often hide their namespace.
 */
export async function loadOpenSeadragonTile(
  source: object,
  item: object,
  level: number,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<ViewerTile> {
  const native = source as TileSource;
  const image = item as TiledImage;
  const tile = { level, x, y };
  const url = native.getTileUrl(level, x, y);
  const src = typeof url === "function" ? url.call(tile) : url;
  const resolved = await resolveImage(native, image, src, signal);
  if (resolved) return resolved;
  const request = {
    src,
    postData: native.getTilePostData?.(level, x, y),
    ajaxHeaders: { ...image.ajaxHeaders, ...native.getTileAjaxHeaders?.(level, x, y) },
  };
  const encoded = await resolveAjax(native, image, request, signal);
  if (encoded) return encoded;
  const loader = image._imageLoader ?? image.imageLoader ?? image.drawer?.imageLoader;
  const legacyDrawer = image.drawer;
  if (!loader && !legacyDrawer?.loadImage)
    throw new Error("OpenSeadragon image loader is unavailable");
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
      ...request,
      loadWithAjax: image.loadTilesWithAjax,
      // A viewer can display a tainted image; downloading requires readable pixels.
      crossOriginPolicy: image.crossOriginPolicy || "Anonymous",
      ajaxWithCredentials: image.ajaxWithCredentials,
      callback,
    });
  });
  return { image: data, ownership: "transferred" };
}

async function resolveAjax(
  source: TileSource,
  image: TiledImage,
  request: TileRequest,
  signal: AbortSignal,
): Promise<ViewerTile | undefined> {
  if (!image.loadTilesWithAjax || request.postData != null || !usesDefaultDownload(source))
    return undefined;
  const url = new URL(request.src, document.baseURI);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  try {
    const response = await fetch(url, {
      // OpenSeadragon treats a falsy tile header as clearing the item header.
      headers: Object.fromEntries(Object.entries(request.ajaxHeaders).filter(([, value]) => value)),
      credentials: image.ajaxWithCredentials ? "include" : "same-origin",
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new HttpError({
        status: response.status,
        transport: "browser-session",
        request: (response.url || url.href).slice(0, 2048),
        retry_after_ms: retryAfterMs(response.headers.get("Retry-After")),
      });
    }
    const bytes = await readResponseBytes(response, SOURCE_FETCH_BYTE_LIMIT, signal);
    return { bytes: bytes.buffer };
  } catch (error) {
    throw loadFailure(error, undefined, url.href);
  }
}

/** Find the library's base TileSource through its geometry API, even when its
 * namespace is bundled away. Inherited custom downloaders must stay in-page. */
function usesDefaultDownload(source: TileSource): boolean {
  let prototype = Object.getPrototypeOf(source);
  let base: TileSource | undefined;
  for (let depth = 0; prototype && depth < 16; depth++) {
    if (Object.hasOwn(prototype, "getNumTiles") && Object.hasOwn(prototype, "getLevelScale"))
      base = prototype;
    prototype = Object.getPrototypeOf(prototype);
  }
  return (
    base !== undefined &&
    PageObject.from(source)?.method("downloadTileStart") ===
      PageObject.from(base)?.method("downloadTileStart")
  );
}

/** Detached URLs cannot preserve session settings or a custom downloader. */
export function usesDefaultTileLoading(source: object, item: object): boolean {
  const image = PageObject.from(item);
  return (
    !image?.truthy("loadTilesWithAjax") &&
    !image?.truthy("ajaxWithCredentials") &&
    !image?.matches("crossOriginPolicy", "use-credentials") &&
    usesDefaultDownload(source as TileSource)
  );
}

async function resolveImage(
  source: TileSource,
  image: TiledImage,
  src: string,
  signal: AbortSignal,
): Promise<ViewerTile | undefined> {
  if (!usesDefaultTileLoading(source, image)) return undefined;
  const url = new URL(src, document.baseURI);
  if (url.protocol === "http:" || url.protocol === "https:") return { url: url.href };
  if (url.protocol !== "blob:") return undefined;
  // Blob URLs belong to the page's storage partition. Read them here without
  // revoking page-owned URLs or downloading their original resource again.
  try {
    const response = await fetch(url, { signal });
    return { image: await response.blob(), ownership: "transferred" };
  } catch (error) {
    throw loadFailure(error, undefined, src);
  }
}
