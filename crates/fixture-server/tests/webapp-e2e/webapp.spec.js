// Real-webapp E2E (Chromium): open the actual website served on loopback,
// paste a fixture-server zoomable image URL, let the shared async WASM function
// discover and download the tiles, then save real bytes and verify the PNG.
const { test, expect, chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
// Match the in-process fixture server's native ESM loading of these helpers.
let replayUrl;
test.beforeAll(async () => {
  ({ replayUrl } = await import("../../../../test/fixture-files.mjs"));
});
const {
  assertSavedPyramid,
  decodePngPixels,
  decodePngSize,
  pixelAt,
} = require("../../../../test/support/png.mjs");

const ADDR = process.env.DEZOOMIFY_E2E_ADDR;
const { formats } = require("../../../../test/support/formats.cjs");
const { chooseFixtureImages } = require("../../../../test/support/image-choice.mjs");
const {
  relayFixtureRequest,
  startPublicFixtureSource,
} = require("../../../../test/support/public-relay.mjs");

test("source URL clips in the middle, copies natively, and leaves timing visible", async ({ page }) => {
  const root = path.resolve(__dirname, "../../../..");
  const { outputFiles } = require("esbuild").buildSync({
    stdin: {
      contents: `export { renderView } from "./packages/shared-ui/src/view.tsx";
        export { presentProgress } from "./packages/shared-ui/src/presentation.ts";`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "sourceTest",
    jsx: "automatic",
  });
  await page.setContent('<main class="dz-main"><div id="source-test"></div><textarea></textarea></main>');
  await page.addStyleTag({ path: path.join(root, "packages/shared-ui/src/styles/theme.css") });
  await page.addScriptTag({ content: outputFiles[0].text });
  const source = page.locator("#dz-job-source-url");
  const longUrl = `https://collections.chateauversailles.fr/cc/${"imageproxy/".repeat(30)}imageproxy.aspx?&filename=objectimages/MV%208181_014.dzi`;
  for (const [url, width] of [[longUrl, 1280], [longUrl, 603], [longUrl, 599], [longUrl, 375], ["https://museum.test/a.dzi", 1280]]) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate((url) => {
      const { renderView, presentProgress } = window.sourceTest;
      renderView(document.querySelector("#source-test"),
        presentProgress({ phase: "acquisition", completed: 8, total: 13 }), {},
        { sourceUrl: url, jobActivity: { startedAt: 0, now: 72000 } });
    }, url);
    await expect(source).toHaveText(url);
    await expect(page.locator("#dz-job-time")).toHaveText("1 min 12 s / ~1 min 57 s");
    const layout = await source.evaluate((element) => {
      const [start, end] = element.children;
      const time = document.querySelector("#dz-job-time");
      const row = element.parentElement.getBoundingClientRect();
      const urlBox = element.getBoundingClientRect(), timeBox = time.getBoundingClientRect();
      const startBox = start.getBoundingClientRect(), endBox = end.getBoundingClientRect();
      const first = document.createRange(), last = document.createRange();
      first.setStart(start.lastChild, 0);
      first.setEnd(start.lastChild, 1);
      const tail = end.firstChild.firstChild;
      last.setStart(tail, tail.length - 1);
      last.setEnd(tail, tail.length);
      const characters = Array.from({ length: tail.length }, (_, index) => {
        const range = document.createRange();
        range.setStart(tail, index);
        range.setEnd(tail, index + 1);
        return range.getBoundingClientRect();
      });
      return {
        clipped: [start.scrollWidth > start.clientWidth, end.scrollWidth > end.clientWidth],
        firstVisible: first.getBoundingClientRect().left >= startBox.left - 1,
        lastVisible: last.getBoundingClientRect().right <= endBox.right + 1,
        timeFits: time.scrollWidth <= time.clientWidth && time.getBoundingClientRect().right <= row.right + 1,
        urlFits: endBox.right <= time.getBoundingClientRect().left,
        schemeHidden: start.firstChild.getBoundingClientRect().width === 0,
        wholeCharacters: characters.every((box) => box.right <= endBox.left + 0.1 || box.left >= endBox.left - 0.1),
        aligned: Math.abs((urlBox.top + urlBox.bottom) - (timeBox.top + timeBox.bottom)) < 1,
      };
    });
    assert.deepEqual(layout, {
      clipped: [url === longUrl, url === longUrl], firstVisible: true, lastVisible: true, timeFits: true, urlFits: true,
      schemeHidden: true, wholeCharacters: true, aligned: true,
    });
    await page.locator("textarea").fill("");
    await source.click();
    assert.equal(await page.evaluate(() => getSelection().toString()), url);
    await page.keyboard.press("ControlOrMeta+c");
    await page.locator("textarea").focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect(page.locator("textarea")).toHaveValue(url);
  }
});

for (const colorScheme of ["light", "dark"]) {
  test(`page text and navigation links have AA contrast in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(`${ADDR}/`);
    const pairs = await page.locator("body").evaluate((body) => {
      const page = getComputedStyle(body);
      const nav = getComputedStyle(body.querySelector(".dz-nav"));
      const link = getComputedStyle(body.querySelector(".help-link"));
      const navBackgrounds = nav.backgroundImage.match(/rgba?\([^)]+\)/g) ?? [nav.backgroundColor];
      return [
        ["text", page.color, page.backgroundColor],
        ...navBackgrounds.map((background) => ["link", link.color, background]),
      ];
    });
    const luminance = (color) => {
      const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map((channel) => {
        const value = Number(channel) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const [role, color, surface] of pairs) {
      const foreground = luminance(color), background = luminance(surface);
      const contrast = (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05);
      expect(contrast, `${role}: ${color} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("website saves a no-CORS ZIF URL through real public-data relay policies", async () => {
  const source = await startPublicFixtureSource();
  const resource = "/fixtures/zif/approximate-direct/image.zif";
  const publicUrl = source.publicOrigin + resource;
  let browser;
  try {
    const fullFile = await fetch(source.origin + resource);
    assert.equal(fullFile.status, 400, "the source refuses unbounded full-file GETs");
    assert.equal(fullFile.headers.get("access-control-allow-origin"), null);
    await fullFile.arrayBuffer();
    browser = await chromium.launch({ args: [
      `--host-resolver-rules=MAP source.test 127.0.0.1:${source.port}`,
      "--no-proxy-server",
    ] });
    const page = await browser.newPage({ acceptDownloads: true });
    const relayed = [];
    const directFailures = [];
    page.on("requestfailed", (request) => {
      if (request.url() === publicUrl) directFailures.push(request.failure().errorText);
    });
    await page.route("**/api/proxy", (route) => relayFixtureRequest(route, source, ADDR, relayed));
    await page.goto(`${ADDR}/`);
    await page.locator("#dz-url-input").fill(publicUrl);
    await page.getByRole("button", { name: /find image/i }).click();
    await expect(page.locator(".dz-completed-section, .dz-error-section, .dz-retry-section"))
      .toBeVisible({ timeout: 60000 });
    const diagnostics = await page.locator("#dz-job-diagnostics").textContent();
    await expect(page.locator(".dz-completed-section"), JSON.stringify({
      relayed, diagnostics: diagnostics.split("\nTimeline")[0],
    }))
      .toBeVisible({ timeout: 1000 });
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save image" }).click();
    assertSavedPyramid(fs.readFileSync(await (await pending).path()), 2);

    assert.ok(directFailures.length > 0, "the browser cannot read the separate source without CORS");
    assert.ok(source.requests.some(({ origin, range }) => origin === ADDR && range === "bytes=0-15"),
      "direct requests really reach the separate source before relay fallback");
    assert.ok(relayed.every(({ target, status, range }) => target === publicUrl &&
      (range === undefined ? status === 400 : status === 206 && /^bytes=\d+-\d+$/.test(range))),
      "only exact byte ranges succeed; discovery's unbounded guesses are refused");
    assert.ok(relayed.some(({ range }) => range === "bytes=0-15"), "relay reads container metadata");
    assert.ok(relayed.some(({ range }) => range && Number(range.match(/\d+/)[0]) >= 9 * 1024 * 1024),
      "relay reaches the metadata index beyond the full-file metadata limit");
    assert.equal(relayed.filter(({ jpeg }) => jpeg).length, 4,
      "all four encoded tile ranges pass through the real relay");
  } finally {
    await browser?.close();
    await source.close();
  }
});

test("website notice links to the working legacy app and can be dismissed", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", { get: () => ["fr-FR"] });
  });
  await page.goto(`${ADDR}/`);
  const notice = page.getByRole("complementary", { name: "Vous cherchez l’ancien Dezoomify ?" });
  await expect(notice).toBeVisible();
  await notice.getByRole("link", { name: "Ouvrir l’ancienne version" }).click();
  await expect(page).toHaveURL(`${ADDR}/legacy/`);
  await expect(page.locator("#url")).toBeVisible();
  await expect(page.getByText("Try the new Dezoomify")).toHaveCount(0);
  assert.deepEqual(errors, [], "legacy scripts still initialize from the relocated directory");
  await page.goto(`${ADDR}/`);
  await notice.getByRole("button", { name: "Fermer", exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator("#dz-url-input")).toBeVisible();
});

for (const fixture of formats) {
  test(`website saves ${fixture.name} pixels`, async ({ page }) => {
    await page.goto(`${ADDR}/`);
    await page.locator("#dz-url-input").fill(ADDR + fixture.input);
    await page.getByRole("button", { name: /find image/i }).click();
    await page.waitForFunction(chooseFixtureImages, fixture.choice, { timeout: 30000 });
    await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 30000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-viewer-ready", "true");
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save image" }).click();
    assertSavedPyramid(fs.readFileSync(await (await pending).path()), fixture.tolerance);
  });
}

test("direct acquisition shows its preview while tile responses are held", async ({ page }) => {
  const tiles = (url) => url.href.includes("pyramid_files");
  const releaseTiles = Promise.withResolvers();
  await page.route(tiles, async (route) => {
    await releaseTiles.promise;
    await route.continue();
  });
  try {
    const attempts = [];
    let proxyRequests = 0;
    await page.route("**/api/proxy", (route) => {
      if (route.request().method() === "POST") proxyRequests += 1;
      route.continue();
    });
    await page.goto(ADDR + "/", { waitUntil: "networkidle" });
    const input = page.locator("#dz-url-input");
    await expect(input).toBeVisible();
    const url = `${ADDR}/fetch?url=https://fixtures.test/cli/pyramid.dzi`;
    await page.route((requestUrl) => requestUrl.href === url, (route) => {
      attempts.push("direct");
      route.continue();
    });
    await input.fill(url);

    const requestedTile = page.waitForRequest((request) => tiles(new URL(request.url())));
    await page.getByRole("button", { name: /find image/i }).click();
    await requestedTile;

    const canvas = page.locator("#rendering-canvas");
    await expect(canvas).toBeVisible({ timeout: 30000 });
    await expect(page.locator(".dz-completed-section")).toHaveCount(0);
    assert.deepEqual(
      await canvas.evaluate((el) => ({ width: el.width, height: el.height })),
      { width: 512, height: 512 },
      "the declared preview surface is present while tiles are still in flight",
    );

    releaseTiles.resolve();
    // Completion must follow the held responses, independently of machine speed.
    await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
    await expect(page.locator(".dz-completed-section")).toContainText(/512/);
    const report = await page.locator("#dz-job-diagnostics").textContent();
    assert.match(report, /^Outcome: .*completed/);
    assert.ok(report.includes(`canonical: ${url}`));
    assert.match(report, /first_tile: source.kind=resource source.uri=.*pyramid_files/);
    await page.locator(".dz-details > summary").click();
    const layout = await page.locator("#dz-job-diagnostics").evaluate((element) => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      horizontallyScrollable: element.scrollWidth > element.clientWidth,
    }));
    assert.equal(layout.whiteSpace, "pre");
    assert.ok(layout.horizontallyScrollable, "wide diagnostics scroll without wrapping");
    await page.locator(".dz-details > summary").click();
    assert.deepEqual(attempts, ["direct"]);
    assert.equal(proxyRequests, 0);
  } finally {
    releaseTiles.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("webapp fails honestly on a page without a zoomable signal", async ({ page }) => {
  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
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
  await page.goto(`${ADDR}/`, { waitUntil: "networkidle" });
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
      await page.goto(`${ADDR}/`, { waitUntil: "networkidle" });
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
  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
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
  await expect(page.locator("#dz-error-message")).toContainText(/The site refused to send this file to Dezoomify’s server \(HTTP 406\)/i);
  await expect(page.locator("#dz-error-message")).toContainText(/your own internet connection/i);
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
      url: replayUrl(ADDR, targetUrl),
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

  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
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
// visible picture with app guidance, no TILE_FAILED, no save.
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
  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
  const url = `${ADDR}/fetch?url=https://fixtures.test/cli/pyramid.dzi`;
  await page.locator("#dz-url-input").fill(url);
  await page.getByRole("button", { name: /find image/i }).click();

  await expect(page.locator(".dz-notice-section")).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("heading", { name: /Showing preview/i })).toBeVisible();
  await expect(page.getByText(/source site does not allow.*downloadable file/i)).toBeVisible();
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
        url: replayUrl(ADDR, route.request().url()),
        method: "GET",
      });
      await route.fulfill({ response });
    },
  );
  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
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
// selection takes the smaller level, and one notice opens the desktop handoff
// while tiles are in flight or after completion. The
// fixture is served entirely from this test: metadata inline, tiles as one
// held 1x1 PNG, so the only real pipeline runs unmodified.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const RESOLUTION_DZI =
  '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="10000" Overlap="0" Format="jpg">' +
  '<Size Width="40000" Height="1000"/></Image>';

