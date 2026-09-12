// Browser E2E for the only supported extension flow: the toolbar action
// starts a job (headless browsers use the test-only driver), a finite source
// snapshot reads the tab's retained resource timeline, the dedicated job tab
// runs the engine end to end, and the output saves as a PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webdriver from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const EXTENSION_ROOT = path.join(REPO_ROOT, "apps/extension");
const GECKO_ID = "{14074c89-8a5f-4813-98df-a7117f062871}";
const STATIC_DIR = path.join(HERE, "fixtures-static");
const TILE_DIR = path.join(REPO_ROOT, "testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli");

function stagePackage(browser, dir, origin, { testDriver = false, grantHostPermissions = true, source } = {}) {
  const zip = path.join(dir, `dezoomify-${browser}.zip`);
  const wxtBrowser = browser === "chromium" ? "chrome" : browser;
  const staged = spawnSync("pnpm", ["--dir", EXTENSION_ROOT, "exec", "wxt", "zip", "--browser", wxtBrowser], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DEZOOMIFY_TEST_HOST_PERMISSIONS: grantHostPermissions ? "1" : "0",
      DEZOOMIFY_TEST_ORIGIN: origin,
      DEZOOMIFY_TEST_DRIVER: testDriver ? "1" : "0",
      ...(source ? { DEZOOMIFY_TEST_SOURCE: source } : {}),
    },
  });
  assert.equal(staged.status, 0, `WXT package ${browser} failed:\n${staged.stderr}`);
  copyFileSync(path.join(EXTENSION_ROOT, ".output-test", `dezoomify-${wxtBrowser}.zip`), zip);
  return zip;
}

async function startFixtureServer(workDir) {
  const metadata = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(metadata.status, 0, `cargo metadata failed:\n${metadata.stderr}`);
  const targetDir = JSON.parse(metadata.stdout).target_directory;
  assert.equal(typeof targetDir, "string", "cargo metadata must report target_directory");
  const bin = path.join(
    targetDir,
    "debug",
    `dezoomify-fixture-server${process.platform === "win32" ? ".exe" : ""}`,
  );
  // Like the WASM glue, target/ is an untracked cache, not a source of
  // truth. Cargo's incremental build is cheap and guarantees that the test
  // server implements the routes in this checkout.
  const build = spawnSync("cargo", ["build", "-p", "dezoomify-fixture-server"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `fixture server build failed:\n${build.stderr}`);
  const addrFile = path.join(workDir, "server.addr");
  const proc = spawn(bin, [
    "--port", "0",
    "--write-address", addrFile,
    "--scenarios-dir", path.join(REPO_ROOT, "testdata/scenarios"),
    "--static-dir", STATIC_DIR,
  ]);
  let base = null;
  for (let i = 0; i < 100 && !base; i += 1) {
    const bound = existsSync(addrFile) ? readFileSync(addrFile, "utf8").trim() : "";
    if (bound) base = `http://${bound}`;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(base, "fixture server did not report its address");
  return { proc, base };
}

function assertPng(bytes) {
  const output = PNG.sync.read(bytes);
  assert.deepEqual([output.width, output.height], [512, 512], "saved image dimensions");
  for (const [name, x, y] of [
    ["tile-0_0.png", 128, 128],
    ["tile-1_0.png", 384, 128],
    ["tile-0_1.png", 128, 384],
    ["tile-1_1.png", 384, 384],
  ]) {
    const tile = PNG.sync.read(readFileSync(path.join(TILE_DIR, name)));
    const expected = [...tile.data.subarray((128 * tile.width + 128) * 4, (128 * tile.width + 128) * 4 + 4)];
    const actual = [...output.data.subarray((y * output.width + x) * 4, (y * output.width + x) * 4 + 4)];
    assert.deepEqual(actual, expected, `${name} center pixel`);
  }
}

async function readCompletedPng(output, deadline) {
  let lastError = "file was never created";
  while (Date.now() <= deadline) {
    if (existsSync(output)) {
      try {
        const bytes = readFileSync(output);
        // Firefox creates the destination before the download stream has
        // finished. Decode the bytes before returning so the E2E observes a
        // completed save, not merely a visible pathname.
        PNG.sync.read(bytes);
        return bytes;
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Firefox saved an incomplete PNG: ${lastError}`);
}

async function waitForJobPage(context) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => candidate.url().includes("/job.html#jobId="));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the extension did not open its job tab");
}

async function runChromiumJob(base, work, options = {}) {
  const zip = stagePackage("chromium", work, base, { testDriver: true, ...options });
  const pkgDir = path.join(work, "pkg");
  spawnSync("python3", ["-m", "zipfile", "-e", zip, pkgDir], { encoding: "utf8" });
  const context = await chromium.launchPersistentContext(path.join(work, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${pkgDir}`, `--load-extension=${pkgDir}`],
  });
  // Downloads are tracked from context level: the job tab saves via a blob
  // anchor, which can fire before a page-level listener attaches.
  const downloads = [];
  for (const page of context.pages()) page.on("download", (download) => downloads.push(download));
  context.on("page", (page) => page.on("download", (download) => downloads.push(download)));
  try {
    const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
    assert.ok(serviceWorker, "background service worker did not start");
    // Chromium may finish installing the unpacked package before Playwright
    // can observe the onInstalled-opened page. Navigating to the same
    // packaged driver is deterministic and does not inject privileged code.
    const extensionId = new URL(serviceWorker.url()).hostname;
    const driverPage = await context.newPage();
    await driverPage.goto(`chrome-extension://${extensionId}/test/driver.html`);
    const driverResult = await driverPage.evaluate(() => globalThis.__DEZOOMIFY_TEST_RUN__
      .then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error?.message ?? error) })));
    assert.deepEqual(driverResult, { ok: true }, `Chromium test driver failed: ${JSON.stringify(driverResult)}`);
    const jobPage = await waitForJobPage(context);
    if (options.beforeCompletion) await options.beforeCompletion(jobPage);
    const deadline = Date.now() + 90000;
    while (downloads.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const download = downloads[0];
    assert.ok(download, "the job tab did not save the assembled image in time");
    const output = path.join(work, "saved-chromium.png");
    await download.saveAs(output);
    return readFileSync(output);
  } finally {
    await context.close();
  }
}

