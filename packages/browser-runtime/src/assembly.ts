// Engine-effect canvas assembly executor.
//
// The browser executor for the Rust job engine maps typed host effects onto
// canvas execution and owns no job policy. The engine owns retries,
// cancellation, recovery, and ordering; this module only executes what the
// effects describe:
//
//   acquire-tile      -> recordPlacement + decode (decode-at-acquisition, the
//                        native model: a tile that cannot decode reports its
//                        acquisition failure through the tile outcome)
//   finalize-output   -> validate the output size and format, allocate the
//                        surface, draw every held tile at its planned
//                        placement, encode and save; a tainted canvas stays
//                        display-only and produces no bytes
//   cancel-work       -> close every retained tile resource
//
// All host constructors are injected so node tests drive the full path with
// fakes.
import { createProcessQueue, drawPlacedTile } from "./tile-draw.ts";
import type { Canvas2DLike, PlacedTileGeometry, TileImageLike } from "./tile-draw.ts";
import type { TileBitmap } from "./tile-decode.ts";
import { canvasTooLargeFailure } from "./plan-gates.ts";
import { BROWSER_LIMITS, probeLimits, safeArea } from "./limits.ts";
import type { BrowserLimits } from "./types.ts";
import { failure } from "./failure.ts";
import type {
  OutputFormat,
  ProcessingRecipe,
  TilePlacementDto,
} from "@dezoomify/wasm-bindings";

/** Generated shape of one tile's output placement. */
export type AssemblyPlacement = TilePlacementDto;

/** Allocated output surface: geometry plus a 2D drawing context. */
export interface AssemblyCanvas {
  width: number;
  height: number;
  ctx2d: Canvas2DLike;
}

