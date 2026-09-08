import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

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

const REVIEWED_PERMS = new Set(["activeTab", "scripting", "nativeMessaging"]);
const REVIEWED_OPTIONAL = new Set(["cookies"]);
const EXPECTED_GECKO_ID = "{14074c89-8a5f-4813-98df-a7117f062871}";

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
  test(`${name}: MV3 with the per-browser background entry`, () => {
    assert.equal(manifest.manifest_version, 3);
    if (name === "chromium") {
      assert.equal(manifest.background?.service_worker, "background/index.js");
      assert.equal(manifest.background?.scripts, undefined, "chromium must not ship Firefox event-page scripts key");
    } else {
      assert.deepEqual(manifest.background?.scripts, ["background/index.js"]);
      assert.equal(manifest.background?.service_worker, undefined, "firefox must not ship Chromium service_worker key");
    }
  });

  test(`${name}: no wildcard permanent hosts`, () => {
    for (const p of manifest.permissions ?? []) {
      assert.ok(!(p.includes("://") || p.includes("*")), `${name} permanent host pattern ${p}`);
    }
    assert.deepEqual(manifest.host_permissions, []);
    assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  });

  test(`${name}: no remote code`, () => {
    // Match patterns (optional hosts, iframe exposure) are grants, not
    // code: strip them before scanning for remote references.
    const withoutGrants = JSON.stringify({
      ...manifest,
      optional_host_permissions: undefined,
      web_accessible_resources: undefined,
    });
    assert.ok(!withoutGrants.includes("http://"), `${name} unexpected remote http`);
    assert.ok(!withoutGrants.includes("javascript:"), `${name} javascript: URL`);
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
    // Chrome Web Store rejects unused permissions: the page saves via a blob
    // anchor, which needs no `downloads` permission, so it must stay absent.
    assert.ok(!(manifest.permissions ?? []).includes("downloads"), `${name} unused downloads permission`);
    // Least privilege: the page works on the bound tab only (`tabs.get`),
    // never enumerates tabs, so `tabs` must stay absent. `scripting` is
    // reviewed and used: the background injects the in-tab modal on the
    // clicked tab only, after detection (never declared content scripts).
    assert.ok(!(manifest.permissions ?? []).includes("tabs"), `${name} tabs permission forbids tab enumeration`);
    assert.ok((manifest.permissions ?? []).includes("scripting"), `${name} scripting permission required for detected-tab modal injection`);
    assert.equal(manifest.content_scripts, undefined, `${name} no content scripts declared`);
  });

  test(`${name}: declared icons exist (grey idle action, blue brand icons)`, () => {
    for (const [size, path] of Object.entries(manifest.icons ?? {})) {
      assert.ok(["16", "48", "128"].includes(size), `${name} unexpected icon size ${size}`);
      assert.ok(path.startsWith("icons/"), `${name} icon must be bundled ${path}`);
    }
    assert.deepEqual(Object.keys(manifest.icons ?? {}).sort(), ["128", "16", "48"]);
    // Toolbar action defaults to the grey idle set (background swaps blue
    // while monitoring via action.setIcon); brand icons stay blue.
    assert.deepEqual(manifest.action?.default_icon, {
      16: "icons/icon16-grey.png",
      48: "icons/icon48-grey.png",
      128: "icons/icon128-grey.png",
    }, `${name} action icon must be the grey idle set`);
    assert.deepEqual(manifest.icons, {
      16: "icons/icon16.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    }, `${name} brand icons must be the blue set`);
  });
}

test("chromium: minimum version supports wasm-unsafe-eval (121+)", () => {
  assert.ok(Number(genChromium.minimum_chrome_version) >= 121, "wasm-unsafe-eval CSP needs Chrome 121+");
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

test("declared permissions are used by shipped code", () => {
  const modal = readFileSync(new URL("../../src/modal/modal.ts", import.meta.url), "utf8");
  assert.ok(modal.includes("sendNativeMessage"), "nativeMessaging must be used by modal handoff");
  assert.ok(modal.includes("api.cookies.getAll"), "cookies must be used by consented handoff");
  assert.ok(!modal.includes("chrome.downloads"), "downloads API must stay unused (blob anchor save)");
  // The background click-to-monitor owns the single reload and the
  // grey<->blue+dot icon transitions, and injects the in-tab modal on the
  // clicked tab only, after its monitored reload completes (pre-reload
  // injection would be wiped by the reload). It observes NO traffic: a
  // `webRequest` listener without host permissions is deaf (activeTab does
  // not enable observation), and candidates come from the injected tab's
  // own timeline instead.
  const background = readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8");
  const backgroundCode = background
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  assert.ok(!backgroundCode.includes("webRequest"), "background must not touch webRequest (deaf without host perms)");
  assert.ok(background.includes("tabs.reload"), "background must perform the single monitored reload");
  assert.ok(background.includes("setIcon"), "background must swap grey<->blue icons");
  assert.ok(background.includes("setBadgeText"), "background must show the monitoring badge dot");
  assert.ok(background.includes("executeScript"), "background must inject the modal on the detected tab");
  assert.ok(background.includes("insertCSS"), "background must inject the modal host CSS on the detected tab");
  assert.ok(background.includes("content/modal.js"), "background must inject only the reviewed loader entry");
  assert.ok(background.includes("content/modal.css"), "background must inject only the reviewed host CSS");
  assert.ok(!background.includes("tabs.query"), "background must never enumerate tabs");
  // Loader protocol parity: background and content/modal.js share the
  // `{ type }` runtime messages (streaming update with urls, tab-side byte
  // confirmation, close, failure). URL-text-only `dezoomify-detected` is
  // retired: the background never emits it (many formats require response
  // bytes); the loader still accepts it as candidates-only (covered in
  // modal-in-tab.test.mjs).
  for (const kind of ["dezoomify-monitor-update", "dezoomify-byte-confirmed", "dezoomify-modal-closed", "dezoomify-modal-failed"]) {
    assert.ok(background.includes(kind), `background must speak ${kind}`);
  }
  assert.ok(background.includes("urls"), "background monitor-update must stream candidate urls");
  assert.ok(!background.includes("dezoomify-detected"), "background must not emit retired URL-text detection");
  const loader = readFileSync(new URL("../../src/content/modal.js", import.meta.url), "utf8");
  for (const kind of ["dezoomify-monitor-update", "dezoomify-byte-confirmed", "dezoomify-modal-closed", "dezoomify-modal-failed"]) {
    assert.ok(loader.includes(kind), `injected loader must speak ${kind}`);
  }
});

test("click-to-monitor least privilege: reload+inject, no enumeration, no offscreen, no webRequest", () => {
  const background = readFileSync(new URL("../../src/background/index.ts", import.meta.url), "utf8");
  const code = background
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  // The clicked tab id comes from the action event only; the background
  // never enumerates tabs, never requests broad hosts, and never observes
  // traffic (a host-permissionless webRequest listener is deaf; the
  // injected tab collects its own candidates permission-free).
  assert.ok(code.includes("onClicked"), "monitor must arm on the explicit action click");
  assert.ok(!code.includes("tabs.query"), "background must never enumerate tabs");
  assert.ok(!code.includes("webRequest"), "background must not observe traffic (deaf without host perms)");
  assert.ok(!code.includes("permissions.request"), "background must not prompt (activeTab covers reload+inject)");
  assert.ok(code.includes("onRemoved"), "monitor must stop when the tab closes");
  assert.ok(code.includes("onUpdated"), "monitor must stop when the tab navigates");
  assert.ok(!code.includes("onInstalled"), "install must not open a fallback extension page");
  assert.ok(!code.includes("offscreen"), "no offscreen document (unnecessary for a reload monitor)");
  assert.ok(!code.includes("host_permissions"), "background must not touch broad host permissions");
  // No offscreen declared in either generated manifest either.
  for (const gen of [genChromium, genFirefox]) {
    assert.equal(gen.offscreen, undefined, "offscreen must stay undeclared");
  }
});

test("store package ships only loaded files (no dead code)", () => {
  const script = readFileSync(new URL("../../scripts/package-store.sh", import.meta.url), "utf8");
  // No content_scripts declared: the programmatically injected loader plus
  // the job iframe (modal/, clicked tab only) ship; src/content/* stays
  // unit-test only. There is no extension-page fallback.
  assert.ok(script.includes("content/modal.js"), "package must stage the injected loader entry");
  assert.ok(script.includes("content/modal.css"), "package must stage the injected host CSS");
  assert.ok(script.includes("modal/modal.html"), "package must stage the job iframe document");
  assert.ok(script.includes("modal/modal.js"), "package must stage the job iframe runner");
  assert.ok(script.includes('SRC/runtime/$f'), "package must stage the modal runtime");
  assert.ok(script.includes("vendor/view.js"), "package must stage the modal UI mirror");
  assert.ok(script.includes("icons background content modal runtime vendor wasm"), "package must zip only the in-browser flow");
  // The grey idle set swapped via action.setIcon must ship with the brand icons.
  assert.ok(script.includes("icon16-grey.png"), "package must stage the grey idle icons");
  // E2E-only manifest variant must not inject a tabs permission: shipped
  // code (and the harness) never enumerates tabs.
  assert.ok(!script.includes('"tabs"'), "package must never inject tabs permission");
  assert.ok(!script.includes("page/page.html"), "package must not stage a fallback page");
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

// --- Click-to-monitor modal policy (additive; least privilege) ---
//
// Monitoring (grey idle action icon, blue brand icons + badge dot while
// watching) performs a single reload, then injects the in-tab modal on the
// clicked tab only (`scripting` after reload-complete, never declared
// content scripts): no tab enumeration, no permanent hosts, no downloads,
// no traffic observation in the background (in-tab timeline instead),
// tab-origin fetch only, and no metadata proxy. The bound-page fallback
// observes via webRequest only after a one-time optional grant for exactly
// the bound tab's origin, requested on the explicit Scan gesture.

test("monitoring adds no permissions (no tabs/downloads/cookies/hosts; scripting reviewed)", () => {
  for (const [name, manifest] of [["chromium", genChromium], ["firefox", genFirefox]]) {
    for (const forbidden of ["tabs", "downloads", "cookies"]) {
      assert.ok(!(manifest.permissions ?? []).includes(forbidden), `${name} monitoring must not add ${forbidden}`);
    }
    // `scripting` is the one reviewed addition: detected-tab-only modal
    // injection (executeScript/insertCSS on the clicked tab, used by the
    // background monitor).
    assert.ok((manifest.permissions ?? []).includes("scripting"), `${name} modal injection requires scripting`);
    assert.deepEqual(manifest.host_permissions, [], `${name} monitoring adds no permanent hosts`);
    assert.deepEqual(
      manifest.optional_host_permissions,
      ["http://*/*", "https://*/*"],
      `${name} per-site grants stay optional`,
    );
  }
});

test("content-script authority stays tab-origin bounded (absent or http/https only)", () => {
  for (const [name, manifest] of [["chromium", genChromium], ["firefox", genFirefox]]) {
    const scripts = manifest.content_scripts;
    if (scripts === undefined) return; // current shape: no content scripts declared
    assert.ok(Array.isArray(scripts), `${name} content_scripts must be a list`);
    for (const entry of scripts) {
      for (const match of entry.matches ?? []) {
        assert.ok(!match.includes("<all_urls>"), `${name} content script must never match <all_urls>: ${match}`);
        assert.ok(
          match.startsWith("http://") || match.startsWith("https://"),
          `${name} content script match must be http/https: ${match}`,
        );
      }
      for (const file of [...(entry.js ?? []), ...(entry.css ?? [])]) {
        assert.ok(!file.startsWith("http"), `${name} content script must be bundled: ${file}`);
      }
    }
  }
});

test("job iframe stays web-accessible on http/https only (hostile-page embed)", () => {
  for (const [name, manifest] of [["chromium", genChromium], ["firefox", genFirefox]]) {
    const war = manifest.web_accessible_resources ?? [];
    const entries = war.filter((entry) => (entry.resources ?? []).includes("modal/modal.html"));
    assert.ok(entries.length > 0, `${name} must expose modal/modal.html for the in-tab iframe`);
    for (const entry of entries) {
      for (const match of entry.matches ?? []) {
        assert.ok(!match.includes("<all_urls>"), `${name} iframe exposure must never use <all_urls>: ${match}`);
        assert.ok(
          match.startsWith("http://") || match.startsWith("https://"),
          `${name} iframe exposure must be http/https: ${match}`,
        );
      }
    }
    // The iframe document ships in the store package.
    const abs = new URL("../../src/modal/modal.html", import.meta.url);
    assert.ok(existsSync(abs), `${name} web-accessible modal.html missing on disk`);
  }
});

test("monitoring icons are bundled when declared (idle grey vs monitoring blue+dot)", () => {
  for (const [name, manifest] of [["chromium", genChromium], ["firefox", genFirefox]]) {
    const icons = { ...(manifest.icons ?? {}), ...((manifest.action?.default_icon ?? {})) };
    assert.ok(Object.keys(icons).length > 0, `${name} must declare icons`);
    for (const rel of Object.values(icons)) {
      assert.ok(rel.startsWith("icons/"), `${name} icon must be bundled ${rel}`);
      const abs = new URL(`../../src/${rel}`, import.meta.url);
      assert.ok(existsSync(abs), `${name} declared icon missing on disk: ${rel}`);
    }
    // No remote icon URLs ever.
    assert.ok(!JSON.stringify(icons).includes("http"), `${name} icons must be local`);
  }
});

test("description stays explicit click-to-monitor with indefinite bounds", () => {
  const text = String(base.description ?? "");
  assert.ok(/click to monitor/i.test(text), "description must name the explicit click-to-monitor action");
  assert.ok(/indefinite/i.test(text), "description must name indefinite monitoring");
  assert.ok(/no background monitoring/i.test(text), "description must promise no background monitoring");
});
