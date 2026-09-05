// GENERATED from packages/browser-runtime/src/types.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/types.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Browser runtime public types. Pure types + tiny helpers, no I/O.
// Keep this file erasable-syntax-only so node type-stripping can import it.

export const SAVE_REQUIRES_READABLE_BYTES = "SAVE_REQUIRES_READABLE_BYTES"         ;

export const ERROR_CODES = {
  SAVE_REQUIRES_READABLE_BYTES,
  TRANSPORT_NETWORK_ERROR: "TRANSPORT_NETWORK_ERROR",
  TRANSPORT_HTTP_ERROR: "TRANSPORT_HTTP_ERROR",
  TRANSPORT_CANCELLED: "TRANSPORT_CANCELLED",
  TRANSPORT_POLICY_DENIED: "TRANSPORT_POLICY_DENIED",
  PROXY_ELIGIBILITY_DENIED: "PROXY_ELIGIBILITY_DENIED",
  PROXY_RATE_LIMITED: "PROXY_RATE_LIMITED",
  PROXY_BUDGET_EXCEEDED: "PROXY_BUDGET_EXCEEDED",
  LIMIT_NATIVE_REQUIRED: "LIMIT_NATIVE_REQUIRED",
  DECODE_FAILED: "DECODE_FAILED",
  INVALID_INPUT: "INVALID_INPUT",
}         ;

export const DIRECT_TRANSPORT_LABEL = "Direct from your browser"         ;
export const PROXY_TRANSPORT_LABEL = "Metadata proxy"         ;

export function assertNever(value       , message         )        {
  throw new Error(message ?? `unexpected value: ${String(value)}`);
}

export function describeOutcome(outcome                      )         {
  switch (outcome) {
    case "readable":
      return "readable bytes available";
    case "ordinary-image-allowed":
      return "ordinary image display allowed";
    case "http-error":
      return "http error response";
    case "network-error":
      return "network or CORS failure";
    case "cancelled":
      return "cancelled";
    case "policy-denied":
      return "denied by policy";
    default:
      return assertNever(outcome, `unknown outcome: ${String(outcome)}`);
  }
}

export function saveCapabilityFor(originClean         )                 {
  if (originClean) return { available: true };
  return {
    available: false,
    code: SAVE_REQUIRES_READABLE_BYTES,
    reason: "Readable tile bytes are required for programmatic save.",
  };
}
