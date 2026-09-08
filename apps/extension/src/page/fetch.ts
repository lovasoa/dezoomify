/**
 * Browser-session fetch (Phase 12).
 *
 * - Uses injected `fetchImpl` with `credentials: "include"` under the
 *   browser's existing session and granted host permissions.
 * - Requires explicit user intent + per-exact-origin permission BEFORE fetch.
 * - Validates every redirect hop against permission scope.
 * - Enforces byte/time/type limits on the returned payload.
 * - Never routes through `/api/proxy` or any proxy relay.
 *
 * Plain JavaScript + JSDoc. `fetchImpl` is injected so unit tests use fakes
 * and request logs can prove cookies only reach allowed origins.
 */

export const PROXY_PATH = "/api/proxy";
export const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Parse the bound-tab origin handed over in the page URL
 * (`page.html?tab=<id>&origin=<scheme://host[:port]>`).
 *
 * The background learns the clicked tab's URL under the click-time
 * activeTab grant and threads its origin through, so the bound page can
 * scope its observation (and its permission request) precisely even when
 * `tabs.get` later hides the tab URL (no host access (yet), grant lapsed).
 * Returns `""` when absent or invalid. Only exact `scheme://host[:port]`
 * http(s) origins without userinfo, path, query, or fragment are accepted;
 * anything else is ignored (the caller falls back to the tab URL, then to
 * an honest failure, never to a guess).
 *
 * @param {unknown} search the URL query string (`location.search` form)
 * @returns {string} the validated origin or `""`
 */
export function parseBoundOrigin(search) {
  let params;
  try {
    params = new URLSearchParams(typeof search === "string" ? search : "");
  } catch {
    return "";
  }
  const raw = params.get("origin");
  if (typeof raw !== "string" || raw === "") return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password) return "";
  if (parsed.pathname !== "/" && parsed.pathname !== "") return "";
  if (parsed.search || parsed.hash) return "";
  if (!parsed.hostname) return "";
  if (raw.length > 256) return "";
  let origin;
  try {
    origin = parsed.origin;
  } catch {
    return "";
  }
  if (origin !== raw) return "";
  return origin;
}

/**
 * Ensure one-time origin access for request observation.
 *
 * A `webRequest` listener without host access is deaf: the platform only
 * delivers events the extension may see, and neither the click-time
 * activeTab grant nor an unprompted page enables observation. Call this on
 * an explicit user gesture (the Scan click) BEFORE installing any
 * `webRequest` listener: granted origins (declared or previously approved)
 * pass silently, otherwise the browser prompts once for exactly this
 * origin. A refusal must fail the scan honestly (never a silent empty
 * result); the toolbar-click modal flow needs no such grant.
 *
 * @param {{ permissions?: { contains?: (p: any) => boolean | Promise<boolean>, request?: (p: any) => boolean | Promise<boolean> } }} browserApi
 *   the extension browser namespace (`api`), never raw host globals
 * @param {string} origin exact `scheme://host[:port]` scope (see `originOf`)
 * @returns {Promise<boolean>} true when observation of the origin is allowed
 */
export async function ensureOriginAccess(browserApi, origin) {
  if (typeof origin !== "string" || origin === "") return false;
  const perms = browserApi ? browserApi.permissions : undefined;
  if (!perms || typeof perms.contains !== "function") return false;
  try {
    if (await perms.contains({ origins: [origin + "/*"] })) return true;
  } catch {
    return false;
  }
  if (typeof perms.request !== "function") return false;
  try {
    return (await perms.request({ origins: [origin + "/*"] })) === true;
  } catch {
    return false;
  }
}

/** MIME families the extension is willing to decode as image/metadata. */
export const ALLOWED_MIME_PREFIXES = Object.freeze([
  "image/",
  "application/xml",
  "text/xml",
  "application/json",
  "text/plain",
  "application/octet-stream",
]);

/**
 * @param {string} url
 * @returns {boolean} true when the URL targets the metadata CORS proxy
 */
export function isProxyUrl(url) {
  return typeof url === "string" && url.includes(PROXY_PATH);
}

/**
 * Origin key `scheme://host[:port]` (effective port, lowercase host).
 * @param {string} url
 */
export function originOf(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const port = u.port ? `:${u.port}` : "";
  return `${u.protocol}//${host}${port}`;
}

