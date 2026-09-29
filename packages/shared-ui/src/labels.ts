// Portable suggested file names shared by the graphical products.

export function extensionForSaveFormat(format: unknown): string {
  const lower = typeof format === "string" ? format.toLowerCase() : "png";
  if (lower === "jpeg" || lower === "jpg") return "jpg";
  if (lower === "tiff" || lower === "tif") return "tif";
  if (lower === "zif") return "zif";
  if (lower === "webp") return "webp";
  if (lower === "iiif" || lower === "iiif-dir") return "iiif";
  return "png";
}

// Control characters (U+0000-U+001F) are illegal in portable file stems.
// The class is built from character codes so the source stays plain ASCII.
const STEM_CONTROL_CLASS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  "g",
);

/** Convert an untrusted core title into a portable file stem. */
export function safeTitleStem(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const cleaned = title
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(STEM_CONTROL_CLASS, "_")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return undefined;
  const deviceStem = cleaned.split(".", 1)[0]?.toLowerCase();
  if (
    deviceStem === "con" ||
    deviceStem === "prn" ||
    deviceStem === "aux" ||
    deviceStem === "nul" ||
    /^(com|lpt)[1-9]$/.test(deviceStem ?? "")
  )
    return undefined;
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
