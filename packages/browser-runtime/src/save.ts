// Programmatic save: only from origin-clean readable surfaces.
import { SAVE_REQUIRES_READABLE_BYTES } from "./types.ts";
import { suggestedNameFor } from "../../shared-ui/src/saveName.ts";

export type SaveFormat = "png" | "jpeg";

export interface ReadableSurfaceForSave {
  readonly originClean: boolean;
  readonly width: number;
  readonly height: number;
  readPixels(): Uint8ClampedArray;
}

export interface SaveResult {
  mime: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  filename: string;
}

export type EncodeFn = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  format: SaveFormat,
) => Uint8Array;

export function mimeFor(format: SaveFormat): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// zlib stream with real DEFLATE compression (fixed Huffman + LZ77):
// deterministic and decodable by any PNG/zlib implementation. Replaces the
// previous stored (uncompressed) blocks, which bloated typical tiles ~4x.
function reverseBits(code: number, len: number): number {
  let res = 0;
  for (let i = 0; i < len; i++) {
    res = (res << 1) | (code & 1);
    code >>>= 1;
  }
  return res;
}

function fixedLitCode(lit: number): { code: number; len: number } {
  if (lit <= 143) return { code: reverseBits(0x30 + lit, 8), len: 8 };
  if (lit <= 255) return { code: reverseBits(0x190 + (lit - 144), 9), len: 9 };
  if (lit <= 279) return { code: reverseBits(lit - 256, 7), len: 7 };
  return { code: reverseBits(0xc0 + (lit - 280), 8), len: 8 };
}

