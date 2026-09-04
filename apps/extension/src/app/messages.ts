/**
 * Internal extension message types (Phase 12).
 *
 * Every message wraps a protocol id, carries `version` + ids on the wire,
 * and is validated: unknown kinds and stale scan/job ids are rejected.
 * Wire shapes must stay compatible with `packages/protocol-ts` generated
 * types; no hand-written interface may duplicate a generated wire DTO for
 * transport — these are host-internal envelopes only.
 *
 * Plain JavaScript + JSDoc.
 */

export const MESSAGE_VERSION = 2;
export const MIN_MESSAGE_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze([
  "StartScan",
  "ScanStarted",
  "CandidateFound",
  "ScanSettled",
  "ScanFailed",
  "FetchResource",
  "FetchResult",
  "StartNativeHandoff",
  "ConsentDecision",
  "NativeResult",
]);

export const PROTO_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);
export const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Build an internal message envelope.
 * @param {string} kind one of MESSAGE_TYPES
 * @param {{ scanId?: string, jobId?: string, requestId?: string }} ids
 * @param {any} [payload]
 */
export function createMessage(kind, ids, payload = {}) {
  if (!MESSAGE_TYPES.includes(kind)) throw new Error(`unknown message kind ${kind}`);
  return Object.freeze({
    kind,
    version: MESSAGE_VERSION,
    scanId: ids.scanId ?? null,
    jobId: ids.jobId ?? null,
    requestId: ids.requestId ?? null,
    payload,
  });
}

/**
 * Validate an inbound message.
 * @param {unknown} raw
 * @param {{ currentScanId?: string | null, currentJobId?: string | null }} [ctx]
 */
export function validateMessage(raw, ctx = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("malformed", "message must be object");
  const msg = /** @type {Record<string, any>} */ (raw);
  for (const k of Object.keys(msg)) {
    if (PROTO_KEYS.includes(k)) return fail("malformed", `forbidden key ${k}`);
  }
  if (!MESSAGE_TYPES.includes(msg.kind)) return fail("unknown-kind", `unknown kind ${msg.kind}`);
  if (!Number.isInteger(msg.version) || msg.version < MIN_MESSAGE_VERSION || msg.version > MESSAGE_VERSION) {
    return fail("bad-version", `unsupported version ${msg.version}`);
  }
  let size = 0;
  try {
    size = JSON.stringify(msg).length;
  } catch {
    return fail("malformed", "not serializable");
  }
  if (size > MAX_MESSAGE_BYTES) return fail("oversize", "message too large");
  if (msg.scanId !== null && msg.scanId !== undefined && typeof msg.scanId !== "string") {
    return fail("malformed", "scanId must be string|null");
  }
  if (msg.jobId !== null && msg.jobId !== undefined && typeof msg.jobId !== "string") {
    return fail("malformed", "jobId must be string|null");
  }
  if (!msg.scanId && !msg.jobId) return fail("missing-id", "scanId or jobId required");
  if (ctx.currentScanId && msg.scanId && msg.scanId !== ctx.currentScanId) {
    return fail("stale", "stale scanId");
  }
  if (ctx.currentJobId && msg.jobId && msg.jobId !== ctx.currentJobId) {
    return fail("stale", "stale jobId");
  }
  return { ok: true };
}
