// Browser canvas save (todo 2.2 home, moved from `src/main.ts`).
//
// The browser canvas path (createImageBitmap -> drawImage -> toBlob) never
// preserves the source ICC color profile or EXIF metadata (native keeps the
// first tile's profile); callers warn so archived colors are not trusted
// blindly. The canvas host is injected so node tests drive the encode path
// with fakes. Keep erasable-syntax-only for the browser `.js` mirrors.
import { failure } from "./session.ts";
import { suggestedNameFor } from "./save-name.ts";

/** Warning logged beside every completed browser save (profile stripped). */
export const BROWSER_SAVE_COLOR_WARNING =
  "Colors may shift slightly: the browser save does not keep the original color profile. For exact colors, use the desktop app.";

export interface CanvasLike {
  toBlob(cb: (blob: unknown | null) => void, mime?: string): void;
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

/** Encode the assembled canvas as a PNG Blob (origin-clean only). */
export function canvasToPngBlob(canvas: CanvasLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (b) =>
          b
            ? resolve(b)
            : reject(
                failure(
                  "OUTPUT_ENCODE_FAILED",
                  "The final picture could not be created from the saved pieces.",
                  false,
                  undefined,
                  "canvas.toBlob returned null while encoding the PNG",
                ),
              ),
        "image/png",
      );
    } catch (e) {
      reject(
        failure(
          "OUTPUT_ENCODE_FAILED",
          "The final picture could not be created from the saved pieces.",
          false,
          undefined,
          `canvas.toBlob threw while encoding the PNG: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  });
}

/**
 * Save an already-encoded object URL through a blob anchor (the website save
 * needs no `downloads` permission). The suggested filename carries the
 * canvas dimensions; unknown dimensions fall back to the bare base name.
 */
export function saveBlobViaAnchor(
  doc: DocumentLike,
  blobUrl: string,
  width?: unknown,
  height?: unknown,
): void {
  const anchor = doc.createElement("a");
  anchor.href = blobUrl;
  anchor.download = suggestedNameFor(width, height, "png");
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
