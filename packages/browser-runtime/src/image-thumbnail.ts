import type { ResourceRead, ResourceRequest, Tile } from "@dezoomify/wasm-bindings";
import { canvasToPngBlob } from "./canvas-save.ts";
import type { TileDecoder } from "./tile-decode.ts";

/** Decode one complete preview tile without touching the job's output assembly. */
export async function imageThumbnail(
  tile: Tile,
  signal: AbortSignal,
  deps: {
    fetch(request: ResourceRequest, signal: AbortSignal): Promise<ResourceRead>;
    process(recipe: Tile["placement"]["processing"], bytes: ArrayBuffer): ArrayBuffer;
    decoder: TileDecoder;
    canvas(): HTMLCanvasElement;
  },
): Promise<Blob | undefined> {
  const size = tile.placement.canvas;
  if (!size || size.width > 1024 || size.height > 1024) return;
  const result = await deps.fetch(tile.request, signal);
  signal.throwIfAborted();
  if (result.kind !== "response") return;
  const bytes = new Uint8Array(result.response.bytes).buffer;
  const bitmap = await deps.decoder.decode(deps.process(tile.placement.processing, bytes), signal);
  try {
    signal.throwIfAborted();
    if (bitmap.width < size.width || bitmap.height < size.height) return;
    const scale = Math.min(1, 160 / Math.max(size.width, size.height));
    const canvas = deps.canvas();
    canvas.width = Math.max(1, Math.round(size.width * scale));
    canvas.height = Math.max(1, Math.round(size.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(
      bitmap as ImageBitmap,
      0,
      0,
      size.width,
      size.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return await canvasToPngBlob(canvas, signal);
  } finally {
    bitmap.close();
  }
}
