import type { ViewerLevel } from "@dezoomify/wasm-bindings";
import { snapshotPyramid } from "../viewers/pyramid.ts";

interface LiveSource {
  width: number;
  height: number;
  minLevel: number;
  maxLevel: number;
  tileOverlap: number;
  getLevelScale(level: number): number;
  getTileWidth(level: number): number;
  getTileHeight(level: number): number;
  getNumTiles(level: number): { x: number; y: number };
  ready: boolean;
  displayRects?: unknown[];
  tileSize: number;
  getTileSize?(level: number): number;
}

/** Snapshot the viewer's regular grids. Rust checks coverage and computes crops;
 * sparse/custom-bound sources need a richer contract and are not approximated. */
export function readLivePyramid(value: object): ViewerLevel[] {
  const source = value as LiveSource;
  if (
    source.ready === false ||
    source.displayRects?.length ||
    Object.hasOwn(source, "getTileBounds") ||
    Object.hasOwn(source, "tileExists")
  )
    throw new Error("unsupported OpenSeadragon grid");
  return snapshotPyramid({
    width: source.width,
    height: source.height,
    minLevel: source.minLevel,
    maxLevel: source.maxLevel,
    tileOverlap: source.tileOverlap,
    getLevelScale: (level) => source.getLevelScale(level),
    getNumTiles: (level) => source.getNumTiles(level),
    getTileWidth: (level) =>
      source.getTileWidth?.(level) ?? source.getTileSize?.(level) ?? source.tileSize,
    getTileHeight: (level) =>
      source.getTileHeight?.(level) ?? source.getTileSize?.(level) ?? source.tileSize,
  });
}
