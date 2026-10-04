// Browser E2E for the only supported extension flow: the toolbar action
// starts a job (headless browsers use the test-only driver), a finite source
// snapshot reads the tab's retained resource timeline, the dedicated job tab
// runs the Rust algorithm end to end, and the output saves as a PNG.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import webdriver from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { formats } from "../../../../test/support/formats.cjs";
import {
  assertSavedPyramid,
  decodePngPixels,
  decodePngSize,
  EXPECTED_HEIGHT,
  EXPECTED_WIDTH,
  pixelAt,
  QUADRANTS,
} from "../../../../test/support/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const EXTENSION_ROOT = path.join(REPO_ROOT, "apps/extension");
const GECKO_ID = "{14074c89-8a5f-4813-98df-a7117f062871}";
const GECKODRIVER = path.join(
  HERE,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "geckodriver.cmd" : "geckodriver",
);
const STATIC_DIR = path.join(HERE, "fixtures-static");
const TILE_DIR = path.join(
  REPO_ROOT,
  "testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli",
);
let fixtureServer;
let fixtureWork;
const packages = new Map();
let matrixChromium;
let matrixFirefox;

before(async () => {
  fixtureWork = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-fixture-"));
  fixtureServer = await startFixtureServer(fixtureWork);
});

after(async () => {
  const cleanup = await Promise.allSettled([matrixChromium?.close(), matrixFirefox?.quit()]);
  fixtureServer?.proc.kill();
  if (fixtureWork) rmSync(fixtureWork, { recursive: true, force: true });
  for (const result of cleanup) if (result.status === "rejected") throw result.reason;
});

function stagePackage(
  browser,
  dir,
  origin,
  { grantHostPermissions = true, sourceHostOnly = false, scenario, restartBackground = false } = {},
) {
  const zip = path.join(dir, `dezoomify-${browser}.zip`);
  // Format fixtures share one package per browser. The harness selects each
  // fixture through the driver URL after the onInstalled page opens idle.
  if (scenario?.startsWith("fixtures/")) scenario = "idle";
  const key = JSON.stringify([
    browser,
    origin,
    grantHostPermissions,
    sourceHostOnly,
    scenario,
    restartBackground,
  ]);
  if (packages.has(key)) {
    copyFileSync(packages.get(key), zip);
    return zip;
  }
  const wxtBrowser = browser === "chromium" ? "chrome" : browser;
  const staged = spawnSync(
    "pnpm",
    ["--dir", EXTENSION_ROOT, "exec", "wxt", "zip", "--browser", wxtBrowser, "--mode", "testing"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DEZOOMIFY_TEST_HOST_PERMISSIONS: grantHostPermissions ? "1" : "0",
        ...(sourceHostOnly ? { DEZOOMIFY_TEST_SOURCE_HOST_ONLY: "1" } : {}),
        DEZOOMIFY_TEST_ORIGIN: origin,
        ...(scenario ? { DEZOOMIFY_TEST_SCENARIO: scenario } : {}),
        ...(restartBackground ? { DEZOOMIFY_TEST_RESTART_BACKGROUND: "1" } : {}),
      },
    },
  );
  assert.equal(staged.status, 0, `WXT package ${browser} failed:\n${staged.stderr}`);
  copyFileSync(path.join(EXTENSION_ROOT, ".output", `dezoomify-${wxtBrowser}.zip`), zip);
  const cached = path.join(fixtureWork, `package-${packages.size}.zip`);
  copyFileSync(zip, cached);
  packages.set(key, cached);
  return zip;
}

