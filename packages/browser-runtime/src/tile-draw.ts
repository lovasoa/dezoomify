// Tile painting (todo 2.2 home, moved from `src/main.ts`).
//
// Readable bytes come first so CORS-granting sites keep the clean save.
// After the readable retries are exhausted, an unprocessed tile falls back
// to a plain <img> (no CORS needed): the user sees the picture, but scripts
// can no longer read or save the canvas. Processed tiles rethrow:
// decrypt/re-encode needs readable bytes. The host image constructor and
// timers are injected so node tests drive the fallback with fakes. Keep
// erasable-syntax-only for the browser `.js` mirrors.
import type { PlanTile } from "./session.ts";
import type { TileBitmap } from "./tile-decode.ts";

export interface TileImageLike {
  naturalWidth: number;
  naturalHeight: number;
}

export interface TileDrawHooks {
  onRequestStart(label: string): number;
  onRequestEnd(id: number, ok: boolean): void;
  onLog(line: string): void;
  onUpdate(): void;
}

export interface TileDrawDeps {
  fetchTile(url: string, headers: Record<string, string>): Promise<{ bytes: ArrayBuffer }>;
  decode(bytes: ArrayBuffer): Promise<TileBitmap>;
  throttle?: (url: string) => Promise<void>;
  processTile?: (recipe: string, bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  loadImage?: (url: string, ms?: number) => Promise<TileImageLike>;
  imageCtor?: new () => TileImageElementLike;
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
  requestTimeoutMs?: number;
  isOrdinaryImageTile(processing: unknown): boolean;
  hooks: TileDrawHooks;
}

export interface TileImageElementLike {
  naturalWidth: number;
  naturalHeight: number;
  referrerPolicy: string;
  src: string;
  addEventListener(type: string, listener: () => void, opts?: { once?: boolean }): void;
}

export interface Canvas2DLike {
  drawImage(
    source: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** Output placement of one decoded tile, shared by the website painter and
 * the engine-effect assembly executor: top-left corner plus the planned
 * extent when the plan declares one. */
export interface PlacedTileGeometry {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/**
 * Draw one decoded tile onto an output surface at its planned placement.
 * Trusts the plan for layout: the canvas stays seamless even when a tile
 * decodes at an unexpected size; the decoded bitmap is scaled to the
 * planned extent so no gap appears. `onMismatch` receives a generic
 * diagnostic when the decoded and planned sizes disagree; it never identifies
 * an individual tile.
 */
export function drawPlacedTile(
  ctx2d: Canvas2DLike,
  source: TileBitmap | TileImageLike,
  geometry: PlacedTileGeometry,
  onMismatch?: (line: string) => void,
): void {
  // Image elements carry naturalWidth/naturalHeight (their layout width
  // would mislead); decoded bitmaps carry width/height. Branch on the
  // image shape first so production <img> fallbacks measure correctly.
  const isImage = (source as Partial<TileImageLike>).naturalWidth !== undefined;
  const fullW = isImage ? (source as TileImageLike).naturalWidth : (source as TileBitmap).width;
  const fullH = isImage ? (source as TileImageLike).naturalHeight : (source as TileBitmap).height;
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
  url: string,
  deps: {
    imageCtor?: new () => TileImageElementLike;
    setTimeoutFn?: (cb: () => void, ms: number) => unknown;
    clearTimeoutFn?: (t: unknown) => void;
    ms?: number;
    hooks?: Pick<TileDrawHooks, "onRequestStart" | "onRequestEnd" | "onUpdate">;
  } = {},
): Promise<TileImageElementLike> {
  const ms = deps.ms ?? 30000;
  const hooks = deps.hooks;
  const reqId = hooks ? hooks.onRequestStart("img") : -1;
  return new Promise((resolve, reject) => {
    // Ordinary image elements only: dependency-injected in tests, otherwise
    // the host Image constructor directly (never a CORS opt-in, so no grant
    // is needed and the canvas taints on draw).
    const Ctor =
      deps.imageCtor ??
      (globalThis as unknown as { Image?: new () => TileImageElementLike }).Image;
    if (!Ctor && typeof Image === "undefined") {
      if (hooks) {
        hooks.onRequestEnd(reqId, false);
        hooks.onUpdate();
      }
      reject(new Error("tile image unavailable without an image host"));
      return;
    }
    const setTimer =
      deps.setTimeoutFn ?? ((cb: () => void, t: number) => setTimeout(cb, t));
    const clearTimer =
      deps.clearTimeoutFn ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const img = Ctor ? new Ctor() : new Image();
    let timer: unknown = null;
    const done = (ok: boolean, value: TileImageElementLike | Error) => {
      if (timer) clearTimer(timer);
      timer = null;
      if (hooks) {
        hooks.onRequestEnd(reqId, ok);
        hooks.onUpdate();
      }
      if (ok) resolve(value as TileImageElementLike);
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
  processTile: (recipe: string, bytes: ArrayBuffer) => Promise<ArrayBuffer>,
): (recipe: string, bytes: ArrayBuffer) => Promise<ArrayBuffer> {
  let tail: Promise<unknown> = Promise.resolve();
  return (recipe: string, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
    const run = tail.then(() => processTile(recipe, bytes));
    tail = run.catch(() => undefined);
    return run;
  };
}

export interface TilePainter {
  drawTile(
    ctx2d: Canvas2DLike,
    tile: PlanTile,
    opts?: { processTile?: (recipe: string, bytes: ArrayBuffer) => Promise<ArrayBuffer> },
  ): Promise<boolean>;
}

/**
 * Draw one planned tile. Returns true when the tile was painted through
 * ordinary image display (canvas now tainted, display-only); false when it
 * arrived as readable bytes (canvas stays clean). When the <img> also fails,
 * the original readable failure (with its technical chain) is what the job
 * reports.
 */
export function createTilePainter(deps: TileDrawDeps): TilePainter {
  const processQueue = deps.processTile ? createProcessQueue(deps.processTile) : null;
  const loadImage =
    deps.loadImage ??
    ((url: string, ms?: number) =>
      loadTileImage(url, {
        ...(deps.imageCtor ? { imageCtor: deps.imageCtor } : {}),
        ...(deps.setTimeoutFn ? { setTimeoutFn: deps.setTimeoutFn } : {}),
        ...(deps.clearTimeoutFn ? { clearTimeoutFn: deps.clearTimeoutFn } : {}),
        ms: typeof ms === "number" ? ms : (deps.requestTimeoutMs ?? 30000),
        hooks: deps.hooks,
      }));

  async function drawTile(
    ctx2d: Canvas2DLike,
    tile: PlanTile,
    opts?: { processTile?: (recipe: string, bytes: ArrayBuffer) => Promise<ArrayBuffer> },
  ): Promise<boolean> {
    const drawBitmap = async (source: TileBitmap | TileImageLike): Promise<void> => {
      drawPlacedTile(
        ctx2d,
        source,
        { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
        (line) => deps.hooks.onLog(line),
      );
    };
    let readableFailure: unknown = null;
    try {
      let { bytes } = await deps.fetchTile(tile.uri, tile.headers ?? {});
      const processTile = opts?.processTile ?? (processQueue ? (r: string, b: ArrayBuffer) => (processQueue as (r: string, b: ArrayBuffer) => Promise<ArrayBuffer>)(r, b) : undefined);
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
