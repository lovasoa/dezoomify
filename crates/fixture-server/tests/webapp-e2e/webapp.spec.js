// Real-webapp E2E (Chromium): open the actual website served on loopback,
// paste a fixture-server zoomable image URL, let the shared async WASM function
// discover and download the tiles, then save real bytes and verify the PNG.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {
  assertSavedPyramid,
  decodePngPixels,
  decodePngSize,
  pixelAt,
} = require("../../../../test/support/png.mjs");

const ADDR = process.env.DEZOOMIFY_E2E_ADDR;
const { formats } = require("../../../../test/support/formats.cjs");

for (const fixture of formats) {
  test(`website saves ${fixture.name} pixels`, async ({ page }) => {
    await page.goto(`${ADDR}/beta/`);
    await page.locator("#dz-url-input").fill(ADDR + fixture.input);
    await page.getByRole("button", { name: /find image/i }).click();
    await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 30000 });
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save image" }).click();
    assertSavedPyramid(fs.readFileSync(await (await pending).path()), 2);
  });
}

test("webapp discovers, downloads, assembles, and saves a real DZI pyramid", async ({ page }) => {
  // Hold tile responses long enough to observe the acquisition state: the
  // canvas is the live output surface, visible before those responses complete.
  await page.route((url) => url.href.includes("pyramid_files"), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  // website/direct-success: metadata goes direct, the proxy stays unused;
  // the save proves the canvas is origin-clean (tainted cannot export).
  const golden = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../../testdata/scenarios/website/direct-success/expected/result.json"),
      "utf8",
    ),
  );
  const attempts = [];
  let proxyRequests = 0;
  await page.route("**/api/proxy", (route) => {
    if (route.request().method() === "POST") proxyRequests += 1;
    route.continue();
  });
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  const input = page.locator("#dz-url-input");
  await expect(input).toBeVisible();
  const url = `${ADDR}/fetch?url=https://fixtures.test/cli/pyramid.dzi`;
  await page.route((requestUrl) => requestUrl.href === url, (route) => {
    attempts.push("direct");
    route.continue();
  });
  await input.fill(url);

  await page.getByRole("button", { name: /find image/i }).click();

  const canvas = page.locator("#rendering-canvas");
  await expect(canvas).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".dz-completed-section")).toHaveCount(0);
  assert.deepEqual(
    await canvas.evaluate((el) => ({ width: el.width, height: el.height })),
    { width: 512, height: 512 },
    "the declared preview surface is present while tiles are still in flight",
  );

  // The pipeline must reach the completed state with real dimensions.
  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  await expect(page.locator(".dz-completed-section")).toContainText(/512/);
  const report = await page.locator("#dz-job-diagnostics").textContent();
  assert.match(report, /presented_phase: completed/);
  assert.match(report, /first_tile.url: .*pyramid_files/);
  // Tiles paint live during acquisition, so the assembled
  // picture stays visible next to the save button on the clean path too.
  await expect(canvas).toBeVisible();
  assert.deepEqual(
    await canvas.evaluate((el) => ({ width: el.width, height: el.height })),
    { width: 512, height: 512 },
  );

  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Save image" }).click();
  const download = await downloadPromise;
  const tmp = path.join(__dirname, "downloads");
  fs.mkdirSync(tmp, { recursive: true });
  const target = path.join(tmp, `saved-${Date.now()}.png`);
  await download.saveAs(target);
  const bytes = fs.readFileSync(target);
  assertSavedPyramid(bytes);

  // website/direct-success: one direct metadata attempt, zero proxy requests.
  assert.deepEqual(attempts, golden.attempts, "website/direct-success attempts");
  assert.equal(proxyRequests, golden.proxyRequests, "website/direct-success proxyRequests");
  assert.equal(golden.originClean, true, "website/direct-success originClean (save exported bytes)");
});

test("webapp fails honestly on a page without a zoomable signal", async ({ page }) => {
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  const input = page.locator("#dz-url-input");
  await expect(input).toBeVisible();
  const url = `${ADDR}/fetch?url=https://fixtures.test/cli/plain.html`;
  await input.fill(url);
  await page.getByRole("button", { name: /find image/i }).click();
  await expect(page.locator(".dz-error-section")).toBeVisible({ timeout: 30000 });
  const body = await page.locator("#app").innerText();
  assert.match(body, /No zoomable image was found/i);
  await page.getByRole("button", { name: "Start over" }).click();
  await input.fill("view-source:https://www.britishmuseum.org/collection/example");
  await page.getByRole("button", { name: /find image/i }).click();
  const report = await page.locator("#dz-job-diagnostics").textContent();
  assert.match(report, /input: view-source:https:\/\/www.britishmuseum.org/);
  assert.match(report, /kind=invalid-url/);
});

