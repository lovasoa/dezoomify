import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function readText(rel) {
  return fs.readFileSync(path.join(here, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(readText(rel));
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
