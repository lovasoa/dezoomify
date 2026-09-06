// Live webapp suite. Opt-in diagnostic suite (env DEZOOMIFY_LIVE_WEB=1):
// opens the REAL webapp, pastes the real-site input URL, and asserts the app
// attempts discovery and
// reaches a zoomable-image plan, observed as real network requests to the
// target site (metadata + at least one tile), then cancels the job.
// Targets are the legacy input URLs only; nothing is hardcoded per site.
// Both http and https targets are exercised; there is no http/https
// distinction.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

let ADDR = "";

test.beforeAll(() => {
  ({ addr: ADDR } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "addr.json"), "utf8"),
  ));
});

const TARGETS = [
  ["L01", "https://artsandculture.google.com/asset/liza-kottou-0113/3gGrYhjfhcwvbA"],
  ["L02", "https://www.nationalgallery.org.uk/paintings/alexandre-calame-at-handeck"],
  ["L03", "https://www.vangoghmuseum.nl/en/collection/s0424M1991"],
  ["L04", "https://www.londonmuseum.org.uk/collections/v/object-95380/a-country-fair/"],
  ["L05", "https://philamuseum.org/collection/object/101731"],
  ["L06", "https://gallica.bnf.fr/iiif/ark:/12148/btv1b53252063t/f1/info.json"],
  ["L07", "https://www.ngv.vic.gov.au/explore/collection/work/3867/"],
  ["L08", "https://nla.gov.au/nla.obj-152642460/view"],
  ["L09", "https://collections.csntm.org/image-service/iiif/MNTGRCGA01/default/M_NT_GRC_GA01_20250609_203r/M_NT_GRC_GA01_20250609_203r/info.json"],
  ["L10", "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37"],
  ["L11", "https://images.memorix.nl/wba/topviewjson/memorix/6eb5a89b-b76c-5039-3999-aabfd7a0c7c9"],
  ["L12", "https://www.beeldbankgroningen.nl/beelden/detail/53479cae-899f-0ac1-8913-40276a93a4f7/media/1c7914ee-3f37-0d37-3218-48eba1c3a97f?mode=detail&view=horizontal&rows=1&page=4&fq%5B%5D=search_s_download:%22Nee%22&sort=random%7B1785398988616%7D%20asc"],
  ["L13", "https://salha.nl/bronnen/fotos-en-films/foto-s/detail/2b1d137e-2308-11e0-acba-74f6d356987f/media/80e3858f-5c15-e084-d368-5aa6b9fa0062"],
  ["L14", "https://archief.zaanstad.nl/mediabank/zoek-in-de-beeldbank/detail/5e5e4b6f-1ed0-ae92-e18a-5e1cc449fd7d/media/33f3329d-6882-81a5-43ab-1a7ffe286575"],
  ["L15", "https://erfgoedcentrumzutphen.nl/onderzoeken/beeldbank/detail/268857ad-0480-2e3e-953d-4cf9731c35ff/media/70b46159-6022-5903-a718-c083adb32fe0"],
  ["L16", "https://noord-hollandsarchief.nl/beelden/beeldbank/detail/49AB27FEFB8F11DF9E4D523BC2E286E2/media/9c2a1001-932a-3beb-503f-8d9421db389e"],
  ["L17", "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc"],
  ["L18", "https://digital.blb-karlsruhe.de/blbhs/content/zoom/2410801"],
  ["L19", "https://gallery.hungaricana.hu/en/SzerencsKepeslap/1168634/?img=0"],
  ["L20", "https://dc.library.okstate.edu/digital/collection/OKMaps/id/6483/rec/6"],
  ["L21", "https://digitalcollections.lib.washington.edu/digital/custom/mirador3?manifest=https://digitalcollections.lib.washington.edu//iiif/info/social/1303/manifest.json"],
  ["L22", "https://krpano.com/panos/andreabiffi/galleria_04.xml"],
  ["L23", "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs"],
  ["L24", "https://bronze.asdc.sinica.edu.tw/filePool/R/05395-1.html"],
  ["L25", "https://www.neptunelabs.com/fsi-viewer/"],
  ["L26", "https://image.hng-data.org/iipsrv/iipsrv.fcgi?FIF=/HNG/016/card/0178.tif"],
  ["L28", "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml"],
  ["L29", "https://wmts.ngi.be/arcgis/rest/services/20k__%7BD67270FA-BDEC-4A9F-95D1-BEC0C75BA45E%7D__default__404000/MapServer"],
  ["L30", "https://digital.blb-karlsruhe.de/image/tiler/square/2410801/0/{{X}}/{{Y}}"],
  ["L32", "https://openseadragon.github.io/examples/tilesource-zoomify/"],
  ["L33", "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json"],
  ["L34", "https://map-view.nls.uk/iiif/19619%2F196194600/info.json"],
  ["L35", "https://collection.ethnomuseum.ru/entity/OBJECT/32945"],
];

