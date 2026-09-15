// Shared save-name helper: lowest layer, dependency-free.
//
// One suggestedNameFor() for every app. A core-extracted title is preferred;
// otherwise base `dezoomify`, optional `-WxH` suffix when dimensions are known
// positive integers, extension from format
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

/** Convert an untrusted core title into a portable file stem. */
export function safeTitleStem(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return undefined;
  const deviceStem = cleaned.split(".", 1)[0]?.toLowerCase();
  if (
    deviceStem === "con" || deviceStem === "prn" || deviceStem === "aux" || deviceStem === "nul" ||
    /^(com|lpt)[1-9]$/.test(deviceStem ?? "")
  ) return undefined;
  return cleaned;
}

export function suggestedNameFor(
  width: unknown,
  height: unknown,
  format: unknown,
  title?: unknown,
): string {
  const ext = extensionForSaveFormat(format);
  const stem = safeTitleStem(title);
  if (stem) return `${stem}.${ext}`;
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
