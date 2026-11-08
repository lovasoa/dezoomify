import type { LiveViewerSource } from "../viewers/source.ts";
import { readLivePyramid } from "./pyramid.ts";
import { loadOpenSeadragonTile } from "./tile-loader.ts";

export { readViewerTile, releaseViewerTiles } from "../viewers/session.ts";

/** Adapt source-specific loading while sharing resource ownership and grids. */
export function openTileSource(source: object, item: object): LiveViewerSource {
  return {
    levels: readLivePyramid(source),
    load: (level, x, y, signal) => loadOpenSeadragonTile(source, item, level, x, y, signal),
  };
}
