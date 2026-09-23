import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function readText(rel) {
  return fs.readFileSync(path.join(here, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function sorted(arr) {
  return [...arr].sort();
}

function assertNoTrailingSpaces(content, label) {
  for (const [i, line] of content.split("\n").entries()) {
    assert.ok(!/[ \t]$/.test(line), `${label} line ${i + 1} has trailing space`);
  }
}

const EXPECTED_COMMANDS = [
  "answer_choice",
  "cancel_job",
  "open_saved_output",
  "pause_job",
  "query_capabilities",
  "request_destination",
  "resume_job",
  "start_job",
];
const EXPECTED_CHANNELS = ["dezoomify://job-snapshot", "dezoomify://deep-link-pending"];
const EXPECTED_ENCODERS = ["png", "jpeg", "tiff", "zif", "webp"];

const DESKTOP_META = readJson("../src-tauri/dezoomify.json");

function xdezoomify(doc) {
  return doc["x-dezoomify"] ?? doc;
}

test("generated files list exact commands and channels", () => {
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
  for (const field of [
    "commands",
    "eventChannels",
    "encoders",
    "decoders",
    "protocol",
    "updater",
  ]) {
    assert.deepEqual(a[field], b[field], `tauri vs capabilities field ${field}`);
    assert.deepEqual(a[field], c[field], `tauri vs desktop-capabilities field ${field}`);
  }
});

test("protocol range, encoders, and updater stay consistent", () => {
  const tauriConf = readJson("../src-tauri/tauri.conf.json");
  const desktopCap = readJson("../../../generated/desktop-capabilities.json");
  // The bundle identifier and deep-link scheme live in the tauri config.
  assert.equal(tauriConf.identifier, "dev.ophir.dezoomify");
  assert.deepEqual(DESKTOP_META.deepLink.schemes, ["dezoomify"]);
  for (const doc of [DESKTOP_META, desktopCap]) {
    const x = xdezoomify(doc);
    assert.deepEqual(x.protocol, { max: "2.0", min: "2.0", version: "2.0" });
    assert.deepEqual(sorted(x.encoders), sorted(EXPECTED_ENCODERS));
    assert.equal(x.updater.enabled, false);
    assert.equal(x.updater.httpsOnly, true);
    assert.equal(x.updater.requiresUserConfirm, true);
    assert.deepEqual(x.updater.allowlist ?? [], [], "disabled updater ships an empty allowlist");
    assert.ok(
      (x.updater.allowlist ?? []).every((u) => u.startsWith("https://")),
      "https allowlist",
    );
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

test("desktop protocol matches the v2-only release contract", () => {
  const desktopCap = readJson("../../../generated/desktop-capabilities.json");
  const x = xdezoomify(desktopCap);
  const desktopProto = desktopCap.protocol ?? x.protocol;
  assert.deepEqual(desktopProto, { max: "2.0", min: "2.0", version: "2.0" });
  const compat = readText("../../../release/compatibility.toml");
  assert.ok(compat.includes('current = "2.0"'), "compat current is 2.0");
  assert.ok(compat.includes('n_minus_1 = "2.0"'), "compat minimum is 2.0");
});

test("desktop scenario transcript is minimal and redacted", () => {
  const result = readJson("../../../testdata/scenarios/desktop/basic/expected/result.json");
  assert.ok(Array.isArray(result.states) && result.states.length >= 2, "states");
  assert.ok(result.states.includes("completed"), "terminal state");
});
