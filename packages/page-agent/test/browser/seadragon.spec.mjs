import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { test } from "../../../../test/browser/fixtures.mjs";
import {
  createSeadragonViewer,
  seadragonLibrary,
  seadragonVersions,
} from "../../../../test/browser/seadragon-fixture.mjs";

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
  if (
    url.pathname.startsWith("/authenticated/") &&
    route.request().headers().authorization !== "Bearer fixture"
  )
    return route.fulfill({ status: 401, body: "Authentication required" });
  if (url.pathname.startsWith("/img/")) return route.fulfill({ status: 404, body: "" });
  if (/^\/(iiif|zoomify|image)\//.test(url.pathname))
    return route.fulfill({ contentType: "image/png", body: ordinaryTile });
  const tilePath =
    url.pathname === "/imageproxy.aspx"
      ? `/tiles/${url.searchParams.get("filename").replace("objectimages/image_files/", "")}`
      : url.pathname;
  const match = tilePath.match(
    /^\/(?:tiles|second|custom|bounds|ajax|multi|authenticated)\/(\d+)\/(\d+)_(\d+)\.png$/,
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
  const source = input.viewer;
  // Read the full-resolution grid and one fractional-size lower level.
  const levels = source.levels.filter((grid) => [8, 10].includes(grid.level));
  for (const grid of levels) {
    for (let row = 0; row < grid.grid_size.height; row++) {
      for (let column = 0; column < grid.grid_size.width; column++) {
        await acquireTile(page, input.url, source, grid, column, row);
      }
    }
  }
}

async function acquireTile(page, sourceUrl, source, grid, column, row) {
  const left = Math.max(0, column * grid.tile_size.width - grid.overlap.width);
  const top = Math.max(0, row * grid.tile_size.height - grid.overlap.height);
  const width =
    Math.min(grid.size.width, (column + 1) * grid.tile_size.width + grid.overlap.width) - left;
  const height =
    Math.min(grid.size.height, (row + 1) * grid.tile_size.height + grid.overlap.height) - top;
  const result = await page.evaluate(
    ({ source, sourceUrl, grid, column, row, width, height }) =>
      Promise.resolve(
        ViewerScanner.readViewerTile(
          { handle: source.handle, source_url: sourceUrl, level: grid.level, column, row },
          { width, height },
        ),
      ).then((value) =>
        value.ok && value.buffer ? { ...value, buffer: [...new Uint8Array(value.buffer)] } : value,
      ),
    { source, sourceUrl, grid, column, row, width, height },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  let pixels;
  if (result.url) {
    const bytes = await page.evaluate(
      async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
      result.url,
    );
    const { data, info } = await sharp(Buffer.from(bytes))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [width, height]);
    pixels = data;
  } else {
    assert.deepEqual([result.width, result.height], [width, height]);
    pixels = Buffer.from(result.buffer);
  }
  assert.equal(pixels.length, width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4)
    assert.deepEqual([...pixels.subarray(offset, offset + 4)], [23, 87, 151, 255]);
}

async function checkObservation(page, runtime, mode) {
  const result = await page.evaluate(() => ViewerScanner.scanViewers());
  if (mode === "image") {
    assert.deepEqual(result.inputs, []);
    assert.deepEqual(result.handles, []);
    assert.deepEqual(result.images, [
      { url: "https://viewer.fixture.test/image/original.png", width: 256, height: 256 },
    ]);
    return;
  }
  assert.equal(
    result.inputs.length,
    expectedImages(runtime, mode),
    JSON.stringify(result.diagnostics),
  );
  const live = result.inputs.filter((input) => input.kind === "observed-viewer");
  if (mode === "authenticated") assert.equal(live.length, 1);
  if (["custom", "expando", "global", "multi", "ajax", "authenticated"].includes(mode)) {
    for (const input of live) await acquireTiles(page, input);
  }
  for (const input of live) {
    await checkSession(page, input, mode);
  }
  for (const input of result.inputs.filter((input) => input.kind === "observed-metadata")) {
    checkMetadata(input, mode);
  }
  assert.equal(await page.evaluate(() => window.viewportUnchanged()), true);
}

async function checkSession(page, input, mode) {
  const source = input.viewer;
  const request = {
    handle: source.handle,
    source_url: input.url,
    level: 10,
    column: 0,
    row: 0,
  };
  if (["failure", "bounds"].includes(mode)) {
    const failed = await page.evaluate(
      (request) => ViewerScanner.readViewerTile(request, { width: 257, height: 257 }),
      request,
    );
    if (failed.url) {
      assert.equal(await page.evaluate(async (url) => (await fetch(url)).status, failed.url), 503);
    } else {
      assert.equal(failed.ok, false);
      assert.equal(failed.error.kind, mode === "bounds" ? "internal" : "network-failure");
    }
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

for (const version of ["5.0.1", "6.1.1"])
  test(`OpenSeadragon ${version}: cropped authenticated JPEG pixels`, async ({
    page,
    loadModule,
  }) => {
    const runtime = seadragonVersions.find((entry) => entry.version === version);
    const size = 257;
    const jpeg = await sharp({
      create: { width: size, height: size, channels: 3, background: "#175797" },
    })
      .composite([
        {
          input: { create: { width: 32, height: size, channels: 3, background: "white" } },
          left: size - 32,
          top: 0,
        },
      ])
      .jpeg()
      .toBuffer();
    await page.route("https://viewer.fixture.test/**", (route) =>
      route.request().isNavigationRequest() ||
      route.request().headers().authorization !== "Bearer fixture"
        ? tileResponse(route)
        : route.fulfill({ contentType: "image/jpeg", body: jpeg }),
    );
    await page.goto("https://viewer.fixture.test/");
    await page.addScriptTag({ content: seadragonLibrary(runtime) });
    await page.evaluate(createSeadragonViewer, { runtime, mode: "authenticated" });
    await loadModule(page);
    const cropped = await page.evaluate(async (size) => {
      const {
        inputs: [input],
        handles,
      } = await ViewerScanner.scanViewers();
      try {
        const request = {
          handle: input.viewer.handle,
          source_url: input.url,
          level: 10,
          column: 0,
          row: 0,
        };
        const original = await ViewerScanner.readViewerTile(request, { width: size, height: size });
        const cropped = await ViewerScanner.readViewerTile(request, {
          width: size - 40,
          height: size,
        });
        if (!original.ok || !cropped.ok || !original.buffer || !cropped.buffer)
          throw new Error(JSON.stringify({ original, cropped }));
        const fullPixels = new Uint8Array(original.buffer);
        const croppedPixels = new Uint8Array(cropped.buffer);
        const stride = cropped.width * 4;
        return {
          width: cropped.width,
          height: cropped.height,
          bytes: croppedPixels.length,
          matches: croppedPixels.every(
            (value, i) =>
              value === fullPixels[Math.floor(i / stride) * original.width * 4 + (i % stride)],
          ),
          differentEdges: croppedPixels[stride - 4] !== fullPixels[original.width * 4 - 4],
        };
      } finally {
        ViewerScanner.releaseViewerTiles(handles);
      }
    }, size);
    assert.deepEqual(cropped, {
      width: size - 40,
      height: size,
      bytes: (size - 40) * size * 4,
      matches: true,
      differentEdges: true,
    });
  });

for (const runtime of seadragonVersions) {
  const modes = ["global", "closure", "custom"];
  if (runtime === seadragonVersions.at(-1)) {
    modes.push(
      "expando",
      "empty",
      "sparse",
      "bounds",
      "failure",
      "multi",
      "iiif",
      "zoomify",
      "image",
      "authenticated",
    );
  }
  // These releases cover the two supported AJAX loader contracts (GET and POST).
  if (runtime.version.startsWith("2.") || runtime === seadragonVersions.at(-1)) modes.push("ajax");
  if (runtime.classic) modes.push("query");
  for (const mode of modes) {
    test(`${runtime.classic ? "Seadragon" : "OpenSeadragon"} ${runtime.version}: ${mode}`, async ({
      page,
      loadModule,
    }) => {
      const requests = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/ajax/")) requests.push(request);
      });
      await page.route("https://viewer.fixture.test/**", tileResponse);
      await page.goto("https://viewer.fixture.test/");
      await page.addScriptTag({ content: seadragonLibrary(runtime) });
      await page.evaluate(createSeadragonViewer, { runtime, mode });
      await loadModule(page);
      await checkObservation(page, runtime, mode);
      if (mode === "ajax") checkAjax(requests, runtime);
    });
  }
}
