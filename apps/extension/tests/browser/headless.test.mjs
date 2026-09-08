// Headless extension E2E: the REAL store-shaped package (staged by
// package-store.sh) runs a complete job in both engines: open a fixture
// page -> traffic scan observes the zoomable source -> wasm core discovers
// -> tiles fetched -> image assembled -> saved bytes verified against the
// fixture pyramid.
//
// Two lanes per engine:
// - grants lane (loopback host permissions injected for the E2E only, since
//   browser chrome cannot be clicked headlessly to grant activeTab): stands
//   in for a user who approved the one-time per-site origin access the
//   bound Scan requests. Full job, bytes verified.
// - no-grants lane (the TRUE store package, host_permissions: []): the
//   production shape without a click (headless drivers cannot press the
//   toolbar button, so no activeTab grant exists and `tabs.get` hides the
//   target URL). Asserts the failure modes stay honest: no webRequest
//   host-permission warnings from any extension context (a permissionless
//   webRequest listener is deaf), and the bound Scan fails fast with a
//   no-target-access message guiding back to the toolbar button instead of
//   scanning deaf for 20s and reporting a misleading "no candidate". The
//   prompt-denial path (`permissions.request` -> false) cannot settle
//   headlessly (an undisplayable prompt never resolves), so it is covered
//   by unit tests (`ensureOriginAccess` matrix) plus the static gate that
//   the denial throws before any listener is installed.
//
// Chromium: Playwright persistent context with --load-extension.
// Firefox: Selenium + geckodriver (WebDriver moz/addon/install), downloads
// routed to a temp dir via profile prefs. The shared body below is the same
// for both drivers.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";
import webdriver from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const PACKAGE_SCRIPT = path.join(REPO_ROOT, "apps/extension/scripts/package-store.sh");
const GECKO_ID = "{14074c89-8a5f-4813-98df-a7117f062871}";
const STATIC_DIR = path.join(HERE, "fixtures-static");

function stagePackage(browser, dir, grants = true, origin = "") {
  const zip = path.join(dir, `dezoomify-${browser}.zip`);
  const staged = spawnSync("bash", [PACKAGE_SCRIPT, browser, zip], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DEZOOMIFY_TEST_HOST_PERMISSIONS: grants ? "1" : "0",
      DEZOOMIFY_TEST_ORIGIN: grants ? origin : "",
    },
  });
  assert.equal(staged.status, 0, `package-store.sh ${browser} failed:\n${staged.stderr}`);
  return zip;
}

