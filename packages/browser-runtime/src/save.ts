// Programmatic save: only from origin-clean readable surfaces.
import { SAVE_REQUIRES_READABLE_BYTES } from "./types.ts";

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

// zlib stream made only of deflate stored (uncompressed) blocks: deterministic
// and decodable by any PNG/zlib implementation.
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let src = 0;
  let dst = 2;
  for (let i = 0; i < blocks; i++) {
    const len = Math.min(65535, data.length - src);
    out[dst] = i === blocks - 1 ? 1 : 0;
    out[dst + 1] = len & 0xff;
    out[dst + 2] = (len >>> 8) & 0xff;
    out[dst + 3] = (~len) & 0xff;
    out[dst + 4] = ((~len) >>> 8) & 0xff;
    out.set(data.subarray(src, src + len), dst + 5);
    src += len;
    dst += 5 + len;
  }
  const adler = adler32(data);
  out[dst] = (adler >>> 24) & 0xff;
  out[dst + 1] = (adler >>> 16) & 0xff;
  out[dst + 2] = (adler >>> 8) & 0xff;
  out[dst + 3] = adler & 0xff;
  return out.subarray(0, dst + 4);
}

// Encodes RGBA pixels as a real, decodable PNG (color type 6, bit depth 8,
// filter 0 per scanline, uncompressed IDAT).
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
  const idat = zlibStored(raw);
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
  const filename = `image-${surface.width}x${surface.height}.${format === "png" ? "png" : "jpg"}`;
  return { mime, bytes, width: surface.width, height: surface.height, filename };
}
