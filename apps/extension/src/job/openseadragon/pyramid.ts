import type { DziSource } from "./types.ts";

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

/** Only expose grids the existing Deep Zoom planner can reproduce exactly.
 * Tile addresses and decoding remain the live viewer's responsibility.
 */
export function readLivePyramid(value: object, base: string): DziSource {
  const source = value as LiveSource;
  const { width, height, maxLevel, tileOverlap: overlap = 0 } = source;
  const tileSize = source.getTileWidth(maxLevel);
  if (
    source.ready === false ||
    source.minLevel !== 0 ||
    source.displayRects?.length ||
    Object.hasOwn(source, "getTileBounds") ||
    Object.hasOwn(source, "tileExists") ||
    ![width, height, tileSize].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff) ||
    maxLevel !== Math.ceil(Math.log2(Math.max(width, height))) ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap > tileSize
  )
    throw new Error("unsupported OpenSeadragon grid");
  for (let level = 0; level <= maxLevel; level++) {
    const scale = 2 ** (level - maxLevel);
    const count = source.getNumTiles(level);
    if (
      source.getLevelScale(level) !== scale ||
      source.getTileWidth(level) !== tileSize ||
      source.getTileHeight(level) !== tileSize ||
      count.x !== Math.ceil(Math.ceil(width * scale) / tileSize) ||
      count.y !== Math.ceil(Math.ceil(height * scale) / tileSize)
    )
      throw new Error("unsupported OpenSeadragon grid");
  }
  return {
    protocol: "dzi",
    width,
    height,
    tileWidth: tileSize,
    tileHeight: tileSize,
    overlap,
    format: "png",
    base,
  };
}

export function tileCoordinates(url: string, shape: DziSource): [number, number, number] {
  const match = /\/(\d+)\/(\d+)_(\d+)\.png$/.exec(url);
  if (!match) throw { kind: "bad-url", detail: "invalid OpenSeadragon tile address" };
  const [level, x, y] = match.slice(1).map(Number);
  const maxLevel = Math.ceil(Math.log2(Math.max(shape.width, shape.height)));
  const scale = 2 ** (level - maxLevel);
  if (
    level > maxLevel ||
    x >= Math.ceil((shape.width * scale) / shape.tileWidth) ||
    y >= Math.ceil((shape.height * scale) / shape.tileHeight)
  )
    throw { kind: "bad-url", detail: "invalid OpenSeadragon tile coordinates" };
  return [level, x, y];
}
