export interface CanvasAssembly {
  acquireTile(tile: string, placement: unknown, bytes: ArrayBuffer): Promise<void>;
  decodePixels(tile: string): void;
  openEncoder(format: string, canvas?: { width: number; height: number } | null): void;
  finalizeEncoder(): Promise<void>;
  publishOutput(): void;
  release(): void;
}
export function createCanvasAssembly(deps: {
  decode(bytes: ArrayBuffer): Promise<CanvasImageSource & { width: number; height: number }>;
  createCanvas(width: number, height: number): { width: number; height: number; ctx2d: CanvasRenderingContext2D; toBlob(cb: BlobCallback, mime?: string): void };
  encode(canvas: { toBlob(cb: (blob: unknown | null) => void, mime?: string): void }): Promise<unknown>;
  save(output: unknown, width: number, height: number): void;
  sourceUrl?: string;
}): CanvasAssembly;
