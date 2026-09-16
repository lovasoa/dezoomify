// Structured failure type shared by every browser-runtime module.
//
// Extracted from `./session.ts` so leaf modules (canvas save, assembly,
// plan gates) can raise typed failures without depending on the discovery
// client.

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
  /** Transport kind id (`direct`, `metadata-proxy`, ...). */
  transportKind?: string;
  /** Bounded single-line server signal captured from an HTTP error body. */
  preview?: string;
}

/** Typed fetch cause crossing the worker boundary into the wasm core. */
export interface FetchCause {
  code: string;
  http?: number;
  transport: string;
  reason?: string;
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
    transportKind?: string;
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
