// GENERATED from packages/browser-runtime/src/tile-draw.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/tile-draw.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Tile painting (todo 2.2 home, moved from `src/main.ts`).
//
// Readable bytes come first so CORS-granting sites keep the clean save.
// After the readable retries are exhausted, an unprocessed tile falls back
// to a plain <img> (no CORS needed): the user sees the picture, but scripts
// can no longer read or save the canvas. Processed tiles rethrow:
// decrypt/re-encode needs readable bytes. The host image constructor and
// timers are injected so node tests drive the fallback with fakes. Keep
// erasable-syntax-only for the browser `.js` mirrors.

/** Output placement of one decoded tile, shared by the website painter and
 * the engine-effect assembly executor: top-left corner plus the planned
 * extent when the plan declares one. */

/**
 * Draw one decoded tile onto an output surface at its planned placement.
 * Trusts the plan for layout: the canvas stays seamless even when a tile
 * decodes at an unexpected size; the decoded bitmap is scaled to the
 * planned extent so no gap appears. `onMismatch` receives a generic
 * diagnostic when the decoded and planned sizes disagree; it never identifies
 * an individual tile.
 */
export function drawPlacedTile(
  ctx2d              ,
  source                            ,
  geometry                    ,
  onMismatch                         ,
)       {
  // Image elements carry naturalWidth/naturalHeight (their layout width
  // would mislead); decoded bitmaps carry width/height. Branch on the
  // image shape first so production <img> fallbacks measure correctly.
  const isImage = (source                          ).naturalWidth !== undefined;
  const fullW = isImage ? (source                 ).naturalWidth : (source              ).width;
  const fullH = isImage ? (source                 ).naturalHeight : (source              ).height;
  const planW = geometry.w ?? fullW;
  const planH = geometry.h ?? fullH;
  if (planW !== fullW || planH !== fullH) {
    onMismatch?.("A tile size differed from the plan; it was scaled to keep the image seamless.");
  }
  if (planW > 0 && planH > 0 && fullW > 0 && fullH > 0) {
    ctx2d.drawImage(source, 0, 0, fullW, fullH, geometry.x, geometry.y, planW, planH);
  }
}

/**
 * Load one tile as an ordinary image element: visible, but with no byte
 * access. Deliberately leaves the CORS opt-in unset, so no CORS grant is
 * needed; drawing the result taints the canvas. The caller must treat a
 * tainted canvas as display-only: no pixel reads, no toBlob/toDataURL, no
 * programmatic save.
 */
export function loadTileImage(
  url        ,
  deps

    = {},
)                                {
  const ms = deps.ms ?? 30000;
  const hooks = deps.hooks;
  const reqId = hooks ? hooks.onRequestStart("img") : -1;
  return new Promise((resolve, reject) => {
    // Ordinary image elements only: dependency-injected in tests, otherwise
    // the host Image constructor directly (never a CORS opt-in, so no grant
    // is needed and the canvas taints on draw).
    const Ctor =
      deps.imageCtor ??
      (globalThis                                                         ).Image;
    if (!Ctor && typeof Image === "undefined") {
      if (hooks) {
        hooks.onRequestEnd(reqId, false);
        hooks.onUpdate();
      }
      reject(new Error("tile image unavailable without an image host"));
      return;
    }
    const setTimer =
      deps.setTimeoutFn ?? ((cb            , t        ) => setTimeout(cb, t));
    const clearTimer =
      deps.clearTimeoutFn ?? ((t         ) => clearTimeout(t                                 ));
    const img = Ctor ? new Ctor() : new Image();
    let timer          = null;
    const done = (ok         , value                              ) => {
      if (timer) clearTimer(timer);
      timer = null;
      if (hooks) {
        hooks.onRequestEnd(reqId, ok);
        hooks.onUpdate();
      }
      if (ok) resolve(value                        );
      else reject(value);
    };
    img.addEventListener("load", () => done(true, img), { once: true });
    img.addEventListener(
      "error",
      () => done(false, new Error("tile image failed to load")),
      { once: true },
    );
    timer = setTimer(() => {
      try {
        img.src = "";
      } catch {
        // Cancelling a hung load must never throw.
      }
      done(false, new Error(`tile image timed out after ${ms / 1000}s`));
    }, ms);
    // Don't tell the tile host the request comes from dezoomify (legacy parity).
    img.referrerPolicy = "no-referrer";
    img.src = url;
  });
}

/**
 * Encrypted-tile processing (e.g. Google Arts and Culture containers) goes
 * through one serialized queue. Tile fetches run concurrently, so processing
 * calls are serialized here: fetching stays parallel, only the short decrypt
 * step queues.
 */
export function createProcessQueue(
  processTile                                                              ,
)                                                               {
  let tail                   = Promise.resolve();
  return (recipe        , bytes             )                       => {
    const run = tail.then(() => processTile(recipe, bytes));
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Draw one planned tile. Returns true when the tile was painted through
 * ordinary image display (canvas now tainted, display-only); false when it
 * arrived as readable bytes (canvas stays clean). When the <img> also fails,
 * the original readable failure (with its technical chain) is what the job
 * reports.
 */
export function createTilePainter(deps              )              {
  const processQueue = deps.processTile ? createProcessQueue(deps.processTile) : null;
  const loadImage =
    deps.loadImage ??
    ((url        , ms         ) =>
      loadTileImage(url, {
        ...(deps.imageCtor ? { imageCtor: deps.imageCtor } : {}),
        ...(deps.setTimeoutFn ? { setTimeoutFn: deps.setTimeoutFn } : {}),
        ...(deps.clearTimeoutFn ? { clearTimeoutFn: deps.clearTimeoutFn } : {}),
        ms: typeof ms === "number" ? ms : (deps.requestTimeoutMs ?? 30000),
        hooks: deps.hooks,
      }));

  async function drawTile(
    ctx2d              ,
    tile          ,
    opts                                                                                 ,
  )                   {
    const drawBitmap = async (source                            )                => {
      drawPlacedTile(
        ctx2d,
        source,
        { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
        (line) => deps.hooks.onLog(line),
      );
    };
    let readableFailure          = null;
    try {
      let { bytes } = await deps.fetchTile(tile.uri, tile.headers ?? {});
      const processTile = opts?.processTile ?? (processQueue ? (r        , b             ) => (processQueue                                                       )(r, b) : undefined);
      if (tile.processing && tile.processing !== "none" && processTile) {
        bytes = await processTile(tile.processing, bytes);
      } else if (tile.processing && tile.processing !== "none" && !processTile) {
        throw new Error(`tile processing unavailable for recipe: ${tile.processing}`);
      }
      const bitmap = await deps.decode(bytes);
      try {
        await drawBitmap(bitmap);
      } finally {
        try {
          bitmap.close();
        } catch {
          // Bitmap cleanup is best-effort.
        }
      }
      return false;
    } catch (error) {
      readableFailure = error;
    }
    if (!deps.isOrdinaryImageTile(tile.processing)) throw readableFailure;
    try {
      if (deps.throttle) {
        try {
          await deps.throttle(tile.uri);
        } catch {
          // Throttle waits must never fail a tile.
        }
      }
      const img = await loadImage(tile.uri);
      await drawBitmap(img);
      return true;
    } catch {
      throw readableFailure;
    }
  }

  return { drawTile };
}
