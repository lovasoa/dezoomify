// Use Tauri's platform icon encoders with the same artwork as the website.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const output = process.argv[2] ?? path.join(root, "apps/desktop/src-tauri/icons");
const temporary = mkdtempSync(path.join(tmpdir(), "dezoomify-icons-"));
try {
  execFileSync(
    process.execPath,
    [cli, "icon", path.join(root, "favicon.svg"), "--output", temporary],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  // Tauri recommends the 32px ICO layer first for development. Its CLI currently
  // emits 16px first; reorder directory entries without changing image payloads.
  const icoPath = path.join(temporary, "icon.ico");
  const ico = readFileSync(icoPath);
  const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) =>
    Buffer.from(ico.subarray(6 + i * 16, 22 + i * 16)),
  );
  const first = entries.findIndex((entry) => entry[0] === 32 && entry[1] === 32);
  if (first < 0) throw new Error("Tauri generated no 32px Windows icon");
  entries.unshift(...entries.splice(first, 1));
  Buffer.concat(entries).copy(ico, 6);
  writeFileSync(icoPath, ico);
  // The ICNS encoder iterates a hash map. Stabilize block order so rebuilding
  // leaves tracked assets unchanged, while preserving every encoded layer.
  const icnsPath = path.join(temporary, "icon.icns");
  const icns = readFileSync(icnsPath);
  const layers = [];
  for (let offset = 8; offset < icns.length; ) {
    const length = icns.readUInt32BE(offset + 4);
    if (length <= 8 || offset + length > icns.length) throw new Error("Invalid Tauri ICNS layer");
    layers.push(icns.subarray(offset, offset + length));
    offset += length;
  }
  layers.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)));
  writeFileSync(icnsPath, Buffer.concat([icns.subarray(0, 8), ...layers]));
  mkdirSync(output, { recursive: true });
  // Only shipped desktop formats; Tauri also generates unused mobile/store assets.
  for (const name of [
    "32x32.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.png",
    "icon.ico",
    "icon.icns",
  ]) {
    copyFileSync(path.join(temporary, name), path.join(output, name));
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
