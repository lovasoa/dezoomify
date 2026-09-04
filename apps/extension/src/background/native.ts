/**
 * One-use native handoff session (Phase 12).
 *
 * Trust model (documented, do not weaken):
 * - The browser enforces the native host manifest's exact `allowed_origins` /
 *   extension IDs. That browser enforcement authenticates the extension sender
 *   of the browser-established Native Messaging channel to the native host.
 * - The host must NOT claim to authenticate the extension by inspecting a
 *   self-asserted ID, challenge response, nonce, or handoff payload.
 * - Fresh challenge + one-use nonce bind ONE consent/credential message to one
 *   job. They provide session binding + replay defense only; they are not a
 *   signature and authenticate neither the sender nor any website content.
 * - Website/deep-link content stays untrusted and never inherits channel auth.
 * - Cookies flow only after explicit UI confirmation, only to the native host,
 *   in one bounded message, memory-only, never persisted intentionally.
 *
 * Plain JavaScript + JSDoc. Time/randomness/host-allowlist are injected for
 * deterministic unit tests.
 */

export const CURRENT_NATIVE_PROTOCOL = 2;
export const MIN_NATIVE_PROTOCOL = 1;
export const HANDOFF_TTL_MS = 5 * 60 * 1000;
export const MAX_ORIGINS = 8;
export const MAX_COOKIE_NAMES = 64;

/**
 * Build consent details shown in UI. Names only, never values.
 * @param {{ appName: string, appVersion: string, origins: string[], cookieNames: string[], expiry: string, purpose: string }} d
 */
export function buildConsentDetails(d) {
  const origins = Array.isArray(d.origins) ? d.origins.slice(0, MAX_ORIGINS) : [];
  const names = Array.isArray(d.cookieNames) ? d.cookieNames.filter((n) => typeof n === "string").slice(0, MAX_COOKIE_NAMES) : [];
  return Object.freeze({
    app: `${d.appName} ${d.appVersion}`,
    origins: Object.freeze(origins),
    cookieNames: Object.freeze(names),
    expiry: d.expiry,
    purpose: d.purpose,
  });
}

/**
 * Render consent details to a DOM-like snapshot string for tests.
 * Must contain names/scopes and never values.
 * @param {ReturnType<typeof buildConsentDetails>} details
 */
export function renderConsentSnapshot(details) {
  const lines = [
    `<div class="consent">`,
    `  <span class="app">${escapeHtml(details.app)}</span>`,
    ...details.origins.map((o) => `  <span class="origin">${escapeHtml(o)}</span>`),
    ...details.cookieNames.map((n) => `  <span class="cookie-name">${escapeHtml(n)}</span>`),
    `  <span class="expiry">${escapeHtml(details.expiry)}</span>`,
    `  <span class="purpose">${escapeHtml(details.purpose)}</span>`,
    `</div>`,
  ];
  return lines.join("\n");
}

/**
 * @param {string} s
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Create a one-use native handoff manager.
 * @param {{
 *   now?: () => number,
 *   randomHex?: (bytes: number) => string,
 *   isExtensionIdAllowed?: (id: string) => boolean,
 *   onNativeJob?: (job: any) => void,
 * }} [deps]
 */
export function createNativeHandoffManager(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const randomHex =
    deps.randomHex ??
    ((bytes) => {
      let s = "";
      for (let i = 0; i < bytes; i++) {
        s += Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, "0");
      }
      return s;
    });
  const isExtensionIdAllowed = deps.isExtensionIdAllowed ?? (() => false);
  /** @type {Map<string, any>} challenge -> session */
  const pending = new Map();
  /** @type {Set<string>} used nonces (replay table) */
  const usedNonces = new Set();

  /**
   * Negotiate protocol then issue a fresh challenge+nonce for one handoff.
   */
  function negotiate({ extensionId, clientVersion, jobId }) {
    if (!isExtensionIdAllowed(extensionId)) {
      return { ok: false, code: "id-not-allowed" };
    }
    if (!Number.isInteger(clientVersion) || clientVersion < MIN_NATIVE_PROTOCOL || clientVersion > CURRENT_NATIVE_PROTOCOL) {
      return { ok: false, code: "incompatible-version" };
    }
    if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 128) {
      return { ok: false, code: "bad-job" };
    }
    const challenge = randomHex(16);
    const nonce = randomHex(16);
    const createdAt = now();
    pending.set(challenge, {
      challenge,
      nonce,
      jobId,
      extensionId,
      createdAt,
      expiresAt: createdAt + HANDOFF_TTL_MS,
      consented: false,
      redeemed: false,
    });
    return { ok: true, negotiatedVersion: Math.min(clientVersion, CURRENT_NATIVE_PROTOCOL), challenge, nonce, expiresAt: createdAt + HANDOFF_TTL_MS };
  }

  /**
   * Bind an explicit consent decision to the challenge/job/nonce.
   * Rejects replay/expired/wrong-job without any native/network activity.
   */
  function bindConsent({ challenge, nonce, jobId, origins, cookieNames, confirmed }) {
    const sess = pending.get(challenge);
    if (!sess) return { ok: false, code: "unknown-challenge" };
    if (sess.redeemed || usedNonces.has(nonce)) return { ok: false, code: "replay" };
    if (sess.nonce !== nonce) return { ok: false, code: "bad-nonce" };
    if (sess.jobId !== jobId) return { ok: false, code: "wrong-job" };
    if (now() > sess.expiresAt) return { ok: false, code: "expired" };
    if (confirmed !== true) return { ok: false, code: "confirmation-required" };
    if (!Array.isArray(origins) || origins.length === 0 || origins.length > MAX_ORIGINS) {
      return { ok: false, code: "bad-origins" };
    }
    for (const o of origins) {
      try {
        const u = new URL(o);
        if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, code: "bad-origins" };
      } catch {
        return { ok: false, code: "bad-origins" };
      }
    }
    if (!Array.isArray(cookieNames) || cookieNames.length > MAX_COOKIE_NAMES) {
      return { ok: false, code: "bad-cookies" };
    }
    sess.consented = true;
    return { ok: true };
  }

  /**
   * Redeem exactly once. Valid redeem triggers `onNativeJob`; every reject
   * path performs zero network activity.
   */
  function redeem({ challenge, nonce, jobId }) {
    const sess = pending.get(challenge);
    if (!sess) return { ok: false, code: "unknown-challenge" };
    if (sess.redeemed || usedNonces.has(nonce)) return { ok: false, code: "replay" };
    if (sess.nonce !== nonce) return { ok: false, code: "bad-nonce" };
    if (sess.jobId !== jobId) return { ok: false, code: "wrong-job" };
    if (now() > sess.expiresAt) return { ok: false, code: "expired" };
    if (!sess.consented) return { ok: false, code: "consent-required" };
    sess.redeemed = true;
    usedNonces.add(nonce);
    pending.delete(challenge);
    if (typeof deps.onNativeJob === "function") {
      deps.onNativeJob({ jobId, challenge });
    }
    return { ok: true };
  }

  /** Decline keeps the job cookieless in the extension. */
  function decline(challenge) {
    pending.delete(challenge);
    return { ok: true, continuedCookieless: true };
  }

  function pendingCount() {
    return pending.size;
  }

  return { negotiate, bindConsent, redeem, decline, pendingCount, _usedNonces: usedNonces };
}
