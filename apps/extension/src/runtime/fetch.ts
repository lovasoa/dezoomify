/**
 * Bounded readable-byte transport for the extension job tab.
 *
 * This module deliberately has no permission prompt. A job tab can inspect a
 * missing host grant and ask the coordinator to show an explicit UI action,
 * but it must never turn a background fetch into a surprise browser prompt.
 * Source-document requests are owned by the coordinator/source script; this
 * transport is only for extension-origin requests with an existing host grant.
 */
import { blockedReason, forwardCoreHeaders, isPublicHttpUrl, normalizeErrorPreviewText, originOfUrl } from "@dezoomify/browser-runtime";
import type { HostFailure } from "@dezoomify/browser-runtime";
import type { FetchFailureCode } from "@dezoomify/wasm-bindings";

export const PROXY_PATH = "/api/proxy";
export const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
type TransportCategory = "source-document-lost"|"access-required"|"forbidden"|"redirect-unavailable"|"cancelled"|"network"|"throttled"|"malformed"|"limit-exceeded";
type Purpose = "metadata" | "tile" | "probe";
type HeaderSource = Headers | Record<string, string> | Array<{ name?: unknown; value?: unknown }>;
type FetchResponse = Response & { bytes?: Uint8Array; durationMs?: number };
type FetchOptions = { requestId?: number; purpose?: Purpose; headers?: HeaderSource; maxBytes?: number; timeoutMs?: number; cancelled?: () => boolean; userIntent?: boolean };
type FetchDeps = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<FetchResponse>;
  hasPermission: (origin: string) => boolean | Promise<boolean>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/** @typedef {"source-document-lost"|"access-required"|"forbidden"|"redirect-unavailable"|"cancelled"|"network"|"throttled"|"malformed"|"limit-exceeded"} TransportCategory */

/** MIME families accepted for bytes intended for an image or metadata parser. */
export const ALLOWED_MIME_PREFIXES = Object.freeze([
  "image/", "application/xml", "text/xml", "application/json", "application/ld+json",
  "text/plain", "text/html", "application/octet-stream",
]);

/** @param {string} url */
export function isProxyUrl(url: string): boolean {
  return typeof url === "string" && url.includes(PROXY_PATH);
}

/** @param {TransportCategory} category @param {string} message @param {Record<string, unknown>} [extra] */
export function transportError(category: TransportCategory, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code: category, category, ...extra });
}

/** @param {unknown} error */
export function asFetchFailure(error: unknown): HostFailure {
  const candidate = error as { category?: unknown; code?: unknown; message?: unknown; status?: unknown; retry_after_ms?: unknown } | null;
  const category = blockedReason(candidate?.category) ?? "network";
  const http = typeof candidate?.status === "number" && Number.isInteger(candidate.status) && candidate.status > 0
    ? candidate.status
    : undefined;
  const code: FetchFailureCode = http !== undefined
    ? "TRANSPORT_HTTP_ERROR"
    : category === "cancelled"
      ? "TRANSPORT_CANCELLED"
      : category === "throttled"
        ? "UPSTREAM_RATE_LIMITED"
        : category === "access-required" || category === "forbidden"
          ? "TRANSPORT_POLICY_DENIED"
          : category === "network"
            ? "TRANSPORT_NETWORK_ERROR"
            : category === "redirect-unavailable"
              ? "TRANSPORT_BAD_REDIRECT"
              : category === "limit-exceeded"
                ? "TRANSPORT_SIZE_LIMIT"
                : category === "malformed"
                  ? "TRANSPORT_BAD_URL"
                  : "DISCOVERY_FAILED";
  return {
    code,
    retryable: category === "network" || category === "throttled",
    message: typeof candidate?.message === "string" ? candidate.message : "Extension transport failed",
    blocked_reason: category,
    transport: "browser-session",
    ...(http === undefined ? {} : { http }),
    ...(typeof candidate?.retry_after_ms === "number" ? { retry_after_ms: candidate.retry_after_ms } : {}),
  };
}

