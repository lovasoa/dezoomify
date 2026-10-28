import type { ViewerAdapter, ViewerImage } from "../viewers/adapter.ts";
import { PageObject } from "../viewers/page-object.ts";
import { scanLimits } from "../viewers/scan-state.ts";
import { type LiveViewerSource, viewerImage } from "../viewers/source.ts";
import { loadTile } from "./loader.ts";
import { readPyramid } from "./pyramid.ts";

/** Read public APIs after identifying a real map viewport. No global `ol`, class
 * name, initializer syntax, metadata endpoint or private field layout is needed. */
export const openLayersAdapter: ViewerAdapter = {
  anchors(element) {
    return element.classList.contains("ol-viewport") ? [element, element.parentElement] : [];
  },
  identify(object, access) {
    if (!object.method("getLayers") || !object.method("getView") || !object.method("getViewport"))
      return undefined;
    const viewport = access.element(PageObject.from(object.call("getViewport")));
    return viewport?.classList.contains("ol-viewport") ? viewport : undefined;
  },
  images(map) {
    const layers = collection(map.call("getLayers"));
    const images: ViewerImage[] = [];
    const seen = new Set<object>();
    for (let index = 0; index < layers.length && index < scanLimits.images; index++) {
      const layer = layers[index];
      if (seen.has(layer.identity)) continue;
      seen.add(layer.identity);
      if (layer.method("getLayers")) layers.push(...collection(layer.call("getLayers")));
      if (!layer.method("getSource")) continue;
      const source = PageObject.from(layer.call("getSource"));
      if (!source?.method("getTileGrid") || !source.method("getTile")) continue;
      images.push(viewerImage(source.identity, () => openSource(map, source)));
    }
    return images;
  },
};

function openSource(map: PageObject, source: PageObject): LiveViewerSource {
  const levels = readPyramid(source);
  const view = PageObject.from(map.call("getView"));
  const projection = source.method("getProjection") ? source.call("getProjection") : undefined;
  const fallback = view?.call("getProjection");
  return {
    levels,
    load: (level, x, y, signal) => loadTile(source, level, x, y, projection ?? fallback, signal),
  };
}

function collection(value: unknown): PageObject[] {
  const object = PageObject.from(value);
  const array = object?.call("getArray");
  if (!Array.isArray(array) || array.length > scanLimits.images)
    throw new Error("unsupported viewer layers");
  return array.flatMap((layer) => {
    const object = PageObject.from(layer);
    return object ? [object] : [];
  });
}
