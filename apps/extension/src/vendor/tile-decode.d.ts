export type TileBitmap = CanvasImageSource & { width: number; height: number; close?(): void };
export function createTileDecoder(): { decode(bytes: ArrayBuffer): Promise<TileBitmap>; dispose?(): void };
