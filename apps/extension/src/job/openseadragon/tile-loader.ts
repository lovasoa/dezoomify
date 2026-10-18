import {
  isJobError,
  readResponseBytes,
  retryAfterMs,
  unknownDetail,
} from "@dezoomify/browser-runtime";
import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { transportError } from "../../runtime/fetch.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

interface NativeSource {
  getTileUrl?(level: number, x: number, y: number): string | (() => string);
  getTilePostData?(level: number, x: number, y: number): BodyInit | null;
  getTileAjaxHeaders?(level: number, x: number, y: number): Record<string, string> | null;
  downloadTileStart?(job: NativeJob): unknown;
  downloadTileAbort?(job: NativeJob): void;
}

interface NativeItem {
  loadTilesWithAjax?: boolean;
  ajaxHeaders?: Record<string, string>;
  crossOriginPolicy?: string | boolean;
  ajaxWithCredentials?: boolean;
  element?: Element;
  _viewer?: { element?: Element };
}

interface NativeJob {
  source: NativeSource;
  src: string;
  tile: { level: number; x: number; y: number };
  loadWithAjax: boolean;
  ajaxHeaders: Record<string, string>;
  crossOriginPolicy?: string | boolean;
  ajaxWithCredentials: boolean;
  postData: BodyInit | null;
  userData: Record<string, unknown>;
  finish(data: unknown, request?: unknown, type?: string): void;
  fail(message: unknown, request?: unknown): void;
  abort(): void;
}

function failure(cause: unknown): JobError {
  return isJobError(cause)
    ? cause
    : transportError("network-failure", unknownDetail(cause).slice(0, 4096));
}

function aborted(signal: AbortSignal): JobError {
  return isJobError(signal.reason) ? signal.reason : { kind: "cancelled" };
}

function httpFailure(
  status: number,
  request: string,
  detail: string,
  retry?: string | null,
): JobError {
  return {
    kind: "http-error",
    status,
    request,
    transport: "browser-session",
    detail: detail.slice(0, 4096),
    retry_after_ms: retryAfterMs(retry),
  };
}

function checkPixels(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw failure("OpenSeadragon returned an invalid tile size");
  if (width * height > MAX_PIXELS) throw { kind: "size-limit", max_bytes: MAX_PIXELS * 4 };
}

function isBitmap(value: unknown): value is ImageBitmap {
  return Object.prototype.toString.call(value) === "[object ImageBitmap]";
}

async function imageBlob(value: unknown, doc: Document): Promise<Blob> {
  // Results can belong to a readable child frame, so same-realm instanceof checks are insufficient.
  if (Object.prototype.toString.call(value) === "[object Blob]") {
    const blob = value as Blob;
    if (blob.size > MAX_BYTES) throw { kind: "size-limit", max_bytes: MAX_BYTES };
    const bitmap = await createImageBitmap(blob);
    try {
      checkPixels(bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
    return blob;
  }
  const result = value as { canvas?: HTMLCanvasElement } | null;
  const image = (result?.canvas ?? value) as CanvasImageSource & {
    width: number;
    height: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  try {
    checkPixels(image?.naturalWidth ?? image?.width, image?.naturalHeight ?? image?.height);
    const canvas = doc.createElement("canvas");
    canvas.width = image.naturalWidth ?? image.width;
    canvas.height = image.naturalHeight ?? image.height;
    const context = canvas.getContext("2d");
    if (!context) throw failure("OpenSeadragon tile canvas is unavailable");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) reject(failure("OpenSeadragon tile PNG encoding failed"));
        else if (blob.size > MAX_BYTES) reject({ kind: "size-limit", max_bytes: MAX_BYTES });
        else resolve(blob);
      }, "image/png");
    });
  } finally {
    if (isBitmap(value)) value.close();
  }
}

function jobOptions(source: NativeSource, item: NativeItem, level: number, x: number, y: number) {
  const tile = { level, x, y };
  const uri = source.getTileUrl?.(level, x, y);
  const src = typeof uri === "function" ? uri.call(tile) : uri;
  const doc = item._viewer?.element?.ownerDocument ?? item.element?.ownerDocument ?? document;
  return {
    source,
    tile,
    src: src ?? "",
    postData: source.getTilePostData?.(level, x, y) ?? null,
    loadWithAjax: !!item.loadTilesWithAjax,
    ajaxHeaders: {
      ...item.ajaxHeaders,
      ...source.getTileAjaxHeaders?.(level, x, y),
    },
    crossOriginPolicy: item.crossOriginPolicy,
    ajaxWithCredentials: !!item.ajaxWithCredentials,
    userData: {},
    doc,
  };
}

