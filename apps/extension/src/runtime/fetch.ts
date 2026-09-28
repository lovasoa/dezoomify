/**
 * Bounded readable-byte transport for the extension job tab.
 *
 * This module deliberately has no permission prompt. A job tab can inspect a
 * missing host grant and ask the job page to show an explicit UI action,
 * but it must never turn a background fetch into a surprise browser prompt.
 * Source-document requests are owned by the job page/source script; this
 * transport is only for extension-origin requests with an existing host grant.
 */

import type { DiagnosticRecorder } from "@dezoomify/app-model";
import type { HostFailure } from "@dezoomify/browser-runtime";
import {
  blockedReason,
  forwardCoreHeaders,
  isFetchFailure,
  isPublicHttpUrl,
  originOfUrl,
  readErrorPreview,
  readResponseBytes,
  retryAfterMs,
} from "@dezoomify/browser-runtime";
import type { FetchFailure, FetchFailureCode, ResourceRequest } from "@dezoomify/wasm-bindings";

export const PROXY_PATH = "/api/proxy";
export const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
type TransportCategory =
  | "source-document-lost"
  | "access-required"
  | "forbidden"
  | "cancelled"
  | "network"
  | "throttled"
  | "malformed"
  | "limit-exceeded";
type FetchDeps = {
  diagnostics?: DiagnosticRecorder;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  hasPermission: (origin: string) => boolean | Promise<boolean>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/** @typedef {"source-document-lost"|"access-required"|"forbidden"|"cancelled"|"network"|"throttled"|"malformed"|"limit-exceeded"} TransportCategory */

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

/** @param {TransportCategory} category @param {string} message @param {Record<string, unknown>} [extra] */
export function transportError(
  category: TransportCategory,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return Object.assign(new Error(message), { code: category, category, ...extra });
}

/** @param {unknown} error */
export function asFetchFailure(error: unknown): HostFailure {
  if (isFetchFailure(error)) return error;
  const candidate = error as {
    category?: unknown;
    code?: unknown;
    message?: unknown;
    status?: unknown;
    retry_after_ms?: unknown;
  } | null;
  const category = blockedReason(candidate?.category) ?? "network";
  const http =
    typeof candidate?.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status > 0
      ? candidate.status
      : undefined;
  const code: FetchFailureCode =
    http !== undefined
      ? "TRANSPORT_HTTP_ERROR"
      : category === "cancelled"
        ? "TRANSPORT_CANCELLED"
        : category === "throttled"
          ? "UPSTREAM_RATE_LIMITED"
          : category === "access-required" || category === "forbidden"
            ? "TRANSPORT_POLICY_DENIED"
            : category === "network"
              ? "TRANSPORT_NETWORK_ERROR"
              : category === "limit-exceeded"
                ? "TRANSPORT_SIZE_LIMIT"
                : category === "malformed"
                  ? "TRANSPORT_BAD_URL"
                  : "DISCOVERY_FAILED";
  return {
    code,
    recovery: [],
    retryable:
      http !== undefined
        ? [408, 425, 429].includes(http) || http >= 500
        : category === "network" || category === "throttled",
    message:
      typeof candidate?.message === "string" ? candidate.message : "Extension transport failed",
    blocked_reason: category,
    transport: "browser-session",
    ...(http === undefined ? {} : { http }),
    ...(typeof candidate?.retry_after_ms === "number"
      ? { retry_after_ms: candidate.retry_after_ms }
      : {}),
  };
}

/** @param {string} url */
function checkedUrl(url: string): URL {
  if (isProxyUrl(url))
    throw transportError("malformed", "proxy transport is forbidden in the extension");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw transportError("malformed", "invalid URL");
  }
  if (!isPublicHttpUrl(parsed.href)) throw transportError("malformed", "unsupported URL scheme");
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
    deps.diagnostics?.count("requests");
    signal.throwIfAborted();
    const parsed = checkedUrl(request.uri);
    const origin = originOfUrl(parsed.href);
    if (!(await deps.hasPermission(origin))) {
      throw transportError("access-required", `Access to ${origin} requires an explicit action`, {
        hosts: [origin],
        code: "permission-denied",
      });
    }
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
      deps.diagnostics?.record(
        request.purpose === "metadata" || !response.ok ? "debug" : "trace",
        "request",
        {
          request: request.id,
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
        throw transportError("malformed", "malformed fetch response");
      if (!response.ok) {
        throw {
          code: "TRANSPORT_HTTP_ERROR",
          http: response.status,
          retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
          message: "The website refused this file.",
          recovery: [],
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
        throw transportError("malformed", `unsupported response type ${contentType}`);
      const bytes = await readResponseBytes(
        response,
        deps.maxBytes ?? MAX_BYTES_DEFAULT,
        controller.signal,
      );
      deps.diagnostics?.count("bytes_fetched", bytes.byteLength);
      deps.diagnostics?.record("trace", "body-read", {
        request: request.id,
        bytes: bytes.byteLength,
        duration_ms: performance.now() - started,
      });
      return {
        bytes,
        finalUri: response.url || parsed.href,
        contentType,
      };
    } catch (error) {
      if (!signal.aborted) {
        deps.diagnostics?.count("request_failures");
        deps.diagnostics?.record("debug", "request-failed", {
          request: request.id,
          purpose: request.purpose,
          transport: "extension-origin",
          url: request.uri,
          duration_ms: performance.now() - started,
          error,
        });
      }
      if (isFetchFailure(error)) throw error;
      if (error && typeof error === "object" && "category" in error) throw error;
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "TRANSPORT_SIZE_LIMIT"
      ) {
        controller.abort();
        throw transportError(
          "limit-exceeded",
          error instanceof Error ? error.message : "response exceeds byte limit",
        );
      }
      if (timedOut && !signal.aborted) throw transportError("network", "fetch timeout");
      if (signal.aborted || controller.signal.aborted)
        throw transportError("cancelled", "request cancelled");
      throw transportError(
        "network",
        error instanceof Error ? error.message : "network request failed",
      );
    } finally {
      (deps.clearTimeoutFn ?? clearTimeout)(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return { fetchResource };
}