const fzpGolden = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../../../testdata/scenarios/formats/fzp/expected/result.json"), "utf8",
));
test("FreezoomPack computed Lime paths discover an index and save browser pixels", async ({ page }) => {
  await page.route("**/fzp/views/reported.html?*", (route) => route.fulfill({
    contentType: "text/html",
    body: `<script src="../limescripts/lime.js"></script><script>lime('reported','xml');</script>`,
  }));
  await page.route("**/fzp/limescripts/lime.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `var lime_depth = limeGetScriptDepth();
      jime_vars.ResourcePath = lime_depth['dir'] + "resources/";
      jime_vars.IndexPath = lime_depth['dir'] + "xmls/";`,
  }));
  await page.route("**/fzp/xmls/reported.xml", (route) => route.fulfill({
    contentType: "application/xml",
    body: `<item title="Reported viewer"><item resource="floor" ext="fzp" label="1/1"/></item>`,
  }));
  await page.goto(`${ADDR}/beta/`, { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(`${ADDR}/fzp/views/reported.html?l=1&amp;n=6`);
  await page.getByRole("button", { name: /find image/i }).click();
  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save image" }).click();
  const decoded = decodePngPixels(fs.readFileSync(await (await pending).path()));
  const golden = fzpGolden.floor.find((level) => level.level === 0);
  assert.equal(decoded.width, golden.width);
  assert.equal(decoded.height, golden.height);
  golden.gray_pixels.forEach((gray, index) => {
    assert.deepEqual([...decoded.pixels.subarray(index * decoded.bpp, index * decoded.bpp + 3)], [gray, gray, gray]);
  });
});
for (const [profile, levels] of Object.entries(fzpGolden)) {
  for (const golden of levels) {
    test(`FreezoomPack ${profile} level ${golden.level} saves pixels matching native output`, async ({ page }) => {
      const requests = [];
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith(`/fzp/resources/${profile}/`) && pathname.endsWith(".jpg")) {
          requests.push(pathname);
        }
      });
      if (golden.level === 1) {
        // Expose just the stored reduced level to the product's automatic picker.
        await page.route(`**/fzp/resources/${profile}/root.xml`, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: (await response.text()).replace('min="0"', 'min="1"') });
        });
      }
      await page.goto(`${ADDR}/beta/`, { waitUntil: "networkidle" });
      await page.locator("#dz-url-input").fill(`${ADDR}/fzp/resources/${profile}/root.xml`);
      await page.getByRole("button", { name: /find image/i }).click();
      await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
      assert.deepEqual(requests.sort(), [...golden.requests].sort());
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: "Save image" }).click();
      const download = await pending;
      const bytes = fs.readFileSync(await download.path());
      const decoded = decodePngPixels(bytes);
      assert.equal(decoded.width, golden.width);
      assert.equal(decoded.height, golden.height);
      golden.gray_pixels.forEach((gray, index) => {
        assert.deepEqual([...decoded.pixels.subarray(index * decoded.bpp, index * decoded.bpp + 3)], [gray, gray, gray]);
      });
    });
  }
}

const FAILED_METADATA_URL = "https://fixtures.test/errors/info.json";

test("metadata proxy failure reaches the error UI with its complete typed context", async ({ page }) => {
  let proxyPosts = 0;
  await page.route((url) => url.href === FAILED_METADATA_URL, (route) => route.abort());
  await page.route("**/api/proxy", (route) => {
    if (route.request().method() === "POST") proxyPosts += 1;
    route.fulfill({
      status: 406,
      contentType: "application/json",
      headers: { "x-request-id": "proxy-example" },
      body: JSON.stringify({ code: "TRANSPORT_HTTP_ERROR", preview: "Cloudflare challenge" }),
    });
  });
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(FAILED_METADATA_URL);
  await page.getByRole("button", { name: /find image/i }).click();
  await expect(page.locator(".dz-error-section")).toBeVisible({ timeout: 30000 });
  assert.equal(proxyPosts, 1, "the failed direct metadata request falls back exactly once");

  const diagnostics = await page.locator("#dz-job-diagnostics").textContent();
  assert.ok(diagnostics);
  assert.match(diagnostics, /code=TRANSPORT_HTTP_ERROR\b/);
  assert.match(diagnostics, /kind=http-error\b/);
  assert.match(diagnostics, /transport=metadata-proxy\b/);
  assert.match(diagnostics, /status=406\b/);
  assert.match(diagnostics, /proxy-example/);
  assert.match(diagnostics, /Cloudflare challenge/);
  assert.doesNotMatch(diagnostics, /binding\.invalid-value/);
  await expect(page.locator("#app")).toContainText(/The site refused to share this file \(HTTP 406\)/i);
});

// Production topology of a Google Arts & Culture asset page: the page is
// not CORS-readable (direct fetch fails) while tile-info and signed,
// AES-CBC-encrypted tiles are; the metadata proxy relays the page.
const ARTS_PAGE_URL = "https://artsandculture.google.com/asset/liza-kottou-0113.html";

test("webapp downloads a Google Arts & Culture image through the metadata proxy", async ({ page }) => {
  // The asset page is not CORS-readable: the direct fetch fails like in
  // production, so discovery must fall back to the metadata proxy.
  await page.route((url) => url.href === ARTS_PAGE_URL, (route) => route.abort());

  // Test double of the /api/proxy Pages Function (always relays as GET).
  const proxyTargets = [];
  const relayToFixture = async (route, targetUrl) => {
    const response = await route.fetch({
      url: `${ADDR}/proxy?url=${encodeURIComponent(targetUrl)}`,
      method: "GET",
    });
    await route.fulfill({ response });
  };
  await page.route("**/api/proxy", async (route) => {
    const body = route.request().postDataJSON();
    proxyTargets.push(body.targetUrl);
    await relayToFixture(route, body.targetUrl);
  });

  // fixtures.test never resolves (RFC 2606): metadata takes the proxy
  // fallback while this interception stands in for direct tile egress.
  await page.route(
    (url) => url.host === "fixtures.test" && url.pathname.startsWith("/arts/gap/path=x"),
    async (route) => {
      await relayToFixture(route, route.request().url());
    },
  );

  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(ARTS_PAGE_URL);
  await page.getByRole("button", { name: /find image/i }).click();

  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Save image" }).click();
  const download = await downloadPromise;
  const target = path.join(__dirname, "downloads", `arts-${Date.now()}.png`);
  await download.saveAs(target);
  const bytes = fs.readFileSync(target);
  const { width, height } = decodePngSize(bytes);
  assert.equal(width, 100, "saved image width clips the padded final column");
  assert.equal(height, 50, "saved image height clips the padded final row");
  // The final signed tile decrypts (in wasm) to a full 64×64 PNG whose
  // useful 36×50 region is red and whose right/bottom padding is black.
  // Nonzero empty_pels metadata pins 1:1 cropping: scaling the full decoded
  // tile into the planned extent would pull black padding into these sampled
  // output pixels. Two tiles also pin concurrent downloads plus serialized
  // worker-side decrypt processing.
  const decoded = decodePngPixels(bytes);
  for (const [x, y] of [[0, 0], [63, 0], [64, 32], [99, 49], [0, 49], [99, 0]]) {
    assert.deepEqual(pixelAt(decoded, x, y), [200, 48, 48, 255], `solid tile color at ${x},${y}`);
  }
  assert.ok(
    proxyTargets.includes(ARTS_PAGE_URL),
    "the asset page must have been fetched through the metadata proxy",
  );
});

// Tile host without a CORS grant (the krpano galleria case): readable
// fetch() calls for tiles fail, while plain <img> loads succeed. The app
// must paint the tiles as ordinary display and finish display-only:
// visible picture with right-click guidance, no TILE_FAILED, no save.
test("webapp displays CORS-blocked ordinary tiles instead of failing", async ({ page }) => {
  // The DZI tile base derives from the fetched metadata URL, so tile
  // fetches are same-origin /fetch URLs here; matching on the tile path
  // (not the host) aborts exactly the readable tile fetches while plain
  // <img> loads for the same URLs succeed.
  let readableRequests = 0;
  let imageRequests = 0;
  await page.route(
    (url) => url.href.includes("pyramid_files"),
    async (route) => {
      if (route.request().resourceType() === "image") {
        imageRequests += 1;
        await route.continue();
      } else {
        readableRequests += 1;
        await route.abort();
      }
    },
  );
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  const url = `${ADDR}/fetch?url=https://fixtures.test/cli/pyramid.dzi`;
  await page.locator("#dz-url-input").fill(url);
  await page.getByRole("button", { name: /find image/i }).click();

  await expect(page.locator(".dz-notice-section")).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("heading", { name: /Showing preview/i })).toBeVisible();
  await expect(page.getByText(/right-click/i)).toBeVisible();
  await expect(page.locator(".dz-error-section")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save image" })).toHaveCount(0);
  const canvas = page.locator("#rendering-canvas");
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el) => ({ width: el.width, height: el.height }));
  assert.equal(size.width, 512, "displayed image width");
  assert.equal(size.height, 512, "displayed image height");
  assert.equal(readableRequests, 1, "one tile classifies the CORS policy for the origin");
  assert.ok(imageRequests > 1, "later tiles load directly as ordinary images");
});

