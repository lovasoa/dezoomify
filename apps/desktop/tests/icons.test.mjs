import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const script = path.join(root, "scripts", "gen-desktop-icons.py");
const iconsDir = path.join(root, "apps", "desktop", "src-tauri", "icons");
const expected = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.ico", "icon.icns"];

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("gen-desktop-icons.py is versioned, stdlib-only, and deterministic", () => {
  assert.ok(fs.existsSync(script), "scripts/gen-desktop-icons.py must be versioned");
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /byte-identical/, "script must document deterministic output");
  assert.match(source, /cargo xtask build desktop/, "script must name its xtask entry");
  assert.match(source, /cargo xtask test desktop/, "script must name its test lane");
  const imports = [...source.matchAll(/^import (\w+)|^from (\w+)/gm)].map((m) => m[1] ?? m[2]);
  for (const name of imports) {
    assert.ok(
      ["struct", "zlib", "pathlib"].includes(name),
      `non-stdlib import ${name} needs review`,
    );
  }
  for (const name of expected) {
    assert.ok(fs.existsSync(path.join(iconsDir, name)), `missing generated icon ${name}`);
  }
  const before = new Map(expected.map((n) => [n, sha256(path.join(iconsDir, n))]));
  execFileSync("python3", [script], { cwd: root, stdio: "pipe" });
  const afterFirst = new Map(expected.map((n) => [n, sha256(path.join(iconsDir, n))]));
  execFileSync("python3", [script], { cwd: root, stdio: "pipe" });
  const afterSecond = new Map(expected.map((n) => [n, sha256(path.join(iconsDir, n))]));
  for (const name of expected) {
    assert.equal(afterFirst.get(name), before.get(name), `${name} changed on re-run`);
    assert.equal(afterSecond.get(name), afterFirst.get(name), `${name} nondeterministic`);
  }
});

test("generated icons carry correct container magic", () => {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const name of ["32x32.png", "128x128.png", "128x128@2x.png"]) {
    const bytes = fs.readFileSync(path.join(iconsDir, name));
    assert.ok(bytes.subarray(0, 8).equals(pngMagic), `${name} lacks PNG magic`);
  }
  const ico = fs.readFileSync(path.join(iconsDir, "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "ICO reserved must be 0");
  assert.equal(ico.readUInt16LE(2), 1, "ICO type must be 1");
  assert.ok(ico.readUInt16LE(4) >= 1, "ICO must hold at least one entry");
  const icns = fs.readFileSync(path.join(iconsDir, "icon.icns"));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns", "ICNS magic must be icns");
});
