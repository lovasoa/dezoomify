// Shared save-name helper (todo 2.2 home: lowest layer, dependency-free).
//
// One suggestedNameFor() for every app. Base `dezoomify`, optional `-WxH`
// suffix when dimensions are known positive integers, extension from format
// (png default, jpeg/jpg -> jpg, tiff/tif -> tif, zif -> zif, webp -> webp,
// iiif/iiif-dir -> iiif). Pure, erasable-syntax-only, no I/O or DOM, so
// Vite/WXT bundles, node type-stripping, and native shells share it.
// `packages/shared-ui` re-exports these helpers for rendering; it never owns
// them, so browser-runtime save code imports downward only. The extension
// job tab imports the workspace package directly; the CLI mirrors the
// `dezoomify` base in Rust (titles and collision
// suffixes stay Rust-side). Todo 5.1: desktop GUI parity exposes ZIF, WebP,
// and `iiif-dir` (`.iiif`) alongside PNG/JPEG/TIFF.
export type SaveNameFormat =
  | "png"
  | "jpeg"
  | "jpg"
  | "tiff"
  | "tif"
  | "zif"
  | "webp"
  | "iiif"
  | "iiif-dir";

export function extensionForSaveFormat(format: unknown): string {
  const lower = typeof format === "string" ? format.toLowerCase() : "png";
  if (lower === "jpeg" || lower === "jpg") return "jpg";
  if (lower === "tiff" || lower === "tif") return "tif";
  if (lower === "zif") return "zif";
  if (lower === "webp") return "webp";
  if (lower === "iiif" || lower === "iiif-dir") return "iiif";
  return "png";
}

export function suggestedNameFor(
  width: unknown,
  height: unknown,
  format: unknown,
): string {
  const ext = extensionForSaveFormat(format);
  const w = typeof width === "number" ? width : Number(width);
  const h = typeof height === "number" ? height : Number(height);
  if (
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0
  ) {
    return `dezoomify-${w}x${h}.${ext}`;
  }
  return `dezoomify.${ext}`;
}