function findFirefoxBinary() {
  if (process.env.DEZOOMIFY_FIREFOX_BIN) return process.env.DEZOOMIFY_FIREFOX_BIN;
  for (const candidate of ["/usr/bin/firefox-esr", "/usr/bin/firefox"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function runFirefoxJob(base, work) {
  const zip = stagePackage("firefox", work, base, { testDriver: true });
  const binary = findFirefoxBinary();
  assert.ok(binary, "no Firefox binary found; set DEZOOMIFY_FIREFOX_BIN");
  const downloadsDir = path.join(work, "downloads");
  mkdirSync(downloadsDir);
  const options = new firefox.Options();
  options.addArguments("-headless");
  options.setPageLoadStrategy("eager");
  options.setBinary(binary);
  options.setPreference("browser.download.dir", downloadsDir);
  options.setPreference("browser.download.folderList", 2);
  options.setPreference("browser.download.useDownloadDir", true);
  options.setPreference("browser.helperApps.neverAsk.saveToDisk", "image/png");
  // Selenium Manager otherwise writes below the user's home directory,
  // which is commonly read-only in hermetic local/CI runs.
  process.env.SE_CACHE_PATH = path.join(work, "selenium-cache");
  const driver = await new webdriver.Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  try {
    await driver.manage().setTimeouts({ pageLoad: 15000, script: 15000, implicit: 0 });
    const addonId = await driver.installAddon(zip, true);
    assert.equal(addonId, GECKO_ID, `unexpected add-on id ${addonId}`);
    const output = path.join(downloadsDir, "dezoomify-512x512.png");
    const deadline = Date.now() + 90000;
    return await readCompletedPng(output, deadline);
  } finally {
    await driver.quit();
  }
}

test("chromium: packaged extension runs the job-tab engine flow", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-chromium-"));
  let server = null;
  try {
    server = await startFixtureServer(work);
    assertPng(await runChromiumJob(server.base, work));
  } finally {
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

test("chromium: optional host grant keeps the React job view mounted", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-permission-"));
  let server = null;
  try {
    server = await startFixtureServer(work);
    assertPng(await runChromiumJob(server.base, work, {
      grantHostPermissions: false,
      async beforeCompletion(jobPage) {
        const grant = jobPage.locator("[data-dz-allow-access=true]");
        await grant.waitFor({ state: "visible", timeout: 30000 });
        await grant.click();
        await jobPage.locator(".dz-card").waitFor({ state: "visible", timeout: 30000 });
      },
    }));
  } finally {
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

test("chromium: partial-output actions disappear after the terminal event", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-partial-"));
  let server = null;
  try {
    server = await startFixtureServer(work);
    assertPng(await runChromiumJob(server.base, work, {
      source: "https://fixtures.test/cli/corrupt.dzi",
      async beforeCompletion(jobPage) {
        const keep = jobPage.locator("[data-dz-partial-choice=keep]");
        await keep.waitFor({ state: "visible", timeout: 30000 });
        await keep.click();
        await jobPage.locator("h2").filter({ hasText: "Showing preview" }).waitFor({ state: "visible", timeout: 30000 });
        assert.equal(await jobPage.locator("[data-dz-partial-choice]").count(), 0);
      },
    }));
  } finally {
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

test("firefox: packaged extension runs the job-tab engine flow", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-firefox-"));
  let server = null;
  try {
    server = await startFixtureServer(work);
    assertPng(await runFirefoxJob(server.base, work));
  } finally {
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});
