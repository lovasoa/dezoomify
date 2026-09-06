/**
 * Extension-to-native handoff client (page side).
 *
 * Orchestrates one consented cookie handoff to the desktop app over
 * allowlisted Native Messaging. The browser enforces the manifest allowlist;
 * this client never authenticates anyone from a self-asserted id, challenge,
 * or nonce. Challenge + one-use nonce bind one consent/credential exchange
 * to one job and block replay; they are session binding, not signatures.
 *
 * Flow: validate locally (zero native messages on failure) -> handshake
 * (capability gate) -> negotiate (fresh challenge+nonce) -> explicit consent
 * UI (names/scopes only, never values) -> read cookies for the consented
 * origins only (cookies + host permissions required) -> single bounded
 * credential message -> job-started. Declining (or denying permission)
 * keeps the job cookieless in the extension with zero credential send.
 * Sibling origins never receive cookies (local scope check + host enforcement).
 *
 * Memory-only: cookie values live only in owned locals, are dropped and
 * best-effort overwritten after send/cancel, and never reach forbidden
 * stores (storage, cache keys, console, analytics, URLs). There is no claim
 * of universal zeroization in JavaScript or managed browser memory.
 *
 * Plain JavaScript + JSDoc, import-free so node unit tests can load it via
 * a data: URL without a build step. All host/cookie/consent effects are
 * injected for deterministic tests.
 */

export const NATIVE_HOST_NAME = "dev.ophir.dezoomify.native_host";
export const CURRENT_NATIVE_PROTOCOL = 2;
export const MIN_NATIVE_PROTOCOL = 1;
export const NATIVE_PROTOCOL_VERSION = "1.0";
export const MAX_ORIGINS = 8;
export const MAX_COOKIE_NAMES = 64;
export const MAX_COOKIES = 64;
export const MAX_SOURCE_URL_LENGTH = 2048;
export const MAX_COOKIE_NAME_LENGTH = 256;
export const MAX_COOKIE_VALUE_LENGTH = 4096;
export const MAX_TOKEN_LENGTH = 128;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Query keys that must never appear in a handoff source URL. */
export const SECRET_QUERY_KEYS = Object.freeze([
  "cookie",
  "cookies",
  "authorization",
  "proxy-authorization",
  "bearer",
  "token",
  "signature",
  "sig",
  "auth",
  "secret",
  "password",
  "session",
  "sid",
  "apikey",
  "api_key",
  "key",
]);

/**
 * Validate a handoff source URL (bounded, non-secret, untrusted until confirmed).
 * Mirrors the native host envelope rules.
 * @param {unknown} raw
 * @returns {{ ok: boolean, code?: string }}
 */
export function validateHandoffSource(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, code: "bad-url" };
  if (raw.length > MAX_SOURCE_URL_LENGTH) return { ok: false, code: "oversize" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: "bad-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "bad-scheme" };
  }
  if (parsed.username || parsed.password) return { ok: false, code: "secret-field" };
  const lower = raw.toLowerCase();
  for (const needle of [
    "cookie",
    "authorization",
    "bearer",
    "signature",
    "secret",
    "password",
    "session=",
    "token=",
    "apikey",
    "api_key",
    "file://",
    "/etc/",
    "c:\\",
  ]) {
    if (lower.includes(needle)) return { ok: false, code: "secret-field" };
  }
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.includes(key.toLowerCase())) {
      return { ok: false, code: "secret-field" };
    }
  }
  return { ok: true };
}

/**
 * Validate consented origins (1..8 http(s), no userinfo).
 * @param {unknown} origins
 * @returns {{ ok: boolean, code?: string }}
 */
export function validateHandoffOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > MAX_ORIGINS) {
    return { ok: false, code: "bad-origins" };
  }
  for (const origin of origins) {
    if (typeof origin !== "string" || origin.length === 0 || origin.length > 1024) {
      return { ok: false, code: "bad-origins" };
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return { ok: false, code: "bad-origins" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, code: "bad-origins" };
    }
    if (parsed.username || parsed.password) return { ok: false, code: "bad-origins" };
  }
  return { ok: true };
}

/**
 * Validate consented cookie names (never values).
 * @param {unknown} names
 * @returns {{ ok: boolean, code?: string }}
 */
export function validateHandoffCookieNames(names) {
  if (!Array.isArray(names)) return { ok: false, code: "bad-cookies" };
  if (names.length > MAX_COOKIE_NAMES) return { ok: false, code: "bad-cookies" };
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_COOKIE_NAME_LENGTH) {
      return { ok: false, code: "bad-cookies" };
    }
    if (/[\r\n\0=;, ]/.test(name) || /[\x00-\x20\x7f]/.test(name)) {
      return { ok: false, code: "bad-cookies" };
    }
  }
  return { ok: true };
}

/**
 * Validate credential cookies against the consented scope (sibling isolation).
 * Every cookie origin must be consented; every cookie name must have been
 * disclosed at consent time. Cookieless (zero cookies) is always allowed.
 * @param {unknown} cookies
 * @param {string[]} consentedOrigins
 * @param {string[]} consentedNames
 * @returns {{ ok: boolean, code?: string }}
 */
