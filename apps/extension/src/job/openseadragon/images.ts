import type { ViewerImage } from "../viewers/adapter.ts";
import { projectMetadata } from "../viewers/metadata.ts";
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
  return viewerImage(
    source.identity,
    () => openTileSource(source.identity, owner.identity),
    (context, base) => projectMetadata(readTileSource(source, base), context),
  );
}
