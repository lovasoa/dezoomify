// Shared validation for ordinary user input and deep-link source URLs.
// Deep links carry only a source address; credentials, local paths, and
// secret-bearing query or fragment keys are rejected before dispatch.

export function isValidInputUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

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
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const key = pair.slice(0, eq).replace(/^[?#]+/, "");
        if (DEEP_LINK_SECRET_QUERY_KEYS.has(key.toLowerCase())) return true;
      }
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
