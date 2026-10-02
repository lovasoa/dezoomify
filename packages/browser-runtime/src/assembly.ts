// Canvas decoding, painting, and PNG output for browser capabilities.
import type { OutputDisposition, TilePlacement } from "@dezoomify/wasm-bindings";
import { outputError, tileError } from "./failure.ts";
import { BROWSER_LIMITS, type BrowserLimits, probeLimits } from "./limits.ts";
import { canvasTooLargeFailure } from "./plan-gates.ts";
import type { TileBitmap } from "./tile-decode.ts";
import type { Canvas2DLike, PlacedTileGeometry, TileImageLike } from "./tile-draw.ts";
import { drawPlacedTile } from "./tile-draw.ts";

export type BrowserSaveDisposition = Extract<
  OutputDisposition,
  "browser-save-initiated" | "browser-save-ready"
>;
export type BrowserOutputDisposition = BrowserSaveDisposition | "display-only";

/** Allocated output surface: geometry plus a 2D drawing context. */
export interface AssemblyCanvas {
  width: number;
  height: number;
  ctx2d: Canvas2DLike;
}

export interface CanvasAssemblyDeps<C extends AssemblyCanvas = AssemblyCanvas> {
  diagnostics?: import("../../shared-ui/src/diagnostics.ts").DiagnosticRecorder;
  signal?: AbortSignal;
  /** Decode acquired tile bytes into a bitmap (tile-decode's decoder). */
  decode(bytes: ArrayBuffer): Promise<TileBitmap>;
  /**
   * Apply one core processing recipe (e.g. `google-arts-decrypt`) to raw
   * tile bytes before decoding with the pure WASM `applyProcessing` function.
   */
  processTile(recipe: TilePlacement["processing"], bytes: ArrayBuffer): ArrayBuffer;
  /** Allocate the output surface; called only after limit validation. */
  createCanvas(width: number, height: number): C;
  /** Encode the assembled surface (canvas-to-blob on the job tab). */
  encode(canvas: C, signal: AbortSignal): Promise<Blob>;
  /** Perform the product's save operation and return its actual disposition. */
  save(
    output: Blob,
    width: number,
    height: number,
    signal: AbortSignal,
  ): BrowserSaveDisposition | Promise<BrowserSaveDisposition>;
  /** Job source URL, named in limit-failure diagnostics. */
  sourceUrl?: string;
  /** Limits override for tests; defaults to the browser canvas limits. */
  limits?: BrowserLimits;
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
  /** Validate and reveal the declared output surface before acquisition. */
  prepare(canvas?: { width: number; height: number } | null): void;
  /** Decode and paint immediately, or hold when the plan has no declared size. */
  acquireTile(tile: number, placement: TilePlacement, bytes: ArrayBuffer): Promise<void>;
  /**
   * Display-only acquisition: hold an ordinary image element for assembly.
   * The canvas taints when it is drawn, so the job can only complete as
   * display-only (no pixel reads, no programmatic save).
   */
  acquireDisplayTile(tile: number, placement: TilePlacement, image: TileImageLike): void;
  /** Output dimensions from the declared canvas or accumulated placements. */
  dimensions(): { width: number; height: number } | null;
  /**
   * The one awaited output operation: flush any retained tiles, encode and
   * save, or keep a tainted canvas display-only.
   * Throws a typed failure when the output cannot be produced.
   */
  finalizeOutput(
    canvas?: { width: number; height: number } | null,
  ): Promise<BrowserOutputDisposition>;
  /** Close every retained tile resource (idempotent). */
  release(): void;
}

function placementGeometry(
  placement: TilePlacement,
  bitmap: TileBitmap | undefined,
): PlacedTileGeometry {
  const w = placement.expected_size?.width ?? bitmap?.width;
  const h = placement.expected_size?.height ?? bitmap?.height;
  return { x: placement.position.x, y: placement.position.y, w, h };
}

