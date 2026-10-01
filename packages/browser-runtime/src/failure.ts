// Structured failures shared by browser operations. Hosts throw plain
// objects matching the generated `Error` shapes: serde round-trips them
// across the Rust/TypeScript boundary unchanged.
import type { BlockedReason, Error as JobError } from "@dezoomify/wasm-bindings";
import { isJobError } from "../../shared-ui/src/failure.ts";

export { isJobError };

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

/** Typed tile failure with its diagnostic cause retained in `detail`.
 * Already-typed causes pass through unchanged; decoding and processing
 * failures are deterministic, so they never degrade to the retryable
 * transport fallback. */
export function tileError(kind: "decode-failed" | "processing-failed", cause: unknown): JobError {
  return isJobError(cause) ? cause : { kind, detail: String(cause).slice(0, 2048) };
}

/** Typed output failure with its diagnostic cause retained in `detail`. */
export function outputError(
  kind: "plan-invalid" | "output-unavailable" | "encode-failed" | "write-failed" | "internal",
  detail?: string,
): JobError {
  switch (kind) {
    case "plan-invalid":
    case "output-unavailable":
    case "encode-failed":
    case "write-failed":
    case "internal":
      return detail === undefined ? { kind } : { kind, detail };
  }
}