async function startFixtureServer(workDir) {
  const addrFile = path.join(workDir, "server.addr");
  const proc = spawn(process.execPath, [
    path.join(REPO_ROOT, "test/fixture-server.mjs"),
    "--parent-stdio",
    "--port",
    "0",
    "--write-address",
    addrFile,
    "--scenarios-dir",
    path.join(REPO_ROOT, "testdata/scenarios"),
    "--static-dir",
    STATIC_DIR,
    "--request-log",
    path.join(workDir, "fixture-requests.jsonl"),
  ]);
  let base = null;
  for (let i = 0; i < 100 && !base; i += 1) {
    const bound = existsSync(addrFile) ? readFileSync(addrFile, "utf8").trim() : "";
    if (bound) base = `http://${bound}`;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(base, "fixture server did not report its address");
  return { proc, base, logFile: path.join(workDir, "fixture-requests.jsonl") };
}

function assertPng(bytes) {
  const decoded = decodePngPixels(bytes);
  assert.deepEqual(
    [decoded.width, decoded.height],
    [EXPECTED_WIDTH, EXPECTED_HEIGHT],
    "saved image dimensions",
  );
  for (const { tile, center } of QUADRANTS) {
    // Each tile file is sampled at its own center; the saved output at the
    // tile's placement center.
    const tilePixels = decodePngPixels(readFileSync(path.join(TILE_DIR, tile)));
    const expected = pixelAt(tilePixels, tilePixels.width >> 1, tilePixels.height >> 1);
    const actual = pixelAt(decoded, ...center);
    assert.deepEqual(actual, expected, `${tile} center pixel`);
  }
}

function assertPngShape(bytes) {
  const { width, height } = decodePngSize(bytes);
  assert.deepEqual([width, height], [EXPECTED_WIDTH, EXPECTED_HEIGHT], "saved image dimensions");
}

async function readCompletedPng(outputDir, deadline) {
  let lastError = "no PNG was created";
  while (Date.now() <= deadline) {
    const outputs = readdirSync(outputDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .map((entry) => path.join(outputDir, entry.name));
    if (outputs.length === 1) {
      try {
        const bytes = readFileSync(outputs[0]);
        // Firefox creates the destination before the download stream has
        // finished. Decode the bytes before returning so the E2E observes a
        // completed save, not merely a visible pathname.
        decodePngPixels(bytes);
        return bytes;
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
    } else if (outputs.length > 1) lastError = `expected one PNG, found ${outputs.length}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Firefox saved an incomplete PNG: ${lastError}`);
}

function newFixtureEvents(logFile, offset) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .slice(offset)
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function waitForFixtureEvent(logFile, offset, predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const event = newFixtureEvents(logFile, offset).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fixture did not record ${label}`);
}

async function waitForJobPage(context) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const page = context
      .pages()
      .find((candidate) => candidate.url().includes("/job.html#sourceTabId="));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the extension did not open its job tab");
}

async function waitForVisible(page, selector, label) {
  try {
    await page.locator(selector).waitFor({ state: "visible", timeout: 30000 });
  } catch (error) {
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "<unavailable>");
    throw new Error(`${label} did not become visible\njob page: ${body}`, { cause: error });
  }
}

async function runChromiumJob(base, work, options = {}) {
  const shared = options.scenario?.startsWith("fixtures/");
  let context = shared ? matrixChromium : null;
  if (!context) {
    const sessionWork = shared ? path.join(fixtureWork, "chromium") : work;
    mkdirSync(sessionWork, { recursive: true });
    const zip = stagePackage("chromium", sessionWork, base, options);
    const pkgDir = path.join(sessionWork, "pkg");
    spawnSync("python3", ["-m", "zipfile", "-e", zip, pkgDir], { encoding: "utf8" });
    context = await chromium.launchPersistentContext(path.join(sessionWork, "profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${pkgDir}`, `--load-extension=${pkgDir}`],
    });
    if (shared) matrixChromium = context;
  }
  // Track downloads at context level so the test sees the extension API's
  // Blob download regardless of which page initiated it.
  const downloads = [];
  const diagnostics = [];
  const observe = (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${String(error?.stack || error?.message || error)}`),
    );
    page.on("crash", () => diagnostics.push("page crash"));
  };
  const onDownload = (download) => downloads.push(download);
  for (const page of context.pages()) {
    page.on("download", onDownload);
    observe(page);
  }
  const onPage = (page) => {
    page.on("download", onDownload);
    observe(page);
  };
  context.on("page", onPage);
  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    assert.ok(serviceWorker, "background service worker did not start");
    // Chromium may finish installing the unpacked package before Playwright
    // can observe the onInstalled-opened page. Reuse that page when it exists
    // so its test driver starts only one job; create a page only as fallback.
    const extensionId = new URL(serviceWorker.url()).hostname;
    const driverUrl = `chrome-extension://${extensionId}/test/driver.html`;
    let driverPage = context.pages().find((page) => page.url().startsWith(driverUrl));
    const driverDeadline = Date.now() + 5000;
    while (!driverPage && Date.now() < driverDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      driverPage = context.pages().find((page) => page.url() === driverUrl);
    }
    if (!driverPage) {
      driverPage = await context.newPage();
      await driverPage.goto(driverUrl);
    }
    if (options.scenario?.startsWith("fixtures/"))
      await driverPage.goto(`${driverUrl}?scenario=${encodeURIComponent(options.scenario)}`);
    await driverPage.waitForFunction(
      () => typeof globalThis.__DEZOOMIFY_TEST_RUN__?.then === "function",
      { timeout: 15000 },
    );
    const driverResult = await driverPage.evaluate(() =>
      globalThis.__DEZOOMIFY_TEST_RUN__.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error?.message ?? error) }),
      ),
    );
    assert.deepEqual(
      driverResult,
      { ok: true },
      `Chromium test driver failed: ${JSON.stringify(driverResult)}`,
    );
    const jobPage = await waitForJobPage(context);
    if (options.beforeCompletion) await options.beforeCompletion(jobPage);
    const deadline = Date.now() + 90000;
    while (downloads.length === 0 && Date.now() < deadline) {
      if (
        await jobPage
          .locator(".dz-error-section")
          .isVisible()
          .catch(() => false)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const download = downloads[0];
    if (!download) {
      const jobText = await jobPage
        .locator("body")
        .innerText()
        .catch(() => "<unavailable>");
      const fixtureLog = existsSync(fixtureServer.logFile)
        ? readFileSync(fixtureServer.logFile, "utf8").trim()
        : "<unavailable>";
      assert.fail(
        `the job tab did not save the assembled image in time\njob page: ${jobText}\nbrowser diagnostics: ${diagnostics.join("\n") || "<none>"}\nfixture requests: ${fixtureLog || "<none>"}`,
      );
    }
    await waitForVisible(jobPage, "#dz-btn-open", "open saved image action");
    await waitForVisible(jobPage, "#dz-btn-reveal", "show containing folder action");
    assert.equal(await jobPage.locator("#dz-btn-save").count(), 0, "no second save action");
    assert.match(
      download.suggestedFilename(),
      /\.png$/i,
      "the generated PNG filename keeps its extension",
    );
    assert.equal(
      downloads.length,
      1,
      `the job starts exactly one image download: ${JSON.stringify(downloads.map((item) => ({ url: item.url(), filename: item.suggestedFilename() })))}\n${diagnostics.join("\n")}`,
    );
    if (options.afterSave) await options.afterSave(jobPage);
    const output = path.join(work, "saved-chromium.png");
    if (options.restartBackground) {
      await waitForVisible(jobPage, ".dz-completed-section", "completed job before worker restart");
      const cdp = await context.browser().newBrowserCDPSession();
      const { targetInfos } = await cdp.send("Target.getTargets");
      const workerTarget = targetInfos.find(
        (target) => target.type === "service_worker" && target.url === serviceWorker.url(),
      );
      assert.ok(workerTarget, "background service worker target is active");
      const closed = await cdp.send("Target.closeTarget", { targetId: workerTarget.targetId });
      assert.equal(closed.success, true, "background service worker target closed");
      await cdp.detach();
      const restarted = await jobPage.evaluate(async () => {
        return (globalThis.browser ?? globalThis.chrome).runtime.sendMessage({
          type: "dezoomify-test-wake-background",
        });
      });
      assert.deepEqual(restarted, { ok: true }, "closed background worker restarted for a message");
      const directResult = await jobPage.evaluate(async () => {
        const access = globalThis.__DEZOOMIFY_TEST_SOURCE_ACCESS__;
        if (!access) throw new Error("job page direct source access is missing");
        const scanned = await access.scan();
        const fetched = await access.fetch(scanned.firstUrl);
        return { count: scanned.count, byteLength: fetched.byteLength };
      });
      assert.ok(directResult.count > 0, "source scan still works after worker restart");
      assert.ok(directResult.byteLength > 0, "source fetch still works after worker restart");
      await driverPage.evaluate(() => globalThis.__DEZOOMIFY_TEST_RELEASE__?.());
    }
    const navigationResult = await driverPage.evaluate(() =>
      globalThis.__DEZOOMIFY_TEST_AFTER_JOB__.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error?.message ?? error) }),
      ),
    );
    assert.deepEqual(navigationResult, { ok: true }, "source navigation invalidates direct access");
    await download.saveAs(output);
    return readFileSync(output);
  } finally {
    context.off("page", onPage);
    if (shared) {
      await context.clearCookies();
      // Closing every tab retires the source-access objects and job runtimes.
      // Keep the extension and browser process, then open a fresh driver tab.
      for (const page of context.pages()) await page.close();
      const page = await context.newPage();
      const worker = context.serviceWorkers()[0];
      await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/test/driver.html`);
    } else await context.close();
  }
}

function findFirefoxBinary() {
  if (process.env.DEZOOMIFY_FIREFOX_BIN) return process.env.DEZOOMIFY_FIREFOX_BIN;
  for (const candidate of ["/usr/bin/firefox-esr", "/usr/bin/firefox"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function runFirefoxJob(base, work, runOptions = {}) {
  const logOffset = existsSync(fixtureServer.logFile)
    ? readFileSync(fixtureServer.logFile, "utf8").length
    : 0;
  const shared = runOptions.scenario?.startsWith("fixtures/");
  const sessionWork = shared ? path.join(fixtureWork, "firefox") : work;
  const binary = findFirefoxBinary();
  assert.ok(binary, "no Firefox binary found; set DEZOOMIFY_FIREFOX_BIN");
  const downloadsDir = path.join(sessionWork, "downloads");
  mkdirSync(downloadsDir, { recursive: true });
  for (const file of readdirSync(downloadsDir)) rmSync(path.join(downloadsDir, file));
  const browserOptions = new firefox.Options();
  browserOptions.addArguments("-headless");
  browserOptions.setPageLoadStrategy("eager");
  browserOptions.setBinary(binary);
  browserOptions.setPreference("browser.download.dir", downloadsDir);
  browserOptions.setPreference("browser.download.folderList", 2);
  browserOptions.setPreference("browser.download.useDownloadDir", true);
  browserOptions.setPreference("browser.helperApps.neverAsk.saveToDisk", "image/png");
  assert.ok(existsSync(GECKODRIVER), "the pinned geckodriver package is not installed");
  // Firefox treats extension documents as privileged WebDriver contexts.
  const service = new firefox.ServiceBuilder(GECKODRIVER).addArguments("--allow-system-access");
  const reused = shared && matrixFirefox;
  const driver =
    reused ||
    (await new webdriver.Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(browserOptions)
      .setFirefoxService(service)
      .build());
  if (shared) matrixFirefox = driver;
  try {
    await driver.manage().setTimeouts({ pageLoad: 15000, script: 15000, implicit: 0 });
    if (!reused) {
      const zip = stagePackage("firefox", sessionWork, base, runOptions);
      const addonId = await driver.installAddon(zip, true);
      assert.equal(addonId, GECKO_ID, `unexpected add-on id ${addonId}`);
    }
    let fixtureStarted = false;
    await driver.wait(
      async () => {
        for (const handle of await driver.getAllWindowHandles()) {
          await driver.switchTo().window(handle);
          const url = await driver.getCurrentUrl();
          if (!url.includes("/test/driver.html")) continue;
          if (runOptions.scenario?.startsWith("fixtures/") && !fixtureStarted) {
            // Navigate the privileged page through WebDriver without injecting
            // script. The shared idle package starts exactly one fixture job.
            await driver.get(`${url}?scenario=${encodeURIComponent(runOptions.scenario)}`);
            fixtureStarted = true;
            return false;
          }
          const [body] = await driver.findElements(webdriver.By.css("body"));
          if (!body) continue;
          const state = await body.getDomAttribute("data-driver");
          if (state === "failed") throw new Error(await body.getText());
          if (state === "ready") return true;
        }
        return false;
      },
      30000,
      undefined,
      50,
    );
    const deadline = Date.now() + 90000;
    const output = await readCompletedPng(downloadsDir, deadline).catch(async (error) => {
      const pages = [];
      for (const handle of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(handle);
        pages.push(`${await driver.getCurrentUrl()}\n${await driver.getPageSource()}`);
      }
      throw new Error(`${error.message}\n${pages.join("\n")}`, { cause: error });
    });
    const handles = await driver.getAllWindowHandles();
    let jobTab;
    for (const handle of handles) {
      await driver.switchTo().window(handle);
      if ((await driver.getCurrentUrl()).includes("/job.html#sourceTabId=")) {
        jobTab = handle;
        break;
      }
    }
    assert.ok(jobTab, "Firefox job tab remains available after saving");
    const { By } = webdriver;
    await driver.wait(
      async () => (await driver.findElements(By.css("#dz-btn-open"))).length === 1,
      15000,
    );
    assert.equal((await driver.findElements(By.css("#dz-btn-reveal"))).length, 1);
    assert.equal(
      (await driver.findElements(By.css("#dz-btn-save"))).length,
      0,
      "no second save action",
    );
    if (runOptions.scenario === "cookie-session") {
      await waitForFixtureEvent(
        fixtureServer.logFile,
        logOffset,
        (event) => event.path === "/__source-access-proof" && event.status === 200,
        "the authenticated direct job-page fetch",
      );
    }
    await waitForFixtureEvent(
      fixtureServer.logFile,
      logOffset,
      (event) => event.path === "/target.html" && event.query === "after-navigation=1",
      "the source-tab navigation invalidation",
    );
    // Wait for the driver to verify invalidation, not just the navigation's
    // HTTP request, before retiring this fixture's source and job tabs.
    let driverTab;
    for (const handle of await driver.getAllWindowHandles()) {
      await driver.switchTo().window(handle);
      if ((await driver.getCurrentUrl()).includes("/test/driver.html")) {
        driverTab = handle;
        break;
      }
    }
    assert.ok(driverTab, "Firefox test driver remains available");
    await driver.wait(
      async () => {
        const body = await driver.findElement(By.css("body"));
        const state = await body.getDomAttribute("data-after-job");
        if (state === "failed") throw new Error(await body.getText());
        return state === "ready";
      },
      15000,
      undefined,
      50,
    );
    if (shared) {
      for (const handle of await driver.getAllWindowHandles()) {
        if (handle === driverTab) continue;
        await driver.switchTo().window(handle);
        await driver.close();
      }
      await driver.switchTo().window(driverTab);
      const idleUrl = new URL(await driver.getCurrentUrl());
      idleUrl.search = "";
      await driver.get(idleUrl.href);
    }
    return output;
  } finally {
    if (!shared) await driver.quit();
  }
}

test("packaged browser format matrices", { concurrency: 2 }, async (matrix) => {
  await Promise.all(
    [
      ["chromium", runChromiumJob],
      ["firefox", runFirefoxJob],
    ].map(([browser, run]) =>
      matrix.test(browser, async (suite) => {
        // Each browser owns one session; its fixtures stay sequential. Only the
        // independent browsers overlap. Special cases below run after both finish.
        for (const fixture of formats) {
          await suite.test(
            `${fixture.name} saves the shared pixels`,
            { timeout: 180000 },
            async () => {
              const work = mkdtempSync(path.join(tmpdir(), "dezoomify-format-"));
              try {
                assertSavedPyramid(
                  await run(fixtureServer.base, work, { scenario: `fixtures/${fixture.name}` }),
                  fixture.tolerance,
                );
              } finally {
                rmSync(work, { recursive: true, force: true });
              }
            },
          );
        }
      }),
    ),
  );
});

test("chromium: packaged extension runs the job-tab flow", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-chromium-"));
  try {
    assertPng(
      await runChromiumJob(fixtureServer.base, work, {
        async afterSave(jobPage) {
          const downloadId = await jobPage.evaluate(async () => {
            const downloads = (globalThis.browser ?? globalThis.chrome).downloads;
            const items = await downloads.search({ state: "complete" });
            if (items.length !== 1) throw new Error("expected one completed save");
            globalThis.outputActions = [];
            downloads.open = async (id) => {
              globalThis.outputActions.push(["open", id]);
              throw new Error("viewer unavailable");
            };
            downloads.show = async (id) => {
              globalThis.outputActions.push(["show", id]);
            };
            return items[0].id;
          });
          await jobPage.locator("#dz-btn-open").click();
          await waitForVisible(jobPage, ".dz-completed-section [role=alert]", "open action error");
          await jobPage.locator("#dz-btn-reveal").click();
          await jobPage.locator(".dz-completed-section [role=alert]").waitFor({ state: "hidden" });
          assert.deepEqual(await jobPage.evaluate(() => globalThis.outputActions), [
            ["open", downloadId],
            ["show", downloadId],
          ]);
        },
      }),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("chromium: optional host grant keeps the React job view mounted", {
  timeout: 180000,
}, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-permission-"));
  try {
    assertPng(
      await runChromiumJob(fixtureServer.base, work, {
        sourceHostOnly: true,
        scenario: "permission",
        async beforeCompletion(jobPage) {
          const grant = jobPage.locator("[data-dz-allow-access=true]");
          await waitForVisible(jobPage, "[data-dz-allow-access=true]", "permission action");
          await grant.click();
          await waitForVisible(
            jobPage,
            ".dz-completed-section",
            "completed job after permission grant",
          );
        },
      }),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("chromium: partial-output actions disappear after the terminal event", {
  timeout: 180000,
}, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-partial-"));
  try {
    assertPngShape(
      await runChromiumJob(fixtureServer.base, work, {
        scenario: "corrupt",
        async beforeCompletion(jobPage) {
          const keep = jobPage.locator("[data-dz-partial-choice=keep]");
          await waitForVisible(jobPage, "[data-dz-partial-choice=keep]", "partial-output action");
          await keep.click();
          await waitForVisible(jobPage, ".dz-completed-section", "partial completion");
          assert.equal(await jobPage.locator("[data-dz-partial-choice]").count(), 0);
        },
      }),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("chromium: packaged extension retains session cookies and page referrer for protected tiles", {
  timeout: 180000,
}, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-cookie-session-"));
  try {
    // The fixture page creates an HttpOnly session cookie. Its metadata and
    // every tile return 403 unless the browser attaches that cookie and the page referrer, while
    // this test observes only the successful image, not request headers.
    assertPng(await runChromiumJob(fixtureServer.base, work, { scenario: "cookie-session" }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("chromium: job-page source access survives a background service-worker restart", {
  timeout: 180000,
}, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-background-restart-"));
  try {
    assertPng(
      await runChromiumJob(fixtureServer.base, work, {
        scenario: "cookie-session",
        restartBackground: true,
      }),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("chromium: packaged extension follows signed metadata and tile redirects without credentials", {
  timeout: 180000,
}, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-tile-redirect-"));
  try {
    // Signed-Zoomify shape: the Zoomify metadata and every tile 307 to a
    // signed URL. Tile URLs keep the requested base although the metadata
    // redirected, and the transport follows credential-free, so the CORS
    // `*` responses stay readable and the job still assembles the image.
    assertPng(await runChromiumJob(fixtureServer.base, work, { scenario: "tile-redirect" }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("firefox: packaged extension runs the job-tab flow", { timeout: 180000 }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-firefox-"));
  try {
    assertPng(await runFirefoxJob(fixtureServer.base, work));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

for (const [browser, runJob] of [
  ["chromium", runChromiumJob],
  ["firefox", runFirefoxJob],
]) {
  test(`${browser}: observed Zoomify metadata wins without analytics access`, {
    timeout: 180000,
  }, async () => {
    const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-observed-zoomify-"));
    const offset = existsSync(fixtureServer.logFile)
      ? readFileSync(fixtureServer.logFile, "utf8").length
      : 0;
    try {
      // No permission action is clicked. localhost is the ungranted analytics
      // origin; the source observation contains only the metadata request URL.
      assertPng(
        await runJob(fixtureServer.base, work, {
          sourceHostOnly: true,
          scenario: "observed-zoomify",
        }),
      );
      const events = newFixtureEvents(fixtureServer.logFile, offset);
      assert.equal(
        events.filter((event) => event.path === "/observed-zoomify/opt-out.html").length,
        1,
        "only the source page loads the analytics iframe",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

test("firefox: source fetching retains cookies and page referrer and rejects navigation", {
  timeout: 180000,
}, async () => {
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-e2e-firefox-source-access-"));
  try {
    assertPng(await runFirefoxJob(fixtureServer.base, work, { scenario: "cookie-session" }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
