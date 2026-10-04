import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const script = path.join(root, "scripts", "gen-desktop-icons.mjs");
const iconsDir = path.join(root, "apps", "desktop", "src-tauri", "icons");
const expected = [
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.ico",
  "icon.icns",
];

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("committed desktop icons match the logo and pinned Tauri generator", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dezoomify-icon-test-"));
  try {
    execFileSync(process.execPath, [script, temporary], { cwd: root, stdio: "pipe" });
    for (const name of expected) {
      assert.equal(
        sha256(path.join(temporary, name)),
        sha256(path.join(iconsDir, name)),
        `${name} is stale`,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("desktop PNGs contain the transparent blue and coral logo at each required size", async () => {
  for (const [name, size] of [
    ["32x32.png", 32],
    ["128x128.png", 128],
    ["128x128@2x.png", 256],
    ["icon.png", 512],
  ]) {
    const { data, info } = await sharp(path.join(iconsDir, name))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, size);
    assert.equal(info.height, size);
    assert.equal(info.channels, 4);
    assert.equal(data[3], 0, `${name} needs transparent corners`);
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 255) colors.add(data.subarray(i, i + 3).toString("hex"));
    }
    assert.ok(colors.has("3c7bff"), `${name} lacks the blue magnifier`);
    assert.ok(colors.has("ff8080"), `${name} lacks the coral tiles`);
  }
});

test("generated icons carry platform containers and required layers", () => {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const name of ["32x32.png", "128x128.png", "128x128@2x.png"]) {
    const bytes = fs.readFileSync(path.join(iconsDir, name));
    assert.ok(bytes.subarray(0, 8).equals(pngMagic), `${name} lacks PNG magic`);
  }
  const ico = fs.readFileSync(path.join(iconsDir, "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "ICO reserved must be 0");
  assert.equal(ico.readUInt16LE(2), 1, "ICO type must be 1");
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const offset = 6 + i * 16;
    const width = ico[offset] || 256;
    assert.equal(ico[offset + 1] || 256, width);
    sizes.push(width);
    assert.ok(ico.readUInt32LE(offset + 12) + ico.readUInt32LE(offset + 8) <= ico.length);
  }
  assert.equal(sizes[0], 32, "32px must be first for development");
  assert.deepEqual(
    sizes.toSorted((a, b) => a - b),
    [16, 24, 32, 48, 64, 256],
  );
  const icns = fs.readFileSync(path.join(iconsDir, "icon.icns"));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns", "ICNS magic must be icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const layers = new Set();
  let offset = 8;
  while (offset < icns.length) {
    layers.add(icns.subarray(offset, offset + 4).toString("ascii"));
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= icns.length);
    offset += length;
  }
  assert.equal(offset, icns.length);
  for (const layer of ["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]) {
    assert.ok(layers.has(layer), `missing macOS layer ${layer}`);
  }
});