async function legacyAjax(job: NativeJob, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(job.src, {
    method: job.postData ? "POST" : "GET",
    body: job.postData || null,
    headers: job.ajaxHeaders,
    credentials: job.ajaxWithCredentials ? "include" : "same-origin",
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw httpFailure(
      response.status,
      job.src,
      `HTTP ${response.status}`,
      response.headers.get("retry-after"),
    );
  }
  const bytes = await readResponseBytes(response, MAX_BYTES, signal);
  return new Blob([bytes], { type: response.headers.get("content-type") ?? "" });
}

function loadLegacyTile(
  job: NativeJob,
  doc: Document,
  signal: AbortSignal,
): HTMLImageElement | undefined {
  if (!job.src) throw failure("OpenSeadragon returned no tile address");
  job.src = new URL(job.src, doc.baseURI).href;
  if (job.loadWithAjax) {
    void legacyAjax(job, signal).then(
      (blob) => job.finish(blob),
      (error) => job.fail(error),
    );
    return;
  }
  const image = doc.createElement("img");
  image.crossOrigin =
    typeof job.crossOriginPolicy === "string" ? job.crossOriginPolicy : "Anonymous";
  image.onload = () => job.finish(image);
  image.onerror = image.onabort = () =>
    job.fail(`OpenSeadragon tile image failed: ${job.src.slice(0, 2048)}`);
  image.src = job.src;
  return image;
}

function abortNative(source: NativeSource, job: NativeJob | undefined): void {
  if (!job) return;
  try {
    source.downloadTileAbort?.(job);
  } catch {
    // A broken page abort hook must not replace cancellation or timeout.
  }
}

/** One page-owned load attempt. The Rust job owns retries and tile geometry. */
export function loadOpenSeadragonTile(
  source: object,
  item: object,
  level: number,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const native = source as NativeSource;
    const controller = new AbortController();
    let job: NativeJob | undefined;
    let image: HTMLImageElement | undefined;
    let settled = false;
    let completing = false;
    let stoppedError: JobError | undefined;
    const timer = setTimeout(
      () => stop(transportError("timeout", "OpenSeadragon tile load timed out")),
      TIMEOUT_MS,
    );
    const cancel = () => stop(aborted(signal));
    function settle(error?: unknown, blob?: Blob): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (stoppedError || error) reject(stoppedError ?? failure(error));
      else resolve(blob as Blob);
    }
    function stop(error: JobError): void {
      if (settled || stoppedError) return;
      stoppedError = error;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort(error);
      if (image) {
        image.onload = image.onerror = image.onabort = null;
        image.src = "";
      }
      abortNative(native, job);
      // Browser codecs cannot be aborted. Retain ownership until their conversion has settled.
      if (!completing) settle(error);
    }
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) return cancel();
    try {
      const options = jobOptions(native, item as NativeItem, level, x, y);
      job = {
        ...options,
        abort: cancel,
        finish(data, request, type) {
          if (settled || stoppedError || completing) {
            if (isBitmap(data)) data.close();
            return;
          }
          if (!data) {
            job?.fail(type || "OpenSeadragon returned no tile data", request);
            return;
          }
          completing = true;
          void imageBlob(data, options.doc).then((blob) => settle(undefined, blob), settle);
        },
        fail(message, request) {
          if (completing || settled || stoppedError) return;
          const xhr = request as XMLHttpRequest | undefined;
          settle(
            xhr && xhr.status >= 400
              ? httpFailure(
                  xhr.status,
                  options.src,
                  unknownDetail(message),
                  xhr.getResponseHeader?.("retry-after"),
                )
              : failure(message || "OpenSeadragon tile load failed"),
          );
        },
      };
      if (native.downloadTileStart) {
        void Promise.resolve(native.downloadTileStart(job)).catch((error) => job?.fail(error));
      } else {
        image = loadLegacyTile(job, options.doc, controller.signal);
      }
    } catch (error) {
      stop(failure(error));
    }
  });
}