// IIIF Presentation manifests name an image service rather than a plan. The
// catalog surfaces that entry as an ImageRequest to the service info.json,
// which the website follows with a fresh bounded attempt before it can plan
// and download the tiles. Nothing here is stubbed beyond the fixtures.test
// host being relayed to the deterministic fixture server.
test("webapp follows a deferred IIIF manifest request to the info.json and tiles", async ({ page }) => {
  await page.route(
    (url) => url.host === "fixtures.test",
    async (route) => {
      const response = await route.fetch({
        url: `${ADDR}/fetch?url=${encodeURIComponent(route.request().url())}`,
        method: "GET",
      });
      await route.fulfill({ response });
    },
  );
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  const manifest = `${ADDR}/fetch?url=https://fixtures.test/iiif-presentation/manifest.json`;
  await page.locator("#dz-url-input").fill(manifest);
  await page.getByRole("button", { name: /find image/i }).click();

  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  const canvas = page.locator("#rendering-canvas");
  assert.deepEqual(
    await canvas.evaluate((el) => ({ width: el.width, height: el.height })),
    { width: 512, height: 512 },
    "the followed info.json plans the full 512x512 pyramid",
  );
});

// One DZI pyramid whose maximum level (40000x1000) exceeds the browser
// canvas side limit while the level below (20000x500) fits: automatic
// selection takes the smaller level, the notice names both resolutions while
// tiles are still in flight, and "Try maximum" retries the declared maximum,
// which reports the large-canvas error with the desktop-app action. The
// fixture is served entirely from this test: metadata inline, tiles as one
// held 1x1 PNG, so the only real pipeline runs unmodified.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const RESOLUTION_DZI =
  '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="10000" Overlap="0" Format="jpg">' +
  '<Size Width="40000" Height="10000"/></Image>';