export function createCanvasAssembly<C extends AssemblyCanvas>(
  deps: CanvasAssemblyDeps<C>,
): CanvasAssembly {
  const lifetime = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, lifetime.signal]) : lifetime.signal;
  const placements = new Map<number, TilePlacement>();
  const bitmaps = new Map<number, TileBitmap>();
  const displayImages = new Map<number, TileImageLike>();
  let canvas: C | null = null;
  let canvasSize: { width: number; height: number } | null = null;
  let tainted = false;
  let finalized = false;
  let mismatchSamples = 0;

  function allocate(size: { width: number; height: number }): C {
    deps.diagnostics?.context({
      canvas: size,
      canvas_bytes: size.width * size.height * 4,
      canvas_limits: deps.limits ?? BROWSER_LIMITS,
    });
    const verdict = probeLimits(size, deps.limits ?? BROWSER_LIMITS);
    if (verdict.verdict !== "ok") {
      throw canvasTooLargeFailure(size.width, size.height, deps.sourceUrl ?? "", verdict.reason);
    }
    const surface = deps.createCanvas(size.width, size.height);
    canvas = surface;
    canvasSize = { ...size };
    return surface;
  }

  function prepare(declared?: { width: number; height: number } | null): void {
    signal.throwIfAborted();
    if (!declared || canvas) return;
    if (!(declared.width > 0 && declared.height > 0)) {
      throw outputError(
        "plan-invalid",
        `declared an empty canvas ${declared.width}x${declared.height}`,
      );
    }
    allocate(declared);
    flushHeld();
  }

  async function acquireTile(
    tile: number,
    placement: TilePlacement,
    bytes: ArrayBuffer,
  ): Promise<void> {
    signal.throwIfAborted();
    placements.set(tile, placement);
    // Processing and decoding failures are typed at their source so they
    // classify as tile failures instead of the retryable fetch fallback.
    let input: ArrayBuffer;
    try {
      input =
        placement.processing === "none" ? bytes : deps.processTile(placement.processing, bytes);
    } catch (error) {
      signal.throwIfAborted();
      throw tileError("processing-failed", error);
    }
    signal.throwIfAborted();
    let bitmap: TileBitmap;
    try {
      bitmap = await deps.decode(input);
    } catch (error) {
      signal.throwIfAborted();
      throw tileError("decode-failed", error);
    }
    const mismatch =
      placement.expected_size &&
      (placement.expected_size.width !== bitmap.width ||
        placement.expected_size.height !== bitmap.height);
    if ((mismatch && mismatchSamples++ < 3) || tile < 3)
      deps.diagnostics?.record("debug", "tile-geometry", {
        tile,
        decoded_width: bitmap.width,
        decoded_height: bitmap.height,
        ...placement,
      });
    if (mismatch) deps.diagnostics?.count("geometry_mismatches");
    if (signal.aborted) {
      bitmap.close();
      signal.throwIfAborted();
    }
    if (!canvas) {
      bitmaps.set(tile, bitmap);
      return;
    }
    try {
      drawPlacedTile(canvas.ctx2d, bitmap, placementGeometry(placement, bitmap));
    } finally {
      try {
        bitmap.close();
      } catch {
        // Bitmap cleanup is best-effort.
      }
    }
  }

  function markDisplayOnly(): void {
    if (tainted) return;
    tainted = true;
    deps.onDisplayOnly?.();
  }

  /** Paint probe tiles that arrived before the declared output surface. */
  function flushHeld(): void {
    if (!canvas) return;
    for (const [tile, bitmap] of bitmaps) {
      const placement = placements.get(tile);
      if (!placement) continue;
      try {
        drawPlacedTile(canvas.ctx2d, bitmap, placementGeometry(placement, bitmap));
      } finally {
        bitmaps.delete(tile);
        try {
          bitmap.close();
        } catch {
          // Bitmap cleanup is best-effort.
        }
      }
    }
    for (const [tile, image] of displayImages) {
      const placement = placements.get(tile);
      if (!placement) continue;
      drawPlacedTile(canvas.ctx2d, image, placementGeometry(placement, undefined));
      displayImages.delete(tile);
    }
  }

  function acquireDisplayTile(tile: number, placement: TilePlacement, image: TileImageLike): void {
    signal.throwIfAborted();
    placements.set(tile, placement);
    if (canvas) {
      drawPlacedTile(canvas.ctx2d, image, placementGeometry(placement, undefined));
    } else {
      displayImages.set(tile, image);
    }
    markDisplayOnly();
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
      const w = placement.expected_size?.width ?? bitmap?.width ?? image?.naturalWidth ?? 0;
      const h = placement.expected_size?.height ?? bitmap?.height ?? image?.naturalHeight ?? 0;
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
    declared?: { width: number; height: number } | null,
  ): Promise<BrowserOutputDisposition> {
    signal.throwIfAborted();
    if (finalized) {
      throw outputError("internal", "output was finalized twice");
    }
    let surface = canvas;
    if (!surface) {
      const size = outputSize(declared);
      if (!(size.width > 0 && size.height > 0)) {
        throw outputError(
          "plan-invalid",
          `output had an empty canvas ${size.width}x${size.height}`,
        );
      }
      surface = allocate(size);
    }
    finalized = true;

    flushHeld();

    if (tainted) {
      // A tainted canvas can never be read or encoded: the drawn picture
      // stays visible as display-only output and no bytes are produced.
      return "display-only";
    }
    let encoded: Blob;
    const started = performance.now();
    try {
      encoded = await deps.encode(surface, signal);
    } catch (error) {
      signal.throwIfAborted();
      // A browser may defer origin-clean enforcement until encoding. The
      // assembled picture stays visible as display-only instead of failing.
      if (deps.isTaintError?.(error)) {
        markDisplayOnly();
        return "display-only";
      }
      throw error;
    }
    signal.throwIfAborted();
    deps.diagnostics?.record("info", "encoded", {
      width: surface.width,
      height: surface.height,
      bytes: encoded.size,
      format: encoded.type,
      duration_ms: performance.now() - started,
    });
    const disposition = await deps.save(encoded, surface.width, surface.height, signal);
    signal.throwIfAborted();
    return disposition;
  }

  function release(): void {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
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
  }

  return {
    prepare,
    acquireTile,
    acquireDisplayTile,
    dimensions,
    finalizeOutput,
    release,
  };
}