const LIVE_ENABLED = process.env.DEZOOMIFY_LIVE_WEB === "1";
const PER_TARGET_MS = 25000;

test.skip(!LIVE_ENABLED, "live webapp checks are opt-in: run with DEZOOMIFY_LIVE_WEB=1");

function siteOriginOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

for (const [id, url] of TARGETS) {
  test(`live web ${id}: app attempts discovery and reaches the tile plan`, async ({ page }) => {
    test.setTimeout(PER_TARGET_MS + 30000);
    const origin = siteOriginOf(url);
    if (!origin) {
      test.skip(true, "unparseable URL");
      return;
    }
    let siteRequests = 0;
    let siteOkResponses = 0;
    let firstTileUrl = null;
    // Tile-level accounting: a metadata 200 alone must never turn the target
    // green. At least one planned tile (a non-input request to the site
    // origin) must return 2xx/3xx. Tile 404s on the site origin, or tile-like
    // 404s against the app itself (the krpano regression where relative
    // galleria_04.tiles/* resolved against /beta/), fail the target outright.
    const tileUrls = [];
    const tileOkUrls = [];
    const tileFailedUrls = [];
    const appOriginTile404s = [];
    const isTileLike = (target) =>
      /\.(jpg|jpeg|png|webp|tif|tiff|dzi|xml)(\?|#|$)/i.test(target) ||
      target.includes(".tiles/") ||
      target.includes("/tiles/") ||
      target.includes("tile");
    page.on("request", (request) => {
      const target = request.url();
      if (target.startsWith(origin) && !target.startsWith(ADDR)) {
        siteRequests += 1;
        if (target !== url && firstTileUrl === null) {
          firstTileUrl = target;
        }
        if (target !== url) tileUrls.push(target);
      } else if (target.startsWith(ADDR) && isTileLike(target)) {
        // Wrong-base tiles (relative metadata URLs resolved against the app
        // page) surface here as /beta/*.tiles/* 404s; record for the verdict.
        tileUrls.push(target);
      }
    });
    page.on("response", (response) => {
      const target = response.url();
      const status = response.status();
      if (target.startsWith(origin) && !target.startsWith(ADDR)) {
        if (status < 400) siteOkResponses += 1;
        if (target !== url) {
          if (status < 400) tileOkUrls.push(`${status} ${target}`);
          else tileFailedUrls.push(`${status} ${target}`);
        }
      } else if (target.startsWith(ADDR) && status >= 400 && isTileLike(target)) {
        appOriginTile404s.push(`${status} ${target}`);
      }
    });
    // Live metadata proxy relay: the loopback harness serves no /api/proxy
    // route, so stub the production relay shape at the page layer. The POST
    // targetUrl is relayed to the real upstream with a GET and the upstream
    // response is passed through with x-proxy-upstream-url set, mirroring
    // src/server/proxy.ts so tile-base propagation is exercised live.
    // Missing or invalid targets get an honest 4xx and upstream errors pass
    // through; the stub never throws.
    await page.route("**/api/proxy", async (route) => {
      let targetUrl = null;
      try {
        targetUrl = route.request().postDataJSON()?.targetUrl ?? null;
      } catch {
        targetUrl = null;
      }
      if (typeof targetUrl !== "string" || !/^https?:\/\//i.test(targetUrl)) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ code: "PROXY_POLICY_DENIED" }),
        });
        return;
      }
      let upstream = null;
      try {
        upstream = await route.fetch({ url: targetUrl, method: "GET" });
      } catch {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ code: "TRANSPORT_NETWORK_ERROR" }),
        });
        return;
      }
      let headers = null;
      try {
        headers = { ...upstream.headers(), "x-proxy-upstream-url": targetUrl };
      } catch {
        headers = { "x-proxy-upstream-url": targetUrl };
      }
      await route.fulfill({ response: upstream, headers });
    });
    await page.goto(ADDR + "/beta/", { waitUntil: "domcontentloaded" });
    const input = page.locator("#dz-url-input");
    await expect(input).toBeVisible();
    await input.fill(url);
    await page.getByRole("button", { name: /dezoomify/i }).first().click();

    // Bounded observation: wait for at least one readable tile (the app
    // planned tiles from real, auto-selected metadata and fetched one), or
    // an honest terminal state. Breaking on the first tile *request* alone
    // hid the krpano regression where every tile 404'd against /beta/.
    const deadline = Date.now() + PER_TARGET_MS;
    let errorState = null;
    while (Date.now() < deadline) {
      if (tileOkUrls.length >= 1) break;
      if (tileFailedUrls.length >= 1 || appOriginTile404s.length >= 1) break;
      const state = await page.locator("#app").innerText().catch(() => "");
      const failed = state.match(
        /Could not dezoomify|No zoomable image|could not be saved|Part of the image|TILE_FAILED/i,
      );
      if (failed) {
        errorState = failed[0];
        break;
      }
      if (/Download complete|cancelled/i.test(state)) break;
      await page.waitForTimeout(500);
    }
    // Never leave a background download running.
    const cancel = page.locator("#dz-btn-cancel");
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click().catch(() => {});
    }
    console.log(
      `live web ${id}: site_requests=${siteRequests} tiles=${tileUrls.length} tile_ok=${tileOkUrls.length} ` +
        `tile_fail=${tileFailedUrls.length} app404=${appOriginTile404s.length} first_tile=${firstTileUrl ?? "none"}`,
    );
    if (appOriginTile404s.length >= 1) {
      throw new Error(
        `${url}: planned tile URLs resolved against the app instead of the site ` +
          `(relative base lost, e.g. krpano galleria_04.tiles/* under /beta/): ${appOriginTile404s[0]}; ` +
          "fix the metadata finalUri propagation",
      );
    }
    if (tileFailedUrls.length >= 1 && tileOkUrls.length === 0) {
      throw new Error(
        `${url}: planned tile fetches failed (${tileFailedUrls[0]}); ` +
          "the target is broken for the new webapp; remove it from the live target list " +
          "with the reason in the commit message",
      );
    }
    if (errorState !== null && tileOkUrls.length === 0) {
      throw new Error(
        `${url}: the webapp reported "${errorState}" without ever fetching a readable tile; ` +
          "the target is broken for the new webapp; remove it from the live target list " +
          "with the reason in the commit message",
      );
    }
    expect(siteRequests, `${id}: the app must attempt discovery on the site`).toBeGreaterThanOrEqual(1);
    expect(
      siteOkResponses,
      `${id}: the app must get at least one readable (2xx/3xx) response from the site`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      tileUrls.length,
      `${id}: the app must plan at least one tile (a non-metadata request to the site)`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      tileOkUrls.length,
      `${id}: at least one planned tile must be readable (2xx/3xx); ` +
        `failures: ${tileFailedUrls.slice(0, 3).join("; ") || "none"}`,
    ).toBeGreaterThanOrEqual(1);
  });
}