test("desktop guidance downloads directly without leaving the website", async ({ page }) => {
  let apiRequests = 0;
  await page.route("https://api.github.com/**", (route) => {
    apiRequests++;
    return route.abort();
  });
  const installerUrl = "https://github.com/lovasoa/dezoomify/releases/latest/download/dezoomify-desktop.msi";
  await page.route(installerUrl, (route) => route.fulfill({
    contentType: "application/octet-stream",
    headers: { "content-disposition": 'attachment; filename="dezoomify-test.msi"' },
    body: "Mock installer bytes",
  }));
  await page.goto(`${ADDR}/`, { waitUntil: "networkidle" });
  await page.locator("#dz-nav-btn-desktop").click();
  const dialog = page.getByRole("dialog");
  const downloads = dialog.locator(".dz-modal-download-box");
  await expect(downloads.getByRole("link")).toHaveCount(3);
  const windows = downloads.getByRole("link", { name: "Windows installer · x64 (MSI)" });
  await expect(windows).toHaveAttribute("href", installerUrl);
  await expect(downloads.getByRole("link", { name: "macOS installer · Apple Silicon (DMG)" })).toHaveAttribute("href", /\/releases\/latest\/download\/dezoomify-desktop\.dmg$/);
  await expect(downloads.getByRole("link", { name: "Linux installer · x64 (DEB)" })).toHaveAttribute("href", /\/releases\/latest\/download\/dezoomify-desktop\.deb$/);
  const pending = page.waitForEvent("download");
  await windows.click();
  expect((await pending).suggestedFilename()).toBe("dezoomify-test.msi");
  await expect(page).toHaveURL(`${ADDR}/`);
  expect(apiRequests).toBe(0);
});

