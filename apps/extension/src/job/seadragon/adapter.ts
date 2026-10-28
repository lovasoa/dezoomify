import type { ViewerAdapter } from "../viewers/adapter.ts";
import { projectMetadata } from "../viewers/metadata.ts";
import { viewerImage } from "../viewers/source.ts";
import { readSeadragonSource } from "./metadata.ts";
import { openSeadragonSource } from "./session.ts";

/** Original Seadragon Ajax exposes tracker.target and drawer.elmt rather than
 * OpenSeadragon's canvas/innerTracker. Its closure-only viewers cannot be probed
 * through the later library's keyboard handler. */
export const seadragonAdapter: ViewerAdapter = {
  identify(viewer, access) {
    const target = access.element(viewer.reference("tracker")?.reference("target"));
    const drawer = viewer.reference("drawer");
    return target && drawer?.matches("elmt", target) && viewer.truthy("viewport")
      ? target
      : undefined;
  },
  images(viewer) {
    const source = viewer.reference("source");
    return source
      ? [
          viewerImage(
            source.identity,
            () => openSeadragonSource(source),
            (context, base) => projectMetadata(readSeadragonSource(source, base), context),
          ),
        ]
      : [];
  },
  roots(root) {
    const namespace = root.reference("Seadragon");
    return namespace ? [namespace] : [];
  },
};
