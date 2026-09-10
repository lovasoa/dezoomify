import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const output = (browser) => new URL(`../../.output/${browser}-mv3/`, import.meta.url);
const manifest = (browser) => JSON.parse(readFileSync(new URL("manifest.json", output(browser)), "utf8"));
const REVIEWED_PERMISSIONS = ["activeTab", "scripting", "nativeMessaging"];

for (const browser of ["chrome", "firefox"]) {
  test(`${browser}: WXT emits the reviewed MV3 manifest`, () => {
    const value = manifest(browser);
    assert.equal(value.manifest_version, 3);
    assert.deepEqual(value.permissions, REVIEWED_PERMISSIONS);
    assert.deepEqual(value.optional_permissions, ["cookies"]);
    assert.deepEqual(value.optional_host_permissions, ["http://*/*", "https://*/*"]);
    assert.ok(value.host_permissions === undefined || value.host_permissions.length === 0);
    assert.equal(value.content_scripts, undefined);
    assert.equal(value.web_accessible_resources, undefined);
    assert.equal(value.offscreen, undefined);
    for (const forbidden of ["tabs", "downloads", "cookies"]) {
      assert.ok(!value.permissions.includes(forbidden), `${browser} must not permanently request ${forbidden}`);
    }
    assert.equal(value.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'");
    assert.deepEqual(value.action.default_icon, {
      16: "icons/icon16-grey.png",
      48: "icons/icon48-grey.png",
      128: "icons/icon128-grey.png",
    });
    assert.deepEqual(value.icons, {
      16: "icons/icon16.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    });
  });
}

test("WXT keeps Chromium as an MV3 service worker", () => {
  const value = manifest("chrome");
  assert.equal(value.background?.service_worker, "background.js");
  assert.equal(value.background?.scripts, undefined);
  assert.equal(value.minimum_chrome_version, "121");
});

test("WXT emits Firefox's required classic MV3 background script", () => {
  const value = manifest("firefox");
  assert.deepEqual(value.background?.scripts, ["background.js"]);
  assert.equal(value.background?.service_worker, undefined);
  assert.equal(value.background?.type, undefined);
  assert.equal(value.browser_specific_settings?.gecko?.id, "{14074c89-8a5f-4813-98df-a7117f062871}");
  assert.equal(value.browser_specific_settings?.gecko?.strict_min_version, "128.0");
  const background = new URL("background.js", output("firefox"));
  const parsed = spawnSync(process.execPath, ["--check", fileURLToPath(background)], { encoding: "utf8" });
  assert.equal(parsed.status, 0, `Firefox classic script failed node --check:\n${parsed.stderr}`);
  assert.ok(!readFileSync(background, "utf8").match(/^\s*(import|export)\s/m), "Firefox background must be classic");
});

test("WXT configuration is the only extension builder and manifest source", () => {
  const config = readFileSync(new URL("../../wxt.config.ts", import.meta.url), "utf8");
  assert.ok(config.includes("manifestVersion: 3"));
  assert.ok(config.includes("build:before"), "WASM and test assets must use a WXT hook");
  assert.ok(!existsSync(new URL("../../scripts/build.mjs", import.meta.url)));
  assert.ok(!existsSync(new URL("../../scripts/generate-manifests.mjs", import.meta.url)));
  assert.ok(!existsSync(new URL("../../scripts/package-store.sh", import.meta.url)));
  assert.ok(existsSync(new URL("../../entrypoints/background.ts", import.meta.url)));
  assert.ok(existsSync(new URL("../../entrypoints/job/index.html", import.meta.url)));
  assert.ok(!existsSync(new URL("../../src/job/job.html", import.meta.url)));
});
