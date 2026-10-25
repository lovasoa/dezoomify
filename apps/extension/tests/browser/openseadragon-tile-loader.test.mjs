import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/job/openseadragon/session.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "TileSession",
  target: "es2022",
  define: { "import.meta.url": JSON.stringify(import.meta.url) },
});
const library = readFileSync(
  new URL(import.meta.resolve("openseadragon/build/openseadragon/openseadragon.min.js")),
  "utf8",
);
const tile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));

async function loadFixture(mode) {
  const source = new OpenSeadragon.DziTileSource({
    width: 256,
    height: 256,
    tileSize: 256,
    tileOverlap: 0,
    tilesUrl: "https://tiles.fixture.invalid/tiles/",
    fileFormat: "png",
  });
  source.getTileUrl = function (level, x, y) {
    return () =>
      mode.startsWith("custom")
        ? `cache:${level}/${x}/${y}`
        : `${this.tilesUrl}${level}/${x}_${y}.png?mode=${mode}`;
  };
  source.getTilePostData = () => "image=256&tile=8/0/0";
  source.getTileAjaxHeaders = () => ({ "X-Tile": "256", "X-Override": "tile" });
  const item = {
    _imageLoader: new OpenSeadragon.ImageLoader({ timeout: 1000 }),
    loadTilesWithAjax: mode !== "image",
    ajaxHeaders: { "X-Item": "item", "X-Override": "item" },
    crossOriginPolicy: false,
  };
  let bitmap;
  if (mode.startsWith("custom")) {
    source.downloadTileStart = function (job) {
      if (job.src !== "cache:8/0/0") throw new Error("custom cache token changed");
      const { level, x, y } = job.tile;
      void fetch(`${this.tilesUrl}${level}/${x}_${y}.png?mode=${mode}`, {
        method: "POST",
        body: job.postData,
        headers: job.ajaxHeaders,
      })
        .then(async (response) => {
          const data = await response.blob();
          if (mode === "custom-blob") {
            const frame = document.createElement("iframe");
            document.body.append(frame);
            job.finish(new frame.contentWindow.Blob([data]), null, "rasterBlob");
          } else {
            bitmap = await createImageBitmap(data);
            if (mode === "custom-bitmap") job.finish(bitmap, null, "imageBitmap");
            else {
              const frame = document.createElement("iframe");
              document.body.append(frame);
              const canvas = frame.contentDocument.createElement("canvas");
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              const context = canvas.getContext("2d");
              context.drawImage(bitmap, 0, 0);
              bitmap.close();
              job.finish(context, null, "context2d");
            }
          }
        })
        .catch((error) => job.fail(error));
    };
  } else if (mode === "failure")
    source.downloadTileStart = (job) => job.fail("original tile failure");
  else if (mode === "oversized")
    source.downloadTileStart = (job) =>
      job.finish(new Blob([new Uint8Array(9 * 1024 * 1024)]), null, "rasterBlob");

  const globalKeys = new Set(Reflect.ownKeys(window));
  const metadata = TileSession.registerTileSource(source, item, {
    documentUrl: location.href,
    imageIndex: 0,
  });
  const addedGlobals = Reflect.ownKeys(window)
    .filter((key) => !globalKeys.has(key))
    .map(String);
  const base = JSON.parse(metadata.input.contents).dezoomify_viewer.resource_base;
  const result = await TileSession.readViewerTile(`${base}/8/0/0/256/256.png`, base);
  TileSession.releaseViewerTiles([base]);
  const retired = await TileSession.readViewerTile(`${base}/8/0/0/256/256.png`, base);
  if (retired.ok) throw new Error("retired source still loads tiles");
  if (!result.ok) return result.error;
  const bytes = Uint8Array.fromBase64(result.data);
  const decoded = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement("canvas");
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  decoded.close();
  return {
    width: canvas.width,
    height: canvas.height,
    pixel: [...context.getImageData(0, 0, 1, 1).data],
    bytes: [...bytes],
    closedBitmap: mode !== "custom-bitmap" || bitmap.width === 0,
    addedGlobals,
  };
}

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${name}: existing OpenSeadragon loader returns custom and ordinary tiles`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const requests = [];
      await page.route(/https:\/\/(?:tiles\.)?fixture\.invalid\//, async (route) => {
        const request = route.request();
        if (request.isNavigationRequest())
          return route.fulfill({ contentType: "text/html", body: "<body></body>" });
        requests.push(request);
        return route.fulfill({
          contentType: "image/png",
          body: tile,
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" },
        });
      });
      await page.goto("https://fixture.invalid/");
      await page.addScriptTag({
        content: `(()=>{${library}\nwindow.OpenSeadragon=OpenSeadragon;})()`,
      });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(() => {
        Object.defineProperty(window, "__dezoomifyOpenSeadragon", { value: "page-owned" });
      });
      for (const mode of ["ajax", "image", "custom-context", "custom-bitmap", "custom-blob"]) {
        const result = await page.evaluate(loadFixture, mode);
        assert.deepEqual(
          [result.width, result.height, result.pixel, result.closedBitmap, result.addedGlobals],
          [256, 256, [196, 48, 48, 255], true, []],
          mode,
        );
        if (mode === "ajax" || mode === "custom-blob")
          assert.deepEqual(Buffer.from(result.bytes), tile, `${mode}: preserve encoded bytes`);
        const request = requests.find(
          (request) => new URL(request.url()).searchParams.get("mode") === mode,
        );
        assert.equal(request.method(), mode === "image" ? "GET" : "POST");
        if (mode !== "image") {
          assert.equal(request.postData(), "image=256&tile=8/0/0");
          assert.equal(request.headers()["x-item"], "item");
          assert.equal(request.headers()["x-tile"], "256");
          assert.equal(request.headers()["x-override"], "tile");
        }
      }
      const error = await page.evaluate(loadFixture, "failure");
      assert.equal(error.kind, "network-failure");
      assert.match(error.detail, /original tile failure/);
      assert.equal((await page.evaluate(loadFixture, "oversized")).kind, "size-limit");
      assert.equal(await page.evaluate(() => window.__dezoomifyOpenSeadragon), "page-owned");
    } finally {
      await browser.close();
    }
  });
}
