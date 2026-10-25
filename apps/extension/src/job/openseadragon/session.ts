import { registerViewer } from "../viewers/session.ts";
import type { MetadataContext } from "../viewers/types.ts";
import { readLivePyramid } from "./pyramid.ts";
import { loadOpenSeadragonTile } from "./tile-loader.ts";

export { readViewerTile, releaseViewerTiles } from "../viewers/session.ts";

/** Adapt source-specific loading while sharing resource ownership and grids. */
export function registerTileSource(source: object, item: object, context: MetadataContext) {
  return registerViewer(readLivePyramid(source), context, async (level, x, y) => ({
    image: await loadOpenSeadragonTile(source, item, level, x, y),
    owned: true,
  }));
}
