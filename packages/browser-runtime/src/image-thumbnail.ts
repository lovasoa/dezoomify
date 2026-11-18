import type { ResourceRead, ResourceRequest, Tile } from "@dezoomify/wasm-bindings";
import type { BrowserHostDependencies } from "./browser-host.ts";
import { canvasToPngBlob } from "./canvas-save.ts";
import type { TileDecoder } from "./tile-decode.ts";
import type { TilePixels, TileRaster } from "./tile-pixels.ts";

/** Decode one complete preview tile without touching the job's output assembly. */
export async function imageThumbnail(
  tile: Tile,
  signal: AbortSignal,
  deps: {
    fetch(request: ResourceRequest, signal: AbortSignal): Promise<ResourceRead>;
    loadViewerTile?: BrowserHostDependencies["loadViewerTile"];
    process(recipe: Tile["placement"]["processing"], bytes: ArrayBuffer): ArrayBuffer;
    decoder: TileDecoder;
    canvas(): HTMLCanvasElement;
  },
): Promise<Blob | undefined> {
  const size = tile.placement.canvas;
  if (!size || size.width > 1024 || size.height > 1024) return;
  let resource: TilePixels | ResourceRequest;
  if (tile.source.kind === "viewer") {
    if (!deps.loadViewerTile || !tile.placement.expected_size) return;
    resource = await deps.loadViewerTile(tile.source, tile.placement.expected_size, signal);
  } else resource = tile.source;
  let input: TileRaster;
  if ("buffer" in resource) input = resource;
  else {
    const result = await deps.fetch(resource, signal);
    if (result.kind !== "response") return;
    signal.throwIfAborted();
    input = deps.process(tile.placement.processing, new Uint8Array(result.response.bytes).buffer);
  }
  signal.throwIfAborted();
  const bitmap = await deps.decoder.decode(input, signal);
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
