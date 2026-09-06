import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readJson(rel) {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
}

// Mirror of scripts/generate-manifests.mjs: deterministic merge, underscore
// keys stripped. The generated manifests must match exactly.
function merge(base, overlay) {
  if (Array.isArray(overlay)) return [...overlay];
  if (overlay !== null && typeof overlay === "object" && base !== null && typeof base === "object" && !Array.isArray(base)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(overlay)) out[k] = merge(base[k], v);
    return out;
  }
  return overlay;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, sortKeys(val)]));
  }
  return v;
}

const base = readJson("../../src/manifest/base.json");
const chromiumOverlay = readJson("../../src/manifest/chromium.json");
const firefoxOverlay = readJson("../../src/manifest/firefox.json");
const genChromium = readJson("../../generated/manifest.chromium.json");
const genFirefox = readJson("../../generated/manifest.firefox.json");

const REVIEWED_PERMS = new Set(["activeTab", "scripting", "webRequest", "downloads", "nativeMessaging", "tabs", "cookies"]);
const REVIEWED_OPTIONAL = new Set(["cookies"]);
const EXPECTED_GECKO_ID = "dezoomify@example.com";

function cspText(manifest) {
  const csp = manifest.content_security_policy;
  if (!csp) return "";
  if (typeof csp === "string") return csp;
  return Object.values(csp).join(" ");
}

function backgroundUrls(manifest) {
  const bg = manifest.background ?? {};
  const urls = [];
  if (typeof bg.service_worker === "string") urls.push(bg.service_worker);
  for (const s of bg.scripts ?? []) urls.push(s);
  if (typeof bg.page === "string") urls.push(bg.page);
  return urls;
}

for (const [name, manifest] of [["chromium", genChromium], ["firefox", genFirefox]]) {
  test(`${name}: MV3 with the dual cross-browser background`, () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background?.service_worker, "background/index.js");
    assert.deepEqual(manifest.background?.scripts, ["background/index.js"]);
  });

  test(`${name}: no wildcard permanent hosts`, () => {
    for (const p of manifest.permissions ?? []) {
      assert.ok(!(p.includes("://") || p.includes("*")), `${name} permanent host pattern ${p}`);
    }
    assert.deepEqual(manifest.host_permissions, []);
    assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  });

  test(`${name}: no remote code`, () => {
    const withoutOptionalHosts = JSON.stringify({ ...manifest, optional_host_permissions: undefined });
    assert.ok(!withoutOptionalHosts.includes("http://"), `${name} unexpected remote http`);
    assert.ok(!withoutOptionalHosts.includes("javascript:"), `${name} javascript: URL`);
    for (const u of backgroundUrls(manifest)) {
      assert.ok(!u.startsWith("http"), `${name} remote background ${u}`);
      assert.ok(!u.startsWith("data:"), `${name} data background ${u}`);
    }
  });

  test(`${name}: strict CSP with wasm enabled for the page core`, () => {
    const csp = cspText(manifest);
    assert.ok(csp.includes("script-src 'self'"), `${name} CSP must pin script-src 'self'`);
    assert.ok(csp.includes("'wasm-unsafe-eval'"), `${name} CSP must allow the wasm core`);
    assert.ok(csp.includes("object-src 'none'"), `${name} CSP must block objects`);
    assert.ok(!csp.replaceAll("'wasm-unsafe-eval'", "").includes("unsafe-eval"), `${name} unsafe-eval`);
    assert.ok(!csp.includes("unsafe-inline"), `${name} unsafe-inline`);
  });

  test(`${name}: only reviewed permissions`, () => {
    for (const p of manifest.permissions ?? []) {
      assert.ok(REVIEWED_PERMS.has(p), `${name} unreviewed permission ${p}`);
    }
    for (const p of manifest.optional_permissions ?? []) {
      assert.ok(REVIEWED_OPTIONAL.has(p), `${name} unreviewed optional permission ${p}`);
    }
    assert.ok(!(manifest.permissions ?? []).includes("cookies"), `${name} cookies must be optional, not permanent`);
  });
}

test("chromium: minimum version supports the dual background (121+)", () => {
  assert.ok(Number(genChromium.minimum_chrome_version) >= 121, "Chrome ignores background.scripts before 121");
});

test("firefox: gecko id matches reviewed release config; min version is MV3-capable", () => {
  assert.equal(genFirefox.browser_specific_settings?.gecko?.id, EXPECTED_GECKO_ID);
  assert.ok(Number(genFirefox.browser_specific_settings.gecko.strict_min_version) >= 128);
  assert.equal(genChromium.browser_specific_settings, undefined);
});

test("least-privilege: activeTab present, nativeMessaging declared", () => {
  for (const gen of [genChromium, genFirefox]) {
    assert.ok((gen.permissions ?? []).includes("activeTab"));
    assert.ok((gen.permissions ?? []).includes("nativeMessaging"));
  }
});

test("generated manifests are the deterministic generator output (base+overlay, no underscore keys)", () => {
  for (const [name, overlay, gen] of [
    ["chromium", chromiumOverlay, genChromium],
    ["firefox", firefoxOverlay, genFirefox],
  ]) {
    const merged = Object.fromEntries(Object.entries(merge(base, overlay)).filter(([k]) => !k.startsWith("_")));
    assert.deepEqual(sortKeys(gen), sortKeys(merged), `${name} must match scripts/generate-manifests.mjs output`);
    const raw = readFileSync(new URL(`../../generated/manifest.${name}.json`, import.meta.url), "utf8");
    assert.ok(raw.endsWith("\n"), `${name} missing trailing newline`);
    assert.deepEqual(JSON.parse(raw), gen);
    for (const key of Object.keys(gen)) {
      assert.ok(!key.startsWith("_"), `${name} generated manifest must not ship ${key}`);
    }
  }
});
