// Headless extension gate: load the REAL store-shaped packages (exactly what
// package-store.sh ships to the Chromium Web Store and AMO) in headless
// Chromium (MV3 service worker) and headless Firefox (MV2 background page),
// and assert the background actually starts and runs. Hermetic: no page
// navigation, no network, loopback-free.
//
// The Firefox assertion is the load-bearing one: MV2 background scripts are
// classic scripts, so any `export`/`import` in the shipped sources is a
// SyntaxError that unit tests (which import the same files as ESM) can never
// see. Chromium asserts the module service worker starts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const PACKAGE_SCRIPT = path.join(REPO_ROOT, "apps/extension/scripts/package-store.sh");

// Stage the package the same way the store-submission workflow does, then
// extract it so Chromium's --load-extension (which wants a directory) works.
function stagePackage(browser, dir) {
  const zip = path.join(dir, `dezoomify-${browser}.zip`);
  const staged = spawnSync("bash", [PACKAGE_SCRIPT, browser, zip], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(staged.status, 0, `package-store.sh ${browser} failed:\n${staged.stderr}`);
  const extracted = path.join(dir, `${browser}-package`);
  const unzip = spawnSync("python3", ["-m", "zipfile", "-e", zip, extracted], {
    encoding: "utf8",
  });
  assert.equal(unzip.status, 0, `unzip failed:\n${unzip.stderr}`);
  return extracted;
}

test("chromium: packaged MV3 extension starts its module service worker", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dezoomify-ext-chromium-"));
  try {
    const packageDir = stagePackage("chromium", dir);
    const context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${packageDir}`,
        `--load-extension=${packageDir}`,
      ],
    });
    try {
      const worker = await context
        .waitForEvent("serviceworker", { timeout: 20000 })
        .catch(() => null);
      assert.ok(worker, "extension service worker never started");
      assert.ok(
        worker.url().endsWith("background/index.js"),
        `unexpected service worker url ${worker.url()}`,
      );
      assert.equal(await worker.evaluate(() => 1 + 1), 2, "service worker unresponsive");
    } finally {
      await context.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firefox: packaged MV2 extension runs its classic background script", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dezoomify-ext-firefox-"));
  try {
    const packageDir = stagePackage("firefox", dir);
    const context = await firefox.launchPersistentContext(path.join(dir, "profile"), {
      headless: true,
      addons: [packageDir],
    });
    try {
      // MV2 background.scripts run in a hidden background page.
      let page = null;
      for (let i = 0; i < 40 && !page; i += 1) {
        page = context.backgroundPages().at(-1) ?? null;
        if (!page) await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(page, "extension background page never appeared");
      // If the classic script failed to parse, its globals are undefined.
      const kind = await page.evaluate(() => typeof globalThis.createBackground);
      assert.equal(kind, "function", "background/index.js did not execute (parse or runtime failure)");
    } finally {
      await context.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
