import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";
import { openLayersLibrary } from "./openlayers-fixture.mjs";

const cases = JSON.parse(readFileSync(new URL("./corpus/openlayers/cases.json", import.meta.url)));
const tile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));
const scanner = (
  await build({
    stdin: {
      contents: `export {scanViewers} from './viewer-scanner.ts';
export {readViewerTile,releaseViewerTiles} from './viewers/session.ts';`,
      resolveDir: new URL("../../src/job", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "ViewerScanner",
    target: "es2022",
    define: { "import.meta.url": JSON.stringify(import.meta.url) },
  })
).outputFiles[0].text;

function createViewer(fixture) {
  const ol = OpenLayersFixture;
  const image = fixture.protocol !== "wms";
  const options = {
    size: [fixture.width, fixture.height],
    tileSize: fixture.tileSize,
    crossOrigin: "Anonymous",
  };
  const source =
    fixture.protocol === "iiif"
      ? new ol.IIIF({
          ...options,
          resolutions: fixture.resolutions,
          version: 2,
          format: "png",
          supports: ["regionByPx", "sizeByW"],
          url: `${location.origin}/iiif`,
        })
      : fixture.protocol === "zoomify"
        ? new ol.Zoomify({ ...options, url: `${location.origin}/zoomify/` })
        : new ol.TileWMS({ url: `${location.origin}/wms`, params: { LAYERS: "maps" } });
  const element = document.getElementById("viewer");
  const map = new ol.Map({
    target: element,
    layers: [
      new ol.LayerGroup({ layers: [new ol.TileLayer({ source }), new ol.TileLayer({ source })] }),
    ],
    view: new ol.View({
      center: image ? [fixture.width / 2, -fixture.height / 2] : [0, 0],
      resolution: image ? 16 : 10000,
    }),
  });
  // Match eMuseum's element data store while hiding the library namespace.
  if (fixture.ownership === "element-data") element.jQueryCorpusData = { map };
  else window.corpusMap = map;
  const position = () => JSON.stringify([map.getView().getCenter(), map.getView().getResolution()]);
  const before = position();
  window.corpusViewportUnchanged = () => before === position();
  window.corpusSuspendLoading = () => {
    source.setTileLoadFunction((tile) => {
      window.corpusPendingTileState = () => tile.getState();
    });
  };
  window.corpusGetterCalls = 0;
  Object.defineProperty(window, "corpusGetter", {
    get() {
      window.corpusGetterCalls++;
      throw new Error("getter executed");
    },
  });
  window.OpenLayersFixture = undefined;
}

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  for (const runtime of ["ol6", "ol"]) {
    test(`${name}: ${runtime} replays the historical OpenLayers issue corpus`, {
      timeout: 120000,
    }, async () => {
      const browser = await engine.launch({ headless: true });
      const library = await openLayersLibrary(runtime);
      try {
        for (const fixture of cases) {
          const page = await browser.newPage();
          const requests = [];
          try {
            await page.route("https://viewer.fixture.test/**", (route) => {
              if (route.request().isNavigationRequest())
                return route.fulfill({
                  contentType: "text/html",
                  body: '<div id="viewer" style="width:600px;height:500px"></div>',
                });
              requests.push(route.request().url());
              return route.fulfill({ contentType: "image/png", body: tile });
            });
            await page.goto(`https://viewer.fixture.test/${fixture.name}`);
            await page.addScriptTag({ content: library });
            await page.evaluate(createViewer, fixture);
            await page.addScriptTag({ content: scanner });
            const result = await page.evaluate(() => ViewerScanner.scanViewers(Date.now() + 1500));
            if (fixture.protocol === "wms") {
              assert.equal(result.inputs.length, 0, "geographic WMS has no finite image pyramid");
              continue;
            }
            assert.equal(
              result.inputs.length,
              1,
              `${fixture.name}: ${JSON.stringify(result.diagnostics)}`,
            );
            const observed = JSON.parse(result.inputs[0].contents).dezoomify_viewer;
            const largest = observed.levels.at(-1);
            assert.deepEqual(largest.size, { width: fixture.width, height: fixture.height });
            assert.deepEqual(largest.tile_size, {
              width: fixture.tileSize,
              height: fixture.tileSize,
            });
            assert.equal(observed.source_url, page.url());
            assert.deepEqual(result.resources, [observed.resource_base]);
            const loaded = await page.evaluate(
              async ({ base, level, size, tileSize }) => {
                const result = await ViewerScanner.readViewerTile(
                  `${base}/${level}/0/0/256/256.png`,
                  base,
                );
                const x = Math.ceil(size.width / tileSize) - 1;
                const y = Math.ceil(size.height / tileSize) - 1;
                const width = size.width - x * tileSize;
                const height = size.height - y * tileSize;
                const edgeUrl = `${base}/${level}/${x}/${y}/${width}/${height}.png`;
                const dimensions = [];
                // A second read must leave the cached drawable usable by its viewer.
                for (let attempt = 0; attempt < 2; attempt++) {
                  const edge = await ViewerScanner.readViewerTile(edgeUrl, base);
                  if (!edge.ok) throw new Error(JSON.stringify(edge));
                  const image = await createImageBitmap(
                    new Blob([Uint8Array.fromBase64(edge.data)]),
                  );
                  dimensions.push([image.width, image.height]);
                  image.close();
                }
                corpusSuspendLoading();
                const pending = ViewerScanner.readViewerTile(
                  `${base}/${level}/0/0/256/256.png`,
                  base,
                );
                ViewerScanner.releaseViewerTiles([base]);
                return {
                  result,
                  dimensions,
                  cancelled: await pending,
                  tileState: corpusPendingTileState(),
                  retired: await ViewerScanner.readViewerTile(
                    `${base}/${level}/0/0/256/256.png`,
                    base,
                  ),
                };
              },
              {
                base: observed.resource_base,
                level: largest.level,
                size: largest.size,
                tileSize: fixture.tileSize,
              },
            );
            assert.equal(
              loaded.result.ok,
              true,
              `${fixture.name}: ${JSON.stringify(loaded.result)}`,
            );
            assert.equal(loaded.retired.ok, false);
            assert.equal(loaded.cancelled.error?.kind, "cancelled");
            assert.equal(loaded.tileState, 1, "retirement leaves the viewer's tile loading");
            const edge = [
              ((fixture.width - 1) % fixture.tileSize) + 1,
              ((fixture.height - 1) % fixture.tileSize) + 1,
            ];
            assert.deepEqual(loaded.dimensions, [edge, edge]);
            assert.ok(
              requests.some((url) =>
                url.includes(fixture.protocol === "iiif" ? "/iiif/" : "/zoomify/TileGroup"),
              ),
            );
            assert.deepEqual(
              await page.evaluate(() => ({
                viewport: corpusViewportUnchanged(),
                getters: corpusGetterCalls,
              })),
              { viewport: true, getters: 0 },
            );
          } finally {
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
    });
  }
}