function findFirefoxBinary() {
  if (process.env.DEZOOMIFY_FIREFOX_BIN) return process.env.DEZOOMIFY_FIREFOX_BIN;
  for (const candidate of ["/usr/bin/firefox-esr", "/usr/bin/firefox"]) {
    if (existsSync(candidate)) return candidate;
  }
  const pwCache = path.join(process.env.HOME, ".cache", "ms-playwright");
  if (existsSync(pwCache)) {
    for (const build of readdirSync(pwCache).filter((d) => /^firefox-\d+$/.test(d)).sort().reverse()) {
      const bin = path.join(pwCache, build, "firefox", "firefox");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

// background/ and content/ ship as classic scripts in both browsers: every
// staged file must parse without module syntax.
function assertClassicScripts(stagingDir) {
  for (const name of ["background", "content"]) {
    const dir = path.join(stagingDir, name);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(path.join(dir, file), "utf8");
      assert.doesNotThrow(
        () => new vm.Script(source, { filename: `${name}/${file}` }),
        `${name}/${file} must parse as a classic script`,
      );
    }
  }
}

// --- deterministic fixture server on loopback ---
async function startFixtureServer(workDir) {
  const bin = path.join(REPO_ROOT, "target/debug/dezoomify-fixture-server");
  if (!existsSync(bin)) {
    const build = spawnSync("cargo", ["build", "-p", "dezoomify-fixture-server"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `fixture server build failed:\n${build.stderr}`);
  }
  const addrFile = path.join(workDir, "server.addr");
  const proc = spawn(bin, [
    "--port", "0",
    "--write-address", addrFile,
    "--scenarios-dir", path.join(REPO_ROOT, "testdata/scenarios"),
    "--static-dir", STATIC_DIR,
  ]);
  let base = null;
  for (let i = 0; i < 100 && !base; i++) {
    // The server writes the bare socket address (e.g. "127.0.0.1:PORT").
    const bound = existsSync(addrFile) ? readFileSync(addrFile, "utf8").trim() : null;
    if (bound) base = `http://${bound}`;
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(base, "fixture server did not report its address");
  return { proc, base };
}

// --- shared PNG verification (same fixture pyramid as the webapp E2E) ---
function decodePngSize(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47 >>> 0, "PNG signature");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function decodePngPixels(bytes) {
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = decodePngSize(bytes);
  const colorType = bytes[25];
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
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
      }
      out[x] = v & 0xff;
    }
  }
  return { pixels, bpp, width, height };
}

function assertSavedPyramid(bytes) {
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
}

// --- the shared E2E body ---
// driver.openTarget(url) creates the fixture target tab via a single
// `tabs.create` (returns the new tab id, no enumeration) and
// driver.extensionPage().scanAndSave(targetId) navigates the extension page
// to the bound `page.html?tab=<id>` flow, the same bound-tab flow the
// toolbar click uses in production. Shipped code never calls `tabs.query`.
async function runExtensionJob(driver, base) {
  const targetId = await driver.openTarget(`${base}/target.html`);
  const page = await driver.extensionPage();
  const saved = await page.scanAndSave(targetId);
  assertSavedPyramid(saved);
}

test("chromium: packaged extension runs a full job end to end", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-chromium-"));
  let context = null;
  let server = null;
  try {
    // Server first: the staged grant names the exact fixture origin
    // (scheme://host:port), which strict matchers (Firefox `contains`)
    // require to observe anything.
    server = await startFixtureServer(work);
    const zip = stagePackage("chromium", work, true, server.base);
    const pkgDir = path.join(work, "pkg");
    spawnSync("python3", ["-m", "zipfile", "-e", zip, pkgDir], { encoding: "utf8" });
    context = await chromium.launchPersistentContext(path.join(work, "profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${pkgDir}`, `--load-extension=${pkgDir}`],
    });
    // runtime.onInstalled opens the extension page once.
    let ext = null;
    for (let i = 0; i < 60 && !ext; i++) {
      ext = context.pages().find((p) => p.url().includes("page.html")) ?? null;
      if (!ext) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ext, "first-run extension page never opened");
    // Unbound first-run page shows guidance only (never a tab list).
    await ext.waitForSelector("#tabs p", { timeout: 15000 });

    const driver = {
      openTarget: async (url) => {
        // Single-tab creation from the extension page context: returns the
        // new tab id directly, no `tabs.query` enumeration anywhere.
        const targetTabId = await ext.evaluate(
          (u) => browser.tabs.create({ url: u, active: false }).then((t) => t.id),
          url,
        );
        assert.ok(Number.isInteger(targetTabId), "tabs.create must return a tab id");
        return targetTabId;
      },
      extensionPage: () => ({
        scanAndSave: async (targetTabId) => {
          // Navigate to the bound flow the toolbar click uses in production.
          const baseExt = ext.url().split("page.html")[0];
          await ext.goto(`${baseExt}page.html?tab=${targetTabId}`, { timeout: 20000 });
          await ext.waitForSelector(`button[data-tabid="${targetTabId}"]`, { timeout: 15000 });
          // Attach the download waiter before clicking so the event cannot
          // slip past between save and listener registration.
          const downloadPromise = ext.waitForEvent("download", { timeout: 90000 });
          await ext.click(`button[data-tabid="${targetTabId}"]`);
          await ext.waitForFunction(
            () => document.body.dataset.outcome === "saved" || document.body.dataset.outcome === "failed",
            null,
            { timeout: 90000 },
          );
          const outcome = await ext.evaluate(() => document.body.dataset.outcome);
          if (outcome === "failed") {
            assert.fail("extension job failed: " + (await ext.evaluate(() => document.getElementById("log").textContent)));
          }
          const download = await downloadPromise;
          const file = path.join(work, "saved.png");
          await download.saveAs(file);
          return readFileSync(file);
        },
      }),
    };
    await runExtensionJob(driver, server.base);
  } finally {
    if (context) await context.close();
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

test("firefox: packaged extension runs a full job end to end", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-firefox-"));
  let driver = null;
  let server = null;
  try {
    // Server first (see chromium lane): the staged grant names the exact
    // fixture origin, which strict matchers require.
    server = await startFixtureServer(work);
    const zip = stagePackage("firefox", work, true, server.base);
    const staging = path.join(work, "pkg");
    spawnSync("python3", ["-m", "zipfile", "-e", zip, staging], { encoding: "utf8" });
    assertClassicScripts(staging);

    const binary = findFirefoxBinary();
    assert.ok(binary, "no Firefox binary found; set DEZOOMIFY_FIREFOX_BIN");
    const downloadsDir = path.join(work, "downloads");
    mkdirSync(downloadsDir);
    const options = new firefox.Options();
    options.addArguments("-headless");
    options.setBinary(binary);
    options.setPreference("browser.download.dir", downloadsDir);
    options.setPreference("browser.download.folderList", 2);
    options.setPreference("browser.download.useDownloadDir", true);
    options.setPreference("browser.helperApps.neverAsk.saveToDisk", "image/png");
    driver = await new webdriver.Builder().forBrowser("firefox").setFirefoxOptions(options).build();

    const addonId = await driver.installAddon(zip, true);
    assert.equal(addonId, GECKO_ID, `unexpected add-on id ${addonId}`);

    // runtime.onInstalled opened the extension page as a real tab.
    let extHandle = null;
    for (let i = 0; i < 60 && !extHandle; i++) {
      for (const handle of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(handle);
        if ((await driver.getCurrentUrl()).includes("page.html")) { extHandle = handle; break; }
      }
      if (!extHandle) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(extHandle, "first-run extension page never opened");
    // Unbound first-run page shows guidance only (never a tab list).
    await driver.wait(async () => (await driver.findElements({ css: "#tabs p" })).length > 0, 15000);

    const savedFile = path.join(downloadsDir, "dezoomify-512x512.png");
    const driverApi = {
      openTarget: async (url) => {
        // Single-tab creation: returns the new tab id directly, no `tabs.query`.
        const targetTabId = await driver.executeScript(
          "return browser.tabs.create({ url: arguments[0], active: false }).then((t) => t.id);",
          url,
        );
        assert.ok(Number.isInteger(targetTabId), "tabs.create must return a tab id");
        await driver.sleep(1500);
        await driver.switchTo().window(extHandle);
        return targetTabId;
      },
      extensionPage: () => ({
        scanAndSave: async (targetTabId) => {
          // geckodriver refuses driver.get() to moz-extension:// URLs from a
          // content context, so open the bound page through the extension's
          // own tabs.create (this window hosts page.html and has browser
          // APIs), the same mechanism the toolbar click uses in production.
          const extUrl = await driver.getCurrentUrl();
          const baseExt = extUrl.split("page.html")[0];
          const before = new Set(await driver.getAllWindowHandles());
          await driver.executeScript(
            "return browser.tabs.create({ url: arguments[0], active: true }).then(() => null);",
            `${baseExt}page.html?tab=${targetTabId}`,
          );
          let boundHandle = null;
          for (let i = 0; i < 60 && !boundHandle; i++) {
            for (const handle of await driver.getAllWindowHandles()) {
              if (before.has(handle)) continue;
              await driver.switchTo().window(handle);
              if ((await driver.getCurrentUrl()).includes(`page.html?tab=${targetTabId}`)) {
                boundHandle = handle;
                break;
              }
            }
            if (!boundHandle) await new Promise((r) => setTimeout(r, 250));
          }
          assert.ok(boundHandle, "bound extension page never opened");
          await driver.wait(
            async () => (await driver.findElements({ css: `button[data-tabid="${targetTabId}"]` })).length > 0,
            15000,
          );
          await driver.findElement({ css: `button[data-tabid="${targetTabId}"]` }).click();
          const deadline = Date.now() + 90000;
          for (;;) {
            const state = await driver.executeScript(
              "return { outcome: document.body.dataset.outcome ?? null, log: document.getElementById('log')?.textContent ?? '' };",
            );
            if (state.outcome === "failed") assert.fail("extension job failed: " + state.log);
            if (existsSync(savedFile)) return readFileSync(savedFile);
            if (Date.now() > deadline) assert.fail("job did not save in time; log:\n" + state.log);
            await new Promise((r) => setTimeout(r, 500));
          }
        },
      }),
    };
    await runExtensionJob(driverApi, server.base);
  } finally {
    if (driver) await driver.quit();
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

// --- no-grants negative lane (true store shape) ---
//
// Regression lane for total-but-silent production breakage: with
// host_permissions: [] (what ships), the bound Scan must fail honestly
// naming the missing origin access, and no extension context may emit
// webRequest host-permission warnings (a permissionless listener is deaf).

function assertStoreManifest(zip) {
  const listed = spawnSync(
    "python3",
    ["-c", "import json,sys,zipfile; print(json.load(zipfile.ZipFile(sys.argv[1]).open('manifest.json')).get('host_permissions'))", zip],
    { encoding: "utf8" },
  );
  assert.equal(listed.stdout.trim(), "[]", "negative lane must stage the true store manifest (host_permissions: [])");
}

test("chromium without host grants: no deaf APIs, honest permission denial", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-nogrants-"));
  let context = null;
  let server = null;
  try {
    const zip = stagePackage("chromium", work, false);
    assertStoreManifest(zip);
    const pkgDir = path.join(work, "pkg");
    spawnSync("python3", ["-m", "zipfile", "-e", zip, pkgDir], { encoding: "utf8" });
    server = await startFixtureServer(work);
    context = await chromium.launchPersistentContext(path.join(work, "profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${pkgDir}`, `--load-extension=${pkgDir}`],
    });
    const warnings = [];
    const note = (text) => {
      if (/host permission/i.test(String(text ?? ""))) warnings.push(String(text));
    };
    context.on("console", (msg) => note(msg.text()));
    context.on("page", (p) => p.on("console", (msg) => note(msg.text())));
    let ext = null;
    for (let i = 0; i < 60 && !ext; i++) {
      ext = context.pages().find((p) => p.url().includes("page.html")) ?? null;
      if (!ext) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ext, "first-run extension page never opened");
    await ext.waitForSelector("#tabs p", { timeout: 15000 });
    // Service-worker console too (the background owns no webRequest now).
    for (const worker of context.serviceWorkers()) worker.on("console", (msg) => note(msg.text()));

    const targetTabId = await ext.evaluate(
      (u) => browser.tabs.create({ url: u, active: false }).then((t) => t.id),
      `${server.base}/target.html`,
    );
    assert.ok(Number.isInteger(targetTabId), "tabs.create must return a tab id");
    const baseExt = ext.url().split("page.html")[0];
    await ext.goto(`${baseExt}page.html?tab=${targetTabId}`, { timeout: 20000 });
    await ext.waitForSelector(`button[data-tabid="${targetTabId}"]`, { timeout: 15000 });
    await ext.click(`button[data-tabid="${targetTabId}"]`);
    await ext.waitForFunction(
      () => document.body.dataset.outcome === "failed",
      null,
      { timeout: 30000 },
    );
    const log = await ext.evaluate(() => document.getElementById("log").textContent);
    assert.match(log, /cannot see the target tab/, "hidden tab URL must fail fast and honestly, got:\n" + log);
    assert.ok(!log.includes("scan stopped"), "must not burn a deaf 20s scan before failing");
    assert.equal(
      warnings.length,
      0,
      "no webRequest host-permission warnings allowed, got:\n" + warnings.join("\n"),
    );
  } finally {
    if (context) await context.close();
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

test("firefox without host grants: honest permission denial", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-nogrants-ff-"));
  let driver = null;
  let server = null;
  try {
    const zip = stagePackage("firefox", work, false);
    assertStoreManifest(zip);
    server = await startFixtureServer(work);

    const binary = findFirefoxBinary();
    assert.ok(binary, "no Firefox binary found; set DEZOOMIFY_FIREFOX_BIN");
    const options = new firefox.Options();
    options.addArguments("-headless");
    options.setBinary(binary);
    driver = await new webdriver.Builder().forBrowser("firefox").setFirefoxOptions(options).build();

    const addonId = await driver.installAddon(zip, true);
    assert.equal(addonId, GECKO_ID, `unexpected add-on id ${addonId}`);

    let extHandle = null;
    for (let i = 0; i < 60 && !extHandle; i++) {
      for (const handle of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(handle);
        if ((await driver.getCurrentUrl()).includes("page.html")) { extHandle = handle; break; }
      }
      if (!extHandle) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(extHandle, "first-run extension page never opened");
    await driver.wait(async () => (await driver.findElements({ css: "#tabs p" })).length > 0, 15000);

    const targetTabId = await driver.executeScript(
      "return browser.tabs.create({ url: arguments[0], active: false }).then((t) => t.id);",
      `${server.base}/target.html`,
    );
    assert.ok(Number.isInteger(targetTabId), "tabs.create must return a tab id");
    await driver.sleep(1500);
    await driver.switchTo().window(extHandle);
    const extUrl = await driver.getCurrentUrl();
    const baseExt = extUrl.split("page.html")[0];
    const before = new Set(await driver.getAllWindowHandles());
    await driver.executeScript(
      "return browser.tabs.create({ url: arguments[0], active: true }).then(() => null);",
      `${baseExt}page.html?tab=${targetTabId}`,
    );
    let boundHandle = null;
    for (let i = 0; i < 60 && !boundHandle; i++) {
      for (const handle of await driver.getAllWindowHandles()) {
        if (before.has(handle)) continue;
        await driver.switchTo().window(handle);
        if ((await driver.getCurrentUrl()).includes(`page.html?tab=${targetTabId}`)) {
          boundHandle = handle;
          break;
        }
      }
      if (!boundHandle) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(boundHandle, "bound extension page never opened");
    await driver.wait(
      async () => (await driver.findElements({ css: `button[data-tabid="${targetTabId}"]` })).length > 0,
      15000,
    );
    await driver.findElement({ css: `button[data-tabid="${targetTabId}"]` }).click();
    const deadline = Date.now() + 30000;
    for (;;) {
      const state = await driver.executeScript(
        "return { outcome: document.body.dataset.outcome ?? null, log: document.getElementById('log')?.textContent ?? '' };",
      );
      if (state.outcome === "failed") {
        assert.match(state.log, /cannot see the target tab/, "hidden tab URL must fail fast and honestly, got:\n" + state.log);
        assert.ok(!state.log.includes("scan stopped"), "must not burn a deaf 20s scan before failing");
        break;
      }
      if (Date.now() > deadline) assert.fail("denial never surfaced; log:\n" + state.log);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    if (driver) await driver.quit();
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});
