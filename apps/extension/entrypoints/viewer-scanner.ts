import { readViewerTile, releaseViewerTiles, scanViewers } from "@dezoomify/page-agent";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { attachViewerTransport } from "../src/viewer-transport";

// A bundled file preserves module imports without page globals or runtime eval.
// The transport must share this injected module instance so it can reach the
// loaders the scan registered.
export default defineUnlistedScript(async () => {
  const result = await scanViewers();
  if (result.handles.length === 0) return result;
  const channelId = crypto.randomUUID();
  attachViewerTransport(channelId, {
    handles: result.handles,
    read: readViewerTile,
    dispose: () => releaseViewerTiles(result.handles),
  });
  return { ...result, channelId };
});
