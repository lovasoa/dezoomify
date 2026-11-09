import { geometry, readTiledSource } from "../viewers/metadata.ts";
import type { PageObject } from "../viewers/page-object.ts";
import type { TileSource } from "../viewers/types.ts";

/** Call only for a source from an identified, DOM-bound Seadragon viewer. Its
 * tile-address method exposes the base URL hidden in the legacy source closure. */
export function readSeadragonSource(source: PageObject, baseURI: string): TileSource {
  const shape = geometry(source);
  const level = source.number("maxLevel");
  const suffix = `${level}/0_0.${shape.format}`;
  const url = source.call("getTileUrl", level, 0, 0);
  if (typeof url !== "string" || !url.endsWith(suffix))
    throw new Error("unsupported Seadragon address");
  const base = url.slice(0, -suffix.length);
  if (source.call("getTileUrl", 0, 0, 0) !== `${base}0/0_0.${shape.format}`)
    throw new Error("unsupported Seadragon address");
  return readTiledSource(source, shape, baseURI, base);
}
