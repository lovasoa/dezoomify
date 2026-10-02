// Structured failures shared by browser operations. Hosts throw plain
// objects matching the generated `Error` shapes: serde round-trips them
// across the Rust/TypeScript boundary unchanged. The closed-enum vocabulary
// lives beside its validation in the shared UI's failure module.
import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { blockedReason, isJobError } from "../../shared-ui/src/failure.ts";

export { blockedReason, isJobError };

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
