import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function readText(rel) {
  return fs.readFileSync(path.join(here, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function extractBracketStrings(source, constName) {
  const idx = source.indexOf(constName);
  assert.ok(idx >= 0, `missing ${constName}`);
  const eq = source.indexOf("=", idx);
  assert.ok(eq >= 0, `missing = for ${constName}`);
  const open = source.indexOf("[", eq);
  assert.ok(open >= 0, `missing [ for ${constName}`);
  // Balanced bracket walk (no nesting expected beyond one level).
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth += 1;
    if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, `missing ] for ${constName}`);
  const body = source.slice(open, end + 1);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function sorted(arr) {
  return [...arr].sort();
}

function assertNoTrailingSpaces(content, label) {
  for (const [i, line] of content.split("\n").entries()) {
    assert.ok(!/[ \t]$/.test(line), `${label} line ${i + 1} has trailing space`);
  }
}

const EXPECTED_COMMANDS = ["answer_choice", "cancel_job", "query_capabilities", "request_destination", "start_job"];
const EXPECTED_CHANNELS = [
  "dezoomify://job-state",
  "dezoomify://job-progress",
  "dezoomify://job-output",
  "dezoomify://job-error",
  "dezoomify://deep-link-pending",
];
const EXPECTED_ENCODERS = ["png", "jpeg", "tiff"];
const NATIVE_HOST = "dev.ophir.dezoomify.native_host";

const DESKTOP_META = readJson("../src-tauri/dezoomify.json");

function xdezoomify(doc) {
  return doc["x-dezoomify"] ?? doc;
}

test("rust command registry lists exact commands", () => {
  const src = readText("../src-tauri/src/commands.rs");
  const commands = extractBracketStrings(src, "COMMANDS");
  assert.deepEqual(sorted(commands), sorted(EXPECTED_COMMANDS));
  for (const name of EXPECTED_COMMANDS) {
    assert.ok(src.includes(`"${name}"`), `registry missing ${name}`);
  }
  assert.ok(src.includes("unknown") && src.includes("stale"), "unknown/stale rejection");
  assert.ok(src.includes("seq"), "event ordering");
});

test("typescript integration commands match registry", () => {
  const rust = extractBracketStrings(readText("../src-tauri/src/commands.rs"), "COMMANDS");
  const ts = extractBracketStrings(readText("../src/desktopIntegration.ts"), "DESKTOP_COMMANDS");
  assert.deepEqual(sorted(ts), sorted(rust));
  assert.deepEqual(sorted(ts), sorted(EXPECTED_COMMANDS));
});

test("generated files list exact commands and channels", () => {
  const tauriConf = readJson("../src-tauri/tauri.conf.json");
  const capGen = readJson("../src-tauri/capabilities/generated.json");
  const desktopCap = readJson("../../../generated/desktop-capabilities.json");
  for (const [label, doc] of [
    ["src-tauri/dezoomify.json", DESKTOP_META],
    ["capabilities/generated.json", capGen],
    ["generated/desktop-capabilities.json", desktopCap],
  ]) {
    const x = xdezoomify(doc);
    const commands = x.commands ?? doc.commands;
    const channels = x.eventChannels ?? doc.eventChannels;
    assert.deepEqual(sorted(commands), sorted(EXPECTED_COMMANDS), `${label} commands`);
    assert.deepEqual(sorted(channels), sorted(EXPECTED_CHANNELS), `${label} channels`);
  }
  // Cross-file byte-level agreement on shared fields.
  const a = DESKTOP_META;
  const b = xdezoomify(capGen);
  const c = xdezoomify(desktopCap);
  for (const field of ["commands", "eventChannels", "encoders", "decoders", "protocol", "nativeHost", "updater", "fingerprint"]) {
    assert.deepEqual(a[field], b[field], `tauri vs capabilities field ${field}`);
    assert.deepEqual(a[field], c[field], `tauri vs desktop-capabilities field ${field}`);
  }
});

test("protocol range, encoders, native host, updater stay consistent", () => {
  const tauriConf = readJson("../src-tauri/tauri.conf.json");
  const desktopCap = readJson("../../../generated/desktop-capabilities.json");
  const lib = readText("../src-tauri/src/lib.rs");
  const integration = readText("../src/desktopIntegration.ts");
  // The bundle identifier and deep-link scheme live in the tauri config.
  assert.equal(tauriConf.identifier, "dev.ophir.dezoomify");
  assert.deepEqual(DESKTOP_META.deepLink.schemes, ["dezoomify"]);
  for (const doc of [DESKTOP_META, desktopCap]) {
    const x = xdezoomify(doc);
    assert.deepEqual(x.protocol, { max: "1.0", min: "1.0", version: "1.0" });
    assert.deepEqual(sorted(x.encoders), sorted(EXPECTED_ENCODERS));
    assert.equal(x.nativeHost.name, NATIVE_HOST);
    assert.equal(x.updater.enabled, true);
    assert.equal(x.updater.httpsOnly, true);
    assert.equal(x.updater.requiresUserConfirm, true);
    assert.ok((x.updater.allowlist ?? []).every((u) => u.startsWith("https://")), "https allowlist");
  }
  assert.ok(lib.includes('PROTOCOL_MIN') && lib.includes('"1.0"'), "lib protocol");
  assert.ok(lib.includes(NATIVE_HOST), "lib native host");
  assert.ok(integration.includes('"1.0"') && integration.includes(NATIVE_HOST), "integration protocol/host");
  const hostSrc = readText("../src-tauri/src/bin/dezoomify-native-host.rs");
  assert.ok(hostSrc.includes(NATIVE_HOST), "native host binary name");
  assert.ok(hostSrc.includes("capability.unavailable"), "fail-closed rejection");
});

test("event channels match and forbid tile bytes", () => {
  const eventsTs = readText("../src/events.ts");
  const integrationTs = readText("../src/desktopIntegration.ts");
  const fromEvents = extractBracketStrings(eventsTs, "DESKTOP_EVENT_CHANNELS");
  const fromIntegration = extractBracketStrings(integrationTs, "DESKTOP_EVENT_CHANNELS");
  assert.deepEqual(sorted(fromEvents), sorted(EXPECTED_CHANNELS));
  assert.deepEqual(sorted(fromIntegration), sorted(EXPECTED_CHANNELS));
  assert.ok(eventsTs.includes("assertNoTileBytes"), "redaction helper");
  assert.ok(eventsTs.includes("FORBIDDEN_IPC_KEYS"), "forbidden-IPC-key set backs the guard");
  for (const rel of ["../src-tauri/tauri.conf.json", "../src-tauri/capabilities/generated.json", "../../../generated/desktop-capabilities.json"]) {
    const raw = readText(rel);
    assert.ok(!raw.includes("tileBytes") && !raw.includes("tile_bytes"), `${rel} must not carry tile bytes`);
  }
});

test("generated files are canonical bytes (LF, pretty, no drift)", () => {
  for (const rel of [
    "../src-tauri/tauri.conf.json",
    "../src-tauri/capabilities/generated.json",
    "../../../generated/desktop-capabilities.json",
  ]) {
    const raw = readText(rel);
    assert.ok(raw.endsWith("\n"), `${rel} ends with LF`);
    assert.ok(!raw.includes("\r"), `${rel} no CR`);
    assertNoTrailingSpaces(raw, rel);
    const canonical = JSON.stringify(JSON.parse(raw), null, 2) + "\n";
    assert.equal(raw, canonical, `${rel} not canonical 2-space JSON`);
  }
});

test("installer templates use placeholders and no wildcards", () => {
  const chromium = readText("../../../installer/native-messaging/chromium.json.in");
  const firefox = readText("../../../installer/native-messaging/firefox.json.in");
  for (const [label, content] of [
    ["chromium", chromium],
    ["firefox", firefox],
  ]) {
    assert.ok(content.includes("@HOST_PATH@"), `${label} host placeholder`);
    assert.ok(content.includes("@EXTENSION_ID@"), `${label} extension placeholder`);
    assert.ok(!content.includes("*"), `${label} no wildcards`);
    assert.ok(content.includes(NATIVE_HOST), `${label} host name`);
  }
  assert.ok(chromium.includes("allowed_origins") && chromium.includes("chrome-extension://"), "chromium origins");
  assert.ok(firefox.includes("allowed_extensions"), "firefox extensions");
  // Templates stay valid once placeholders are substituted.
  const fakeHost = "/opt/dezoomify/dezoomify-native-host";
  const fakeId = "abcdefghijklmnopqrstuvwxyzabcdef";
  const expandedChromium = chromium.replaceAll("@HOST_PATH@", fakeHost).replaceAll("@EXTENSION_ID@", fakeId);
  const parsed = JSON.parse(expandedChromium);
  assert.ok(parsed.allowed_origins[0].includes(fakeId));
  assert.ok(path.isAbsolute(parsed.path), "absolute host path");
});

test("desktop typescript stays host-neutral (no web/extension imports)", () => {
  for (const rel of ["../src/desktopIntegration.ts", "../src/events.ts"]) {
    const src = readText(rel);
    assert.ok(!/from\s+["'][^"']*apps\/web/.test(src), `${rel} must not import web`);
    assert.ok(!/from\s+["'][^"']*apps\/extension/.test(src), `${rel} must not import extension`);
    assert.ok(!/from\s+["'][^"']*browser-runtime/.test(src), `${rel} must not import browser runtime`);
    assert.ok(!/import\s*\(\s*["'][^"']*apps\/(web|extension)/.test(src), `${rel} no dynamic web import`);
    assert.ok(!src.includes("webIntegration.ts"), `${rel} no web integration import`);
    // The desktop TS layer performs no I/O of its own: it never calls
    // fetch/XHR (host effects belong to the native runtime).
    assert.ok(!/\bfetch\s*\(/.test(src), `${rel} must not fetch directly`);
    assert.ok(!src.includes("XMLHttpRequest"), `${rel} must not use XHR`);
  }
  const cargo = readText("../src-tauri/Cargo.toml");
  assert.ok(cargo.includes("[workspace]"), "standalone manifest detaches workspace");
  assert.ok(!cargo.match(/^tauri\s*=/m), "no tauri dependency in lean shell");
});

test("desktop scenario transcript is minimal and redacted", () => {
  const result = readJson("../../../testdata/scenarios/desktop/basic/expected/result.json");
  assert.ok(Array.isArray(result.states) && result.states.length >= 2, "states");
  assert.ok(typeof result.outputHash === "string" && result.outputHash.length > 10, "outputHash");
  assert.ok(result.states.includes("completed"), "terminal state");
});
