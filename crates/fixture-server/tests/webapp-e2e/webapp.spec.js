// Real-webapp E2E (Chromium): open the actual website served on loopback,
// paste a fixture-server zoomable image URL, let the worker-hosted wasm core
// discover and download the tiles, then save real bytes and verify the PNG.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const assert = require("node:assert/strict");

let ADDR = "";

test.beforeAll(() => {
  ({ addr: ADDR } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "addr.json"), "utf8"),
  ));
});

function decodePngSize(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47 >>> 0, "PNG signature");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return { width, height };
}

// Inflates the concatenated IDAT stream of a small RGB PNG and returns rows.
function decodePngPixels(bytes) {
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // Canvas PNGs are RGBA (color type 6); fixtures are RGB (type 2).
  // One filter byte per row. Reverse every standard PNG row filter.
  const colorType = bytes[25];
  assert.ok(colorType === 2 || colorType === 6, `unsupported color type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp + 1;
  const pixels = Buffer.alloc(width * height * bpp);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    const row = raw.subarray(y * stride + 1, (y + 1) * stride);
    const out = pixels.subarray(y * width * bpp, (y + 1) * width * bpp);
    for (let x = 0; x < row.length; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * width * bpp + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * width * bpp + x - bpp] : 0;
      const v = row[x];
      let value;
      switch (filter) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + Math.floor((a + b) / 2); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG row filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }
  return { pixels, width, height, bpp };
}

test("webapp discovers, downloads, assembles, and saves a real DZI pyramid", async ({ page }) => {
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  const input = page.locator("#dz-url-input");
  await expect(input).toBeVisible();
  const url = `${ADDR}/fetch?url=https://fixtures.test/cli/pyramid.dzi`;
  await input.fill(url);

  await page.getByRole("button", { name: /dezoomify/i }).first().click();

  // The pipeline must reach the completed state with real dimensions.
  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(/512/)).toBeVisible();

  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Save image" }).click();
  const download = await downloadPromise;
  const tmp = path.join(__dirname, "downloads");
  fs.mkdirSync(tmp, { recursive: true });
  const target = path.join(tmp, `saved-${Date.now()}.png`);
  await download.saveAs(target);
  const bytes = fs.readFileSync(target);
  const { width, height } = decodePngSize(bytes);
  assert.equal(width, 512, "saved image width");
  assert.equal(height, 512, "saved image height");

  const { pixels, bpp } = decodePngPixels(bytes);
  const at = (x, y) => {
    const o = (y * width + x) * bpp;
    return [pixels[o], pixels[o + 1], pixels[o + 2]];
  };
  assert.deepEqual(at(64, 64), [196, 48, 48], "top-left quadrant red");
  assert.deepEqual(at(448, 64), [48, 168, 64], "top-right quadrant green");
  assert.deepEqual(at(64, 448), [48, 72, 200], "bottom-left quadrant blue");
  assert.deepEqual(at(448, 448), [232, 220, 96], "bottom-right quadrant yellow");
});

test("webapp fails honestly on a page without a zoomable signal", async ({ page }) => {
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  const input = page.locator("#dz-url-input");
  await expect(input).toBeVisible();
  const url = `${ADDR}/fetch?url=https://fixtures.test/cli/plain.html`;
  await input.fill(url);
  await page.getByRole("button", { name: /dezoomify/i }).first().click();
  await expect(page.locator(".dz-error-section")).toBeVisible({ timeout: 30000 });
  const body = await page.locator("#app").innerText();
  assert.match(body, /No zoomable image was found/i);
});

// `.invalid` never resolves (RFC 2606), so the direct browser fetch fails
// deterministically with a network error, offline or online. The metadata
// URL is public and credential-free, hence proxy-eligible: the fallback
// itself is the behavior under test.
const UNREACHABLE_METADATA_URL = "https://dezoomify.invalid/unreachable.json";

test("default job attempts the metadata proxy after direct failure", async ({ page }) => {
  let proxyPosts = 0;
  await page.route("**/api/proxy", (route) => {
    if (route.request().method() === "POST") proxyPosts += 1;
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ code: "PROXY_POLICY_DENIED" }),
    });
  });
  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(UNREACHABLE_METADATA_URL);
  await page.getByRole("button", { name: /dezoomify/i }).first().click();
  await expect(page.locator(".dz-error-section")).toBeVisible({ timeout: 30000 });
  assert.ok(proxyPosts >= 1, "job must attempt the metadata proxy after direct failure");
});

// Production topology of a Google Arts & Culture asset page: no CORS grant
// on the page (the direct browser fetch fails) while the tile-info XML and
// the signed, AES-CBC-encrypted tiles are readable. The metadata CORS proxy
// relays the page; the browser decrypts tiles via the wasm adapter.
const ARTS_PAGE_URL = "https://artsandculture.google.com/asset/liza-kottou-0113.html";

test("webapp downloads a Google Arts & Culture image through the metadata proxy", async ({ page }) => {
  // The asset page is not CORS-readable: the direct fetch fails like in
  // production, so discovery must fall back to the metadata proxy.
  await page.route((url) => url.href === ARTS_PAGE_URL, (route) => route.abort());

  // Test double of the /api/proxy Pages Function: same wire contract,
  // relayed against the deterministic fixture server on loopback. The relay
  // is always a GET regardless of the intercepted request's method.
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

  // fixtures.test never resolves (RFC 2606): metadata fetches therefore take
  // the proxy fallback above, while tiles are never proxied by policy; this
  // interception stands in for direct tile egress against the same fixture
  // server, preserving the signed-URL and encrypted-payload semantics.
  await page.route(
    (url) => url.host === "fixtures.test" && url.pathname.startsWith("/arts/gap/path=x"),
    async (route) => {
      await relayToFixture(route, route.request().url());
    },
  );

  await page.goto(ADDR + "/beta/", { waitUntil: "networkidle" });
  await page.locator("#dz-url-input").fill(ARTS_PAGE_URL);
  await page.getByRole("button", { name: /dezoomify/i }).first().click();

  await expect(page.locator(".dz-completed-section")).toBeVisible({ timeout: 60000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Save image" }).click();
  const download = await downloadPromise;
  const target = path.join(__dirname, "downloads", `arts-${Date.now()}.png`);
  await download.saveAs(target);
  const bytes = fs.readFileSync(target);
  const { width, height } = decodePngSize(bytes);
  assert.equal(width, 128, "saved image width");
  assert.equal(height, 64, "saved image height");
  // Two signed encrypted tiles decrypt (in wasm) to a solid RGBA PNG. Two
  // tiles also pin the concurrent-processing path: tile downloads run in
  // parallel, decrypt steps queue on the single-pending worker client.
  const { pixels } = decodePngPixels(bytes);
  const at = (x, y) => {
    const o = (y * width + x) * 4;
    return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
  };
  for (const [x, y] of [[0, 0], [63, 0], [64, 32], [127, 63], [0, 63], [127, 0]]) {
    assert.deepEqual(at(x, y), [200, 48, 48, 255], `solid tile color at ${x},${y}`);
  }
  assert.ok(
    proxyTargets.includes(ARTS_PAGE_URL),
    "the asset page must have been fetched through the metadata proxy",
  );
});
