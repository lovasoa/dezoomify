// Shared validation for ordinary user input and deep-link source URLs.
// Deep links carry only a source address; credentials, local paths, and
// secret-bearing query or fragment keys are rejected before use.

export function isValidInputUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Canonical secret/credential query-key vocabulary (28 keys, sorted): query or
 * fragment keys that must never travel in a handoff deep link or enter
 * diagnostics. Matching is case-insensitive exact, never substring. This is
 * the single TypeScript source; it mirrors the canonical Rust contract
 * constant `dezoomify::model::SENSITIVE_QUERY_KEYS` in
 * `crates/dezoomify/src/model.rs` (consumed by
 * `apps/desktop/src-tauri/src/deep_link.rs`). The two lists are pinned
 * together by twin membership lock tests: `sensitive_query_key_membership_is_locked`
 * in `deep_link.rs` and "secret query vocabulary mirrors the Rust contract" in
 * `apps/desktop/tests/policy-vectors.test.mjs`. Update both sides together.
 */
export const DEEP_LINK_SECRET_QUERY_KEYS = new Set([
  "access-token",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "code",
  "cookie",
  "cookies",
  "credential",
  "key",
  "passwd",
  "password",
  "proxy-authorization",
  "secret",
  "session",
  "sessionid",
  "sessiontoken",
  "set-cookie",
  "sid",
  "sig",
  "signature",
  "state",
  "ticket",
  "token",
  "x-api-key",
]);

/**
 * Signed/credential query-key policy for metadata CORS proxy admission: URLs
 * whose signature would break, or that carry credentials, must never be
 * proxied. Deliberately narrower than `DEEP_LINK_SECRET_QUERY_KEYS` (a strict
 * subset): OAuth handoff parameters such as `code` and `state` are not
 * signed-fetch credentials, and rejecting them would break legitimate metadata
 * URLs. Defined once here; consumed by `packages/browser-runtime/src/web-fetch.ts`
 * (the browser's proxy-fallback gate) and `src/server/security.ts` (the
 * metadata CORS proxy validator). Locked by
 * `apps/desktop/tests/policy-vectors.test.mjs`.
 */
export const SIGNED_QUERY_KEYS = new Set([
  "access_token",
  "auth",
  "credential",
  "key",
  "password",
  "secret",
  "session",
  "sid",
  "sig",
  "signature",
  "ticket",
  "token",
]);

const SECRET_FRAGMENT_KEY_RE = /^[?#]+/;

/**
 * Secret-bearing query or fragment keys in a source URL. Regions mirror the
 * Rust `smuggled_secret_key` in `apps/desktop/src-tauri/src/deep_link.rs`: the
 * query runs from the first `?` up to the first `#`; the fragment runs from
 * the first `#`. A pair's key is the text before its first `=` (or the whole
 * pair) and counts whether or not a value follows, so bare keys (`?token`) and
 * percent-encoded spellings (`?%74oken=1`) are caught like `?token=secret`.
 * Unparseable URLs count as secret-bearing (fail closed).
 */
export function hasSecretQueryParams(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true;
  }
  for (const key of parsed.searchParams.keys()) {
    if (DEEP_LINK_SECRET_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  if (parsed.hash) {
    for (const pair of parsed.hash.slice(1).split("&")) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      const rawKey = (eq < 0 ? pair : pair.slice(0, eq)).replace(SECRET_FRAGMENT_KEY_RE, "");
      if (rawKey.length === 0) continue;
      if (DEEP_LINK_SECRET_QUERY_KEYS.has(rawKey.toLowerCase())) return true;
      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        continue;
      }
      if (DEEP_LINK_SECRET_QUERY_KEYS.has(decodedKey.toLowerCase())) return true;
    }
  }
  return false;
}

export function isValidDeepLinkSource(source: unknown): source is string {
  if (typeof source !== "string") return false;
  const trimmed = source.trim();
  if (!isValidInputUrl(trimmed) || hasSecretQueryParams(trimmed)) return false;
  // userinfo credentials must never travel in a deep link: any authority
  // containing `@` is rejected, mirroring the Rust `has_userinfo` check in
  // `apps/desktop/src-tauri/src/deep_link.rs`. `URL.username` alone misses
  // empty userinfo (`https://@example.com`).
  const afterScheme = trimmed.split("://")[1] ?? "";
  const authority = afterScheme.split(/[/?#]/)[0] ?? "";
  if (authority.includes("@")) return false;
  const lower = trimmed.toLowerCase();
  return !["file://", "/etc/", "c:\\"].some((needle) => lower.includes(needle));
}