test("lower resolution opens a desktop handoff with the exact URL and keyboard navigation", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let releaseTiles;
  const tilesReady = new Promise((resolve) => { releaseTiles = resolve; });
  await page.route(
    (url) => url.host === "fixtures.test",
    async (route) => {
      if (route.request().url().includes("_files/")) {
        // Hold tile responses so the notice is observable mid-fetch.
        await tilesReady;
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
  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill("https://fixtures.test/resolution/big.dzi");
  await page.getByRole("button", { name: /find image/i }).click();

  // The notice names the selected and maximum resolutions while tiles are
  // still being fetched; the smaller job keeps downloading behind it.
  const notice = page.locator("#dz-resolution-notice");
  await expect(notice).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".dz-completed-section")).toHaveCount(0);
  await expect(notice.getByRole("button")).toHaveCount(1);
  const sizes = await page.locator("#dz-resolution-message").textContent();
  assert.match(sizes ?? "", /20000×500/, "selected resolution");
  assert.match(sizes ?? "", /40000×1000/, "maximum resolution");

  const action = page.locator("#dz-btn-download-desktop");
  await action.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link")).toHaveCount(3);
  await expect(dialog.getByRole("link", { name: "Linux installer · x64 (DEB)" })).toHaveAttribute("href", /\/releases\/latest\/download\/dezoomify-desktop\.deb$/);
  const source = dialog.getByRole("textbox");
  await expect(source).toHaveValue("https://fixtures.test/resolution/big.dzi");
  await expect(source).toHaveAttribute("readonly", "");
  const close = dialog.getByRole("button", { name: "Close dialog" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const copy = dialog.getByRole("button", { name: "Copy address" });
  await expect(copy).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await copy.click();
  await expect(dialog.getByRole("status")).toContainText("Address copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://fixtures.test/resolution/big.dzi",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();
  releaseTiles();
  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  await action.click();
  await expect(source).toHaveValue("https://fixtures.test/resolution/big.dzi");
  await close.click();
  await expect(page.getByRole("button", { name: "Save image" })).toBeVisible();
});

// website/proxy-fallback flow contract: a non-readable metadata URL takes
// the automatic direct-then-proxy request order. Exactly one metadata
// request needs the relay; this source's tiles are directly readable and
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
      url: replayUrl(ADDR, targetUrl),
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
  // This source grants readable tile egress, so its tile requests succeed
  // directly and never need the relay.
  await page.route(
    (url) => url.host === "fixtures.test" && url.pathname.includes("pyramid_files"),
    async (route) => relayToFixture(route, route.request().url()),
  );
  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
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
    "this source's directly readable tiles do not need the relay",
  );
  // The save exported real bytes, so the canvas is origin-clean.
  assert.equal(golden.originClean, true, "website/proxy-fallback originClean");
});

