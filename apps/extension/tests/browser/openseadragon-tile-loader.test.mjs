import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";

const bundle = await build({
  entryPoints: [
    fileURLToPath(new URL("../../src/job/openseadragon/tile-loader.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "TileLoader",
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
    tilesUrl: "https://tiles.fixture.invalid/image/",
    fileFormat: "png",
  });
  source.getTileUrl = function (level, x, y) {
    if (mode.startsWith("custom")) return `cache-token:${level}/${x}/${y}`;
    return `${this.tilesUrl}${level}/${x}_${y}.png?mode=${mode}`;
  };
  source.getTilePostData = function () {
    return `image=${this.width}&tile=8/0/0`;
  };
  source.getTileAjaxHeaders = function () {
    return { "X-Tile": String(this.height), "X-Override": "tile" };
  };
  const item = {
    loadTilesWithAjax: !mode.endsWith("image"),
    ajaxHeaders: { "X-Item": "item", "X-Override": "item" },
    crossOriginPolicy: mode === "legacy-image" ? false : "Anonymous",
    ajaxWithCredentials: false,
  };
  let bitmap;
  if (mode.startsWith("custom")) {
    source.downloadTileStart = async function (job) {
      if (job.src !== "cache-token:8/0/0") throw new Error("custom cache token changed");
      const { level, x, y } = job.tile;
      const response = await fetch(`${this.tilesUrl}${level}/${x}_${y}.png?mode=${mode}`, {
        method: "POST",
        body: job.postData,
        headers: job.ajaxHeaders,
      });
      const data = await response.blob();
      if (mode === "custom-blob") {
        const frame = document.createElement("iframe");
        document.body.append(frame);
        job.finish(new frame.contentWindow.Blob([data]), null, "rasterBlob");
        return;
      }
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
    };
  } else if (mode.startsWith("legacy")) source.downloadTileStart = undefined;
  const blob = await TileLoader.loadOpenSeadragonTile(
    source,
    item,
    8,
    0,
    0,
    new AbortController().signal,
  );
  const decoded = await createImageBitmap(blob);
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
    bytes: [...new Uint8Array(await blob.arrayBuffer())],
    closedBitmap: mode !== "custom-bitmap" || bitmap.width === 0,
  };
}

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${name}: page-native tile loading, cross-realm results and cancellation`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const requests = [];
      await page.route(/https:\/\/(?:tiles\.)?fixture\.invalid\//, async (route) => {
        const request = route.request();
        if (request.isNavigationRequest())
          return route.fulfill({ contentType: "text/html", body: "<body></body>" });
        requests.push({
          url: request.url(),
          method: request.method(),
          body: request.postData(),
          headers: request.headers(),
        });
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
      for (const mode of [
        "ajax-blob",
        "custom-context",
        "custom-bitmap",
        "custom-blob",
        "native-image",
        "legacy-image",
        "legacy-ajax",
      ]) {
        const result = await page.evaluate(loadFixture, mode);
        assert.deepEqual(
          [result.width, result.height, result.pixel, result.closedBitmap],
          [256, 256, [196, 48, 48, 255], true],
          mode,
        );
        if (mode.endsWith("blob") || mode === "legacy-ajax")
          assert.deepEqual(
            Buffer.from(result.bytes),
            tile,
            `${mode}: preserve encoded image bytes`,
          );
        const observed = requests.filter((request) => request.url.includes(`mode=${mode}`));
        assert.equal(observed.length, 1, `${mode}: one load attempt`);
        assert.equal(observed[0].method, mode.endsWith("image") ? "GET" : "POST", mode);
        if (!mode.endsWith("image")) {
          assert.equal(observed[0].body, "image=256&tile=8/0/0", mode);
          assert.equal(observed[0].headers["x-item"], "item", mode);
          assert.equal(observed[0].headers["x-tile"], "256", mode);
          assert.equal(observed[0].headers["x-override"], "tile", mode);
        }
      }
      const cancellations = await page.evaluate(async () => {
        const results = [];
        for (const reason of [
          undefined,
          { kind: "timeout", transport: "browser-session", detail: "source deadline" },
        ]) {
          const controller = new AbortController();
          let job,
            aborted = false;
          const source = {
            downloadTileStart(value) {
              job = value;
            },
            downloadTileAbort(value) {
              aborted = value === job;
            },
          };
          const pending = TileLoader.loadOpenSeadragonTile(
            source,
            {},
            0,
            0,
            0,
            controller.signal,
          ).catch((error) => error);
          controller.abort(reason);
          const error = await pending;
          const canvas = document.createElement("canvas");
          const bitmap = await createImageBitmap(canvas);
          job.finish(bitmap, null, "imageBitmap");
          results.push({ error, aborted, released: bitmap.width === 0 });
        }
        return results;
      });
      assert.deepEqual(cancellations, [
        { error: { kind: "cancelled" }, aborted: true, released: true },
        {
          error: { kind: "timeout", transport: "browser-session", detail: "source deadline" },
          aborted: true,
          released: true,
        },
      ]);
      const encodingCancellation = await page.evaluate(async () => {
        const original = HTMLCanvasElement.prototype.toBlob;
        let release, encoded;
        const ready = new Promise((resolve) => {
          encoded = resolve;
        });
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
          original.call(
            this,
            (blob) => {
              release = () => callback(blob);
              encoded();
            },
            ...args,
          );
        };
        try {
          const controller = new AbortController();
          const bitmap = await createImageBitmap(document.createElement("canvas"));
          let aborted = false,
            settled = false;
          const source = {
            downloadTileStart(job) {
              job.finish(bitmap, null, "imageBitmap");
            },
            downloadTileAbort() {
              aborted = true;
            },
          };
          const pending = TileLoader.loadOpenSeadragonTile(
            source,
            {},
            0,
            0,
            0,
            controller.signal,
          ).catch((error) => {
            settled = true;
            return error;
          });
          await ready;
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const beforeRelease = { aborted, settled, retained: bitmap.width > 0 };
          release();
          const error = await pending;
          return { beforeRelease, error, released: bitmap.width === 0 };
        } finally {
          HTMLCanvasElement.prototype.toBlob = original;
        }
      });
      assert.deepEqual(encodingCancellation, {
        beforeRelease: { aborted: true, settled: false, retained: true },
        error: { kind: "cancelled" },
        released: true,
      });
      const oversized = await page.evaluate(async () => {
        const source = {
          downloadTileStart(job) {
            job.finish(new Blob([new Uint8Array(9 * 1024 * 1024)]));
          },
        };
        return TileLoader.loadOpenSeadragonTile(
          source,
          {},
          0,
          0,
          0,
          new AbortController().signal,
        ).catch((error) => error);
      });
      assert.equal(oversized.kind, "size-limit");
      const invalidResults = await page.evaluate(async () => {
        const controller = new AbortController();
        const failed = await TileLoader.loadOpenSeadragonTile(
          {
            getTileUrl: () => "private-cache-token",
            downloadTileStart(job) {
              job.finish(
                null,
                { status: 503, getResponseHeader: () => "2" },
                "original load failure",
              );
            },
          },
          {},
          0,
          0,
          0,
          controller.signal,
        ).catch((error) => error);
        const tooManyPixels = await TileLoader.loadOpenSeadragonTile(
          {
            downloadTileStart(job) {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 5000;
              job.finish(canvas);
            },
          },
          {},
          0,
          0,
          0,
          controller.signal,
        ).catch((error) => error);
        return { failed, tooManyPixels };
      });
      assert.deepEqual(invalidResults.failed, {
        kind: "http-error",
        status: 503,
        request: "private-cache-token",
        transport: "browser-session",
        detail: "original load failure",
        retry_after_ms: 2000,
      });
      assert.equal(invalidResults.tooManyPixels.kind, "size-limit");
    } finally {
      await browser.close();
    }
  });
}
