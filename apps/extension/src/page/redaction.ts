/**
 * Central redaction helpers (Phase 12).
 *
 * - `redactUrl`: strip userinfo, redact sensitive query values, drop fragments.
 * - `scanForCanary`: search text snapshots for secret canaries.
 * - `bestEffortOverwrite`: zero-fill caller-owned buffers on release.
 * - `FORBIDDEN_STORES`: places that must never hold secrets.
 *
 * Memory-only handling: secrets live only in owned buffers/variables, are
 * released on ack/cancel/disconnect/timeout/exit, and owned buffers are
 * overwritten best-effort. There is explicitly NO claim of universal
 * zeroization: JavaScript, browser, IPC, allocator, and OS copies cannot be
 * guaranteed wiped. Callers must not copy secrets into forbidden stores.
 *
 * Plain JavaScript + JSDoc.
 */

/** Stores/sinks that must never intentionally hold cookie values or secrets. */
export const FORBIDDEN_STORES = Object.freeze([
  "extension-storage",
  "indexeddb",
  "local-storage",
  "session-storage",
  "browser-cache",
  "url",
  "clipboard",
  "console",
  "analytics",
  "crash-report",
  "tauri-ipc",
  "filesystem",
  "cache-keys",
  "process-args",
  "environment",
]);

/** Query parameter names treated as sensitive. */
export const SENSITIVE_QUERY_KEYS = Object.freeze([
  "token",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "sid",
  "key",
  "apikey",
  "api_key",
  "secret",
  "password",
  "passwd",
  "code",
  "state",
  "sessiontoken",
]);

/**
 * Redact a URL for labels/logs/diagnostics.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  if (typeof url !== "string" || url.length === 0) return "[empty-url]";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "[invalid-url]";
  }
  if (parsed.username || parsed.password) {
    parsed.username = "***";
    try {
      parsed.password = "";
    } catch {
      // ignore
    }
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) {
      parsed.searchParams.set(key, "***");
    }
  }
  if (parsed.hash && parsed.hash.length > 1) {
    parsed.hash = "";
  }
  return parsed.toString();
}

/**
 * Scan text snapshots for leaked canaries.
 * @param {string[]} haystacks e.g. [consoleText, storageDump, stderrText]
 * @param {string[]} canaries unique per-test secret values
 * @returns {string[]} canaries that were found (empty = clean)
 */
export function scanForCanary(haystacks, canaries) {
  const found = [];
  for (const canary of canaries) {
    if (!canary) continue;
    for (const hay of haystacks) {
      if (typeof hay === "string" && hay.includes(canary)) {
        found.push(canary);
        break;
      }
    }
  }
  return found;
}

/**
 * Best-effort overwrite of a caller-owned buffer. Fills with zeros.
 * This only affects the passed view; it cannot wipe browser/allocator/OS
 * copies. Never treat a clean canary scan as proof of memory zeroization.
 * @param {Uint8Array} buf owned mutable buffer
 * @returns {boolean} true when overwrite was performed
 */
export function bestEffortOverwrite(buf) {
  if (!(buf instanceof Uint8Array)) return false;
  buf.fill(0);
  return true;
}
