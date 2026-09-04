import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readJson(rel) {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
}

function deepMerge(base, overlay) {
  if (Array.isArray(overlay)) return [...overlay];
  if (overlay !== null && typeof overlay === "object" && base !== null && typeof base === "object" && !Array.isArray(base)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(overlay)) out[k] = deepMerge(base[k], v);
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
const EXPECTED_GECKO_ID = "dezoomify-ng@example.com";

function allHostLike(manifest) {
  return [...(manifest.host_permissions ?? []), ...(manifest.permissions ?? []).filter((p) => p.includes("://") || p.includes("*"))];
}

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
  test(`${name}: no wildcard permanent hosts`, () => {
    for (const h of manifest.host_permissions ?? []) {
      assert.ok(!h.includes("<all_urls>"), `${name} permanent <all_urls>`);
      assert.ok(!h.includes("*"), `${name} permanent wildcard ${h}`);
    }
    for (const p of allHostLike(manifest)) {
      assert.ok(!p.includes("<all_urls>"), `${name} wildcard permanent ${p}`);
    }
    // optional hosts may be broad but permanent must stay empty/narrow
    assert.deepEqual(manifest.host_permissions, []);
  });

  test(`${name}: no remote code`, () => {
    const raw = JSON.stringify(manifest);
    assert.ok(!raw.includes("http://") || raw.includes("http://*/*"), `${name} unexpected remote http`);
    for (const u of backgroundUrls(manifest)) {
      assert.ok(!u.startsWith("http://") && !u.startsWith("https://"), `${name} remote background ${u}`);
      assert.ok(!u.startsWith("data:"), `${name} data background ${u}`);
    }
    assert.ok(!raw.includes("javascript:"), `${name} javascript: URL`);
    assert.ok(!raw.includes("<script"), `${name} inline script`);
  });

  test(`${name}: no eval, strict CSP`, () => {
    const csp = cspText(manifest);
    assert.ok(csp.length > 0, `${name} missing CSP`);
    assert.ok(!csp.includes("unsafe-eval"), `${name} unsafe-eval`);
    assert.ok(!csp.includes("unsafe-inline") || csp.includes("script-src"), `${name} weak CSP`);
    assert.ok(csp.includes("script-src 'self'"), `${name} CSP must pin script-src 'self'`);
    assert.ok(csp.includes("object-src 'none'"), `${name} CSP must block objects`);
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

test("firefox gecko ID matches reviewed release config; chromium has no gecko ID", () => {
  assert.equal(genFirefox.browser_specific_settings?.gecko?.id, EXPECTED_GECKO_ID);
  assert.equal(genChromium.browser_specific_settings, undefined);
});

test("chromium is MV3 service-worker; firefox documents MV2 compat", () => {
  assert.equal(genChromium.manifest_version, 3);
  assert.ok(typeof genChromium.background?.service_worker === "string");
  assert.equal(genFirefox.manifest_version, 2);
  assert.ok(Array.isArray(genFirefox.background?.scripts));
  assert.ok(typeof firefoxOverlay._compatNote === "string" && firefoxOverlay._compatNote.length > 20);
  assert.ok(typeof chromiumOverlay._compatNote === "string" && chromiumOverlay._compatNote.length > 20);
});

test("generated manifests are deterministic merges of base+overlay", () => {
  assert.deepEqual(sortKeys(genChromium), sortKeys(deepMerge(base, chromiumOverlay)));
  assert.deepEqual(sortKeys(genFirefox), sortKeys(deepMerge(base, firefoxOverlay)));
  // script-free JSON: re-serialize deterministically without loss
  for (const [name, gen] of [["chromium", genChromium], ["firefox", genFirefox]]) {
    const raw = readFileSync(new URL(`../../generated/manifest.${name}.json`, import.meta.url), "utf8");
    assert.ok(raw.endsWith("\n"), `${name} missing trailing newline`);
    assert.deepEqual(JSON.parse(raw), gen);
  }
});

test("least-privilege: activeTab present, no <all_urls> anywhere permanent", () => {
  for (const gen of [genChromium, genFirefox]) {
    assert.ok((gen.permissions ?? []).includes("activeTab"));
    assert.ok((gen.permissions ?? []).includes("nativeMessaging"));
    assert.ok(!(gen.permissions ?? []).some((p) => String(p).includes("<all_urls>")));
  }
});
