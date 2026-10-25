import type { ViewerLevel } from "@dezoomify/wasm-bindings";

interface LiveSource {
  width: number;
  height: number;
  minLevel: number;
  maxLevel: number;
  tileOverlap: number;
  ready: boolean;
  displayRects?: unknown[];
  getLevelScale(level: number): number;
  getTileWidth(level: number): number;
  getTileHeight(level: number): number;
  getNumTiles(level: number): { x: number; y: number };
}

/** Snapshot the viewer's regular grids. Rust checks coverage and computes crops;
 * sparse/custom-bound sources need a richer contract and are not approximated. */
export function readLivePyramid(value: object): ViewerLevel[] {
  const source = value as LiveSource;
  if (
    source.ready === false ||
    source.displayRects?.length ||
    Object.hasOwn(source, "getTileBounds") ||
    Object.hasOwn(source, "tileExists") ||
    !Number.isSafeInteger(source.minLevel) ||
    source.minLevel < 0 ||
    !Number.isSafeInteger(source.maxLevel) ||
    source.maxLevel < source.minLevel ||
    source.maxLevel - source.minLevel >= 64
  )
    throw new Error("unsupported OpenSeadragon grid");
  const levels: ViewerLevel[] = [];
  for (let level = source.minLevel; level <= source.maxLevel; level++) {
    const scale = source.getLevelScale(level);
    const count = source.getNumTiles(level);
    levels.push({
      level,
      size: { width: Math.ceil(source.width * scale), height: Math.ceil(source.height * scale) },
      tile_size: { width: source.getTileWidth(level), height: source.getTileHeight(level) },
      overlap: { width: source.tileOverlap ?? 0, height: source.tileOverlap ?? 0 },
      grid_size: { width: count.x, height: count.y },
    });
  }
  return levels;
}
