import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OUTPUT_FORMATS } from "../src/settings.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function readText(rel) {
  return fs.readFileSync(path.join(here, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function sorted(arr) {
  return [...arr].sort();
}

test("the pinned desktop bundler loads its native platform binary", () => {
  const version = readJson("../package.json").devDependencies["@tauri-apps/cli"];
  const output = execFileSync(
    process.execPath,
    [require.resolve("@tauri-apps/cli/tauri.js"), "--version"],
    { encoding: "utf8" },
  );
  assert.equal(output.trim(), `tauri-cli ${version}`);
});

const EXPECTED_COMMANDS = [
  "get_job_diagnostics",
  "answer_partial",
  "cancel_job",
  "dezoomify",
  "pause_job",
  "resume_job",
  "open_saved_output",
  "release_job",
];
const EXPECTED_CHANNELS = [
  "dezoomify://registered",
  "dezoomify://progress",
  "dezoomify://partial",
  "dezoomify://deep-link-pending",
];
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
  for (const field of ["commands", "eventChannels", "encoders", "decoders", "updater"]) {
    assert.deepEqual(a[field], b[field], `tauri vs capabilities field ${field}`);
    assert.deepEqual(a[field], c[field], `tauri vs desktop-capabilities field ${field}`);
  }
});

test("encoders and updater stay consistent", () => {
  const tauriConf = readJson("../src-tauri/tauri.conf.json");
  const desktopCap = readJson("../../../generated/desktop-capabilities.json");
  // The bundle identifier and deep-link scheme live in the tauri config.
  assert.equal(tauriConf.identifier, "dev.ophir.dezoomify");
  assert.deepEqual(DESKTOP_META.deepLink.schemes, ["dezoomify"]);
  for (const doc of [DESKTOP_META, desktopCap]) {
    const x = xdezoomify(doc);
    assert.deepEqual(sorted(x.encoders), sorted(EXPECTED_ENCODERS));
    assert.deepEqual(sorted(x.outputFormats), sorted(OUTPUT_FORMATS));
    assert.equal(x.updater.enabled, false);
    assert.equal(x.updater.httpsOnly, true);
    assert.equal(x.updater.requiresUserConfirm, true);
    assert.deepEqual(x.updater.allowlist ?? [], [], "disabled updater ships an empty allowlist");
  }
});

test("generated files are canonical bytes (LF, pretty, no drift)", () => {
  for (const rel of [
    "../src-tauri/tauri.conf.json",
    "../src-tauri/capabilities/generated.json",
    "../../../generated/desktop-capabilities.json",
  ]) {
    const raw = readText(rel);
    const canonical = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
    assert.equal(raw, canonical, `${rel} not canonical 2-space JSON`);
  }
});

test("desktop capabilities match authored commands and event channels", async () => {
  execFileSync(process.execPath, [
    path.join(here, "../../../scripts/generate-desktop-capabilities.mjs"),
    "--check",
  ]);
});
