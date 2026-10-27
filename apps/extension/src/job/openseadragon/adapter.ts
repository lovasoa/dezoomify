import type { ViewerAdapter } from "../viewers/adapter.ts";
import { createElementProbe, PageAccess } from "../viewers/page-object.ts";
import { scanLimits } from "../viewers/scan-state.ts";
import type { MetadataContext } from "../viewers/types.ts";
import { projectMetadata, readSeadragonSource, readTileSource } from "./metadata.ts";
import { registerTileSource } from "./session.ts";

export const openSeadragonAdapter: ViewerAdapter = {
  identify(object, access) {
    const canvas = access.element(
      object.reference("canvas") ?? object.reference("drawer")?.reference("elmt"),
    );
    const tracker = object.reference("innerTracker") ?? object.reference("tracker");
    if (!canvas || !tracker || !object.truthy("viewport")) return undefined;
    const container = object.reference("container");
    return tracker.matches("element", canvas) ||
      tracker.matches("target", canvas) ||
      (container && tracker.matches("element", container.identity))
      ? canvas
      : undefined;
  },
  images(viewer) {
    const world = viewer.reference("world");
    const items = world ? world.objects("_items", scanLimits.images) : [viewer];
    return items.flatMap((item) => {
      const source = item.reference("source");
      if (!source) return [];
      return [
        {
          identity: source.identity,
          read(context: MetadataContext, base: string) {
            try {
              const snapshot = viewer.has("openDzi")
                ? readSeadragonSource(source, base)
                : readTileSource(source, base);
              return { input: projectMetadata(snapshot, context) };
            } catch {
              return registerTileSource(source.identity, item.identity, context);
            }
          },
        },
      ];
    });
  },
  roots: (root) => {
    const namespace = root.reference("OpenSeadragon");
    return namespace ? [namespace] : [];
  },
  version: (root) =>
    root.reference("OpenSeadragon")?.reference("version")?.boundedString("versionStr", 64),
  registry: (object, realm) => object.mapValues("_viewers", realm),
  async probe(realm, elements, seen, state) {
    const probe = createElementProbe(realm, scanLimits.images);
    if (!probe) return [];
    const access = new PageAccess();
    for (const element of elements) {
      if (state.full()) break;
      if (element.classList.contains("openseadragon-canvas") && !seen.has(element)) {
        state.diagnostics.probes++;
        probe.dispatch(element, (value) => !!openSeadragonAdapter.identify(value, access));
      }
      await state.yieldSlice();
    }
    return probe.captured;
  },
};
