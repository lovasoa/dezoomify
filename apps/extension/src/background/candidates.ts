/**
 * Candidate recognition for extension scans (Phase 12).
 *
 * - Records only `{ url, formatHint }` in memory.
 * - http/https only; all other schemes rejected.
 * - Length caps (URL) + count caps (store) with deterministic first-seen order.
 * - Deduplicates deterministically (first-seen wins).
 * - Never inspects response bodies or page DOM during scanning.
 * - Labels are redacted (userinfo + sensitive query). This module stays
 *   import-free for isolated tests and classic-script loading, so it mirrors
 *   `redaction.ts`; `candidates.test.mjs` asserts the two stay identical.
 *
 * Plain JavaScript + JSDoc (no TypeScript-only syntax).
 *
 * @typedef {{ url: string, formatHint: string }} Candidate
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_CANDIDATES = 100;

/** Query keys whose values must never appear in UI labels.
 *  Must stay identical to SENSITIVE_QUERY_KEYS in redaction.ts (tested). */
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
 * Heuristic format hint from URL text (no network, no body).
 * Mirrors legacy recognition families at a hint level; core does full parsing.
 * @param {string} url
 * @returns {string}
 */
export function recognizeFormatHint(url) {
  const lower = String(url).toLowerCase();
  if (lower.includes("imageproperties.xml")) return "zoomify";
  if (lower.includes(".dzi") || lower.includes("deepzoom")) return "dzi";
  if (lower.includes("info.json") && lower.includes("iiif")) return "iiif";
  if (lower.includes("/info.json")) return "iiif";
  if (lower.includes("iip") || lower.includes("fif=")) return "iip";
  if (lower.includes("tilegroup") || lower.includes("/tiles/") || lower.includes("tile_")) return "tile";
  if (lower.includes("zoomify")) return "zoomify";
  if (lower.includes("krpano") || lower.includes(".pff")) return "pff";
  return "unknown";
}

/**
 * Redact a URL for display labels: strip userinfo, redact sensitive query.
 * @param {string} url
 * @returns {string}
 */
export function redactUrlForLabel(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "[invalid-url]";
  }
  if (parsed.username || parsed.password) {
    parsed.username = "***";
    parsed.password = "";
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) {
      parsed.searchParams.set(key, "***");
    }
  }
  // Never leak fragments that look like tokens.
  if (parsed.hash && parsed.hash.length > 1) {
    parsed.hash = "";
  }
  return parsed.toString();
}

/**
 * Validate a raw candidate URL string.
 * @param {unknown} raw
 * @returns {{ ok: boolean, code?: string }}
 */
export function validateCandidateUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "empty" };
  }
  if (raw.length > MAX_URL_LENGTH) return { ok: false, code: "too-long" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "unsupported-scheme" };
  }
  return { ok: true };
}

/**
 * In-memory bounded candidate store. First-seen order, deterministic dedup.
 */
export function createCandidateStore() {
  /** @type {Map<string, Candidate>} */
  const byUrl = new Map();

  /**
   * @param {string} rawUrl
   * @returns {{ added: boolean, code: string, candidate?: Candidate }}
   */
  function add(rawUrl) {
    const v = validateCandidateUrl(rawUrl);
    if (!v.ok) return { added: false, code: v.code ?? "invalid" };
    if (byUrl.has(rawUrl)) return { added: false, code: "duplicate" };
    if (byUrl.size >= MAX_CANDIDATES) return { added: false, code: "cap-reached" };
    const candidate = { url: rawUrl, formatHint: recognizeFormatHint(rawUrl) };
    byUrl.set(rawUrl, candidate);
    return { added: true, code: "added", candidate };
  }

  function list() {
    return [...byUrl.values()];
  }

  function labels() {
    return list().map((c) => ({ url: c.url, label: redactUrlForLabel(c.url), formatHint: c.formatHint }));
  }

  function clear() {
    byUrl.clear();
  }

  return {
    add,
    list,
    labels,
    clear,
    dispose: clear,
    get size() {
      return byUrl.size;
    },
  };
}
