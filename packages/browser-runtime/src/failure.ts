// Structured failure type shared by every browser-runtime module.
//
// Extracted from `./session.ts` so leaf modules (canvas save, assembly,
// plan gates) can raise typed failures without depending on the discovery
// client. Keep erasable-syntax-only for the browser `.js` mirrors.

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
