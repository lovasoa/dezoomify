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
  isFetchFailure,
  isPublicHttpUrl,
  originOfUrl,
  readErrorPreview,
  readResponseBytes,
  retryAfterMs,
} from "@dezoomify/browser-runtime";
import type { DiagnosticRecorder } from "@dezoomify/shared-ui";
import type {
  BlockedReason,
  FetchFailure,
  FetchFailureCode,
  ResourceRequest,
} from "@dezoomify/wasm-bindings";

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
  code: FetchFailureCode,
  message: string,
  blocked_reason?: BlockedReason,
): FetchFailure {
  return {
    code,
    message,
    transport: "browser-session",
    ...(blocked_reason ? { blocked_reason } : {}),
  };
}

/** @param {string} url */
function checkedUrl(url: string): URL {
  if (isProxyUrl(url))
    throw transportError("TRANSPORT_BAD_URL", "proxy transport is forbidden in the extension");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw transportError("TRANSPORT_BAD_URL", "invalid URL");
  }
  if (!isPublicHttpUrl(parsed.href))
    throw transportError("TRANSPORT_BAD_URL", "unsupported URL scheme");
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
    const origin = originOfUrl(parsed.href);
    if (!(await deps.hasPermission(origin))) {
      throw transportError(
        "TRANSPORT_POLICY_DENIED",
        `Access to ${origin} requires an explicit action`,
        "access-required",
      );
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
      if (signal.aborted) throw transportError("TRANSPORT_CANCELLED", "request cancelled");
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
        throw transportError("TRANSPORT_BAD_URL", "malformed fetch response");
      if (!response.ok) {
        throw {
          code: "TRANSPORT_HTTP_ERROR",
          http: response.status,
          message: "The website refused this file.",
          transport: "browser-session",
          ...(response.status === 401 || response.status === 403
            ? { blocked_reason: "forbidden" }
            : {}),
          preview: await readErrorPreview(response, controller.signal),
          retry_after_ms: retryAfterMs(response.headers.get("retry-after")),
        } satisfies FetchFailure;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const accepted =
        request.purpose === "metadata"
          ? ALLOWED_MIME_PREFIXES
          : ALLOWED_MIME_PREFIXES.filter((mime) => mime !== "text/html");
      if (contentType && !accepted.some((prefix) => contentType.toLowerCase().startsWith(prefix)))
        throw transportError("TRANSPORT_BAD_URL", `unsupported response type ${contentType}`);
      const bytes = await readResponseBytes(
        response,
        deps.maxBytes ?? MAX_BYTES_DEFAULT,
        controller.signal,
      );
      deps.diagnostics?.count("bytes_fetched", bytes.byteLength);
      deps.diagnostics?.count("requests_completed");
      deps.diagnostics?.record("trace", "body-read", {
        bytes: bytes.byteLength,
        duration_ms: performance.now() - started,
      });
      return {
        bytes,
        finalUri: response.url || parsed.href,
        contentType,
      };
    } catch (error) {
      let observed: FetchFailure;
      if (isFetchFailure(error)) observed = error;
      else if (signal.aborted || (controller.signal.aborted && !timedOut))
        observed = transportError("TRANSPORT_CANCELLED", "request cancelled", "cancelled");
      else if (timedOut) observed = transportError("TRANSPORT_TIMEOUT", "fetch timeout");
      else if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "TRANSPORT_SIZE_LIMIT"
      ) {
        controller.abort();
        observed = transportError(
          "TRANSPORT_SIZE_LIMIT",
          error instanceof Error ? error.message : "response exceeds byte limit",
          "limit-exceeded",
        );
      } else
        observed = transportError(
          "TRANSPORT_NETWORK_ERROR",
          error instanceof Error ? error.message : "network request failed",
          "network",
        );
      deps.diagnostics?.count(signal.aborted ? "requests_cancelled" : "request_failures");
      if (!signal.aborted)
        deps.diagnostics?.record("warn", "request-failed", {
          ...observed,
          purpose: request.purpose,
          url: request.uri,
          duration_ms: performance.now() - started,
        });
      throw observed;
    } finally {
      deps.diagnostics?.count("requests_pending", -1);
      (deps.clearTimeoutFn ?? clearTimeout)(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return { fetchResource };
}
