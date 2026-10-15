const FORBIDDEN_IPC_KEYS = new Set([
  "tilebytes",
  "tile_bytes",
  "tiledata",
  "tile_data",
  "pixels",
  "pixeldata",
  "pixel_data",
  "imagebytes",
  "image_bytes",
  "imagedata",
]);

function containsForbiddenKey(value: unknown, seen: Set<unknown>): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenKey(item, seen));
  }
  return Object.entries(value).some(([key, item]) => {
    const lower = key.toLowerCase();
    // Numeric byte counters are allowed; buffers and pixel fields are not.
    return (
      FORBIDDEN_IPC_KEYS.has(lower) ||
      FORBIDDEN_IPC_KEYS.has(lower.replace(/[-_]/g, "")) ||
      containsForbiddenKey(item, seen)
    );
  });
}

// Throw when a payload would carry tile bytes over IPC.
// Progress counters stay allowed; buffers and pixel fields do not.
export function assertNoTileBytes(payload: unknown): void {
  if (containsForbiddenKey(payload, new Set())) {
    throw new Error("ipc.forbidden-tile-bytes: tile bytes must stay in the native runtime");
  }
}
