// PNG golden helpers for the real-window desktop E2E.
//
// Copied from the hermetic gate (`apps/desktop/tests/e2e.test.mjs`) so this
// directory stays self-contained: same 512x512 pyramid quadrants, same
// sha256 pin against `testdata/scenarios/native/cli-dzi/expected/result.json`.
// No public network, no shared state; inputs are fixed with a fixed seed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";

export const EXPECTED_WIDTH = 512;
export const EXPECTED_HEIGHT = 512;
export const EXPECTED_TILES = 4;

// Top-left red, top-right green, bottom-left blue, bottom-right yellow.
export const QUADRANTS = [
  { at: [64, 64], rgb: [196, 48, 48] },
  { at: [448, 64], rgb: [48, 168, 64] },
  { at: [64, 448], rgb: [48, 72, 200] },
  { at: [448, 448], rgb: [232, 220, 96] },
];

export function goldenOutputHash(scenariosDir) {
  const raw = readFileSync(
    path.join(scenariosDir, "native/cli-dzi/expected/result.json"),
    "utf8",
  );
  return JSON.parse(raw).outputHash;
}

export function sha256Hex(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function decodePngSize(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47 >>> 0, "PNG signature");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function decodePngPixels(bytes) {
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = decodePngSize(bytes);
  const colorType = bytes[25];
  assert.ok(colorType === 2 || colorType === 6, `unsupported color type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp + 1;
  const pixels = Buffer.alloc(width * height * bpp);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    const row = raw.subarray(y * stride + 1, (y + 1) * stride);
    const out = pixels.subarray(y * width * bpp, (y + 1) * width * bpp);
    for (let x = 0; x < row.length; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * width * bpp + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * width * bpp + x - bpp] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: assert.fail(`unknown PNG row filter ${filter}`);
      }
      out[x] = v & 0xff;
    }
  }
  return { pixels, bpp, width, height };
}

// Byte-exact save check: dimensions, golden digest, and quadrant placement.
export function assertSavedPyramid(bytes, expectedHash) {
  const { width, height } = decodePngSize(bytes);
  assert.equal(width, EXPECTED_WIDTH, "saved image width");
  assert.equal(height, EXPECTED_HEIGHT, "saved image height");
  assert.equal(sha256Hex(bytes), expectedHash, "saved bytes hash pins the golden");
  const { pixels, bpp } = decodePngPixels(bytes);
  for (const { at: [x, y], rgb } of QUADRANTS) {
    const o = (y * width + x) * bpp;
    assert.deepEqual([pixels[o], pixels[o + 1], pixels[o + 2]], rgb, `quadrant at ${x},${y}`);
  }
}