export function validateCredentialCookies(cookies, consentedOrigins, consentedNames) {
  if (!Array.isArray(cookies)) return { ok: false, code: "bad-cookies" };
  if (cookies.length > MAX_COOKIES) return { ok: false, code: "bad-cookies" };
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object") return { ok: false, code: "bad-cookies" };
    const { name, value, origin } = /** @type {{ name?: unknown, value?: unknown, origin?: unknown }} */ (cookie);
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_COOKIE_NAME_LENGTH) {
      return { ok: false, code: "bad-cookies" };
    }
    if (typeof value !== "string" || value.length > MAX_COOKIE_VALUE_LENGTH) {
      return { ok: false, code: "bad-cookies" };
    }
    if (typeof origin !== "string" || origin.length === 0) {
      return { ok: false, code: "bad-origins" };
    }
    if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) {
      return { ok: false, code: "bad-cookies" };
    }
    if (!consentedOrigins.includes(origin)) {
      return { ok: false, code: "bad-origins" };
    }
    if (!consentedNames.includes(name)) {
      return { ok: false, code: "bad-cookies" };
    }
  }
  return { ok: true };
}

/**
 * Build consent details for explicit UI (names/scopes only, never values).
 * @param {{ origins: string[], cookieNames: string[], jobId: string }} d
 */
export function buildHandoffConsentDetails(d) {
  const origins = Array.isArray(d.origins) ? d.origins.slice(0, MAX_ORIGINS) : [];
  const cookieNames = Array.isArray(d.cookieNames)
    ? d.cookieNames.filter((n) => typeof n === "string").slice(0, MAX_COOKIE_NAMES)
    : [];
  return Object.freeze({
    host: NATIVE_HOST_NAME,
    origins: Object.freeze([...origins]),
    cookieNames: Object.freeze([...cookieNames]),
    jobId: d.jobId,
  });
}

/**
 * Best-effort overwrite of owned cookie values, then drop. Strings are
 * immutable, so this overwrites any byte copies the caller holds and clears
 * the object refs. No universal-zeroization claim.
 * @param {{ name: string, value: string }[]} cookies
 */
export function dropCredentialValues(cookies) {
  if (!Array.isArray(cookies)) return;
  for (const cookie of cookies) {
    try {
      if (cookie && typeof cookie.value === "string") {
        const bytes = new TextEncoder().encode(cookie.value);
        bytes.fill(0);
        cookie.value = "";
      }
    } catch {
      // best-effort only
    }
  }
}

/**
 * Orchestrate one handoff. All effects injected for deterministic tests.
 * @param {{
 *   sourceUrl: string,
 *   origins: string[],
 *   cookieNames: string[],
 *   jobId: string,
 *   extensionId?: string,
 *   sendNativeMessage: (msg: any) => Promise<any>,
 *   getCookies: (origin: string) => Promise<{ name: string, value: string }[]>,
 *   showConsent: (details: any) => Promise<boolean>,
 * }} args
 * @returns {Promise<{ ok: boolean, code?: string, job?: string, continuedCookieless?: boolean, credentialSent?: boolean, nativeCalls?: number }>}
 */
