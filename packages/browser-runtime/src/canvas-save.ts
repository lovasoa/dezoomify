// Browser canvas save shared by browser products.
// The browser canvas path (createImageBitmap -> drawImage -> toBlob) never
// preserves the source ICC color profile or EXIF metadata (native keeps the
// first tile's profile); callers warn so archived colors are not trusted
// blindly. The canvas host is injected so node tests drive the encode path
// with fakes.

import { outputError } from "./failure.ts";

/** Warning logged beside every completed browser save (profile stripped). */
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

/** Encode the assembled canvas as a PNG Blob (origin-clean only). */
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
        reject(
          outputError(
            "OUTPUT_ENCODE_FAILED",
            "The final picture could not be created from the saved pieces.",
            "canvas.toBlob returned null while encoding the PNG",
          ),
        );
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
          "OUTPUT_ENCODE_FAILED",
          "The final picture could not be created from the saved pieces.",
          `canvas.toBlob threw while encoding the PNG: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  });
}

/**
 * Save an already-encoded object URL through a blob anchor (the website save
 * needs no `downloads` permission).
 */
export function saveBlobViaAnchor(doc: DocumentLike, blobUrl: string, filename: string): void {
  const anchor = doc.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