function retryAfterHeaderMs(headers: unknown, at = Date.now()): number | undefined {
  try {
    const value = headers as { get?: (name: string) => string | null; [name: string]: unknown } | null;
    const raw = typeof value?.get === "function"
      ? value.get("retry-after")
      : value?.["retry-after"] ?? value?.["Retry-After"];
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - at) : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} value */
function headerValue(value: unknown): string {
  const headers = value as { get?: (name: string) => string | null; [key: string]: unknown } | null;
  if (!value) return "";
  if (typeof headers?.get === "function") return String(headers.get("content-type") ?? "");
  if (headers) return String(headers["content-type"] ?? headers["Content-Type"] ?? "");
  return "";
}

/** @param {unknown} value */
function contentLength(value: unknown): number | null {
  const headers = value as { get?: (name: string) => string | null; [key: string]: unknown } | null;
  if (!value) return null;
  const raw = typeof headers?.get === "function" ? headers.get("content-length") : headers?.["content-length"] ?? headers?.["Content-Length"];
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Consume a Fetch body while the controller remains live. `arrayBuffer()` is
 * intentionally not used: it would retain an unbounded body before the cap.
 * @param {any} response
 * @param {{ maxBytes: number, controller: AbortController, cancelled?: () => boolean }} opts
 */
export async function readResponseBytes(response: FetchResponse, opts: { maxBytes: number; controller: AbortController; cancelled?: () => boolean }): Promise<Uint8Array> {
  const declared = contentLength(response?.headers);
  if (declared !== null && declared > opts.maxBytes) {
    opts.controller.abort();
    throw transportError("limit-exceeded", `response exceeds ${opts.maxBytes} byte limit`);
  }
  // Older focused fakes supply bytes directly. Production responses stream.
  if (response?.bytes instanceof Uint8Array) {
    if (response.bytes.byteLength > opts.maxBytes) {
      opts.controller.abort();
      throw transportError("limit-exceeded", `oversized response exceeds ${opts.maxBytes} byte limit`);
    }
    return response.bytes;
  }
  const reader = response?.body?.getReader?.();
  if (!reader) throw transportError("malformed", "response has no readable body");
  /** @type {Uint8Array[]} */
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      if (opts.cancelled?.() || opts.controller.signal.aborted) throw transportError("cancelled", "request cancelled");
      const next = await reader.read();
      if (next.done) break;
      const value = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value ?? 0);
      if (value.byteLength > opts.maxBytes - length) {
        opts.controller.abort();
        throw transportError("limit-exceeded", `oversized response exceeds ${opts.maxBytes} byte limit`);
      }
      length += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    if (error && typeof error === "object" && "category" in error) throw error;
    if (opts.cancelled?.() || opts.controller.signal.aborted) throw transportError("cancelled", "request cancelled");
    throw error;
  } finally {
    try { await reader.cancel(); } catch { /* stream cleanup is best effort */ }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

const ERROR_SNIPPET_MAX_CHARS = 300;

/**
 * Bounded server signal from an HTTP error body. Reads a small text body,
 * strips markup, collapses to one line, truncates. Never throws; returns ""
 * when nothing usable remains. Local-only diagnostics content.
 */
async function errorSignal(response: FetchResponse): Promise<string> {
  try {
    const headers = response?.headers as { get?: (name: string) => string | null } | null;
    const declared = Number(headers?.get?.("content-length"));
    if (Number.isSafeInteger(declared) && declared > 16 * 1024) return "";
    const text = typeof (response as { text?: unknown }).text === "function"
      ? await (response as unknown as { text(): Promise<string> }).text()
      : "";
    return normalizeErrorPreviewText(text, ERROR_SNIPPET_MAX_CHARS);
  } catch {
    return "";
  }
}

/** Append a bounded server signal to a transport message (ASCII punctuation only). */
function withSignal(message: string, signal: string): string {
  return signal ? `${message}. Server said: "${signal}"` : message;
}

/** @param {string} url */
function checkedUrl(url: string): URL {
  if (isProxyUrl(url)) throw transportError("malformed", "proxy transport is forbidden in the extension");
  let parsed;
  try { parsed = new URL(url); } catch { throw transportError("malformed", "invalid URL"); }
  if (!isPublicHttpUrl(parsed.href)) throw transportError("malformed", "unsupported URL scheme");
  return parsed;
}

/**
 * @param {{ fetchImpl?: (url: string, init: RequestInit) => Promise<any>, hasPermission: (origin: string) => boolean | Promise<boolean>, setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout }} deps
 */
export function createExtensionFetcher(deps: FetchDeps) {
  const fetchImpl: (url: string, init: RequestInit) => Promise<FetchResponse> = deps.fetchImpl ?? (fetch as (url: string, init: RequestInit) => Promise<FetchResponse>);
  /** @type {Set<AbortController>} */
  const active = new Set<AbortController>();

  /** @param {string} url @param {{ requestId?: number, purpose?: "metadata"|"tile"|"probe", headers?: unknown, maxBytes?: number, timeoutMs?: number, cancelled?: () => boolean }} [opts] */
  async function fetchResource(url: string, opts: FetchOptions = {}) {
    const parsed = checkedUrl(url);
    const origin = originOfUrl(parsed.href);
    if (!opts.userIntent) throw transportError("access-required", "explicit user intent is required", { code: "intent-required" });
    if (!(await deps.hasPermission(origin))) {
      throw transportError("access-required", `Access to ${origin} requires an explicit action`, { hosts: [origin], code: "permission-denied" });
    }
    const controller = new AbortController();
    active.add(controller);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = (deps.setTimeoutFn ?? setTimeout)(() => controller.abort(), timeoutMs);
    try {
      if (opts.cancelled?.()) throw transportError("cancelled", "request cancelled");
      // Manual redirect avoids claiming an automatically followed chain was validated.
      const response = await fetchImpl(parsed.href, {
        credentials: "include", redirect: "manual", signal: controller.signal,
        headers: forwardCoreHeaders(opts.headers, opts.purpose ?? "metadata"),
      });
      if (response?.type === "opaqueredirect" || (response?.status >= 300 && response?.status < 400)) {
        throw transportError("redirect-unavailable", "redirect requires a separately observed destination");
      }
      if (!response || typeof response.status !== "number") throw transportError("malformed", "malformed fetch response");
      if (typeof response.durationMs === "number" && response.durationMs > timeoutMs) throw transportError("network", "fetch timeout");
      if (response.url && response.url !== parsed.href) throw transportError("redirect-unavailable", "redirect permission cannot be validated automatically");
      if (response.status === 429) throw transportError("throttled", withSignal("site is throttling requests", await errorSignal(response)), {
        status: response.status,
        retry_after_ms: retryAfterHeaderMs(response.headers),
      });
      if (response.status === 401 || response.status === 403) {
        // The host grant is already held (checked above): this is an upstream
        // refusal by the site, not a missing browser permission. It must never
        // pause for another grant, or the job re-prompts in a loop.
        throw transportError("forbidden", withSignal(response.status === 401 ? "unauthorized; the site refused this file" : "forbidden; the site refused this file", await errorSignal(response)), { hosts: [origin], status: response.status });
      }
      if (response.status < 200 || response.status >= 300) throw transportError("network", withSignal(`request failed with HTTP ${response.status}`, await errorSignal(response)), { status: response.status });
      const contentType = headerValue(response.headers);
      const accepted = opts.purpose === "metadata" ? ALLOWED_MIME_PREFIXES : ALLOWED_MIME_PREFIXES.filter((mime) => mime !== "text/html");
      if (contentType && !accepted.some((prefix) => contentType.toLowerCase().startsWith(prefix))) throw transportError("malformed", `unsupported response type ${contentType}`);
      const bytes = await readResponseBytes(response, { maxBytes: opts.maxBytes ?? MAX_BYTES_DEFAULT, controller, cancelled: opts.cancelled });
      return { bytes, finalUrl: response.url || parsed.href, contentType, requestId: opts.requestId };
    } catch (error) {
      if (error && typeof error === "object" && "category" in error) throw error;
      if (opts.cancelled?.() || controller.signal.aborted) throw transportError("cancelled", "request cancelled");
      throw transportError("network", error instanceof Error ? error.message : "network request failed");
    } finally {
      (deps.clearTimeoutFn ?? clearTimeout)(timer);
      active.delete(controller);
    }
  }
  function cancel() { for (const controller of active) controller.abort(); active.clear(); }
  return { fetchResource, cancel };
}
