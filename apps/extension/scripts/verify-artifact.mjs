import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const [directory, browser] = process.argv.slice(2);
if (!directory || !["chrome", "firefox"].includes(browser)) {
  throw new Error("usage: node scripts/verify-artifact.mjs <output-directory> <chrome|firefox>");
}

async function filesAt(directory, prefix = "") {
  const names = await readdir(directory);
  const files = [];
  for (const name of names) {
    const relative = path.join(prefix, name);
    const location = path.join(directory, name);
    if ((await stat(location)).isDirectory()) files.push(...await filesAt(location, relative));
    else files.push(relative);
  }
  return files;
}

const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "nativeMessaging"]);
assert.deepEqual(manifest.optional_permissions, ["cookies"]);
assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
assert.deepEqual(manifest.host_permissions ?? [], []);
assert.deepEqual(manifest.content_scripts, undefined);
assert.deepEqual(manifest.web_accessible_resources, undefined);
assert.ok(!manifest.permissions.includes("tabs"));
assert.ok(!manifest.permissions.includes("downloads"));
assert.ok(!manifest.permissions.includes("cookies"));
assert.ok(!manifest.offscreen);

if (browser === "chrome") {
  assert.equal(manifest.background?.service_worker, "background.js");
  assert.equal(manifest.background?.scripts, undefined);
  assert.equal(manifest.minimum_chrome_version, "121");
} else {
  assert.deepEqual(manifest.background?.scripts, ["background.js"]);
  assert.equal(manifest.background?.service_worker, undefined);
  assert.equal(manifest.background?.type, undefined);
  assert.equal(manifest.browser_specific_settings?.gecko?.id, "{14074c89-8a5f-4813-98df-a7117f062871}");
  assert.equal(manifest.browser_specific_settings?.gecko?.strict_min_version, "128.0");
}

const files = await filesAt(directory);
assert.ok(files.includes("background.js"), "missing WXT background bundle");
assert.ok(files.includes("job.html"), "missing dedicated job page");
assert.ok(files.includes("wasm/dezoomify-wasm.js"), "missing WASM glue");
assert.ok(files.includes("wasm/dezoomify-wasm_bg.wasm"), "missing WASM binary");
assert.ok(files.some((file) => /^assets\/worker-.*\.js$/.test(file)), "missing WXT worker bundle");
assert.ok(files.every((file) => !file.endsWith(".ts") && !file.endsWith(".map")), "source files leaked into package");
assert.ok(files.every((file) => !file.startsWith("test/")), "test-only driver leaked into store package");
const classic = spawnSync(process.execPath, ["--check", path.join(directory, "background.js")], { encoding: "utf8" });
assert.equal(classic.status, 0, `background failed node --check:\n${classic.stderr}`);
if (browser === "firefox") {
  const source = await readFile(path.join(directory, "background.js"), "utf8");
  assert.ok(!/^\s*(import|export)\s/m.test(source), "Firefox background must be classic");
}

console.log(`WXT ${browser} artifact: verified ${files.length} files`);
