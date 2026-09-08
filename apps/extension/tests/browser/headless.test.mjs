// Browser E2E for the only supported extension flow: inject the in-tab
// monitor, discover from the tab's resource timeline, run the modal job, and
// verify the saved PNG. The old bound `page.html?tab=` flow is intentionally
// not part of this harness.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webdriver from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const PACKAGE_SCRIPT = path.join(REPO_ROOT, "apps/extension/scripts/package-store.sh");
const GECKO_ID = "{14074c89-8a5f-4813-98df-a7117f062871}";
const STATIC_DIR = path.join(HERE, "fixtures-static");

function stagePackage(browser, dir, origin, testDriver = false) {
  const zip = path.join(dir, `dezoomify-${browser}.zip`);
  const staged = spawnSync("bash", [PACKAGE_SCRIPT, browser, zip], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DEZOOMIFY_TEST_HOST_PERMISSIONS: "1",
      DEZOOMIFY_TEST_ORIGIN: origin,
      DEZOOMIFY_TEST_DRIVER: testDriver ? "1" : "0",
    },
  });
  assert.equal(staged.status, 0, `package-store.sh ${browser} failed:\n${staged.stderr}`);
  return zip;
}

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
  for (let i = 0; i < 100 && !base; i += 1) {
    const bound = existsSync(addrFile) ? readFileSync(addrFile, "utf8").trim() : "";
    if (bound) base = `http://${bound}`;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(base, "fixture server did not report its address");
  return { proc, base };
}

function assertPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "saved output is PNG");
  assert.equal(bytes.readUInt32BE(16), 512, "saved image width");
  assert.equal(bytes.readUInt32BE(20), 512, "saved image height");
}

async function waitForPage(context, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const page = context.pages().find(predicate);
    if (page) return page;
    if (Date.now() > deadline) throw new Error("browser page did not appear");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runChromiumJob(base, work) {
  const zip = stagePackage("chromium", work, base);
  const pkgDir = path.join(work, "pkg");
  spawnSync("python3", ["-m", "zipfile", "-e", zip, pkgDir], { encoding: "utf8" });
  const context = await chromium.launchPersistentContext(path.join(work, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${pkgDir}`, `--load-extension=${pkgDir}`],
  });
  try {
    const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
    assert.ok(serviceWorker, "background service worker did not start");
    const extensionId = new URL(serviceWorker.url()).hostname;
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/modal/modal.html`);
    const targetId = await extensionPage.evaluate(async (url) => {
      const api = globalThis.browser ?? globalThis.chrome;
      return (await api.tabs.create({ url, active: false })).id;
    }, `${base}/target.html`);
    const target = await waitForPage(context, (p) => p.url().startsWith(`${base}/target.html`));
    const download = target.waitForEvent("download", { timeout: 90000 });
    await extensionPage.evaluate(async (tabId) => {
      const api = globalThis.browser ?? globalThis.chrome;
      await api.scripting.insertCSS({ target: { tabId }, files: ["content/modal.css"] });
      await api.scripting.executeScript({ target: { tabId }, files: ["content/modal.js"] });
    }, targetId);
    const result = await download;
    const output = path.join(work, "saved-chromium.png");
    await result.saveAs(output);
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
  const zip = stagePackage("firefox", work, base, true);
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
  const driver = await new webdriver.Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  try {
    await driver.manage().setTimeouts({ pageLoad: 15000, script: 15000, implicit: 0 });
    const addonId = await driver.installAddon(zip, true);
    assert.equal(addonId, GECKO_ID, `unexpected add-on id ${addonId}`);
    let driverHandle = null;
    for (let i = 0; i < 60 && !driverHandle; i += 1) {
      for (const handle of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(handle);
        if ((await driver.getCurrentUrl()).includes("test/driver.html")) {
          driverHandle = handle;
          break;
        }
      }
      if (!driverHandle) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(driverHandle, "Firefox test driver page never opened");
    const targetId = await driver.executeScript(
      "const api = globalThis.browser ?? globalThis.chrome; return (api.tabs.create({ url: arguments[0], active: true })).then((t) => t.id);",
      `${base}/target.html`,
    );
    await driver.sleep(1500);
    const injected = await driver.executeScript(
      "const api = globalThis.browser ?? globalThis.chrome; return api.runtime.sendMessage({type: 'dezoomify-test-inject', tabId: arguments[0]});",
      targetId,
    );
    assert.equal(injected?.ok, true, `Firefox background failed to inject the in-tab monitor: ${injected?.error ?? "unknown error"}`);
    const output = path.join(downloadsDir, "dezoomify-512x512.png");
    const deadline = Date.now() + 90000;
    while (!existsSync(output)) {
      if (Date.now() > deadline) {
        throw new Error("Firefox job did not save in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return readFileSync(output);
  } finally {
    await driver.quit();
  }
}

test("chromium: packaged extension runs the in-tab modal job", { timeout: 180000 }, async () => {
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

test("firefox: packaged extension runs the in-tab modal job", { timeout: 180000 }, async () => {
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
