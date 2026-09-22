// Tile painting shared by browser products.
// Readable bytes come first so CORS-granting sites keep the clean save.
// After the readable retries are exhausted, an unprocessed tile falls back
// to a plain <img> (no CORS needed): the user sees the picture, but scripts
// can no longer read or save the canvas. Processed tiles rethrow:
// decrypt/re-encode needs readable bytes. The host image constructor and
// timers are injected so node tests drive the fallback with fakes.
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
 * Trusts the plan for layout and copies pixels at 1:1 scale. A tile larger
 * than its planned extent is cropped from the right and bottom; this is how
 * padded edge tiles are represented by Google Arts & Culture and similar
 * services. A smaller tile leaves the remainder unpainted instead of
 * stretching its pixels. `onMismatch` receives a generic diagnostic; it
 * never identifies an individual tile.
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
  const copyW = Math.min(planW, fullW);
  const copyH = Math.min(planH, fullH);
  if (planW !== fullW || planH !== fullH) {
    onMismatch?.("A tile size differed from the plan; only its planned pixel extent was drawn.");
  }
  if (copyW > 0 && copyH > 0) {
    ctx2d.drawImage(source, 0, 0, copyW, copyH, geometry.x, geometry.y, copyW, copyH);
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
      deps.imageCtor ?? (globalThis as unknown as { Image?: new () => TileImageElementLike }).Image;
    if (!Ctor && typeof Image === "undefined") {
      if (hooks) {
        hooks.onRequestEnd(reqId, false);
        hooks.onUpdate();
      }
      reject(new Error("tile image unavailable without an image host"));
      return;
    }
    const setTimer = deps.setTimeoutFn ?? ((cb: () => void, t: number) => setTimeout(cb, t));
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
    img.addEventListener("error", () => done(false, new Error("tile image failed to load")), {
      once: true,
    });
    timer = setTimer(() => {
      try {
        img.src = "";
      } catch {
        // Cancelling a hung load must never throw.
      }
      done(false, new Error(`tile image timed out after ${ms / 1000}s`));
    }, ms);
    // Let the browser choose its ordinary image-request referrer behavior.
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
export function createProcessQueue<Recipe>(
  processTile: (recipe: Recipe, bytes: ArrayBuffer) => Promise<ArrayBuffer>,
): (recipe: Recipe, bytes: ArrayBuffer) => Promise<ArrayBuffer> {
  let tail: Promise<unknown> = Promise.resolve();
  return (recipe: Recipe, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
    const run = tail.then(() => processTile(recipe, bytes));
    tail = run.catch(() => undefined);
    return run;
  };
}
