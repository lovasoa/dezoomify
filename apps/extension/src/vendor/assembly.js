// GENERATED from packages/browser-runtime/src/assembly.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/assembly.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Engine-effect canvas assembly executor.
//
// One shared executor for every browser host of the Rust job engine (the
// extension job tab today, the website after its migration): it maps the
// engine's typed host effects onto browser canvas execution and owns no job
// policy. The engine owns retries, cancellation, partial-output decisions,
// and ordering; this module only executes what the effects describe:
//
//   acquire-tile   -> recordPlacement + decode (decode-at-acquisition, the
//                     native model: a tile that cannot decode reports its
//                     acquisition failure through the tile outcome)
//   decode-pixels  -> verify the held decoded tile
//   open-encoder   -> validate the output dimensions and allocate the canvas
//   finalize-encoder -> draw every held tile at its planned placement,
//                     close the bitmaps, encode the output
//   publish-output -> persist the encoded output
//   release-bytes  -> close every retained tile resource
//
// All host constructors are injected so node tests drive the full path with
// fakes. Keep erasable-syntax-only for the browser `.js` mirrors.
import { drawPlacedTile } from "./tile-draw.js";

import { canvasTooLargeFailure } from "./plan-gates.js";
import { BROWSER_LIMITS, probeLimits, safeArea } from "./limits.js";

import { failure } from "./failure.js";

/** Wire shape of one tile's output placement (see `TilePlacementDto`). */

/** Allocated output surface: geometry plus a 2D drawing context. */

function isPlainRecipe(processing                    )          {
  return (
    processing === undefined || processing === null || processing === "" || processing === "none"
  );
}

function placementGeometry(
  placement                   ,
  bitmap                        ,
)                     {
  const w = placement.expected_size?.width ?? bitmap?.width;
  const h = placement.expected_size?.height ?? bitmap?.height;
  return { x: placement.position.x, y: placement.position.y, w, h };
}

export function createCanvasAssembly(deps                    )                 {
  const placements = new Map                           ();
  const bitmaps = new Map                    ();
  let canvas                        = null;
  let encoded          = null;
  let saved = false;

  function recordPlacement(tile        , placement                   )       {
    const { x, y } = placement?.position ?? { x: NaN, y: NaN };
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
      throw failure(
        "PLAN_INVALID",
        "The image layout could not be determined.",
        false,
        undefined,
        `tile ${tile} placement is not a non-negative integer position`,
      );
    }
    placements.set(tile, placement);
  }

  async function acquireTile(
    tile        ,
    placement                   ,
    bytes             ,
  )                {
    recordPlacement(tile, placement);
    if (!isPlainRecipe(placement.processing)) {
      // The canvas host has no processing executor for engine jobs yet:
      // fail typed instead of silently dropping the recipe.
      throw failure(
        "TILE_PROCESSING_UNAVAILABLE",
        "This image needs a processing step this app cannot run yet. Use the desktop app for it.",
        false,
        undefined,
        `tile ${tile} requires processing recipe ${placement.processing}`,
      );
    }
    const bitmap = await deps.decode(bytes);
    bitmaps.set(tile, bitmap);
  }

  function decodePixels(tile        )       {
    if (!bitmaps.has(tile)) {
      throw failure(
        "OUTPUT_STATE",
        "The saved pieces could not be assembled.",
        false,
        undefined,
        `decode-pixels for tile ${tile} without a held decoded tile`,
      );
    }
  }

  /** Output size: the declared canvas, else the union of placements. */
  function outputSize(canvasSize                                           )

    {
    if (canvasSize && canvasSize.width > 0 && canvasSize.height > 0) {
      return { width: canvasSize.width, height: canvasSize.height };
    }
    let width = 0;
    let height = 0;
    for (const [tile, placement] of placements) {
      const bitmap = bitmaps.get(tile);
      const w = placement.expected_size?.width ?? bitmap?.width ?? 0;
      const h = placement.expected_size?.height ?? bitmap?.height ?? 0;
      width = Math.max(width, placement.position.x + (w > 0 ? w : 0));
      height = Math.max(height, placement.position.y + (h > 0 ? h : 0));
    }
    return { width, height };
  }

  function openEncoder(format        , canvasSize                                           )       {
    if (canvas) {
      throw failure(
        "OUTPUT_STATE",
        "The output surface is already open.",
        false,
        undefined,
        "open-encoder arrived twice",
      );
    }
    if (format !== "png") {
      throw failure(
        "OUTPUT_FORMAT_UNSUPPORTED",
        "This app cannot save that image format yet.",
        false,
        undefined,
        `open-encoder format ${format}`,
      );
    }
    const size = outputSize(canvasSize);
    if (!(size.width > 0 && size.height > 0)) {
      throw failure(
        "PLAN_INVALID",
        "The image size could not be determined.",
        false,
        undefined,
        `open-encoder derived an empty canvas ${size.width}x${size.height}`,
      );
    }
    const verdict = probeLimits(size, deps.limits ?? BROWSER_LIMITS);
    if (verdict.verdict !== "ok") {
      // Explicit dimension and area validation before allocation.
      throw canvasTooLargeFailure(size.width, size.height, deps.sourceUrl ?? "", verdict.reason);
    }
    canvas = deps.createCanvas(size.width, size.height);
  }

  async function finalizeEncoder()                {
    if (!canvas || encoded !== null) {
      throw failure(
        "OUTPUT_STATE",
        "The saved pieces could not be assembled.",
        false,
        undefined,
        "finalize-encoder without an open encoder",
      );
    }
    for (const [tile, placement] of placements) {
      const bitmap = bitmaps.get(tile);
      if (!bitmap) continue; // missing tile: the partial region stays empty
      try {
        drawPlacedTile(canvas.ctx2d, bitmap, placementGeometry(placement, bitmap), (line) =>
          deps.log?.(line),
        );
      } finally {
        bitmaps.delete(tile);
        try {
          bitmap.close();
        } catch {
          // Bitmap cleanup is best-effort.
        }
      }
    }
    encoded = await deps.encode(canvas);
  }

  function publishOutput()       {
    if (encoded === null || !canvas) {
      throw failure(
        "OUTPUT_STATE",
        "The final picture is not ready to save.",
        false,
        undefined,
        "publish-output without an encoded output",
      );
    }
    if (!saved) {
      deps.save(encoded, canvas.width, canvas.height);
      saved = true;
    }
  }

  function release()       {
    for (const bitmap of bitmaps.values()) {
      try {
        bitmap.close();
      } catch {
        // Bitmap cleanup is best-effort.
      }
    }
    bitmaps.clear();
    canvas = null;
    encoded = null;
  }

  return {
    recordPlacement,
    acquireTile,
    decodePixels,
    openEncoder,
    finalizeEncoder,
    publishOutput,
    release,
  };
}

/** Overflow-safe area of a declared level size (null when invalid). */
export function declaredArea(size                                     )                {
  if (typeof size?.width !== "number" || typeof size?.height !== "number") return null;
  return safeArea(size.width, size.height);
}
