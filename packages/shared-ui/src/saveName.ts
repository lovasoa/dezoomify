// Shared save-name helper (todo 4.6): one suggestedNameFor() for every app.
// Base `dezoomify`, optional `-WxH` suffix when dimensions are known positive
// integers, extension from format (png default, jpeg/jpg -> jpg, tiff/tif ->
// tif). Pure, erasable-syntax-only, no I/O or DOM, so browsers (via
// scripts/sync-web-js.mjs), node type-stripping, and native shells share it.
// The extension page ships verbatim with no bundler and replicates this
// logic locally (see apps/extension/src/page/page.ts); the CLI mirrors the
// `dezoomify` base in Rust (titles and collision suffixes stay Rust-side).
export type SaveNameFormat = "png" | "jpeg" | "jpg" | "tiff" | "tif";

export function extensionForSaveFormat(format: unknown): string {
  const lower = typeof format === "string" ? format.toLowerCase() : "png";
  if (lower === "jpeg" || lower === "jpg") return "jpg";
  if (lower === "tiff" || lower === "tif") return "tif";
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