// This source's public metadata needs the relay, while its private-origin
// tiles cannot use it. Failed readable tile requests can still fall back to
// ordinary image display and finish with the "visible" transport.
test("post-cutover proxy fallback with ordinary tiles keeps the visible transport", async ({ page }) => {
  const golden = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../../testdata/scenarios/post-cutover/taint/expected/result.json"),
      "utf8",
    ),
  );
  const METADATA_URL = "https://fixtures.test/cli/pyramid.dzi";
  const privateTileOrigin = new URL(ADDR);
  privateTileOrigin.protocol = "https:";
  privateTileOrigin.port = String(Number(privateTileOrigin.port) === 65535 ? 65534 : Number(privateTileOrigin.port) + 1);
  const transcript = [];
  const tileTraffic = [];
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === privateTileOrigin.origin)
      tileTraffic.push({ type: request.resourceType(), error: request.failure().errorText });
  });
  const relayToFixture = async (route, targetUrl) => {
    const response = await route.fetch({
      url: replayUrl(ADDR, targetUrl),
      method: "GET",
    });
    assert.equal(response.status(), 200, `fixture image ${targetUrl}`);
    await route.fulfill({ response });
  };
  await page.route((url) => url.href === METADATA_URL, (route) => {
    transcript.push("direct");
    route.abort();
  });
  await page.route("**/api/proxy", async (route) => {
    const body = route.request().postDataJSON();
    assert.equal(body.targetUrl, METADATA_URL, "private-origin tiles never enter the public relay");
    transcript.push("proxy-metadata-only");
    const response = await route.fetch({ url: replayUrl(ADDR, body.targetUrl), method: "GET" });
    await route.fulfill({ response, body: (await response.text()).replace(
      /<Image\b/, `<Image Url="${privateTileOrigin.origin}/pyramid_files/"`,
    ) });
  });
  // Readable tile fetches fail (missing CORS grant) while plain <img> loads
  // for the same URLs succeed as ordinary image display.
  await page.route(
    (url) => url.origin === privateTileOrigin.origin && url.pathname.startsWith("/pyramid_files/"),
    async (route) => {
      if (route.request().resourceType() === "image") {
        await relayToFixture(route, `https://fixtures.test/cli${new URL(route.request().url()).pathname}`);
      } else {
        await route.abort();
      }
    },
  );
  await page.goto(ADDR + "/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(METADATA_URL);
  await page.getByRole("button", { name: /find image/i }).click();

  await expect(page.locator(".dz-notice-section, .dz-error-section, .dz-retry-section"))
    .toBeVisible({ timeout: 60000 });
  const diagnostics = await page.locator("#dz-job-diagnostics").textContent();
  await expect(page.locator(".dz-notice-section"), JSON.stringify({
    tileTraffic, diagnostics: diagnostics.split("\nTimeline")[0],
  }))
    .toBeVisible({ timeout: 1000 });
  await expect(page.getByRole("heading", { name: /Showing preview/i })).toBeVisible();
  await expect(page.locator(".dz-error-section")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save image" })).toHaveCount(0);
  const transport = "visible";
  assert.deepEqual(transcript, golden.transcript, "post-cutover/taint transcript");
  assert.equal(transport, golden.transport, "post-cutover/taint transport");
});
