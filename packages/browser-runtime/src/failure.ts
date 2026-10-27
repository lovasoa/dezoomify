// Structured failures shared by browser operations. Runtime error classes carry
// the generated Rust facts; boundary payloads preserve the same shapes.
// The closed-enum vocabulary lives beside its validation in the shared UI.
import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { blockedReason, isJobError, unknownDetail } from "../../shared-ui/src/failure.ts";
import { DezoomifyError, errorFromPayload } from "./errors.ts";

export { blockedReason, isJobError, unknownDetail };

/** Typed tile failure with its diagnostic cause retained in `detail`.
 * Already-typed failure facts are preserved; decoding and processing
 * failures are deterministic, so they never degrade to the retryable
 * transport fallback. */
export function tileError(kind: "decode-failed" | "processing-failed", cause: unknown): JobError {
  return isJobError(cause)
    ? errorFromPayload(cause)
    : new DezoomifyError({ kind, detail: unknownDetail(cause) }, { cause });
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
      return new DezoomifyError(detail === undefined ? { kind } : { kind, detail });
  }
}
