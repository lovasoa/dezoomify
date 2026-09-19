// Structured failure type shared by every browser-runtime module.
//
// Extracted from `./session.ts` so leaf modules (canvas save, assembly,
// plan gates) can raise typed failures without depending on the discovery
// client.
import type { BlockedReason, ErrorTransport } from "@dezoomify/wasm-bindings";

export interface StructuredFailure extends Error {
  code: string;
  retryable: boolean;
  /** Raw engine diagnostics for the technical-details section; never shown prominently. */
  detail?: string;
  /**
   * Dense technical diagnostics (transport, HTTP status, failure chain) for
   * logs, the engine, and bug reports. `message` stays the hand-holding UI
   * sentence; `technical` never reaches the prominent error slot.
   */
  technical?: string;
  /**
   * Typed fetch cause (the core wire shape `{code, http?, transport,
   * reason?}`). Discovery diagnostics group on it, never on rendered
   * text; user copy never enters it.
   */
  cause?: FetchCause;
  /** Full request URL of the failed fetch; rendered verbatim in the on-device details. */
  url?: string;
  /** HTTP status when the failure is an HTTP refusal. */
  http?: number;
  /** Host-observed Retry-After hint in milliseconds for a retryable response. */
  retry_after_ms?: number;
  /** Transport kind id (`direct`, `metadata-proxy`, ...). */
  transportKind?: ErrorTransport;
  /** Bounded single-line server signal captured from an HTTP error body. */
  preview?: string;
}

/** Typed fetch cause crossing the worker boundary into the wasm core. */
export interface FetchCause {
  code: string;
  http?: number;
  transport: ErrorTransport;
  reason?: BlockedReason;
}

export function errorTransport(value: unknown): ErrorTransport | undefined {
  switch (value) {
    case "direct": return "direct";
    case "metadata-proxy":
    case "metadata proxy":
    case "proxy": return "metadata-proxy";
    case "browser-session":
    case "extension-origin": return "browser-session";
    case "native": return "native";
    case "display-only": return "display-only";
    default: return undefined;
  }
}

export function blockedReason(value: unknown): BlockedReason | undefined {
  switch (value) {
    case "access-required":
    case "blocked-ipv4":
    case "blocked-ipv6":
    case "cancelled":
    case "content-type":
    case "dns-rebinding":
    case "dns-rebinding-v6":
    case "forbidden":
    case "invalid-url":
    case "limit-exceeded":
    case "loopback-host":
    case "malformed":
    case "malformed-body":
    case "method":
    case "network":
    case "non-standard-port":
    case "origin":
    case "private-host":
    case "protocol-version":
    case "redirect-limit":
    case "redirect-target":
    case "redirect-unavailable":
    case "scheme":
    case "signed-query":
    case "source-document-lost":
    case "throttled":
    case "userinfo": return value;
    default: return undefined;
  }
}

/** Return a stable string code from an arbitrary host-side failure. */
export function stableErrorCode(error: unknown, fallback = "DISCOVERY_FAILED"): string {
  if (!error || typeof error !== "object") return fallback;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : fallback;
}

export function failure(
  code: string,
  message: string,
  retryable = true,
  detail?: string,
  technical?: string,
): StructuredFailure {
  const error = new Error(message) as StructuredFailure;
  error.code = code;
  error.retryable = retryable;
  if (detail) error.detail = detail;
  if (technical) error.technical = technical;
  return error;
}

/**
 * Build a fetch failure carrying its typed cause plus the structured
 * context the details renderer needs. Free-text technical chains are
 * replaced by these fields: the engine gets `cause`, the renderer gets
 * `url`/`http`/`preview`.
 */
export function fetchFailure(
  code: string,
  message: string,
  retryable: boolean,
  context: {
    cause: FetchCause;
    url?: string;
    preview?: string;
    transportKind?: ErrorTransport;
  },
): StructuredFailure {
  const error = failure(code, message, retryable);
  error.cause = context.cause;
  if (context.url) error.url = context.url;
  if (context.preview) error.preview = context.preview;
  if (context.transportKind) error.transportKind = context.transportKind;
  if (typeof context.cause.http === "number") error.http = context.cause.http;
  return error;
}
