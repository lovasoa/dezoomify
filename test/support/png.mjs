// Shared PNG probe for the fixed quadrant-pyramid save goldens across the
// website, desktop, and extension E2Es: one decoder and one fixture geometry.
// PNGs are 8-bit RGB/RGBA, non-interlaced.
import assert from "node:assert/strict";
import zlib from "node:zlib";

export const EXPECTED_WIDTH = 512;
export const EXPECTED_HEIGHT = 512;

// The fixed pyramid fixture: four solid quadrants (top-left red, top-right
// green, bottom-left blue, bottom-right yellow). `at` probes the quadrant in
// the assembled output; `tile`/`center` name the owning fixture tile and its
// center pixel for saves checked against the tile bytes themselves.
export const QUADRANTS = [
  {
    label: "top-left quadrant red",
    tile: "tile-0_0.png",
    at: [64, 64],
    center: [128, 128],
    rgb: [196, 48, 48],
  },
  {
    label: "top-right quadrant green",
    tile: "tile-1_0.png",
    at: [448, 64],
    center: [384, 128],
    rgb: [48, 168, 64],
  },
  {
    label: "bottom-left quadrant blue",
    tile: "tile-0_1.png",
    at: [64, 448],
    center: [128, 384],
    rgb: [48, 72, 200],
  },
  {
    label: "bottom-right quadrant yellow",
    tile: "tile-1_1.png",
    at: [448, 448],
    center: [384, 384],
    rgb: [232, 220, 96],
  },
];

export function decodePngSize(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47 >>> 0, "PNG signature");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Inflates the concatenated IDAT stream of a small RGB(A) PNG and reverses
// every standard PNG row filter.
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
  // Canvas PNGs are RGBA (color type 6); fixtures are RGB (type 2).
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
      let value = row[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          assert.fail(`unknown PNG row filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }
  return { pixels, bpp, width, height };
}

/** RGBA quadruple at one pixel (opaque for RGB sources). */
export function pixelAt({ pixels, bpp, width }, x, y) {
  const o = (y * width + x) * bpp;
  return bpp === 4
    ? [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]]
    : [pixels[o], pixels[o + 1], pixels[o + 2], 255];
}

/** Save check: dimensions and quadrant placement. */
export function assertSavedPyramid(bytes) {
  const { width, height } = decodePngSize(bytes);
  assert.equal(width, EXPECTED_WIDTH, "saved image width");
  assert.equal(height, EXPECTED_HEIGHT, "saved image height");
  const decoded = decodePngPixels(bytes);
  for (const { at, rgb, label } of QUADRANTS) {
    assert.deepEqual(pixelAt(decoded, ...at).slice(0, 3), rgb, label);
  }
}
