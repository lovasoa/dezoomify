import assert from "node:assert/strict";
import sharp from "sharp";
import { test } from "../../../../test/browser/fixtures.mjs";
import {
  seadragonLibrary,
  seadragonVersions,
} from "../../../../test/browser/seadragon-fixture.mjs";

const jpeg = await sharp({
  create: { width: 256, height: 256, channels: 3, background: "#c43030" },
})
  .jpeg()
  .toBuffer();
const pageUrl = "https://viewer.fixture.test/";

async function openViewer(page, loadModule, runtime, credentials) {
  await page.goto(pageUrl);
  await page.addScriptTag({ content: seadragonLibrary(runtime) });
  await page.evaluate(async (credentials) => {
    const library = window.OpenSeadragon;
    const source = new library.DziTileSource(
      512,
      512,
      256,
      0,
      credentials === null ? "/tiles/" : "https://tiles.fixture.test/tiles/",
      "jpg",
    );
    source.getTileAjaxHeaders = () => ({ "X-Override": "tile", "X-Clear": "" });
    const viewer = library({
      id: "viewer",
      tileSources: source,
      showNavigationControl: false,
      loadTilesWithAjax: true,
      ajaxWithCredentials: credentials === true,
      ajaxHeaders: { Authorization: "Bearer fixture", "X-Override": "item", "X-Clear": "item" },
    });
    window.libraryViewer = viewer;
    await new Promise((resolve) => {
      viewer.addHandler("open", resolve);
      if (viewer.isOpen()) resolve();
    });
    viewer.setMouseNavEnabled(false);
    delete window.OpenSeadragon;
  }, credentials);
  await loadModule(page);
  const input = await page.evaluate(async () => (await ViewerScanner.scanViewers()).inputs[0]);
  assert.equal(input.kind, "observed-viewer");
  return input;
}

async function readTile(page, input) {
  return page.evaluate(async (input) => {
    const result = await ViewerScanner.readViewerTile(
      {
        handle: input.viewer.handle,
        source_url: input.url,
        level: 9,
        column: 0,
        row: 0,
      },
      { width: 256, height: 256 },
    );
    return result.ok && "buffer" in result
      ? { ok: true, bytes: [...new Uint8Array(result.buffer)] }
      : result;
  }, input);
}

for (const runtime of seadragonVersions.filter((runtime) => runtime.world)) {
  const credentialsCases = runtime === seadragonVersions.at(-1) ? [null, false, true] : [null];
  for (const credentials of credentialsCases) {
    test(`OpenSeadragon ${runtime.version}: encoded AJAX GET, credentials=${credentials}`, async ({
      page,
      context,
      loadModule,
    }) => {
      await context.addCookies([
        { name: "session", value: "fixture", url: pageUrl },
        { name: "session", value: "fixture", url: "https://tiles.fixture.test/" },
      ]);
      let failure;
      await page.route("https://*.fixture.test/**", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest())
          return route.fulfill({
            contentType: "text/html",
            body: '<div id="viewer" style="width:512px;height:512px"></div>',
          });
        const headers = {
          "Access-Control-Allow-Origin": new URL(pageUrl).origin,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Headers": "Authorization, X-Override, X-Clear",
          "Access-Control-Expose-Headers": "Retry-After",
          "Cache-Control": "no-store",
        };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        const received = await request.allHeaders();
        assert.equal(received.authorization, "Bearer fixture");
        assert.equal(received["x-override"], "tile");
        assert.equal(received["x-clear"], undefined);
        assert.equal(received.cookie, credentials === false ? undefined : "session=fixture");
        if (failure === "http")
          return route.fulfill({
            status: 503,
            headers: { ...headers, "Retry-After": "2" },
            body: "Unavailable",
          });
        if (failure === "size")
          return route.fulfill({ headers, body: Buffer.alloc(8 * 1024 * 1024 + 1) });
        return route.fulfill({ contentType: "image/jpeg", headers, body: jpeg });
      });
      const input = await openViewer(page, loadModule, runtime, credentials);
      try {
        const result = await readTile(page, input);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(Buffer.from(result.bytes), jpeg, "retain the original JPEG encoding");
        failure = "http";
        const http = await readTile(page, input);
        assert.equal(http.error.kind, "http-error");
        assert.equal(http.error.status, 503);
        assert.equal(http.error.retry_after_ms, 2000);
        failure = "size";
        assert.equal((await readTile(page, input)).error.kind, "size-limit");
      } finally {
        await page.evaluate(
          (handle) => ViewerScanner.releaseViewerTiles([handle]),
          input.viewer.handle,
        );
      }
    });
  }
}

test("releasing an AJAX source cancels a pending tile read", async ({ page, loadModule }) => {
  let arrived;
  const requested = new Promise((resolve) => {
    arrived = resolve;
  });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let finished;
  let requestSeen = false;
  const settled = new Promise((resolve) => {
    finished = resolve;
  });
  await page.route("https://viewer.fixture.test/**", async (route) => {
    if (route.request().isNavigationRequest())
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="viewer" style="width:512px;height:512px"></div>',
      });
    if (new URL(route.request().url()).pathname === "/pending") {
      requestSeen = true;
      arrived();
      await released;
      await route.fulfill({ contentType: "image/jpeg", body: jpeg }).catch(() => {});
      finished();
      return;
    }
    return route.fulfill({ contentType: "image/jpeg", body: jpeg });
  });
  let input;
  try {
    input = await openViewer(page, loadModule, seadragonVersions.at(-1), null);
    await page.evaluate((input) => {
      window.libraryViewer.world._items[0].source.getTileUrl = () => "/pending";
      window.pendingTile = ViewerScanner.readViewerTile(
        {
          handle: input.viewer.handle,
          source_url: input.url,
          level: 9,
          column: 0,
          row: 0,
        },
        { width: 256, height: 256 },
      );
    }, input);
    await requested;
    await page.evaluate(
      (handle) => ViewerScanner.releaseViewerTiles([handle]),
      input.viewer.handle,
    );
    const result = await page.evaluate(() => window.pendingTile);
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, "cancelled");
  } finally {
    release();
    if (input)
      await page.evaluate(
        (handle) => ViewerScanner.releaseViewerTiles([handle]),
        input.viewer.handle,
      );
    if (requestSeen) await settled;
  }
});
