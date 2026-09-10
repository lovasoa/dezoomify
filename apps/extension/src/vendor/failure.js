// GENERATED from packages/browser-runtime/src/failure.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/failure.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Structured failure type shared by every browser-runtime module.
//
// Extracted from `./session.ts` so leaf modules (canvas save, assembly,
// plan gates) can raise typed failures without depending on the discovery
// client. Keep erasable-syntax-only for the browser `.js` mirrors.

/** Return a stable string code from an arbitrary host-side failure. */
export function stableErrorCode(error         , fallback = "DISCOVERY_FAILED")         {
  if (!error || typeof error !== "object") return fallback;
  const code = (error                      ).code;
  return typeof code === "string" && code !== "" ? code : fallback;
}

export function failure(
  code        ,
  message        ,
  retryable = true,
  detail         ,
  technical         ,
)                    {
  const error = new Error(message)                     ;
  error.code = code;
  error.retryable = retryable;
  if (detail) error.detail = detail;
  if (technical) error.technical = technical;
  return error;
}
