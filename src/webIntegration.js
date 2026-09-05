// GENERATED from src/webIntegration.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: src/webIntegration.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Web integration: direct-first, automatic eligible metadata-proxy fallback.
import { DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL } from "../packages/browser-runtime/src/types.js";

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

function hasSignedQuery(urlString        )          {
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

function hasCredentialHeader(headers                                    )          {
  if (!headers) return false;
  for (const k of Object.keys(headers)) {
    const l = k.toLowerCase();
    if (l === "cookie" || l === "authorization" || l === "proxy-authorization") return true;
  }
  return false;
}

function isPrivateOrLocalHostname(hostname        )          {
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
  req                 ,
  opts                          ,
)                                        {
  if (req.kind === "tile") return { eligible: false, reason: "tile-never-proxied" };
  if (opts.proxyOptOut) return { eligible: false, reason: "proxy-opt-out" };
  if (req.requiresCookies) return { eligible: false, reason: "cookie-requiring" };
  if (req.requiresAuth) return { eligible: false, reason: "auth-dependent" };
  if (hasCredentialHeader(req.headers)) return { eligible: false, reason: "credential-header" };
  let u     ;
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

export function createWebIntegration(deps

 )

  {
  let proxyOptOut = deps.proxyOptOut ?? false;

  function setProxyOptOut(v         )       {
    proxyOptOut = v;
  }

  function eligible(req                 )                                        {
    return isProxyEligible(req, { proxyOptOut });
  }

  async function fetchMetadata(req                 )                                            {
    deps.onTransport?.(DIRECT_TRANSPORT_LABEL);
    const direct = await deps.direct.fetchResource(req.url, {
      headers: req.headers,
      signal: req.signal,
    });
    const outcome = (direct                        ).outcome;
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

  async function fetchTile(req                 )                                            {
    // Tiles never use the proxy. Ordinary display is a separate caller path.
    deps.onTransport?.(DIRECT_TRANSPORT_LABEL);
    const direct = await deps.direct.fetchResource(req.url, {
      headers: req.headers,
      signal: req.signal,
    });
    return { via: "direct", result: direct };
  }

  function getHandoffSuggestions()           {
    const out           = ["ordinary-image-display"];
    if (deps.capabilities?.extensionAvailable) out.push("extension");
    if (deps.capabilities?.nativeAvailable) out.push("native");
    return out;
  }

  return { fetchMetadata, fetchTile, getHandoffSuggestions, setProxyOptOut, isProxyEligible: eligible };
}
