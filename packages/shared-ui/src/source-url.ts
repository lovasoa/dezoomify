// Shared validation for ordinary user input and deep-link source URLs.
// Deep links carry only a source address; credentials, local paths, and
// secret-bearing query or fragment keys are rejected before use. The Rust
// shell (`apps/desktop/src-tauri/src/deep_link.rs` and `commands.rs`) is the
// authoritative validator; this module is the one TypeScript mirror.

export function isValidInputUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    // userinfo credentials must never enter: any authority containing `@`
    // is rejected (`URL.username` alone misses empty userinfo such as
    // `https://@example.com`), mirroring the Rust `has_userinfo` check.
    const afterScheme = trimmed.split("://")[1] ?? "";
    const authority = afterScheme.split(/[/?#]/)[0] ?? "";
    return !authority.includes("@");
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
 * `apps/desktop/src-tauri/src/deep_link.rs`). Rejection behavior is pinned
 * on both sides by `testdata/deep-link-vectors.json`; membership itself is
 * deliberately unpinned (adding or removing a key is a reviewed policy edit).
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
  const lower = trimmed.toLowerCase();
  return !["file://", "/etc/", "c:\\"].some((needle) => lower.includes(needle));
}

// Idle prefill: read an initial URL from the launch location without ever
// treating it as a started job. Supports ?url=/ ?src= and #url= or bare
// hash payloads. Invalid or secret-bearing candidates return null. The host
// passes its own location; shared UI reads no host globals.
export function readInitialUrl(loc?: { search?: string; hash?: string }): string | null {
  try {
    if (!loc) return null;
    const search = typeof loc.search === "string" ? loc.search : "";
    if (search) {
      const params = new URLSearchParams(search);
      for (const key of ["url", "src", "input_url", "inputUrl"]) {
        const v = params.get(key);
        if (v && isValidInputUrl(v.trim())) return v.trim();
      }
    }
    const hash = typeof loc.hash === "string" ? loc.hash : "";
    if (hash?.startsWith("#")) {
      const body = hash.slice(1);
      if (body.startsWith("?")) {
        const params = new URLSearchParams(body.slice(1));
        const v = params.get("url") ?? params.get("src");
        if (v && isValidInputUrl(v.trim())) return v.trim();
      } else if (body.startsWith("url=")) {
        try {
          const v = decodeURIComponent(body.slice(4).replace(/\+/g, " "));
          if (isValidInputUrl(v.trim())) return v.trim();
        } catch {
          return null;
        }
      } else if (body.length > 0 && body.length <= 2048) {
        try {
          const v = decodeURIComponent(body.replace(/\+/g, " "));
          if (isValidInputUrl(v.trim())) return v.trim();
        } catch {
          return null;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface ValidatedDeepLink {
  sourceUrl: string;
  hint: string | null;
  version: number;
}

const utf8Encoder = new TextEncoder();

// UTF-8 byte length, matching the Rust shell's byte bounds.
function utf8Length(text: string): number {
  return utf8Encoder.encode(text).length;
}

export function normalizeDeepLinkHint(hint: unknown): string | null | undefined {
  if (hint === undefined || hint === null) return null;
  if (typeof hint !== "string") return undefined;
  if (hint.includes("\0")) return undefined;
  if (hint.length === 0) return null;
  // Byte bound matches the Rust shell (`deep_link.rs`: "hint beyond 256 bytes").
  if (utf8Length(hint) > 256) return undefined;
  return hint;
}

export function normalizeDeepLinkVersion(version: unknown): number | null {
  if (typeof version === "number" && Number.isInteger(version)) {
    return version === 1 || version === 2 ? version : null;
  }
  if (typeof version === "string" && (version === "1" || version === "2")) {
    return Number(version);
  }
  return null;
}

// Validate a `dezoomify://deep-link-pending` payload again in the frontend
// before showing the confirm UI. Accepts exactly the validated
// `{source_url, hint, version}` triple emitted by the Rust shell; raw
// `dezoomify://` values are refused (the shell's parser is the single
// validator, pinned by testdata/deep-link-vectors.json). Null means
// reject (no-op).
export function validateDeepLinkPayload(
  payload: Record<string, unknown>,
): ValidatedDeepLink | null {
  const sourceUrl = payload.source_url;
  const version = normalizeDeepLinkVersion(payload.version);
  if (version === null) return null;
  if (!isValidDeepLinkSource(sourceUrl)) return null;
  const hint = normalizeDeepLinkHint(payload.hint ?? null);
  if (hint === undefined) return null;
  return { sourceUrl: (sourceUrl as string).trim(), hint, version };
}
