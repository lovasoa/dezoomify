import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";
import sharp from "sharp";
import {
  createSeadragonViewer,
  seadragonLibrary,
  seadragonVersions,
} from "./seadragon-fixture.mjs";

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
const ordinaryTile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));

// Non-power-of-two dimensions, overlap and edge tiles exercise actual geometry.
async function tileResponse(route) {
  const url = new URL(route.request().url());
  if (route.request().isNavigationRequest())
    return route.fulfill({
      contentType: "text/html",
      body: '<div id="viewer" style="width:800px;height:600px"></div>',
    });
  if (url.pathname.startsWith("/failure/"))
    return route.fulfill({ status: 503, body: "tile failure" });
  if (url.pathname.startsWith("/img/")) return route.fulfill({ status: 404, body: "" });
  if (/^\/(iiif|zoomify)\//.test(url.pathname))
    return route.fulfill({ contentType: "image/png", body: ordinaryTile });
  const tilePath =
    url.pathname === "/imageproxy.aspx"
      ? `/tiles/${url.searchParams.get("filename").replace("objectimages/image_files/", "")}`
      : url.pathname;
  const match = tilePath.match(
    /^\/(?:tiles|second|custom|bounds|ajax|multi)\/(\d+)\/(\d+)_(\d+)\.png$/,
  );
  if (!match) throw new Error(`Unexpected fixture request: ${url}`);
  const [, level, x, y] = match.map(Number);
  const size = {
    width: Math.ceil(513 * 2 ** (level - 10)),
    height: Math.ceil(385 * 2 ** (level - 10)),
  };
  const left = Math.max(0, x * 256 - 1);
  const top = Math.max(0, y * 256 - 1);
  const width = Math.min(size.width, (x + 1) * 256 + 1) - left;
  const height = Math.min(size.height, (y + 1) * 256 + 1) - top;
  const body = await sharp({
    create: { width, height, channels: 4, background: { r: 23, g: 87, b: 151, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return route.fulfill({
    contentType: "image/png",
    body,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

async function acquireTiles(page, input) {
  const source = JSON.parse(input.contents).dezoomify_viewer;
  // Read the full-resolution grid and one fractional-size lower level.
  const levels = source.levels.filter((grid) => [8, 10].includes(grid.level));
  for (const grid of levels) {
    for (let row = 0; row < grid.grid_size.height; row++) {
      for (let column = 0; column < grid.grid_size.width; column++) {
        await acquireTile(page, source, grid, column, row);
      }
    }
  }
}

async function acquireTile(page, source, grid, column, row) {
  const left = Math.max(0, column * grid.tile_size.width - grid.overlap.width);
  const top = Math.max(0, row * grid.tile_size.height - grid.overlap.height);
  const width =
    Math.min(grid.size.width, (column + 1) * grid.tile_size.width + grid.overlap.width) - left;
  const height =
    Math.min(grid.size.height, (row + 1) * grid.tile_size.height + grid.overlap.height) - top;
  const result = await page.evaluate(
    ({ source, grid, column, row, width, height }) =>
      ViewerScanner.readViewerTile(
        { handle: source.handle, source_url: source.source_url, level: grid.level, column, row },
        { width, height },
      ),
    { source, grid, column, row, width, height },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const decoded = await sharp(Buffer.from(result.data, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual([decoded.info.width, decoded.info.height], [width, height]);
  for (let offset = 0; offset < decoded.data.length; offset += 4)
    assert.deepEqual([...decoded.data.subarray(offset, offset + 4)], [23, 87, 151, 255]);
}

async function checkObservation(page, runtime, mode) {
  const result = await page.evaluate(() => ViewerScanner.scanViewers());
  assert.equal(
    result.inputs.length,
    expectedImages(runtime, mode),
    JSON.stringify(result.diagnostics),
  );
  if (mode !== "multi") {
    const kind = ["custom", "failure", "bounds", "ajax"].includes(mode)
      ? "observed-viewer"
      : "observed-metadata";
    for (const input of result.inputs) assert.equal(input.kind, kind);
  }
  const live = result.inputs.filter((input) => input.kind === "observed-viewer");
  if (["custom", "expando", "global", "multi", "ajax"].includes(mode)) {
    for (const input of live) await acquireTiles(page, input);
  }
  for (const input of live) {
    await checkSession(page, input, mode);
  }
  for (const input of result.inputs.filter((input) => input.kind === "observed-metadata")) {
    checkMetadata(input, mode);
  }
  assert.deepEqual(await page.evaluate(() => [window.getterCalls, window.viewportUnchanged()]), [
    0,
    true,
  ]);
}

async function checkSession(page, input, mode) {
  const source = JSON.parse(input.contents).dezoomify_viewer;
  const request = {
    handle: source.handle,
    source_url: source.source_url,
    level: 10,
    column: 0,
    row: 0,
  };
  if (["failure", "bounds"].includes(mode)) {
    const failed = await page.evaluate(
      (request) => ViewerScanner.readViewerTile(request, { width: 257, height: 257 }),
      request,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.error.kind, mode === "bounds" ? "internal" : "network-failure");
  }
  await page.evaluate((handle) => ViewerScanner.releaseViewerTiles([handle]), source.handle);
  const retired = await page.evaluate(
    (request) => ViewerScanner.readViewerTile(request, { width: 257, height: 257 }),
    request,
  );
  assert.equal(retired.error.blocked_reason, "source-document-lost");
}

function checkMetadata(input, mode) {
  if (mode === "zoomify") {
    assert.match(input.contents, /WIDTH="513" HEIGHT="385"/);
    assert.match(input.url, /\/zoomify\/ImageProperties.xml$/);
  } else if (mode === "iiif") {
    const metadata = JSON.parse(input.contents);
    assert.deepEqual([metadata.width, metadata.height], [513, 385]);
    assert.deepEqual(metadata.tiles, [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]);
  } else {
    const image = JSON.parse(input.contents).Image;
    assert.deepEqual(image.Size, { Width: 513, Height: 385 });
    if (mode === "query")
      assert.equal(
        image.Url,
        "https://viewer.fixture.test/imageproxy.aspx?&filename=objectimages/image_files/",
      );
  }
}

function checkAjax(requests, runtime) {
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.headers()["x-viewer"], "viewer");
    assert.equal(request.headers()["x-tile"], "tile");
    assert.equal(request.headers()["x-override"], "tile");
    // POST data was added after the 2.x loader API.
    assert.equal(request.method(), runtime.version.startsWith("2.") ? "GET" : "POST");
    if (request.method() === "POST") assert.equal(request.postData(), "tile=fixture");
  }
}

function expectedImages(runtime, mode) {
  if (["empty", "sparse"].includes(mode)) return 0;
  if (mode === "closure" && runtime.privateViewer) return 0;
  if (mode === "bounds" && !runtime.classic) return 0;
  return mode === "multi" ? 2 : 1;
}

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${name}: real Seadragon and OpenSeadragon release matrix`, {
    timeout: 180000,
  }, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const runtime of seadragonVersions) {
        const modes = [
          "global",
          "expando",
          "closure",
          "custom",
          "empty",
          "sparse",
          "bounds",
          "failure",
        ];
        if (runtime.world) modes.push("multi", "ajax", "iiif", "zoomify");
        if (runtime.classic) modes.push("query");
        for (const mode of modes)
          await t.test(
            `${runtime.classic ? "Seadragon" : "OpenSeadragon"} ${runtime.version}: ${mode}`,
            async () => {
              const page = await browser.newPage();
              const requests = [];
              page.on("request", (request) => {
                if (new URL(request.url()).pathname.startsWith("/ajax/")) requests.push(request);
              });
              try {
                await page.route("https://viewer.fixture.test/**", tileResponse);
                await page.goto("https://viewer.fixture.test/");
                await page.addScriptTag({ content: seadragonLibrary(runtime) });
                await page.evaluate(createSeadragonViewer, { runtime, mode });
                await page.addScriptTag({ content: scanner });
                await checkObservation(page, runtime, mode);
                if (mode === "ajax") checkAjax(requests, runtime);
              } finally {
                await page.close();
              }
            },
          );
      }
    } finally {
      await browser.close();
    }
  });
}
