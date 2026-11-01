import type { ViewerImage } from "../viewers/adapter.ts";
import { address, projectMetadata } from "../viewers/metadata.ts";
import type { PageObject } from "../viewers/page-object.ts";
import { scanLimits } from "../viewers/scan-state.ts";
import { viewerImage } from "../viewers/source.ts";
import { readTileSource } from "./metadata.ts";
import { openTileSource } from "./session.ts";

/** OpenSeadragon 1.x keeps one source on the viewer; 2.x+ keeps sources on
 * world items. Keep each source paired with the object that owns its loader. */
export function openSeadragonImages(viewer: PageObject): ViewerImage[] {
  const world = viewer.reference("world");
  const items = world ? world.objects("_items", scanLimits.images) : [viewer];
  return items.flatMap((item) => {
    const source = item.reference("source");
    return source ? [sourceImage(source, item)] : [];
  });
}

function sourceImage(source: PageObject, owner: PageObject): ViewerImage {
  // ImageTileSource keeps its original URL even when its display pyramid is
  // generated from canvases. Download the original rather than reading pixels.
  if (
    source.string("type") === "image" &&
    !source.has("getTileUrl") &&
    !source.has("downloadTileStart")
  )
    return {
      identity: source.identity,
      read(_context, base) {
        const url = source.string("url");
        const width = source.number("width");
        const height = source.number("height");
        if (!url || !width || !height || source.matches("ready", false))
          throw new Error("image source is not ready");
        return {
          image: {
            url: address(url, base),
            width,
            height,
          },
        };
      },
    };
  return viewerImage(
    source.identity,
    () => openTileSource(source.identity, owner.identity),
    (context, base) => projectMetadata(readTileSource(source, base), context),
  );
}
