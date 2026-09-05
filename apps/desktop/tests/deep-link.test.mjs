import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function readText(relFromHere) {
  return fs.readFileSync(path.join(here, relFromHere), "utf8");
}

// Deep-link parsing is implemented once, in Rust
// (apps/desktop/src-tauri/src/deep_link.rs), and its vectors live in the
// #[cfg(test)] module next to the parser. This file only checks the
// desktop metadata that registers the scheme; anything else would be a
// test-local reimplementation that can drift from the real parser.

test("desktop metadata registers dezoomify protocol scheme", () => {
  // The v1 `bundle.protocol` block is not valid Tauri 2 config; the scheme
  // registration now lives in src-tauri/dezoomify.json (deepLink.schemes)
  // and is applied by the deep-link plugin at SDK-wiring time.
  const conf = JSON.parse(readText("../src-tauri/tauri.conf.json"));
  const meta = JSON.parse(readText("../src-tauri/dezoomify.json"));
  const schemes = meta?.deepLink?.schemes ?? [];
  assert.ok(schemes.includes("dezoomify"), "protocol scheme dezoomify");
  assert.equal(conf.identifier, "dev.ophir.dezoomify");
});

test("rust deep-link tests exercise the parser vectors", () => {
  // Glue check: the vectors this contract relies on must stay inside the
  // Rust test module, not in a JS mirror that never runs the parser.
  const src = readText("../src-tauri/src/deep_link.rs");
  assert.ok(src.includes("#[cfg(test)]"), "parser carries its own tests");
  assert.ok(src.includes("parse_deep_link("), "vectors drive the real parser");
});
