import { PageObject } from "../viewers/page-object.ts";
import type { ViewerTile } from "../viewers/session.ts";

/** Reuse the source's tile object and custom loader/cache. Cancellation only
 * detaches this waiter: the viewer owns the tile and its ongoing render work. */
export async function loadTile(
  source: PageObject,
  level: number,
  x: number,
  y: number,
  projection: unknown,
  signal: AbortSignal,
): Promise<ViewerTile> {
  const tile = PageObject.from(source.call("getTile", level, x, y, 1, projection));
  if (!tile) throw new Error("viewer tile is unavailable");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      tile.call("removeEventListener", "change", changed);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      cleanup();
      reject({ kind: "cancelled" });
    };
    const changed = () => {
      const state = tile.call("getState");
      if (state === 2) {
        cleanup();
        resolve();
      } else if (state === 3 || state === 4) {
        cleanup();
        reject({
          kind: "network-failure",
          detail: "OpenLayers tile load failed",
          transport: "browser-session",
        });
      }
    };
    tile.call("addEventListener", "change", changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    try {
      tile.call("load");
      changed();
    } catch (cause) {
      cleanup();
      reject(cause);
    }
  });
  return { image: tile.call("getImage") };
}
