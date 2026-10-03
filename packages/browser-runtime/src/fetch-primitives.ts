// Shared fetch primitives: small pure validators, codecs, and classifiers
// used by every browser fetch path (website direct transport, extension
// job-tab transport, extension coordinator).
//
// Everything here is host-free: no DOM, no fetch, no globals beyond URL and
// the base64 helpers, so node tests drive each function directly. Trust
// boundaries stay with the callers: the extension coordinator validates
// resource requests, transports enforce their own credential and header
// policies, and the injected tab operation receives pre-validated input.
import type { RequestPurpose } from "@dezoomify/wasm-bindings";

// Native base64 codec (Baseline 2025). The extension manifest requires
// browsers that ship it; the atob fallback below exists only for older
// runtimes such as the pinned Node 24 toolchain. Not in the ES2022 lib yet.
declare global {
  interface Uint8ArrayConstructor {
    fromBase64(data: string): Uint8Array;
  }
  interface Uint8Array {
    toBase64(): string;
  }
}

/** Byte cap for one tab-origin source response, enforced while streaming. */
export const SOURCE_FETCH_BYTE_LIMIT = 8 * 1024 * 1024;

/** Shape bounds for declared request headers. */
export const REQUEST_HEADER_LIMITS = Object.freeze({
  maxCount: 64,
  maxName: 256,
  maxValue: 4096,
});

/** Headers the core may safely ask a browser fetch to forward. */
export const CORE_REQUEST_HEADERS: readonly string[] = Object.freeze([
  "accept",
  "accept-language",
  "if-modified-since",
  "if-none-match",
  "range",
]);

/** @param {unknown} value */
export function isPublicHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Canonical origin of an absolute URL, "" when unparseable. Strict on
 * purpose: origin keying that must never fail lives with its caller.
 * @param {unknown} value
 */
export function originOfUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * Validate one declared header pair, null when malformed. Values pass
 * through otherwise unchanged; forwarding policies live with the transports.
 */
export function sanitizeHeaderPair(
  name: unknown,
  value: unknown,
  limits: { maxName: number; maxValue: number } = REQUEST_HEADER_LIMITS,
): { name: string; value: string } | null {
  if (
    typeof name !== "string" ||
    typeof value !== "string" ||
    name.length === 0 ||
    name.length > limits.maxName ||
    value.length > limits.maxValue ||
    /[\r\n]/.test(name) ||
    /[\r\n]/.test(value)
  )
    return null;
  return { name, value };
}

/**
 * Validate declared headers into a fresh array, null when malformed.
 * @param {unknown} headers
 */
export function validateRequestHeaders(
  headers: unknown,
  limits: { maxCount: number; maxName: number; maxValue: number } = REQUEST_HEADER_LIMITS,
): Array<{ name: string; value: string }> | null {
  if (!Array.isArray(headers) || headers.length > limits.maxCount) return null;
  const result: Array<{ name: string; value: string }> = [];
  for (const header of headers) {
    const pair = sanitizeHeaderPair(
      (header as { name?: unknown } | null)?.name,
      (header as { value?: unknown } | null)?.value,
      limits,
    );
    if (!pair) return null;
    result.push(pair);
  }
  return result;
}

/**
 * Reduce declared headers to the core forwarding allowlist.
 * @param {unknown} headers @param {RequestPurpose} purpose
 */
export function forwardCoreHeaders(
  headers: unknown,
  purpose: RequestPurpose,
): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs = Array.isArray(headers)
    ? headers.map((header) => [header?.name, header?.value])
    : Object.entries(headers && typeof headers === "object" ? headers : {});
  for (const [rawName, rawValue] of pairs) {
    if (typeof rawName !== "string" || typeof rawValue !== "string") continue;
    const name = rawName.toLowerCase();
    if (!CORE_REQUEST_HEADERS.includes(name) || /\r|\n/.test(rawName) || /\r|\n/.test(rawValue))
      continue;
    if ((name === "if-modified-since" || name === "if-none-match") && purpose !== "metadata")
      continue;
    out[name] = rawValue;
  }
  return out;
}

/**
 * Decode one base64 source payload within a byte cap, null when malformed
 * or over budget. Prefers the native codec; the atob loop covers runtimes
 * older than the extension's minimum browsers (notably Node 24).
 * @param {unknown} data
 */
export function decodeBase64Payload(data: unknown, maxBytes: number): Uint8Array | null {
  if (typeof data !== "string" || data.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    return null;
  let bytes: Uint8Array;
  try {
    bytes =
      typeof Uint8Array.fromBase64 === "function"
        ? Uint8Array.fromBase64(data)
        : decodeBase64Legacy(data);
  } catch {
    return null;
  }
  return bytes.length > maxBytes ? null : bytes;
}

/** @param {string} data */
function decodeBase64Legacy(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Normalize an HTTP error body into a bounded server signal: strip markup,
 * collapse to one line, truncate. Never throws; "" when nothing usable
 * remains. Binary bodies (NUL bytes) yield "".
 */
export function normalizeErrorPreviewText(text: string, maxChars: number): string {
  if (!text || text.includes("\0")) return "";
  const flat = text
    .replace(/<[^>]{0,512}>/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls and DEL are precisely the unsafe server bytes removed here.
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > maxChars ? flat.slice(0, maxChars) : flat;
}
