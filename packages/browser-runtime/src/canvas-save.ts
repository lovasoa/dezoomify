// Canvas re-encoding strips the source ICC profile and EXIF metadata. Products
// must surface BROWSER_SAVE_COLOR_WARNING when presenting a browser save.

import { outputError } from "./failure.ts";

export const BROWSER_SAVE_COLOR_WARNING =
  "Colors may shift slightly: the browser save does not keep the original color profile. For exact colors, use the desktop app.";

export interface CanvasLike {
  toBlob(cb: BlobCallback, mime?: string): void;
}

export interface DocumentLike {
  createElement(tag: string): AnchorLike;
  body: { appendChild(el: unknown): void };
}

export interface AnchorLike {
  href: string;
  download: string;
  click(): void;
  remove(): void;
}

/** Browsers report an origin-tainted canvas as a SecurityError. */
export function isCanvasTaintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "SecurityError" || candidate.code === 18;
}

/** Cancellation waits for toBlob's callback because the browser cannot stop
 * encoding. Preserve SecurityError so assembly can retain display-only output. */
export function canvasToPngBlob(canvas: CanvasLike, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (blob: Blob | null) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (blob) resolve(blob);
      else
        reject(outputError("encode-failed", "canvas.toBlob returned null while encoding the PNG"));
    };
    try {
      canvas.toBlob(finish, "image/png");
    } catch (e) {
      if (isCanvasTaintError(e)) {
        reject(e);
        return;
      }
      reject(
        outputError(
          "encode-failed",
          `canvas.toBlob threw while encoding the PNG: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  });
}

/** The caller retains ownership of blobUrl. Clicking starts a browser download
 * but supplies no saved-file confirmation; keep it available for later saves. */
export function saveBlobViaAnchor(doc: DocumentLike, blobUrl: string, filename: string): void {
  const anchor = doc.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
