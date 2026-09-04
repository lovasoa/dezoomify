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

export function defaultEncode(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  format: SaveFormat,
): Uint8Array {
  // Deterministic repository-owned encoding: 8-byte header + raw pixels.
  // Header: [w_lo, w_hi, h_lo, h_hi, fmt(1=png,2=jpeg), 0, 0, 0]
  const header = new Uint8Array(8);
  header[0] = width & 0xff;
  header[1] = (width >> 8) & 0xff;
  header[2] = height & 0xff;
  header[3] = (height >> 8) & 0xff;
  header[4] = format === "png" ? 1 : 2;
  const out = new Uint8Array(8 + pixels.length);
  out.set(header, 0);
  out.set(pixels, 8);
  return out;
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