/**
 * Create a session fetcher.
 * @param {{
 *   fetchImpl: (url: string, init: any) => Promise<{ status: number, url: string, headers: Record<string,string>, bytes: Uint8Array, redirectChain?: string[], durationMs?: number }>,
 *   hasPermission: (origin: string) => boolean | Promise<boolean>,
 *   requestPermission: (origin: string) => boolean | Promise<boolean>,
 *   now?: () => number,
 * }} deps
 */
export function createSessionFetcher(deps) {
  /**
   * Fetch a resource with the browser session.
   * @param {string} url
   * @param {{ userIntent?: boolean, maxBytes?: number, timeoutMs?: number, allowedMimes?: string[] }} [opts]
   */
  async function fetchResource(url, opts = {}) {
    if (isProxyUrl(url)) {
      throw Object.assign(new Error("proxy transport forbidden in extension"), {
        code: "proxy-forbidden",
      });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw Object.assign(new Error("invalid URL"), { code: "invalid-url" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw Object.assign(new Error("unsupported scheme"), { code: "unsupported-scheme" });
    }
    if (!opts.userIntent) {
      throw Object.assign(new Error("explicit user intent required"), {
        code: "intent-required",
      });
    }
    const origin = originOf(url);
    const granted = await deps.hasPermission(origin);
    if (!granted) {
      const nowGranted = await deps.requestPermission(origin);
      if (!nowGranted) {
        throw Object.assign(new Error(`host permission denied for ${origin}`), {
          code: "permission-denied",
        });
      }
    }
    const maxBytes = opts.maxBytes ?? MAX_BYTES_DEFAULT;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** @type {any} */
    const res = await deps.fetchImpl(url, { credentials: "include" });
    // Per-hop redirect scope validation.
    const chain = Array.isArray(res.redirectChain) ? res.redirectChain : [url, res.url].filter(Boolean);
    for (const hop of chain) {
      if (isProxyUrl(hop)) {
        throw Object.assign(new Error("redirect through proxy forbidden"), {
          code: "proxy-forbidden",
        });
      }
      let hopUrl;
      try {
        hopUrl = new URL(hop);
      } catch {
        throw Object.assign(new Error("invalid redirect hop"), { code: "bad-redirect" });
      }
      if (hopUrl.protocol !== "http:" && hopUrl.protocol !== "https:") {
        throw Object.assign(new Error("redirect to unsupported scheme"), { code: "bad-redirect" });
      }
      const hopOrigin = originOf(hop);
      if (hopOrigin !== origin) {
        const hopGranted = await deps.hasPermission(hopOrigin);
        if (!hopGranted) {
          throw Object.assign(new Error(`redirect requires separate permission for ${hopOrigin}`), {
            code: "redirect-permission-required",
          });
        }
      }
    }
    if (typeof res.durationMs === "number" && res.durationMs > timeoutMs) {
      throw Object.assign(new Error("fetch timeout"), { code: "timeout" });
    }
    if (res.status === 401 || res.status === 403) {
      // Cookie handoff is never automatic on 401/403; surface classified error.
      throw Object.assign(new Error(`forbidden (${res.status}); cookie handoff requires explicit consent`), {
        code: res.status === 401 ? "unauthorized" : "forbidden",
      });
    }
    if (!res || typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
      throw Object.assign(new Error(`bad status ${res ? res.status : "?"}`), { code: "bad-status" });
    }
    const contentType = res.headers
      ? String(res.headers["content-type"] ?? res.headers["Content-Type"] ?? "")
      : "";
    const allowed = opts.allowedMimes ?? ALLOWED_MIME_PREFIXES;
    const typeOk = allowed.some((p) => contentType.toLowerCase().startsWith(p.toLowerCase()));
    if (contentType && !typeOk) {
      throw Object.assign(new Error(`unsupported content type ${contentType}`), {
        code: "unsupported-type",
      });
    }
    const bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(0);
    if (bytes.length > maxBytes) {
      throw Object.assign(new Error(`oversized body ${bytes.length} > ${maxBytes}`), {
        code: "oversized",
      });
    }
    return { bytes, finalUrl: res.url ?? url, contentType, redirectChain: chain };
  }

  return { fetchResource };
}
