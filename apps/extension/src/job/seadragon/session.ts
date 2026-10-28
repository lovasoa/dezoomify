import { NetworkError } from "@dezoomify/browser-runtime";
import type { ViewerLevel } from "@dezoomify/wasm-bindings";
import { PageObject } from "../viewers/page-object.ts";
import { snapshotPyramid } from "../viewers/pyramid.ts";
import type { LiveViewerSource } from "../viewers/source.ts";

/** Seadragon Ajax hides both its URL base and image loader in closures. Retain
 * its source API and load readable browser images; never infer a URL template.
 * Sparse sources are rejected, and each requested tile's bounds must agree
 * with the regular grid before loading. The session owns the returned images. */
export function openSeadragonSource(source: PageObject): LiveViewerSource {
  if (source.arrayLength("displayRects", 256))
    throw new Error("unsupported sparse Seadragon source");
  const levels = snapshotPyramid({
    width: source.number("width"),
    height: source.number("height"),
    minLevel: source.number("minLevel"),
    maxLevel: source.number("maxLevel"),
    tileOverlap: source.number("tileOverlap"),
    getLevelScale: (level) => source.call("getLevelScale", level) as number,
    getNumTiles: (level) => source.call("getNumTiles", level) as { x: number; y: number },
    getTileWidth: () => source.number("tileSize"),
    getTileHeight: () => source.number("tileSize"),
  });
  return {
    levels,
    load: async (level, x, y, signal) => {
      const grid = levels.find((grid) => grid.level === level);
      if (!grid) throw new Error("unsupported Seadragon level");
      if (!source.call("tileExists", level, x, y))
        throw new Error("unsupported sparse Seadragon tile");
      checkTileBounds(source, grid, x, y);
      const url = source.call("getTileUrl", level, x, y);
      if (typeof url !== "string") throw new Error("unsupported Seadragon tile URL");
      return { image: await loadImage(url, signal), owned: true };
    },
  };
}

function checkTileBounds(source: PageObject, grid: ViewerLevel, x: number, y: number) {
  const bounds = PageObject.from(source.call("getTileBounds", grid.level, x, y));
  const left = Math.max(0, x * grid.tile_size.width - grid.overlap.width);
  const top = Math.max(0, y * grid.tile_size.height - grid.overlap.height);
  const right = Math.min(grid.size.width, (x + 1) * grid.tile_size.width + grid.overlap.width);
  const bottom = Math.min(grid.size.height, (y + 1) * grid.tile_size.height + grid.overlap.height);
  const expected = { x: left, y: top, width: right - left, height: bottom - top };
  const levelWidth = source.number("width") * (source.call("getLevelScale", grid.level) as number);
  for (const [key, value] of Object.entries(expected)) {
    // Seadragon normalizes both axes by the level width.
    const actual = bounds?.scalar(key, 64) ?? 0;
    if (typeof actual !== "number" || !Number.isFinite(actual))
      throw new Error("unsupported Seadragon tile bounds");
    const pixels = actual * levelWidth;
    const rounded = key === "width" || key === "height" ? Math.ceil(pixels - 1e-9) : pixels;
    if (Math.abs(rounded - value) > 1e-6) throw new Error("unsupported Seadragon tile bounds");
  }
}

function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error?: unknown) => {
      signal.removeEventListener("abort", abort);
      image.onload = image.onerror = null;
      if (error) reject(error);
      else resolve(image);
    };
    const abort = () => {
      image.removeAttribute("src");
      finish(signal.reason);
    };
    image.crossOrigin = "Anonymous";
    image.onload = () => finish();
    image.onerror = () =>
      finish(
        new NetworkError(`Seadragon tile failed: ${url.slice(0, 2048)}`, {
          transport: "browser-session",
        }),
      );
    signal.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}
