import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "../../../../test/browser/fixtures.mjs";

const cases = JSON.parse(
  readFileSync(new URL("../../../../test/browser/corpus/openlayers/cases.json", import.meta.url)),
);
const tile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));
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
      window.corpusFinishLoading = () =>
        new Promise((resolve, reject) => {
          const image = tile.getImage();
          image.addEventListener("load", () => resolve(image.naturalWidth), { once: true });
          image.addEventListener("error", reject, { once: true });
          image.src = `${location.origin}/viewer-cache.png`;
        });
    });
  };
  window.OpenLayersFixture = undefined;
}

for (const runtime of ["ol6", "ol"]) {
  for (const fixture of cases) {
    test(`${runtime}: ${fixture.name}`, async ({ page, loadModule }) => {
      await page.route("https://viewer.fixture.test/**", (route) => {
        if (route.request().isNavigationRequest())
          return route.fulfill({
            contentType: "text/html",
            body: '<div id="viewer" style="width:600px;height:500px"></div>',
          });
        return route.fulfill({ contentType: "image/png", body: tile });
      });
      await page.goto(`https://viewer.fixture.test/${fixture.name}`);
      await loadModule(page, `/test/browser/openlayers-${runtime}.ts`);
      await page.evaluate(createViewer, fixture);
      await loadModule(page);
      const result = await page.evaluate(() => ViewerScanner.scanViewers());
      if (fixture.protocol === "wms") {
        assert.equal(result.inputs.length, 0, "geographic WMS has no finite image pyramid");
        return;
      }
      assert.equal(
        result.inputs.length,
        1,
        `${fixture.name}: ${JSON.stringify(result.diagnostics)}`,
      );
      const observed = result.inputs[0].viewer;
      const largest = observed.levels.at(-1);
      assert.deepEqual(largest.size, { width: fixture.width, height: fixture.height });
      assert.deepEqual(largest.tile_size, {
        width: fixture.tileSize,
        height: fixture.tileSize,
      });
      assert.equal(result.inputs[0].url, page.url());
      const loaded = await page.evaluate(
        async ({ handle, level, size, tileSize }) => {
          const request = { handle, source_url: location.href, level, column: 0, row: 0 };
          const extent = { width: 256, height: 256 };
          const result = await ViewerScanner.readViewerTile(request, extent);
          const x = Math.ceil(size.width / tileSize) - 1;
          const y = Math.ceil(size.height / tileSize) - 1;
          const width = size.width - x * tileSize;
          const height = size.height - y * tileSize;
          const edgeRequest = { ...request, column: x, row: y };
          const dimensions = [];
          const samples = [];
          // A second read must leave the cached drawable usable by its viewer.
          for (let attempt = 0; attempt < 2; attempt++) {
            const edge = await ViewerScanner.readViewerTile(edgeRequest, { width, height });
            if (!edge.ok) throw new Error(JSON.stringify(edge));
            const image = await createImageBitmap(new Blob([edge.buffer]));
            dimensions.push([image.width, image.height]);
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            samples.push([...context.getImageData(0, 0, 1, 1).data]);
            image.close();
          }
          corpusSuspendLoading();
          const pending = ViewerScanner.readViewerTile(request, extent);
          ViewerScanner.releaseViewerTiles([handle]);
          return {
            result,
            dimensions,
            samples,
            cancelled: await pending,
            viewerTileWidth: await corpusFinishLoading(),
            retired: await ViewerScanner.readViewerTile(request, extent),
          };
        },
        {
          handle: observed.handle,
          level: largest.level,
          size: largest.size,
          tileSize: fixture.tileSize,
        },
      );
      assert.equal(loaded.result.ok, true, `${fixture.name}: ${JSON.stringify(loaded.result)}`);
      assert.equal(loaded.retired.ok, false);
      assert.equal(loaded.cancelled.error?.kind, "cancelled");
      assert.equal(
        loaded.viewerTileWidth,
        256,
        "cancelling the download leaves the viewer able to finish loading",
      );
      const edge = [
        ((fixture.width - 1) % fixture.tileSize) + 1,
        ((fixture.height - 1) % fixture.tileSize) + 1,
      ];
      assert.deepEqual(loaded.dimensions, [edge, edge]);
      assert.deepEqual(loaded.samples, [
        [196, 48, 48, 255],
        [196, 48, 48, 255],
      ]);
      assert.equal(await page.evaluate(() => corpusViewportUnchanged()), true);
    });
  }
}
