import {
  openTileSource,
  readViewerTile,
  releaseViewerTiles,
} from "../../../../../packages/page-agent/src/openseadragon/session.ts";
import { registerViewer } from "../../../../../packages/page-agent/src/viewers/session.ts";
import { attachViewerTransport } from "../../../src/viewer-transport.ts";

Object.assign(window, {
  TileSession: {
    openTileSource,
    readViewerTile,
    releaseViewerTiles,
    registerViewer,
    attachViewerTransport,
  },
});
