import type { ViewerLevel } from "@dezoomify/wasm-bindings";
import { PageObject } from "../viewers/page-object.ts";

/** Finite, unwrapped pixel images only. Geographic/reprojected grids and retina
 * scaling need different source semantics and must not become artwork exports.
 * Convert OpenLayers' upward world Y to the core's downward image rows. */
export function readPyramid(source: PageObject): ViewerLevel[] {
  const grid = PageObject.from(source.call("getTileGrid"));
  if (!grid) throw new Error("source has no finite tile grid");
  const extent = grid.call("getExtent") as number[];
  const resolutions = grid.call("getResolutions") as number[];
  const min = grid.call("getMinZoom") as number;
  const max = grid.call("getMaxZoom") as number;
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min < 0 ||
    max < min ||
    max - min >= 64
  )
    throw new Error("unsupported OpenLayers level range");
  if (
    !Array.isArray(extent) ||
    extent.length !== 4 ||
    extent[0] !== 0 ||
    extent[3] !== 0 ||
    !(extent[2] > 0 && extent[1] < 0) ||
    !Array.isArray(resolutions) ||
    resolutions[max] !== 1 ||
    (source.method("getTilePixelRatio") && source.call("getTilePixelRatio", 1) !== 1)
  ) {
    throw new Error("unsupported non-image OpenLayers grid");
  }
  const levels: ViewerLevel[] = [];
  for (let level = min; level <= max; level++) {
    levels.push(readLevel(grid, extent, resolutions, level));
  }
  return levels;
}

function readLevel(
  grid: PageObject,
  extent: number[],
  resolutions: number[],
  level: number,
): ViewerLevel {
  const origin = grid.call("getOrigin", level) as number[];
  if (origin[0] !== 0 || origin[1] !== 0) throw new Error("unsupported image origin");
  const size = grid.call("getTileSize", level) as number | number[];
  const range = PageObject.from(grid.call("getFullTileRange", level));
  const resolution = resolutions[level];
  if (
    range?.number("minX", 1) !== 0 ||
    range.number("minY", 1) !== 0 ||
    !Number.isFinite(resolution) ||
    resolution <= 0
  )
    throw new Error("unsupported image tile range");
  return {
    level,
    size: {
      width: Math.ceil(extent[2] / resolution),
      height: Math.ceil(-extent[1] / resolution),
    },
    tile_size: {
      width: typeof size === "number" ? size : size[0],
      height: typeof size === "number" ? size : size[1],
    },
    overlap: { width: 0, height: 0 },
    grid_size: { width: range.number("maxX") + 1, height: range.number("maxY") + 1 },
  };
}
