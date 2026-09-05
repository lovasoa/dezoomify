// Web integration: direct-first, automatic eligible metadata-proxy fallback.
import { DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL } from "../packages/browser-runtime/src/types.ts";

export interface WebFetchRequest {
  url: string;
  kind: "metadata" | "tile";
  headers?: Record<string, string>;
  requiresCookies?: boolean;
  requiresAuth?: boolean;
  signal?: AbortSignal;
}

export interface DirectLike {
  fetchResource(
    url: string,
    opts?: { headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<
    | { outcome: "readable"; finalUrl: string; status: number; headers: Record<string, string>; bytes: ArrayBuffer }
    | { outcome: "http-error"; finalUrl: string; status: number; headers: Record<string, string> }
    | { outcome: "network-error"; reason: string }
    | { outcome: "cancelled"; reason: string }
    | { outcome: "policy-denied"; reason: string; code: string }
    | { outcome: string; [k: string]: unknown }
  >;
}

export interface ProxyLike {
  fetchViaProxy(
    targetUrl: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; code?: string; bytes?: ArrayBuffer; contentType?: string }>;
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

export function createWebIntegration(deps: {
  direct: DirectLike;
  proxy: ProxyLike;
  onTransport?: (label: string) => void;
  capabilities?: { extensionAvailable?: boolean; nativeAvailable?: boolean };
}): {
  fetchMetadata(req: WebFetchRequest): Promise<{ via: string; result: unknown }>;
  fetchTile(req: WebFetchRequest): Promise<{ via: string; result: unknown }>;
  getHandoffSuggestions(): string[];
  isProxyEligible(req: WebFetchRequest): { eligible: boolean; reason: string };
} {
  function eligible(req: WebFetchRequest): { eligible: boolean; reason: string } {
    return isProxyEligible(req);
  }

  async function fetchMetadata(req: WebFetchRequest): Promise<{ via: string; result: unknown }> {
    deps.onTransport?.(DIRECT_TRANSPORT_LABEL);
    const direct = await deps.direct.fetchResource(req.url, {
      headers: req.headers,
      signal: req.signal,
    });
    const outcome = (direct as { outcome?: string }).outcome;
    // Proxy only after classified CORS/network failure, only for eligible metadata.
    if (outcome === "network-error") {
      const e = eligible({ ...req, kind: "metadata" });
      if (e.eligible) {
        deps.onTransport?.(PROXY_TRANSPORT_LABEL);
        const proxied = await deps.proxy.fetchViaProxy(req.url, { signal: req.signal });
        return { via: "proxy", result: proxied };
      }
    }
    return { via: "direct", result: direct };
  }

  async function fetchTile(req: WebFetchRequest): Promise<{ via: string; result: unknown }> {
    // Tiles never use the proxy. Ordinary display is a separate caller path.
    deps.onTransport?.(DIRECT_TRANSPORT_LABEL);
    const direct = await deps.direct.fetchResource(req.url, {
      headers: req.headers,
      signal: req.signal,
    });
    return { via: "direct", result: direct };
  }

  function getHandoffSuggestions(): string[] {
    const out: string[] = ["ordinary-image-display"];
    if (deps.capabilities?.extensionAvailable) out.push("extension");
    if (deps.capabilities?.nativeAvailable) out.push("native");
    return out;
  }

  return { fetchMetadata, fetchTile, getHandoffSuggestions, isProxyEligible: eligible };
}
