import { build } from "esbuild";

/** Bundle pinned real libraries; fixtures never load public CDN resources. */
export async function openLayersLibrary(packageName = "ol") {
  const result = await build({
    stdin: {
      contents: `export {default as Map} from '${packageName}/Map.js';
export {default as View} from '${packageName}/View.js';
export {default as TileLayer} from '${packageName}/layer/Tile.js';
export {default as LayerGroup} from '${packageName}/layer/Group.js';
export {default as IIIF} from '${packageName}/source/IIIF.js';
export {default as Zoomify} from '${packageName}/source/Zoomify.js';
export {default as TileWMS} from '${packageName}/source/TileWMS.js';`,
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "OpenLayersFixture",
    target: "es2022",
  });
  return result.outputFiles[0].text;
}