test("resolution notice during fetching offers Try maximum and reports the large canvas", async ({ page }) => {
  await page.route(
    (url) => url.host === "fixtures.test",
    async (route) => {
      if (route.request().url().includes("_files/")) {
        // Hold tile responses so the notice is observable mid-fetch.
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/xml",
        headers: { "access-control-allow-origin": "*" },
        body: RESOLUTION_DZI,
      });
    },
  );
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill("https://fixtures.test/resolution/big.dzi");
  await page.getByRole("button", { name: /find image/i }).click();

  // The notice names the selected and maximum resolutions while tiles are
  // still being fetched; the smaller job keeps downloading behind it.
  const notice = page.locator("#dz-resolution-notice");
  await expect(notice).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".dz-completed-section")).toHaveCount(0);
  await expect(page.locator("#dz-resolution-message")).toContainText(/maximal resolution/i);
  const sizes = await page.locator("#dz-resolution-sizes").textContent();
  assert.match(sizes ?? "", /20000×500/, "selected resolution");
  assert.match(sizes ?? "", /40000×1000/, "maximum resolution");

  // "Try maximum" retries the declared maximum resolution.
  await page.locator("#dz-btn-try-maximum").click();
  await expect(page.locator(".dz-error-section")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#dz-error-message")).toContainText(/too large/i);
});

