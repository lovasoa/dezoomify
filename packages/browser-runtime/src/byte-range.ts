import type { Error as JobError, ResourceRequest } from "@dezoomify/wasm-bindings";
import { readResponseBytes } from "./response-body.ts";

export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

function invalid(detail: string): JobError {
  return { kind: "bad-url", detail: `invalid byte-range response: ${detail}` };
}

/** Only finite, single byte ranges have an unambiguous bounded response. */
export function requestedByteRange(headers: ResourceRequest["headers"]): ByteRange | undefined {
  const values = (headers ?? []).filter(({ name }) => name.toLowerCase() === "range");
  if (values.length === 0) return undefined;
  const match = values.length === 1 ? /^bytes=(\d+)-(\d+)$/.exec(values[0].value) : null;
  if (!match)
    throw {
      kind: "bad-url",
      detail: "expected one finite Range: bytes=start-end",
    } satisfies JobError;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const length = end - start + 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    !Number.isSafeInteger(length)
  )
    throw {
      kind: "bad-url",
      detail: "byte range exceeds safe integer bounds or is reversed",
    } satisfies JobError;
  return { start, end, length };
}

/** Validate headers before reading, including servers that ignore Range. */
export function validateByteRangeResponse(
  range: ByteRange,
  status: number,
  contentRange: string | null | undefined,
  contentLength?: string | null,
): void {
  if (status !== 206) throw invalid(`expected HTTP 206, received ${status}`);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
  if (
    !match ||
    Number(match[1]) !== range.start ||
    Number(match[2]) !== range.end ||
    !Number.isSafeInteger(Number(match[3])) ||
    Number(match[3]) <= range.end
  )
    throw invalid(
      `Content-Range does not match bytes=${range.start}-${range.end}: ${(contentRange ?? "missing").slice(0, 256)}`,
    );
  if (
    contentLength !== undefined &&
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) !== range.length)
  )
    throw invalid(`Content-Length does not match ${range.length}: ${contentLength.slice(0, 256)}`);
}

export function validateByteRangeLength(range: ByteRange, length: number): void {
  if (length !== range.length) throw invalid(`expected ${range.length} bytes, received ${length}`);
}

/** Read only the requested bytes; never consume a full ignored-range response. */
export async function readRequestedBytes(
  response: Response,
  range: ByteRange | undefined,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!range) return readResponseBytes(response, maxBytes, signal);
  try {
    validateByteRangeResponse(
      range,
      response.status,
      response.headers.get("content-range"),
      response.headers.get("content-length"),
    );
    if (range.length > maxBytes)
      throw { kind: "size-limit", max_bytes: maxBytes } satisfies JobError;
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }
  const bytes = await readResponseBytes(response, range.length, signal);
  validateByteRangeLength(range, bytes.byteLength);
  return bytes;
}
