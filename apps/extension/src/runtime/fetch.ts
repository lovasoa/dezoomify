/**
 * Bounded readable-byte transport for the extension job tab.
 *
 * This module deliberately has no permission prompt. A job tab can inspect a
 * missing host grant and ask the coordinator to show an explicit UI action,
 * but it must never turn a background fetch into a surprise browser prompt.
 * Source-document requests are owned by the coordinator/source script; this
 * transport is only for extension-origin requests with an existing host grant.
 */

export const PROXY_PATH = "/api/proxy";
export const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** @typedef {"source-document-lost"|"access-required"|"redirect-unavailable"|"cancelled"|"network"|"throttled"|"malformed"|"limit-exceeded"} TransportCategory */

/** Headers the core may safely ask a browser fetch to forward. */
export const CORE_REQUEST_HEADERS = Object.freeze([
  "accept", "accept-language", "if-modified-since", "if-none-match", "range",
]);

/** MIME families accepted for bytes intended for an image or metadata parser. */
export const ALLOWED_MIME_PREFIXES = Object.freeze([
  "image/", "application/xml", "text/xml", "application/json", "text/plain",
  "text/html", "application/octet-stream",
]);

/** @param {string} url */
export function isProxyUrl(url) {
  return typeof url === "string" && url.includes(PROXY_PATH);
}

/** @param {string} url */
export function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}`;
}

/** @param {TransportCategory} category @param {string} message @param {Record<string, unknown>} [extra] */
export function transportError(category, message, extra = {}) {
  return Object.assign(new Error(message), { code: category, category, ...extra });
}

/** @param {unknown} error */
export function asFetchFailure(error) {
  const candidate = /** @type {{ category?: unknown, code?: unknown, message?: unknown }} */ (error);
  const category = typeof candidate?.category === "string" ? candidate.category : "network";
  return {
    code: `extension.${category}`,
    phase: "acquisition",
    retryable: category === "network" || category === "throttled",
    message: typeof candidate?.message === "string" ? candidate.message : "Extension transport failed",
    recovery: [],
    blocked_reason: category,
    transport: "extension-origin",
  };
}

/** @param {unknown} headers @param {"metadata"|"tile"|"probe"} purpose */
export function forwardCoreHeaders(headers, purpose) {
  /** @type {Record<string, string>} */
  const out = {};
  const pairs = Array.isArray(headers)
    ? headers.map((header) => [header?.name, header?.value])
    : Object.entries(headers && typeof headers === "object" ? headers : {});
  for (const [rawName, rawValue] of pairs) {
    if (typeof rawName !== "string" || typeof rawValue !== "string") continue;
    const name = rawName.toLowerCase();
    if (!CORE_REQUEST_HEADERS.includes(name) || /\r|\n/.test(rawName) || /\r|\n/.test(rawValue)) continue;
    if ((name === "if-modified-since" || name === "if-none-match") && purpose !== "metadata") continue;
    out[name] = rawValue;
  }
  return out;
}

/** @param {unknown} value */
function headerValue(value) {
  if (!value) return "";
  if (typeof value.get === "function") return String(value.get("content-type") ?? "");
  if (typeof value === "object") return String(value["content-type"] ?? value["Content-Type"] ?? "");
  return "";
}

/** @param {unknown} value */
function contentLength(value) {
  if (!value) return null;
  const raw = typeof value.get === "function" ? value.get("content-length") : value["content-length"] ?? value["Content-Length"];
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Consume a Fetch body while the controller remains live. `arrayBuffer()` is
 * intentionally not used: it would retain an unbounded body before the cap.
 * @param {any} response
 * @param {{ maxBytes: number, controller: AbortController, cancelled?: () => boolean }} opts
 */
export async function readResponseBytes(response, opts) {
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

/** @param {string} url */
function checkedUrl(url) {
  if (isProxyUrl(url)) throw transportError("malformed", "proxy transport is forbidden in the extension");
  let parsed;
  try { parsed = new URL(url); } catch { throw transportError("malformed", "invalid URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw transportError("malformed", "unsupported URL scheme");
  return parsed;
}

/**
 * @param {{ fetchImpl?: (url: string, init: RequestInit) => Promise<any>, hasPermission: (origin: string) => boolean | Promise<boolean>, setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout }} deps
 */
export function createExtensionFetcher(deps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  /** @type {Set<AbortController>} */
  const active = new Set();

  /** @param {string} url @param {{ requestId?: string, purpose?: "metadata"|"tile"|"probe", headers?: unknown, maxBytes?: number, timeoutMs?: number, cancelled?: () => boolean }} [opts] */
  async function fetchResource(url, opts = {}) {
    const parsed = checkedUrl(url);
    const origin = originOf(parsed.href);
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
      if (response.status === 429) throw transportError("throttled", "site is throttling requests");
      if (response.status === 401 || response.status === 403) {
        throw transportError("access-required", response.status === 401 ? "unauthorized; access cannot be requested automatically" : "forbidden; access cannot be requested automatically", { hosts: [origin] });
      }
      if (response.status < 200 || response.status >= 300) throw transportError("network", `request failed with HTTP ${response.status}`);
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

/** Compatibility name; `requestPermission` is deliberately ignored. */
export function createSessionFetcher(deps) {
  return createExtensionFetcher({ fetchImpl: deps.fetchImpl, hasPermission: deps.hasPermission, setTimeoutFn: deps.setTimeoutFn, clearTimeoutFn: deps.clearTimeoutFn });
}