export interface CanvasAssemblyDeps {
  /** Decode acquired tile bytes into a bitmap (tile-decode's decoder). */
  decode(bytes: ArrayBuffer): Promise<TileBitmap>;
  /**
   * Apply one core processing recipe (e.g. `google-arts-decrypt`) to raw
   * tile bytes before decoding. Hosts route this through the WASM session's
   * pure `applyProcessing` op; calls are serialized by the assembly.
   */
  processTile?: (recipe: ProcessingRecipe, bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  /** Allocate the output surface; called only after limit validation. */
  createCanvas(width: number, height: number): AssemblyCanvas;
  /** Encode the assembled surface (canvas-to-blob on the job tab). */
  encode(canvas: AssemblyCanvas): Promise<unknown>;
  /** Persist the encoded output (blob-anchor save on the job tab). */
  save(output: unknown, width: number, height: number): void;
  /** Job source URL, used for the desktop handoff link in limit failures. */
  sourceUrl?: string;
  /** Limits override for tests; defaults to the browser canvas limits. */
  limits?: BrowserLimits;
  /** Diagnostics sink for placement/decode size mismatches. */
  log?(line: string): void;
  /**
   * Called once when the output becomes display-only (an ordinary image was
   * drawn, or encoding failed because the canvas tainted). Hosts switch the
   * UI to the display-only presentation.
   */
  onDisplayOnly?(): void;
  /** Recognizes a canvas-taint encoding failure (host-provided). */
  isTaintError?(error: unknown): boolean;
}

export interface CanvasAssembly {
  /** Decode-at-acquisition: hold the decoded bitmap for assembly. */
  acquireTile(tile: number, placement: AssemblyPlacement, bytes: ArrayBuffer): Promise<void>;
  /**
   * Display-only acquisition: hold an ordinary image element for assembly.
   * The canvas taints when it is drawn, so the job can only complete as
   * display-only (no pixel reads, no programmatic save).
   */
  acquireDisplayTile(tile: number, placement: AssemblyPlacement, image: TileImageLike): void;
  /** Whether any display-only tile was acquired (output is tainted). */
  isTainted(): boolean;
  /** Output dimensions from the declared canvas or accumulated placements. */
  dimensions(): { width: number; height: number } | null;
  /**
   * The one awaited output operation: validate the destination, draw the
   * retained tiles, encode and save, or keep a tainted canvas display-only.
   * Throws a typed failure when the output cannot be produced.
   */
  finalizeOutput(
    partial: boolean,
    format: OutputFormat,
    canvas?: { width: number; height: number } | null,
  ): Promise<void>;
  /** Close every retained tile resource (idempotent). */
  release(): void;
}

function placementGeometry(
  placement: AssemblyPlacement,
  bitmap: TileBitmap | undefined,
): PlacedTileGeometry {
  const w = placement.expected_size?.width ?? bitmap?.width;
  const h = placement.expected_size?.height ?? bitmap?.height;
  return { x: placement.position.x, y: placement.position.y, w, h };
}

export function createCanvasAssembly(deps: CanvasAssemblyDeps): CanvasAssembly {
  const placements = new Map<number, AssemblyPlacement>();
  const bitmaps = new Map<number, TileBitmap>();
  const displayImages = new Map<number, TileImageLike>();
  const processQueue = deps.processTile ? createProcessQueue(deps.processTile) : null;
  let canvas: AssemblyCanvas | null = null;
  let canvasSize: { width: number; height: number } | null = null;
  let tainted = false;

  function recordPlacement(tile: number, placement: AssemblyPlacement): void {
    placements.set(tile, placement);
  }

  async function acquireTile(
    tile: number,
    placement: AssemblyPlacement,
    bytes: ArrayBuffer,
  ): Promise<void> {
    recordPlacement(tile, placement);
    let input = bytes;
    if (placement.processing !== "none") {
      if (!processQueue) {
        // No processing executor: fail typed instead of silently dropping
        // the recipe.
        throw failure(
          "TILE_PROCESSING_UNAVAILABLE",
          "This image needs a processing step this app cannot run yet. Use the desktop app for it.",
          false,
          undefined,
          `tile ${tile} requires processing recipe ${placement.processing}`,
        );
      }
      input = await processQueue(placement.processing, bytes);
    }
    const bitmap = await deps.decode(input);
    bitmaps.set(tile, bitmap);
  }

  function markDisplayOnly(): void {
    if (tainted) return;
    tainted = true;
    deps.onDisplayOnly?.();
  }

  function acquireDisplayTile(
    tile: number,
    placement: AssemblyPlacement,
    image: TileImageLike,
  ): void {
    recordPlacement(tile, placement);
    displayImages.set(tile, image);
    markDisplayOnly();
  }

  function isTainted(): boolean {
    return tainted;
  }

  function dimensions(): { width: number; height: number } | null {
    if (canvasSize) return { ...canvasSize };
    const derived = derivedSize();
    if (derived.width > 0 && derived.height > 0) return derived;
    return null;
  }

  /** Output size from accumulated placements (declared canvas unknown). */
  function derivedSize(): { width: number; height: number } {
    let width = 0;
    let height = 0;
    for (const [tile, placement] of placements) {
      const bitmap = bitmaps.get(tile);
      const image = displayImages.get(tile);
      const w = placement.expected_size?.width
        ?? bitmap?.width
        ?? image?.naturalWidth
        ?? 0;
      const h = placement.expected_size?.height
        ?? bitmap?.height
        ?? image?.naturalHeight
        ?? 0;
      width = Math.max(width, placement.position.x + (w > 0 ? w : 0));
      height = Math.max(height, placement.position.y + (h > 0 ? h : 0));
    }
    return { width, height };
  }

  /** Output size: the declared canvas, else the union of placements. */
  function outputSize(declared?: { width: number; height: number } | null): {
    width: number;
    height: number;
  } {
    if (declared && declared.width > 0 && declared.height > 0) {
      return { width: declared.width, height: declared.height };
    }
    return derivedSize();
  }

  async function finalizeOutput(
    _partial: boolean,
    _format: OutputFormat,
    declared?: { width: number; height: number } | null,
  ): Promise<void> {
    if (canvas) {
      throw failure(
        "OUTPUT_STATE",
        "The output surface is already open.",
        false,
        undefined,
        "finalize-output arrived twice",
      );
    }
    const size = outputSize(declared);
    if (!(size.width > 0 && size.height > 0)) {
      throw failure(
        "PLAN_INVALID",
        "The image size could not be determined.",
        false,
        undefined,
        `finalize-output derived an empty canvas ${size.width}x${size.height}`,
      );
    }
    const verdict = probeLimits(size, deps.limits ?? BROWSER_LIMITS);
    if (verdict.verdict !== "ok") {
      // Explicit dimension and area validation before allocation.
      throw canvasTooLargeFailure(size.width, size.height, deps.sourceUrl ?? "", verdict.reason);
    }
    canvas = deps.createCanvas(size.width, size.height);
    canvasSize = { width: size.width, height: size.height };

    for (const [tile, placement] of placements) {
      const bitmap = bitmaps.get(tile);
      const image = displayImages.get(tile);
      const source = bitmap ?? image;
      if (!source) continue; // missing tile: the partial region stays empty
      try {
        drawPlacedTile(canvas.ctx2d, source, placementGeometry(placement, bitmap), (line) =>
          deps.log?.(line),
        );
      } finally {
        bitmaps.delete(tile);
        displayImages.delete(tile);
        if (bitmap) {
          try {
            bitmap.close();
          } catch {
            // Bitmap cleanup is best-effort.
          }
        }
      }
    }

    if (tainted) {
      // A tainted canvas can never be read or encoded: the drawn picture
      // stays visible as display-only output and no bytes are produced.
      return;
    }
    let encoded: unknown;
    try {
      encoded = await deps.encode(canvas);
    } catch (error) {
      // A browser may defer origin-clean enforcement until encoding. The
      // assembled picture stays visible as display-only instead of failing.
      if (deps.isTaintError?.(error)) {
        markDisplayOnly();
        return;
      }
      throw error;
    }
    deps.save(encoded, canvas.width, canvas.height);
  }

  function release(): void {
    for (const bitmap of bitmaps.values()) {
      try {
        bitmap.close();
      } catch {
        // Bitmap cleanup is best-effort.
      }
    }
    bitmaps.clear();
    displayImages.clear();
    canvas = null;
    canvasSize = null;
    tainted = false;
  }

  return {
    acquireTile,
    acquireDisplayTile,
    isTainted,
    dimensions,
    finalizeOutput,
    release,
  };
}

/** Overflow-safe area of a declared level size (null when invalid). */
export function declaredArea(size: { width?: number; height?: number }): number | null {
  if (typeof size?.width !== "number" || typeof size?.height !== "number") return null;
  return safeArea(size.width, size.height);
}
