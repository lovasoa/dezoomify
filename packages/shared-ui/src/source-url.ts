// Shared validation for ordinary user input URLs. Credentials and
// secret-bearing query or fragment keys are rejected before use.

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
    // `https://@example.com`).
    const afterScheme = trimmed.split("://")[1] ?? "";
    const authority = afterScheme.split(/[/?#]/)[0] ?? "";
    return !authority.includes("@");
  } catch {
    return false;
  }
}

/**
 * Secret/credential query keys that never travel in a source URL or enter
 * diagnostics (case-insensitive exact match). This is the wire-format
 * counterpart of the wasm boundary's `isSecretKey` callable; Rust
 * `dezoomify::model::SENSITIVE_QUERY_KEYS` owns the policy. It is spelled out
 * here only for pure callers that load no runtime (the desktop webview's
 * payload validation); callers with a runtime ask the boundary instead.
 */
export const SENSITIVE_QUERY_KEYS = new Set([
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
 * Signed/credential query keys rejected from metadata CORS proxy admission
 * (a strict subset of `SENSITIVE_QUERY_KEYS`: OAuth exchange params such as
 * `code`/`state` are not signed-fetch credentials). Consumed by
 * `web-fetch.ts` (proxy-fallback gate) and `src/server/security.ts`
 * (metadata proxy validator).
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
 * Secret-bearing query or fragment keys in a source URL, the pure
 * counterpart of the boundary's `hasSecretParams` callable: a pair's key is
 * the text before its first `=`, so bare keys (`?token`) and percent-encoded
 * spellings are caught like `?token=secret`. Unparseable URLs count as
 * secret-bearing.
 */
export function hasSecretQueryParams(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true;
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  if (parsed.hash) {
    for (const pair of parsed.hash.slice(1).split("&")) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      const rawKey = (eq < 0 ? pair : pair.slice(0, eq)).replace(SECRET_FRAGMENT_KEY_RE, "");
      if (rawKey.length === 0) continue;
      if (SENSITIVE_QUERY_KEYS.has(rawKey.toLowerCase())) return true;
      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        continue;
      }
      if (SENSITIVE_QUERY_KEYS.has(decodedKey.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Signed/credential query keys gate proxy admission: URLs whose signature
 * would break, or that carry credentials, must never be proxied. Unparseable
 * URLs count as signed (fail closed).
 */
export function hasSignedQuery(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return true;
  }
  for (const k of parsed.searchParams.keys()) {
    if (SIGNED_QUERY_KEYS.has(k.toLowerCase())) return true;
  }
  return false;
}

// Idle prefill: read an initial URL from the launch location without ever
// treating it as a started job (`?url=`/`?src=`, `#url=`, or bare hash).
// Invalid or secret-bearing candidates return null: the vocabulary check is
// the pure, no-runtime path of the boundary's `hasSecretParams` callable.
function isPrefillable(candidate: string): boolean {
  return isValidInputUrl(candidate) && !hasSecretQueryParams(candidate);
}

export function readInitialUrl(loc?: { search?: string; hash?: string }): string | null {
  try {
    if (!loc) return null;
    const search = typeof loc.search === "string" ? loc.search : "";
    if (search) {
      const params = new URLSearchParams(search);
      for (const key of ["url", "src", "input_url", "inputUrl"]) {
        const v = params.get(key);
        if (v && isPrefillable(v.trim())) return v.trim();
      }
    }
    const hash = typeof loc.hash === "string" ? loc.hash : "";
    if (hash?.startsWith("#")) {
      const body = hash.slice(1);
      if (body.startsWith("?")) {
        const params = new URLSearchParams(body.slice(1));
        const v = params.get("url") ?? params.get("src");
        if (v && isPrefillable(v.trim())) return v.trim();
      } else if (body.startsWith("url=")) {
        try {
          const v = decodeURIComponent(body.slice(4).replace(/\+/g, " "));
          if (isPrefillable(v.trim())) return v.trim();
        } catch {
          return null;
        }
      } else if (body.length > 0 && body.length <= 2048) {
        try {
          const v = decodeURIComponent(body.replace(/\+/g, " "));
          if (isPrefillable(v.trim())) return v.trim();
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
