// Web integration: direct-first, automatic eligible metadata-proxy fallback.
// Web integration policy: direct-first, automatic eligible metadata-proxy
// fallback (todo 2.2 home, moved from `src/webIntegration.ts`).
//
// Single implementation for the website: proxy eligibility, ordinary-image
// rules, error transport mapping, and the pure catalog/level pickers. The
// unused second integration is gone; `src/webIntegration.ts` only
// re-exports this module for existing imports. Pure, no I/O, no clocks.
import { DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL } from "./transport-labels.ts";

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

/**
 * Whether a planned tile may fall back to ordinary image display when its
 * readable fetch fails. Only unprocessed tiles (`ProcessingRecipe::None`,
 * serialized as `"none"`) qualify: processed tiles (decrypt, re-encode)
 * require readable bytes, and a display fallback would silently drop the
 * processing. Branch on the stable recipe id, never on display text.
 */
export function isOrdinaryImageTile(processing: unknown): boolean {
  return processing === undefined || processing === null || processing === "" || processing === "none";
}

/**
 * Transport label for a structured job error. Tile fetches never use the
 * metadata CORS proxy, so a tile failure always reports the direct browser
 * fetch even when the job's metadata arrived through the proxy; other
 * errors report the job's active transport.
 */
export function errorTransportFor(code: string, activeTransport: string | null): string {
  if (code === "TILE_FAILED") return DIRECT_TRANSPORT_LABEL;
  return activeTransport ?? "direct";
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

/** One catalog image described for the website image picker. */
export interface WebImageOption {
  /** Position in catalog.images (the website plans catalog.images[index]). */
  index: number;
  title: string;
  width?: number;
  height?: number;
  tiles?: number;
}

/** One resolution described for the website level picker. */
export interface WebLevelOption {
  /** Engine level index (the website plans image.levels by this index). */
  index: number;
  label?: string;
  width?: number;
  height?: number;
  tiles?: number;
  fits: boolean;
}

export interface CatalogLike {
  images: Array<{
    id: number;
    title?: string;
    levels: Array<{ index: number; title?: string; imageSize?: { x: number; y: number } }>;
  }>;
}

function optionArea(width: number, height: number): number | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > Number.MAX_SAFE_INTEGER / height) return null;
  const area = width * height;
  return Number.isSafeInteger(area) ? area : null;
}

function largestDeclaredSize(
  levels: Array<{ imageSize?: { x: number; y: number } }>,
): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  let bestArea = -1;
  for (const level of levels) {
    const size = level.imageSize;
    if (!size) continue;
    const area = optionArea(size.x, size.y);
    if (area === null) continue;
    if (area >= bestArea) {
      best = { width: size.x, height: size.y };
      bestArea = area;
    }
  }
  return best;
}

function imageTitleFor(image: { title?: string }, position: number): string {
  const raw = typeof image.title === "string" ? image.title.trim() : "";
  if (raw !== "") return raw.slice(0, 120);
  return `Image ${position + 1}`;
}

/**
 * Pure catalog description for the website image picker (no I/O, no clocks).
 * Each option carries the largest declared size plus a tile estimate.
 * Sizes stay estimates: undeclared levels report no dims and no tiles.
 */
export function describeCatalogImages(
  catalog: CatalogLike,
  estimateTiles?: (width: number, height: number) => number | null,
): WebImageOption[] {
  const images = Array.isArray(catalog?.images) ? catalog.images : [];
  return images.map((image, position) => {
    const title = imageTitleFor(image, position);
    const size = largestDeclaredSize(Array.isArray(image.levels) ? image.levels : []);
    if (!size) return { index: position, title };
    let tiles: number | undefined;
    try {
      const estimate = estimateTiles ? estimateTiles(size.width, size.height) : null;
      if (typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0) tiles = estimate;
    } catch {
      tiles = undefined;
    }
    return {
      index: position,
      title,
      width: size.width,
      height: size.height,
      ...(tiles !== undefined ? { tiles } : {}),
    };
  });
}

/**
 * Pure largest-image default (catalog position). Compares largest declared
 * areas overflow-safe; ties keep the later image; imageless catalogs yield 0.
 */
export function largestCatalogImageIndex(catalog: CatalogLike): number {
  const images = Array.isArray(catalog?.images) ? catalog.images : [];
  let best = 0;
  let bestArea = -1;
  for (let position = 0; position < images.length; position++) {
    const size = largestDeclaredSize(Array.isArray(images[position]?.levels) ? images[position].levels : []);
    const area = size ? optionArea(size.width, size.height) : null;
    if (area !== null && area >= bestArea) {
      best = position;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Pure level description for the website level picker (no I/O, no clocks).
 * Fit comes from the host-supplied predicate (website: probeLimits plus the
 * plan tile cap); undeclared sizes report no dims with fits true so the
 * post-plan gate still enforces the bound after probing.
 */
export function describeImageLevels(
  image: { levels: Array<{ index: number; title?: string; imageSize?: { x: number; y: number } }> },
  opts: {
    fits: (width: number, height: number) => boolean;
    estimateTiles?: (width: number, height: number) => number | null;
  },
): WebLevelOption[] {
  const levels = Array.isArray(image?.levels) ? image.levels : [];
  return levels.map((level) => {
    const size = level.imageSize;
    const rawLabel = typeof level.title === "string" ? level.title.trim().slice(0, 80) : "";
    const label = rawLabel !== "" ? rawLabel : `Level ${level.index}`;
    if (!size) return { index: level.index, label, fits: true };
    let fits = true;
    try {
      fits = opts.fits(size.x, size.y);
    } catch {
      fits = false;
    }
    let tiles: number | undefined;
    try {
      const estimate = opts.estimateTiles ? opts.estimateTiles(size.x, size.y) : null;
      if (typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0) tiles = estimate;
    } catch {
      tiles = undefined;
    }
    return {
      index: level.index,
      label,
      width: size.x,
      height: size.y,
      ...(tiles !== undefined ? { tiles } : {}),
      fits,
    };
  });
}