export async function requestNativeHandoff(args) {
  let nativeCalls = 0;
  const fail = (code) => ({ ok: false, code, credentialSent: false, nativeCalls });
  const source = validateHandoffSource(args.sourceUrl);
  if (!source.ok) return fail(source.code ?? "bad-url");
  const origins = validateHandoffOrigins(args.origins);
  if (!origins.ok) return fail(origins.code ?? "bad-origins");
  const names = validateHandoffCookieNames(args.cookieNames);
  if (!names.ok) return fail(names.code ?? "bad-cookies");
  if (typeof args.jobId !== "string" || args.jobId.length === 0 || args.jobId.length > MAX_TOKEN_LENGTH) {
    return fail("bad-job");
  }
  if (typeof args.sendNativeMessage !== "function") return fail("no-transport");
  if (typeof args.getCookies !== "function") return fail("no-cookies");
  if (typeof args.showConsent !== "function") return fail("no-consent-ui");

  // 1. Capability gate: handshake must report handoff support.
  let handshake;
  try {
    nativeCalls += 1;
    handshake = await args.sendNativeMessage({
      kind: "handshake",
      protocol: NATIVE_PROTOCOL_VERSION,
      clientVersion: CURRENT_NATIVE_PROTOCOL,
    });
  } catch {
    return fail("native-unavailable");
  }
  if (!handshake || typeof handshake !== "object") return fail("native-unavailable");
  if (handshake.error) return fail(handshake.error.code ?? "native-unavailable");
  if (handshake.kind !== "handshake-ack") return fail("native-unavailable");
  if (handshake.capabilities?.handoff !== true) return fail("capability.unavailable");

  // 2. Negotiate one fresh challenge+nonce bound to this job.
  let negotiated;
  try {
    nativeCalls += 1;
    negotiated = await args.sendNativeMessage({
      kind: "negotiate",
      clientVersion: CURRENT_NATIVE_PROTOCOL,
      jobId: args.jobId,
      extensionId: args.extensionId ?? "",
    });
  } catch {
    return fail("native-unavailable");
  }
  if (!negotiated || typeof negotiated !== "object") return fail("native-unavailable");
  if (negotiated.error) return fail(negotiated.error.code ?? "handoff.rejected");
  if (negotiated.kind !== "negotiated") return fail("handoff.rejected");
  const negotiatedVersion = negotiated.negotiatedVersion;
  if (!Number.isInteger(negotiatedVersion) || negotiatedVersion < MIN_NATIVE_PROTOCOL || negotiatedVersion > CURRENT_NATIVE_PROTOCOL) {
    return fail("protocol.incompatible");
  }
  const challenge = negotiated.challenge;
  const nonce = negotiated.nonce;
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > MAX_TOKEN_LENGTH) {
    return fail("bad-nonce");
  }
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > MAX_TOKEN_LENGTH) {
    return fail("bad-nonce");
  }

  // 3. Explicit consent UI (names/scopes only, never values).
  const details = buildHandoffConsentDetails({
    origins: args.origins,
    cookieNames: args.cookieNames,
    jobId: args.jobId,
  });
  let confirmed = false;
  try {
    confirmed = (await args.showConsent(details)) === true;
  } catch {
    confirmed = false;
  }
  // Record consent (or decline) with the host before any cookie access.
  if (confirmed !== true) {
    try {
      nativeCalls += 1;
      await args.sendNativeMessage({ kind: "decline", challenge });
    } catch {
      // decline is best-effort; the job stays cookieless regardless
    }
    return { ok: true, continuedCookieless: true, credentialSent: false, nativeCalls };
  }
  try {
    nativeCalls += 1;
    const consented = await args.sendNativeMessage({
      kind: "consent",
      challenge,
      nonce,
      jobId: args.jobId,
      origins: args.origins,
      cookieNames: args.cookieNames,
      confirmed: true,
    });
    if (!consented || typeof consented !== "object") return fail("handoff.rejected");
    if (consented.error) return fail(consented.error.code ?? "handoff.rejected");
    if (consented.kind !== "consented") return fail("handoff.rejected");
  } catch {
    return fail("native-unavailable");
  }

  // 4. Read cookies for the consented origins only (permission-gated by the
  // caller). Sibling origins are never read.
  /** @type {{ name: string, value: string, origin: string }[]} */
  const cookies = [];
  try {
    for (const origin of args.origins) {
      const entries = await args.getCookies(origin);
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry.name !== "string" || typeof entry.value !== "string") continue;
        cookies.push({ name: entry.name, value: entry.value, origin });
      }
    }
  } catch (e) {
    try {
      nativeCalls += 1;
      await args.sendNativeMessage({ kind: "decline", challenge });
    } catch {
      // ignore
    }
    dropCredentialValues(cookies);
    const code = e && typeof e === "object" && "code" in /** @type {any} */ (e) ? String(/** @type {any} */ (e).code) : "permission-denied";
    return { ok: false, code, continuedCookieless: true, credentialSent: false, nativeCalls };
  }
  const scoped = validateCredentialCookies(cookies, args.origins, args.cookieNames);
  if (!scoped.ok) {
    try {
      nativeCalls += 1;
      await args.sendNativeMessage({ kind: "decline", challenge });
    } catch {
      // ignore
    }
    dropCredentialValues(cookies);
    return { ok: false, code: scoped.code ?? "bad-cookies", credentialSent: false, nativeCalls };
  }

  // 5. Single bounded credential message (values cross here, once).
  const credential = {
    kind: "credential",
    challenge,
    nonce,
    jobId: args.jobId,
    sourceUrl: args.sourceUrl,
    origins: args.origins,
    cookies,
  };
  let credentialBytes = 0;
  try {
    credentialBytes = JSON.stringify(credential).length;
  } catch {
    dropCredentialValues(cookies);
    return fail("oversize");
  }
  if (credentialBytes > MAX_MESSAGE_BYTES) {
    dropCredentialValues(cookies);
    return fail("oversize");
  }
  let started;
  try {
    nativeCalls += 1;
    started = await args.sendNativeMessage(credential);
  } catch {
    dropCredentialValues(cookies);
    return { ok: false, code: "native-unavailable", credentialSent: true, nativeCalls };
  }
  dropCredentialValues(cookies);
  if (!started || typeof started !== "object") return { ok: false, code: "native-unavailable", credentialSent: true, nativeCalls };
  if (started.error) return { ok: false, code: started.error.code ?? "handoff.rejected", credentialSent: true, nativeCalls };
  if (started.kind !== "job-started") return { ok: false, code: "handoff.rejected", credentialSent: true, nativeCalls };
  return { ok: true, job: typeof started.job === "string" ? started.job : args.jobId, credentialSent: true, nativeCalls };
}
