import type { ViewerLevel } from "@dezoomify/wasm-bindings";

interface PyramidSource {
  width: number;
  height: number;
  minLevel: number;
  maxLevel: number;
  tileOverlap: number;
  getLevelScale(level: number): number;
  getTileWidth(level: number): number;
  getTileHeight(level: number): number;
  getNumTiles(level: number): { x: number; y: number };
}

/** Snapshot an identified regular source. The adapter must ensure tile bounds
 * match these grids; Rust validates coverage before acquisition. */
export function snapshotPyramid(source: PyramidSource): ViewerLevel[] {
  if (
    !Number.isSafeInteger(source.minLevel) ||
    source.minLevel < 0 ||
    !Number.isSafeInteger(source.maxLevel) ||
    source.maxLevel < source.minLevel ||
    source.maxLevel - source.minLevel >= 64
  )
    throw new Error("unsupported viewer levels");
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
