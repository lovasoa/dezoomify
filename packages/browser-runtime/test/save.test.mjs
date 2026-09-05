import test from "node:test";
import assert from "node:assert/strict";
import { saveReadable, defaultEncode, encodePng } from "../src/save.ts";
import { SAVE_REQUIRES_READABLE_BYTES } from "../src/types.ts";

function surface2x2(pixels) {
  return {
    originClean: true,
    width: 2,
    height: 2,
    readCalls: 0,
    readPixels() {
      this.readCalls += 1;
      return new Uint8ClampedArray(pixels);
    },
  };
}

// Independent minimal PNG reader for the encoder's own output: verifies the
// signature, chunk structure and CRCs, and decodes the (stored-block) IDAT
// back to RGBA pixels. Filter 0 and color type 6 only, matching the encoder.
function decodePng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) assert.equal(bytes[i], sig[i], "PNG signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let off = 8;
  while (off < bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    const crc = view.getUint32(off + 8 + len);
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    let c = 0xffffffff;
    for (const b of bytes.subarray(off + 4, off + 8 + len)) {
      c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    c = (c ^ 0xffffffff) >>> 0;
    assert.equal(c, crc, `CRC of ${type} chunk`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0].data;
  const w = view.getUint32(ihdr.byteOffset);
  const h = view.getUint32(ihdr.byteOffset + 4);
  assert.equal(ihdr[8], 8, "bit depth 8");
  assert.equal(ihdr[9], 6, "color type RGBA");
  // Inflate stored deflate blocks from the zlib stream.
  const z = chunks[1].data;
  assert.equal(z[0], 0x78);
  const raw = [];
  let p = 2;
  for (;;) {
    const bfinal = z[p] & 1;
    const len = z[p + 1] | (z[p + 2] << 8);
    assert.equal((z[p + 1] | (z[p + 2] << 8)) ^ 0xffff, z[p + 3] | (z[p + 4] << 8), "NLEN complement");
    for (let i = 0; i < len; i++) raw.push(z[p + 5 + i]);
    p += 5 + len;
    if (bfinal) break;
  }
  const scanline = w * 4 + 1;
  assert.equal(raw.length, scanline * h);
  const pixels = [];
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * scanline], 0, "filter type 0");
    for (let x = 0; x < w * 4; x++) pixels.push(raw[y * scanline + 1 + x]);
  }
  return { w, h, pixels: new Uint8ClampedArray(pixels) };
}

test("deterministic 2x2 save produces a real decodable PNG", async () => {
  const pixels = [
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ];
  const s = surface2x2(pixels);
  const res = await saveReadable(s, "png");
  assert.equal(res.mime, "image/png");
  assert.equal(res.width, 2);
  assert.equal(res.height, 2);
  assert.ok(res.filename.includes("2x2"));
  // Deterministic: same input -> same bytes.
  const again = await saveReadable(surface2x2(pixels), "png");
  assert.deepEqual([...res.bytes], [...again.bytes]);
  // The bytes decode (independently, with CRC checks) back to the exact pixels.
  const decoded = decodePng(res.bytes);
  assert.equal(decoded.w, 2);
  assert.equal(decoded.h, 2);
  assert.deepEqual([...decoded.pixels], pixels);
  // defaultEncode is deterministic across calls.
  const manual = defaultEncode(new Uint8ClampedArray(pixels), 2, 2, "png");
  assert.deepEqual([...res.bytes], [...manual]);
});

test("larger non-trivial image round-trips through PNG decode", () => {
  const w = 37;
  const h = 5;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + 11) & 0xff;
  const decoded = decodePng(encodePng(pixels, w, h));
  assert.equal(decoded.w, w);
  assert.equal(decoded.h, h);
  assert.deepEqual([...decoded.pixels], [...pixels]);
});

test("taint guard throws before any canvas API", async () => {
  let reads = 0;
  let encodes = 0;
  const tainted = {
    originClean: false,
    width: 2,
    height: 2,
    readPixels() {
      reads += 1;
      return new Uint8ClampedArray(16);
    },
  };
  await assert.rejects(
    () => saveReadable(tainted, "png", { encode: () => { encodes += 1; return new Uint8Array([1]); } }),
    (e) => e.code === SAVE_REQUIRES_READABLE_BYTES,
  );
  assert.equal(reads, 0);
  assert.equal(encodes, 0);
});

test("jpeg mime with host encoder; unsupported format rejected", async () => {
  const s = surface2x2(new Array(16).fill(0));
  // JPEG has no deterministic repository-owned encoder; the host provides one
  // (canvas toBlob) and the mime follows the requested format.
  const res = await saveReadable(s, "jpeg", {
    encode: () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(res.mime, "image/jpeg");
  assert.deepEqual([...res.bytes], [0xff, 0xd8, 0xff, 0xd9]);
  await assert.rejects(() => saveReadable(s, "webp"));
});
