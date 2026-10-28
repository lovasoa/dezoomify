import type { ObservedInput, ViewerLevel } from "@dezoomify/wasm-bindings";
import type { ViewerImage } from "./adapter.ts";
import { registerViewer, type ViewerLoader } from "./session.ts";
import type { MetadataContext } from "./types.ts";

export interface LiveViewerSource {
  levels: ViewerLevel[];
  load: ViewerLoader;
}

/** Describe an identified source without opening a session until read. Prefer
 * detached metadata when available; an unsupported projection falls back to the
 * library's live source. The collector owns deduplication and handle release. */
export function viewerImage(
  identity: object,
  open: () => LiveViewerSource,
  metadata?: (context: MetadataContext, base: string) => ObservedInput,
): ViewerImage {
  return {
    identity,
    read(context, base) {
      if (metadata) {
        try {
          return { input: metadata(context, base) };
        } catch {
          // Source-specific URLs and loaders must retain their native behavior.
        }
      }
      const source = open();
      return registerViewer(source.levels, context, source.load);
    },
  };
}
