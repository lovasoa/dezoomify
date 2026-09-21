// Web integration policy: direct-first, automatic eligible metadata-proxy
// fallback.
//
// Single policy module for the website: proxy eligibility, ordinary-image
// rules, and error transport mapping. Pure, no I/O, no clocks.
import type { ProcessingRecipe } from "@dezoomify/wasm-bindings";

export interface WebFetchRequest {
  url: string;
  kind: "metadata" | "tile";
  headers?: Record<string, string>;
  requiresCookies?: boolean;
  requiresAuth?: boolean;
  signal?: AbortSignal;
}

const SIGNED_QUERY_KEYS = new Set([
  "token",
  "signature",
  "sig",
  "auth",
  "key",
  "session",
  "sid",
  "ticket",
  "secret",
  "password",
]);

function hasSignedQuery(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    for (const k of u.searchParams.keys()) {
      if (SIGNED_QUERY_KEYS.has(k.toLowerCase())) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function hasCredentialHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const k of Object.keys(headers)) {
    const l = k.toLowerCase();
    if (l === "cookie" || l === "authorization" || l === "proxy-authorization") return true;
  }
  return false;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "localhost." || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h === "127.0.0.1" || h.startsWith("127.") || h === "10.0.0.1") return true;
  if (h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) return true;
  if (h === "::1" || h === "[::1]") return true;
  // 172.16/12
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

export function isProxyEligible(
  req: WebFetchRequest,
): { eligible: boolean; reason: string } {
  if (req.kind === "tile") return { eligible: false, reason: "tile-never-proxied" };
  if (req.requiresCookies) return { eligible: false, reason: "cookie-requiring" };
  if (req.requiresAuth) return { eligible: false, reason: "auth-dependent" };
  if (hasCredentialHeader(req.headers)) return { eligible: false, reason: "credential-header" };
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return { eligible: false, reason: "invalid-url" };
  }
  if (u.username !== "" || u.password !== "") return { eligible: false, reason: "url-userinfo" };
  if (hasSignedQuery(req.url)) return { eligible: false, reason: "signed-query" };
  if (isPrivateOrLocalHostname(u.hostname)) return { eligible: false, reason: "private-local-target" };
  if (u.protocol !== "http:" && u.protocol !== "https:") return { eligible: false, reason: "scheme" };
  return { eligible: true, reason: "public-non-credential-metadata" };
}

/**
 * Whether a planned tile may fall back to ordinary image display when its
 * readable fetch fails. Only unprocessed tiles (`ProcessingRecipe::None`,
 * serialized as `"none"`) qualify: processed tiles (decrypt, re-encode)
 * require readable bytes, and a display fallback would silently drop the
 * processing. Branch on the stable recipe id, never on display text.
 */
export function isOrdinaryImageTile(processing: ProcessingRecipe): boolean {
  return processing === "none";
}

/**
 * Transport label for a structured job error. Tile fetches never use the
 * metadata CORS proxy, so a tile failure always reports the direct browser
 * fetch even when the job's metadata arrived through the proxy; other
 * errors report the job's active transport.
 */
export function errorTransportFor(code: string, activeTransport: string | null): string {
  if (code === "TILE_FAILED") return "direct";
  return activeTransport ?? "direct";
}
