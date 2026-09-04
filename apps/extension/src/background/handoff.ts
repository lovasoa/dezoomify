/**
 * Website-to-extension handoff validation (Phase 12).
 *
 * Treats website messages/links as untrusted, unsigned, bounded, non-secret
 * hints. Validation is pure and performs ZERO network calls. A separate
 * `confirmHandoff` gate requires explicit user confirmation before any host
 * permission request or fetch may happen.
 *
 * Supported: protocol current (2) and N-1 (1). Rejected: N-2 (0), future
 * (>=3), oversize, secret-bearing, wrong-origin envelopes.
 *
 * Plain JavaScript + JSDoc.
 */

export const CURRENT_HANDOFF_PROTOCOL = 2;
export const MIN_HANDOFF_PROTOCOL = 1;
export const MAX_ENVELOPE_BYTES = 8192;
export const MAX_SOURCE_URL_LENGTH = 2048;
export const MAX_CAPABILITIES = 10;
export const MAX_CAPABILITY_LENGTH = 64;
export const MAX_REQUEST_ID_LENGTH = 128;

/** Keys that must never appear in a non-secret handoff envelope. */
export const SECRET_KEYS = Object.freeze([
  "cookie",
  "cookies",
  "cookievalue",
  "cookievalues",
  "authorization",
  "token",
  "secret",
  "signature",
  "privatekey",
  "set-cookie",
  "sessiontoken",
  "bearer",
  "password",
]);

/** Prototype-pollution keys that invalidate any envelope. */
export const PROTO_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/**
 * @param {unknown} envelope
 * @returns {{ ok: boolean, code?: string, message?: string, negotiatedVersion?: number, needsConfirm?: boolean }}
 */
export function validateHandoffEnvelope(envelope, ctx) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return fail("malformed", "envelope must be an object");
  }
  const env = /** @type {Record<string, any>} */ (envelope);
  for (const k of Object.keys(env)) {
    if (PROTO_KEYS.includes(k)) return fail("malformed", `forbidden key ${k}`);
  }
  // Secret scan over keys (case-insensitive) at top level + nested capabilities?
  for (const k of Object.keys(env)) {
    if (SECRET_KEYS.includes(String(k).toLowerCase())) {
      return fail("secret-field", `envelope must be non-secret (found ${k})`);
    }
  }
  // Explicit signature claims are never honored.
  if ("signature" in env || "signed" in env || "authToken" in env) {
    return fail("secret-field", "envelope must not carry signature/auth claims");
  }
  const v = env.protocolVersion;
  if (!Number.isInteger(v)) return fail("bad-version", "protocolVersion must be an integer");
  if (v < MIN_HANDOFF_PROTOCOL || v > CURRENT_HANDOFF_PROTOCOL) {
    if (v < MIN_HANDOFF_PROTOCOL) return fail("unsupported-version", `N-2 version ${v} unsupported`);
    return fail("unsupported-version", `future version ${v} unsupported`);
  }
  const sourceUrl = env.sourceUrl;
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    return fail("bad-url", "sourceUrl required");
  }
  if (sourceUrl.length > MAX_SOURCE_URL_LENGTH) return fail("oversize", "sourceUrl too long");
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return fail("bad-url", "sourceUrl invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("bad-url", "sourceUrl scheme must be http/https");
  }
  if (parsed.username || parsed.password) return fail("secret-field", "sourceUrl must not embed credentials");
  if (env.capabilities !== undefined) {
    if (!Array.isArray(env.capabilities)) return fail("malformed", "capabilities must be an array");
    if (env.capabilities.length > MAX_CAPABILITIES) return fail("oversize", "too many capabilities");
    for (const cap of env.capabilities) {
      if (typeof cap !== "string" || cap.length === 0 || cap.length > MAX_CAPABILITY_LENGTH) {
        return fail("oversize", "capability out of bounds");
      }
      if (!/^[a-z0-9-]+$/i.test(cap)) return fail("malformed", `bad capability ${cap}`);
    }
  }
  if (env.requestId !== undefined) {
    if (typeof env.requestId !== "string" || env.requestId.length > MAX_REQUEST_ID_LENGTH) {
      return fail("oversize", "requestId out of bounds");
    }
  }
  let size = 0;
  try {
    size = JSON.stringify(env).length;
  } catch {
    return fail("malformed", "envelope not serializable");
  }
  if (size > MAX_ENVELOPE_BYTES) return fail("oversize", `envelope ${size} > ${MAX_ENVELOPE_BYTES}`);
  // Sender allowlist check (browser-reported sender/origin where available).
  try {
    const allowed = ctx && typeof ctx.isAllowedSender === "function" ? ctx.isAllowedSender(ctx.senderOrigin) : false;
    if (!allowed) return fail("wrong-origin", `sender not allowlisted: ${ctx ? ctx.senderOrigin : "?"}`);
  } catch {
    return fail("wrong-origin", "sender check failed");
  }
  return { ok: true, negotiatedVersion: v, needsConfirm: true };
}

/**
 * Require explicit user confirmation before any permission/fetch.
 * Performs zero network calls when unconfirmed or when validation failed.
 * @param {{ ok: boolean }} validation result of `validateHandoffEnvelope`
 * @param {boolean} userConfirmed explicit checkbox/confirm action
 * @param {{ onConfirmed?: () => void, networkCalls?: { count: number } }} [deps]
 */
export function confirmHandoff(validation, userConfirmed, deps = {}) {
  if (!validation || validation.ok !== true) {
    return { ok: false, code: "invalid-envelope" };
  }
  if (userConfirmed !== true) {
    return { ok: false, code: "confirmation-required" };
  }
  // Only here may the caller proceed to permission/fetch. Record the gate.
  if (typeof deps.onConfirmed === "function") deps.onConfirmed();
  return { ok: true, needsFetch: true };
}