function fixedDistCode(dist: number): { code: number; len: number } {
  return { code: reverseBits(dist, 5), len: 5 };
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lengthCode(len: number): { sym: number; extra: number; extraBits: number } {
  for (let i = 0; i < LENGTH_BASE.length; i++) {
    const base = LENGTH_BASE[i] ?? 0;
    const extra = LENGTH_EXTRA[i] ?? 0;
    const max = base + (extra === 0 ? 0 : (1 << extra) - 1);
    if (len >= base && len <= max) return { sym: 257 + i, extra, extraBits: len - base };
  }
  throw new Error(`bad match length: ${len}`);
}

function distCode(dist: number): { sym: number; extra: number; extraBits: number } {
  for (let i = 0; i < DIST_BASE.length; i++) {
    const base = DIST_BASE[i] ?? 0;
    const extra = DIST_EXTRA[i] ?? 0;
    const max = base + (extra === 0 ? 0 : (1 << extra) - 1);
    if (dist >= base && dist <= max) return { sym: i, extra, extraBits: dist - base };
  }
  throw new Error(`bad match distance: ${dist}`);
}

function deflateFixedRaw(data: Uint8Array): Uint8Array {
  const n = data.length;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(Math.max(1, n)).fill(-1);
  type Token = { lit: number } | { len: number; dist: number };
  const tokens: Token[] = [];
  const hashAt = (p: number): number =>
    (((data[p] ?? 0) << 10) ^ ((data[p + 1] ?? 0) << 5) ^ (data[p + 2] ?? 0)) & 0x7fff;
  let p = 0;
  while (p < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (p + 3 <= n) {
      const h = hashAt(p);
      let cand = head[h] ?? -1;
      let chain = 0;
      const maxChain = 32;
      const minPos = p - Math.min(p, 32768);
      while (cand !== -1 && cand >= minPos && chain < maxChain) {
        const dist = p - cand;
        if (dist >= 1 && dist <= 32768) {
          const maxLen = Math.min(258, n - p);
          let len = 0;
          while (len < maxLen && data[cand + len] === data[p + len]) len++;
          if (len > bestLen && len >= 3) {
            bestLen = len;
            bestDist = dist;
            if (len === 258) break;
          }
        }
        cand = prev[cand] ?? -1;
        chain++;
      }
      prev[p] = head[h] ?? -1;
      head[h] = p;
    }
    if (bestLen >= 3) {
      tokens.push({ len: bestLen, dist: bestDist });
      for (let k = 1; k < bestLen; k++) {
        if (p + k + 3 <= n) {
          const h2 = hashAt(p + k);
          prev[p + k] = head[h2] ?? -1;
          head[h2] = p + k;
        }
      }
      p += bestLen;
    } else {
      tokens.push({ lit: data[p] ?? 0 });
      p += 1;
    }
  }
  const out: number[] = [];
  let bitbuf = 0;
  let bitcnt = 0;
  const writeBits = (val: number, len: number): void => {
    bitbuf |= val << bitcnt;
    bitcnt += len;
    while (bitcnt >= 8) {
      out.push(bitbuf & 0xff);
      bitbuf >>>= 8;
      bitcnt -= 8;
    }
  };
  writeBits(1, 1);
  writeBits(1, 2);
  for (const t of tokens) {
    if ("lit" in t) {
      const { code, len } = fixedLitCode(t.lit);
      writeBits(code, len);
    } else {
      const lc = lengthCode(t.len);
      const lit = fixedLitCode(lc.sym);
      writeBits(lit.code, lit.len);
      if (lc.extra > 0) writeBits(lc.extraBits, lc.extra);
      const dc = distCode(t.dist);
      const dist = fixedDistCode(dc.sym);
      writeBits(dist.code, dist.len);
      if (dc.extra > 0) writeBits(dc.extraBits, dc.extra);
    }
  }
  {
    const { code, len } = fixedLitCode(256);
    writeBits(code, len);
  }
  if (bitcnt > 0) out.push(bitbuf & 0xff);
  return Uint8Array.from(out);
}

function zlibDeflate(data: Uint8Array): Uint8Array {
  const raw = deflateFixedRaw(data);
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(raw, 2);
  const adler = adler32(data);
  out[2 + raw.length] = (adler >>> 24) & 0xff;
  out[2 + raw.length + 1] = (adler >>> 16) & 0xff;
  out[2 + raw.length + 2] = (adler >>> 8) & 0xff;
  out[2 + raw.length + 3] = adler & 0xff;
  return out;
}

// Encodes RGBA pixels as a real, decodable PNG (color type 6, bit depth 8,
// filter 0 per scanline, fixed-Huffman DEFLATE IDAT).
export function encodePng(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const scanline = width * 4 + 1;
  const raw = new Uint8Array(scanline * height);
  for (let y = 0; y < height; y++) {
    raw[y * scanline] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * scanline + 1);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlibDeflate(raw);
  const total =
    PNG_SIGNATURE.length + (12 + 13) + (12 + idat.length) + 12;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(PNG_SIGNATURE, off);
  off += PNG_SIGNATURE.length;
  const ihdrChunk = pngChunk("IHDR", ihdr);
  out.set(ihdrChunk, off);
  off += ihdrChunk.length;
  const idatChunk = pngChunk("IDAT", idat);
  out.set(idatChunk, off);
  off += idatChunk.length;
  out.set(pngChunk("IEND", new Uint8Array(0)), off);
  return out;
}

export function defaultEncode(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  format: SaveFormat,
): Uint8Array {
  if (format === "png") return encodePng(pixels, width, height);
  throw new Error("no deterministic repository-owned JPEG encoder; use the browser canvas encoder");
}

export class SaveRequiresReadableBytesError extends Error {
  readonly code: string = SAVE_REQUIRES_READABLE_BYTES;
  constructor(message?: string) {
    super(message ?? "Readable tile bytes are required for programmatic save.");
    this.name = "SaveRequiresReadableBytesError";
  }
}

export async function saveReadable(
  surface: ReadableSurfaceForSave,
  format: SaveFormat,
  opts?: { encode?: EncodeFn },
): Promise<SaveResult> {
  // Fail closed BEFORE any canvas/pixel API.
  if (!surface.originClean) {
    throw new SaveRequiresReadableBytesError(
      "Readable tile bytes are required for programmatic save.",
    );
  }
  if (format !== "png" && format !== "jpeg") {
    throw new Error(`unsupported format: ${String(format)}`);
  }
  const pixels = surface.readPixels();
  const expected = surface.width * surface.height * 4;
  if (pixels.length !== expected) {
    throw new Error(`pixel length mismatch: got ${pixels.length}, want ${expected}`);
  }
  const encode = opts?.encode ?? defaultEncode;
  const bytes = encode(pixels, surface.width, surface.height, format);
  if (!bytes || bytes.length === 0) {
    throw new Error("encoder returned empty bytes");
  }
  const mime = mimeFor(format);
  const filename = suggestedNameFor(surface.width, surface.height, format);
  return { mime, bytes, width: surface.width, height: surface.height, filename };
}
