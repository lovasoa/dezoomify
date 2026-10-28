import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Early releases predate npm. Their unmodified, compressed distributions live
// beside provenance in corpus/seadragon; newer releases use lockfile pins.
export const seadragonVersions = [
  { version: "0.8.9", classic: true, privateViewer: true },
  { version: "0.9.129", privateViewer: true },
  { version: "1.2.1", needsGlobal: true },
  { version: "2.4.2", package: "openseadragon2", world: true },
  { version: "3.1.0", package: "openseadragon3", world: true },
  { version: "4.1.1", package: "openseadragon4", world: true },
  { version: "5.0.1", package: "openseadragon5", world: true },
  { version: "6.1.1", package: "openseadragon", world: true },
];

export function seadragonLibrary(runtime) {
  const family = runtime.classic ? "seadragon" : "openseadragon";
  const library = runtime.package
    ? readFileSync(
        new URL(import.meta.resolve(`${runtime.package}/build/openseadragon/openseadragon.js`)),
        "utf8",
      )
    : gunzipSync(
        readFileSync(
          new URL(`./corpus/seadragon/${family}-${runtime.version}.js.gz`, import.meta.url),
        ),
      ).toString();
  return runtime.classic ? library : `(()=>{${library}\nwindow.OpenSeadragon=OpenSeadragon;})()`;
}

/** Runs in the page; keep the viewer in a closure except for the chosen path. */
export async function createSeadragonViewer({ runtime, mode }) {
  const library = runtime.classic ? window.Seadragon : window.OpenSeadragon;
  function fixtureSource() {
    if (mode === "iiif")
      return new library.IIIFTileSource({
        "@context": "http://iiif.io/api/image/2/context.json",
        "@id": `${location.origin}/iiif`,
        protocol: "http://iiif.io/api/image",
        profile: ["http://iiif.io/api/image/2/level2.json"],
        width: 513,
        height: 385,
        tiles: [{ width: 256, scaleFactors: [1, 2, 4] }],
      });
    if (mode === "zoomify")
      return new library.ZoomifyTileSource({
        width: 513,
        height: 385,
        tileSize: 256,
        tilesUrl: `${location.origin}/zoomify/`,
        fileFormat: "jpg",
      });
    const base =
      mode === "query"
        ? `${location.origin}/imageproxy.aspx?&filename=objectimages/image_files/`
        : `${location.origin}/tiles/`;
    return new library.DziTileSource(513, 385, 256, 1, base, "png");
  }
  const source = fixtureSource();
  const element = document.getElementById("viewer");
  const viewer = runtime.classic
    ? new library.Viewer(element)
    : library({
        id: "viewer",
        element,
        tileSources: source,
        showNavigationControl: false,
        blendTime: 0,
        loadTilesWithAjax: mode === "ajax",
        ajaxHeaders: { "X-Viewer": "viewer", "X-Override": "viewer" },
      });
  await new Promise((resolve) => {
    if (runtime.classic) {
      viewer.addEventListener("open", resolve);
      viewer.openTileSource(source);
    } else {
      viewer.addHandler("open", resolve);
      if (viewer.isOpen()) resolve();
    }
  });
  if (mode === "multi") {
    await new Promise((resolve) =>
      viewer.addTiledImage({
        tileSource: new library.DziTileSource(
          513,
          385,
          256,
          1,
          `${location.origin}/second/`,
          "png",
        ),
        success: resolve,
      }),
    );
    // A repeated source must not produce a second observation/handle.
    await new Promise((resolve) => viewer.addTiledImage({ tileSource: source, success: resolve }));
  }
  if (["custom", "failure", "bounds", "ajax", "multi"].includes(mode)) {
    source.getTileUrl = (level, x, y) =>
      `${location.origin}/${mode}/${level}/${x}_${y}.png?session=fixture`;
  }
  if (mode === "ajax") {
    source.getTileAjaxHeaders = () => ({ "X-Tile": "tile", "X-Override": "tile" });
    source.getTilePostData = () => "tile=fixture";
  }
  if (mode === "bounds") source.getTileBounds = () => new library.Rect(0, 0, 0.25, 0.25);
  if (mode === "sparse") source.displayRects = [new library.DisplayRect(0, 0, 256, 256, 0, 10)];
  if (mode === "empty") viewer.close();
  if (mode !== "closure") {
    viewer.setMouseNavEnabled(false);
    if (mode === "expando") element.libraryViewer = viewer;
    else window.libraryViewer = viewer;
  }
  const position = () => JSON.stringify([viewer.viewport?.getZoom(), viewer.viewport?.getCenter()]);
  const before = position();
  window.viewportUnchanged = () => position() === before;
  window.getterCalls = 0;
  Object.defineProperty(window, "viewerGetter", {
    get() {
      window.getterCalls++;
      throw new Error("unexpected getter");
    },
  });
  delete window.Seadragon;
  // 1.2.1 itself looks up its global namespace while loading images.
  if (!runtime.needsGlobal) delete window.OpenSeadragon;
}