// website/proxy-fallback flow contract: a non-readable metadata URL takes
// the automatic direct-then-proxy request order, exactly one metadata-only
// proxy request relays it, tiles go over direct egress (never proxied), and
// the assembled canvas saves origin-clean.
test("webapp proxy fallback matches the website/proxy-fallback flow contract", async ({ page }) => {
  const golden = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../../testdata/scenarios/website/proxy-fallback/expected/result.json"),
      "utf8",
    ),
  );
  const METADATA_URL = "https://fixtures.test/cli/pyramid.dzi";
  const attempts = [];
  const proxyTargets = [];
  const relayToFixture = async (route, targetUrl) => {
    const response = await route.fetch({
      url: `${ADDR}/proxy?url=${encodeURIComponent(targetUrl)}`,
      method: "GET",
    });
    await route.fulfill({ response });
  };
  // The direct browser fetch fails like a missing CORS grant; the attempt is
  // observed before the automatic metadata proxy fallback.
  await page.route((url) => url.href === METADATA_URL, (route) => {
    attempts.push("direct");
    route.abort();
  });
  await page.route("**/api/proxy", async (route) => {
    const body = route.request().postDataJSON();
    attempts.push("proxy");
    proxyTargets.push(body.targetUrl);
    await relayToFixture(route, body.targetUrl);
  });
  // Tiles are never proxied by policy; this interception stands in for
  // direct tile egress, preserving readable bytes for assembly.
  await page.route(
    (url) => url.host === "fixtures.test" && url.pathname.includes("pyramid_files"),
    async (route) => relayToFixture(route, route.request().url()),
  );
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(METADATA_URL);
  await page.getByRole("button", { name: /find image/i }).click();

  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Save image" }).click();
  const download = await downloadPromise;
  const target = path.join(__dirname, "downloads", `proxy-${Date.now()}.png`);
  await download.saveAs(target);
  const { width, height } = decodePngSize(fs.readFileSync(target));
  assert.equal(width, 512, "proxy-fallback save width");
  assert.equal(height, 512, "proxy-fallback save height");

  assert.deepEqual(attempts, golden.attempts, "website/proxy-fallback attempts");
  assert.equal(proxyTargets.length, golden.proxyRequests, "website/proxy-fallback proxyRequests");
  assert.equal(golden.proxyScope, "metadata-only", "website/proxy-fallback proxyScope");
  assert.ok(
    proxyTargets.every((targetUrl) => !targetUrl.includes("pyramid_files")),
    "metadata-only scope: tiles are never proxied",
  );
  // The save exported real bytes, so the canvas is origin-clean.
  assert.equal(golden.originClean, true, "website/proxy-fallback originClean");
});

// post-cutover/taint transcript: the same direct-then-metadata-only-proxy
// order, but tiles arrive as ordinary image display (readable fetches
// blocked), which keeps the picture visible on a tainted canvas and finishes
// display-only with the "visible" transport.
test("post-cutover proxy fallback with ordinary tiles keeps the visible transport", async ({ page }) => {
  const golden = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../../testdata/scenarios/post-cutover/taint/expected/result.json"),
      "utf8",
    ),
  );
  const METADATA_URL = "https://fixtures.test/cli/pyramid.dzi";
  const transcript = [];
  const relayToFixture = async (route, targetUrl) => {
    const response = await route.fetch({
      url: `${ADDR}/proxy?url=${encodeURIComponent(targetUrl)}`,
      method: "GET",
    });
    await route.fulfill({ response });
  };
  await page.route((url) => url.href === METADATA_URL, (route) => {
    transcript.push("direct");
    route.abort();
  });
  await page.route("**/api/proxy", async (route) => {
    const body = route.request().postDataJSON();
    transcript.push("proxy-metadata-only");
    await relayToFixture(route, body.targetUrl);
  });
  // Readable tile fetches fail (missing CORS grant) while plain <img> loads
  // for the same URLs succeed as ordinary image display.
  await page.route(
    (url) => url.host === "fixtures.test" && url.pathname.includes("pyramid_files"),
    async (route) => {
      if (route.request().resourceType() === "image") {
        await relayToFixture(route, route.request().url());
      } else {
        await route.abort();
      }
    },
  );
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(METADATA_URL);
  await page.getByRole("button", { name: /find image/i }).click();

  await expect(page.locator(".dz-notice-section")).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("heading", { name: /Showing preview/i })).toBeVisible();
  await expect(page.locator(".dz-error-section")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save image" })).toHaveCount(0);
  const transport = "visible";
  assert.deepEqual(transcript, golden.transcript, "post-cutover/taint transcript");
  assert.equal(transport, golden.transport, "post-cutover/taint transport");
});
