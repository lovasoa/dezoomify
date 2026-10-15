/**
 * Bounded readable-byte transport for the extension job tab.
 *
 * This module deliberately has no permission prompt. A job tab can inspect a
 * missing host grant and ask the job page to show an explicit UI action,
 * but it must never turn a background fetch into a surprise browser prompt.
 * Source-document requests are owned by the job page/source script; this
 * transport is only for extension-origin requests with an existing host grant.
 */

import {
  forwardCoreHeaders,
  isJobError,
  isPublicHttpUrl,
  originOfUrl,
  readErrorPreview,
  readRequestedBytes,
  requestedByteRange,
  retryAfterMs,
  unknownDetail,
} from "@dezoomify/browser-runtime";
import type { DiagnosticRecorder } from "@dezoomify/shared-ui";
import type { Error as JobError, ResourceRequest } from "@dezoomify/wasm-bindings";

export const PROXY_PATH = "/api/proxy";
export const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
type FetchDeps = {
  diagnostics?: DiagnosticRecorder;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  hasPermission: (origin: string) => boolean | Promise<boolean>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/** MIME families accepted for bytes intended for an image or metadata parser. */
export const ALLOWED_MIME_PREFIXES = Object.freeze([
  "image/",
  "application/xml",
  "text/xml",
  "application/json",
  "application/ld+json",
  "text/plain",
  "text/html",
  "application/octet-stream",
]);

/** @param {string} url */
export function isProxyUrl(url: string): boolean {
  return typeof url === "string" && url.includes(PROXY_PATH);
}

/** Canonical observations from the extension's browser transport. */
export function transportError(
  kind: "bad-url" | "cancelled" | "network-failure" | "timeout" | "source-lost",
  detail: string,
): JobError {
  switch (kind) {
    case "bad-url":
      return { kind, detail };
    case "cancelled":
      return { kind };
    case "network-failure":
    case "timeout":
      return { kind, transport: "browser-session", detail };
    case "source-lost":
      return {
        kind: "policy-denied",
        blocked_reason: "source-document-lost",
        transport: "browser-session",
        detail,
      };
  }
}

/** @param {string} url */
function checkedUrl(url: string): URL {
  if (isProxyUrl(url))
    throw transportError("bad-url", "proxy transport is forbidden in the extension");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw transportError("bad-url", `invalid URL: ${unknownDetail(cause)}`);
  }
  if (!isPublicHttpUrl(parsed.href)) throw transportError("bad-url", "unsupported URL scheme");
  return parsed;
}

/**
 * @param {{ fetchImpl?: (url: string, init: RequestInit) => Promise<any>, hasPermission: (origin: string) => boolean | Promise<boolean>, setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout }} deps
 */
export function createExtensionFetcher(deps: FetchDeps) {
  const fetchImpl: (url: string, init: RequestInit) => Promise<Response> =
    deps.fetchImpl ?? (fetch as (url: string, init: RequestInit) => Promise<Response>);
  async function fetchResource(request: ResourceRequest, signal: AbortSignal) {
    const started = performance.now();
    signal.throwIfAborted();
    const parsed = checkedUrl(request.uri);
    const range = requestedByteRange(request.headers);
    const origin = originOfUrl(parsed.href);
    if (!(await deps.hasPermission(origin))) {
      throw {
        kind: "policy-denied",
        blocked_reason: "access-required",
        transport: "browser-session",
        detail: `access to ${origin} requires an explicit action`,
      } satisfies JobError;
    }
    deps.diagnostics?.count("requests");
    deps.diagnostics?.count("requests_pending");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let timedOut = false;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = (deps.setTimeoutFn ?? setTimeout)(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      if (signal.aborted) throw transportError("cancelled", "request cancelled");
      // Credential-free with browser-native redirect following: no
      // credentials are attached (CDNs answering
      // Access-Control-Allow-Origin: * stay readable, which "include"
      // would fail), and response bytes never return to a redirecting
      // site, so a redirect can neither misuse the user's session nor
      // disclose the target's data to the redirecting site.
      const response = await fetchImpl(parsed.href, {
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
        headers: forwardCoreHeaders(request.headers, request.purpose ?? "metadata"),
      });
      return await readExtensionResponse(
        response,
        request,
        parsed.href,
        started,
        range,
        controller.signal,
      );
    } catch (error) {
      const observed = extensionFailure(error, signal, controller, timedOut);
      recordFailure(observed, request, signal, started);
      throw observed;
    } finally {
      controller.abort();
      deps.diagnostics?.count("requests_pending", -1);
      (deps.clearTimeoutFn ?? clearTimeout)(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  function recordFailure(
    observed: JobError,
    request: ResourceRequest,
    signal: AbortSignal,
    started: number,
  ): void {
    deps.diagnostics?.count(signal.aborted ? "requests_cancelled" : "request_failures");
    if (!signal.aborted)
      deps.diagnostics?.record("warn", "request-failed", {
        ...observed,
        purpose: request.purpose,
        url: request.uri,
        duration_ms: performance.now() - started,
      });
  }

  async function readExtensionResponse(
    response: Response,
    request: ResourceRequest,
    requestedUrl: string,
    started: number,
    range: ReturnType<typeof requestedByteRange>,
    signal: AbortSignal,
  ) {
    deps.diagnostics?.record(
      request.purpose === "metadata" || !response.ok ? "debug" : "trace",
      "request",
      {
        purpose: request.purpose,
        transport: "extension-origin",
        url: request.uri,
        final_url: response.url,
        http: response.status,
        content_type: response.headers.get("content-type"),
        duration_ms: performance.now() - started,
      },
    );
    if (!response || typeof response.status !== "number")
      throw transportError("bad-url", "malformed fetch response");
    if (!response.ok) {
      const retry_after_ms = retryAfterMs(response.headers.get("retry-after"));
      throw {
        kind: "http-error",
        status: response.status,
        request: request.uri,
        transport: "browser-session",
        preview: await readErrorPreview(response, signal),
        ...(retry_after_ms === undefined ? {} : { retry_after_ms }),
      } satisfies JobError;
    }
    const contentType = response.headers.get("content-type") ?? "";
    assertContentType(contentType, request.purpose);
    const bytes = await readRequestedBytes(
      response,
      range,
      deps.maxBytes ?? MAX_BYTES_DEFAULT,
      signal,
    );
    deps.diagnostics?.count("bytes_fetched", bytes.byteLength);
    deps.diagnostics?.count("requests_completed");
    deps.diagnostics?.record("trace", "body-read", {
      bytes: bytes.byteLength,
      duration_ms: performance.now() - started,
    });
    return {
      bytes,
      finalUri: response.url || requestedUrl,
      contentType,
    };
  }
  return { fetchResource };
}

function assertContentType(contentType: string, purpose: ResourceRequest["purpose"]): void {
  const accepted =
    purpose === "metadata"
      ? ALLOWED_MIME_PREFIXES
      : ALLOWED_MIME_PREFIXES.filter((mime) => mime !== "text/html");
  if (contentType && !accepted.some((prefix) => contentType.toLowerCase().startsWith(prefix)))
    throw transportError("bad-url", `unsupported response type ${contentType}`);
}

function extensionFailure(
  error: unknown,
  signal: AbortSignal,
  controller: AbortController,
  timedOut: boolean,
): JobError {
  if (isJobError(error)) {
    if (error.kind === "size-limit") controller.abort();
    return error;
  }
  if (signal.aborted || (controller.signal.aborted && !timedOut))
    return transportError("cancelled", "request cancelled");
  if (timedOut) return transportError("timeout", "fetch timeout");
  return transportError("network-failure", unknownDetail(error));
}
