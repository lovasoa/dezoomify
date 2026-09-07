// Restricted metadata fetch relay (pure, no server framework).
import {
  PROXY_MAX_BYTES,
  PROXY_MAX_REDIRECTS,
  buildProxyCorsHeaders,
  cacheControlForProxy,
  createProxyRequestId,
  isAllowedMetadataContentType,
  proxyOriginKey,
  stripUpstreamHeaders,
  validateProxyTarget,
} from "./security.ts";

export interface IncomingProxyRequest {
  method: string;
  targetUrl: string;
  protocolVersion: number;
  headers?: Record<string, string>;
  origin?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}

export interface ProxyRelayDeps {
  fetchUpstream: (
    url: string,
    init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  websiteOrigin: string;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  resolveHost?: (host: string) => string[] | null;
  /** Test seam: delay before the single 429 retry (production default below). */
  rateLimitRetryDelayMs?: number;
  /** Test seam: millisecond clock for the per-origin token bucket. */
  nowMs?: () => number;
  /** Test seam: bypass the per-origin bucket (unit tests for validators). */
  disableOriginBucket?: boolean;
}

/**
 * Busy sites answer the first request with a token-bucket 429 and admit the
 * retry moments later; a single bounded retry converts that transient
 * throttle into a success. A persistent throttle still fails fast with
 * PROXY_RATE_LIMITED after exactly one retry.
 */
export const RATE_LIMIT_RETRY_DELAY_MS = 750;

export const PROXY_UPSTREAM_URL_HEADER = "x-proxy-upstream-url";

/** Per-origin token bucket (todo 3.2): burst 20, refill 5/s per origin. */
const ORIGIN_BUCKET_CAPACITY = 20;
const ORIGIN_BUCKET_REFILL_PER_SEC = 5;

interface OriginBucket {
  tokens: number;
  updatedMs: number;
}

const originBuckets = new Map<string, OriginBucket>();

/** Test seam: reset per-origin bucket accounting. */
export function clearProxyOriginBuckets(): void {
  originBuckets.clear();
}

function takeOriginToken(originKey: string, nowMs: number): boolean {
  const existing = originBuckets.get(originKey);
  const bucket: OriginBucket = existing ?? {
    tokens: ORIGIN_BUCKET_CAPACITY,
    updatedMs: nowMs,
  };
  if (existing) {
    const elapsedMs = Math.max(0, nowMs - bucket.updatedMs);
    const refill = (elapsedMs / 1000) * ORIGIN_BUCKET_REFILL_PER_SEC;
    bucket.tokens = Math.min(ORIGIN_BUCKET_CAPACITY, bucket.tokens + refill);
    bucket.updatedMs = nowMs;
  }
  if (bucket.tokens < 1) {
    originBuckets.set(originKey, bucket);
    return false;
  }
  bucket.tokens -= 1;
  originBuckets.set(originKey, bucket);
  return true;
}

export interface ProxyRelayResult {
  status: number;
  headers: Record<string, string>;
  body?: ArrayBuffer;
  code?: string;
  requestId: string;
  /** Post-redirect upstream URL the body was read from (success only). */
  upstreamUrl?: string;
}

function headerCase(headers: Record<string, string>, name: string): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return null;
}

function delayBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const abort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export async function handleProxyRequest(
  req: IncomingProxyRequest,
  deps: ProxyRelayDeps,
): Promise<ProxyRelayResult> {
  const requestId = createProxyRequestId();
  const maxBytes = deps.maxBytes ?? PROXY_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? PROXY_MAX_REDIRECTS;
  const retryDelayMs = deps.rateLimitRetryDelayMs ?? RATE_LIMIT_RETRY_DELAY_MS;
  const cors = buildProxyCorsHeaders(deps.websiteOrigin, req.origin);
  const baseHeaders: Record<string, string> = {
    ...cors,
    "cache-control": cacheControlForProxy(),
    "x-request-id": requestId,
  };

  // Incoming must be POST (same-origin /api/proxy with JSON body).
  if (req.method.toUpperCase() !== "POST") {
    return { status: 405, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
  }
  if (!Number.isInteger(req.protocolVersion) || req.protocolVersion < 1) {
    return { status: 422, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
  }
  const first = validateProxyTarget(req.targetUrl, { resolveHost: deps.resolveHost });
  if (!first.ok) {
    return { status: 403, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
  }
  if (!deps.disableOriginBucket) {
    const key = proxyOriginKey(req.targetUrl);
    if (key === null) {
      return { status: 403, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
    }
    const nowMs = deps.nowMs?.() ?? Date.now();
    if (!takeOriginToken(key, nowMs)) {
      return { status: 429, headers: baseHeaders, code: "PROXY_RATE_LIMITED", requestId };
    }
  }

  let current = req.targetUrl;
  let hops = 0;
  for (;;) {
    if (deps.signal?.aborted) {
      return { status: 499, headers: baseHeaders, code: "TRANSPORT_CANCELLED", requestId };
    }
    const upstreamHeaders = stripUpstreamHeaders({
      accept: headerCase(req.headers ?? {}, "accept") ?? "application/json",
    });
    const ifNoneMatch = req.ifNoneMatch ?? headerCase(req.headers ?? {}, "if-none-match");
    if (ifNoneMatch) upstreamHeaders["if-none-match"] = ifNoneMatch;
    const ifModifiedSince =
      req.ifModifiedSince ?? headerCase(req.headers ?? {}, "if-modified-since");
    if (ifModifiedSince) upstreamHeaders["if-modified-since"] = ifModifiedSince;
    let res: {
      status: number;
      headers: { get(name: string): string | null };
      arrayBuffer(): Promise<ArrayBuffer>;
    };
    let rateLimitAttempts = 0;
    for (;;) {
      try {
        // Upstream is always GET.
        res = await deps.fetchUpstream(current, { method: "GET", headers: upstreamHeaders });
      } catch {
        return { status: 502, headers: baseHeaders, code: "TRANSPORT_NETWORK_ERROR", requestId };
      }
      if (res.status !== 429 || rateLimitAttempts >= 1) break;
      rateLimitAttempts += 1;
      await delayBeforeRetry(retryDelayMs, deps.signal);
      if (deps.signal?.aborted) {
        return { status: 499, headers: baseHeaders, code: "TRANSPORT_CANCELLED", requestId };
      }
    }
    // Upstream revalidation: a 304 stays a 304 with validators, no body.
    if (res.status === 304) {
      const notModifiedHeaders: Record<string, string> = { ...baseHeaders };
      const notModifiedExposed: string[] = [];
      const notModifiedEtag = res.headers.get("etag");
      if (notModifiedEtag) {
        notModifiedHeaders["etag"] = notModifiedEtag;
        notModifiedExposed.push("etag");
      }
      const notModifiedLastModified = res.headers.get("last-modified");
      if (notModifiedLastModified) {
        notModifiedHeaders["last-modified"] = notModifiedLastModified;
        notModifiedExposed.push("last-modified");
      }
      if (notModifiedExposed.length > 0) {
        notModifiedHeaders["access-control-expose-headers"] = notModifiedExposed.join(", ");
      }
      return { status: 304, headers: notModifiedHeaders, requestId };
    }
    // Redirect handling with per-hop revalidation.
    if (res.status >= 300 && res.status <= 399) {
      const loc = res.headers.get("location");
      if (!loc) {
        return { status: 502, headers: baseHeaders, code: "TRANSPORT_NETWORK_ERROR", requestId };
      }
      hops += 1;
      if (hops > maxRedirects) {
        return { status: 508, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
      }
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return { status: 502, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
      }
      const hopCheck = validateProxyTarget(next, { resolveHost: deps.resolveHost });
      if (!hopCheck.ok) {
        return { status: 403, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
      }
      current = next;
      continue;
    }
    if (res.status < 200 || res.status > 299) {
      const code = res.status === 429 ? "PROXY_RATE_LIMITED" : "TRANSPORT_HTTP_ERROR";
      return { status: res.status, headers: baseHeaders, code, requestId };
    }
    const contentType = res.headers.get("content-type");
    if (!isAllowedMetadataContentType(contentType)) {
      return { status: 415, headers: baseHeaders, code: "PROXY_POLICY_DENIED", requestId };
    }
    const declared = res.headers.get("content-length");
    if (declared !== null && declared !== undefined && declared !== "") {
      const n = Number(declared);
      if (Number.isFinite(n) && n > maxBytes) {
        return { status: 413, headers: baseHeaders, code: "PROXY_BUDGET_EXCEEDED", requestId };
      }
    }
    let body: ArrayBuffer;
    try {
      body = await res.arrayBuffer();
    } catch {
      return { status: 502, headers: baseHeaders, code: "TRANSPORT_NETWORK_ERROR", requestId };
    }
    if (body.byteLength > maxBytes) {
      return { status: 413, headers: baseHeaders, code: "PROXY_BUDGET_EXCEEDED", requestId };
    }
    const outHeaders: Record<string, string> = {
      ...baseHeaders,
      "content-type": contentType ?? "application/octet-stream",
      // Post-redirect base for relative tile URLs. Browsers can only read
      // this when it is CORS-exposed (see buildProxyCorsHeaders).
      [PROXY_UPSTREAM_URL_HEADER]: current,
      "access-control-expose-headers": PROXY_UPSTREAM_URL_HEADER,
    };
    const exposed = [PROXY_UPSTREAM_URL_HEADER];
    const etag = res.headers.get("etag");
    if (etag) {
      outHeaders["etag"] = etag;
      exposed.push("etag");
    }
    const lastModified = res.headers.get("last-modified");
    if (lastModified) {
      outHeaders["last-modified"] = lastModified;
      exposed.push("last-modified");
    }
    outHeaders["access-control-expose-headers"] = exposed.join(", ");
    return { status: 200, headers: outHeaders, body, requestId, upstreamUrl: current };
  }
}
