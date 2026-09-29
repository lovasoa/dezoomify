// Structured failures shared by browser operations.
import type {
  BlockedReason,
  FetchFailure,
  FetchFailureCode,
  Error as JobError,
} from "@dezoomify/wasm-bindings";

/** Validate the observed-failure payload at browser boundaries, without rebuilding it. */
export function isFetchFailure(value: unknown): value is FetchFailure {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const codes = {
    TRANSPORT_HTTP_ERROR: true,
    DISCOVERY_HTTP_ERROR: true,
    UPSTREAM_RATE_LIMITED: true,
    TRANSPORT_POLICY_DENIED: true,
    PROXY_BUDGET_EXCEEDED: true,
    PROXY_ERROR: true,
    PROXY_NETWORK_ERROR: true,
    PROXY_RATE_LIMITED: true,
    DISCOVERY_FAILED: true,
    TRANSPORT_TIMEOUT: true,
    TRANSPORT_NETWORK_ERROR: true,
    TRANSPORT_CANCELLED: true,
    TRANSPORT_BAD_URL: true,
    TRANSPORT_BAD_REDIRECT: true,
    TRANSPORT_REDIRECT_LIMIT: true,
    TRANSPORT_SIZE_LIMIT: true,
  } satisfies Record<FetchFailureCode, true>;
  return (
    typeof v.code === "string" &&
    Object.hasOwn(codes, v.code) &&
    typeof v.message === "string" &&
    v.message.length <= 4096 &&
    ["direct", "metadata-proxy", "browser-session", "native", "display-only"].includes(
      String(v.transport),
    ) &&
    (v.blocked_reason === undefined || blockedReason(v.blocked_reason) !== undefined) &&
    (v.http === undefined ||
      (typeof v.http === "number" && Number.isInteger(v.http) && v.http >= 100 && v.http <= 599)) &&
    (v.retry_after_ms === undefined ||
      (typeof v.retry_after_ms === "number" &&
        Number.isSafeInteger(v.retry_after_ms) &&
        v.retry_after_ms >= 0)) &&
    [v.detail, v.preview].every(
      (text) => text === undefined || (typeof text === "string" && text.length <= 4096),
    )
  );
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
    case "scheme":
    case "signed-query":
    case "source-document-lost":
    case "throttled":
    case "userinfo":
      return value;
    default:
      return undefined;
  }
}

/** Typed output failure with its diagnostic cause retained in the domain error. */
export function outputError(code: string, message: string, detail?: string): JobError {
  return { code, message, phase: "output", retryable: false, ...(detail ? { detail } : {}) };
}
