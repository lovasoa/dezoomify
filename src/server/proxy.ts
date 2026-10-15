// Bounded public source fetch relay (pure, no server framework).
import {
  readRequestedBytes,
  requestedByteRange,
} from "../../packages/browser-runtime/src/byte-range.ts";
import { normalizeErrorPreviewText } from "../../packages/browser-runtime/src/fetch-primitives.ts";
import {
  type ReadableResponse,
  readErrorPreview,
} from "../../packages/browser-runtime/src/response-body.ts";
import {
  buildProxyCorsHeaders,
  cacheControlForProxy,
  createProxyRequestId,
  forwardedClientHeaders,
  isAllowedSourceContentType,
  PROXY_MAX_BYTES,
  PROXY_MAX_REDIRECTS,
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

interface UpstreamResponse extends ReadableResponse {
  status: number;
}

export interface ProxyRelayDeps {
  /** Fetch without following redirects; honor the supplied cancellation signal. */
  fetchUpstream: (
    url: string,
    init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<UpstreamResponse>;
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
  /** Shared deadline for upstream headers, redirects, retry, and body reads. */
  timeoutMs?: number;
}

/**
 * Busy sites answer the first request with a token-bucket 429 and admit the
 * retry moments later; a single bounded retry converts that transient
 * throttle into a success. A persistent throttle still fails fast with
 * PROXY_RATE_LIMITED after exactly one retry.
 */
export const RATE_LIMIT_RETRY_DELAY_MS = 750;
const UPSTREAM_TIMEOUT_MS = 30_000;

export const PROXY_UPSTREAM_URL_HEADER = "x-proxy-upstream-url";

/** Per-origin token bucket: burst 20, refill 5/s per origin. */
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
  preview?: string;
  status: number;
  headers: Record<string, string>;
  body?: ArrayBuffer;
  code?: string;
  /** Machine-readable policy reason (e.g. `scheme`, `private-host`,
   * `content-type`, `redirect-limit`, ...). Present on policy denials and
   * on the malformed-request responses the adapters synthesize, so callers
   * can tell our policy apart from an upstream HTTP status. */
  reason?: string;
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
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener("abort", finish, { once: true });
    }
  });
}

function cancelBody(response: UpstreamResponse): void {
  void response.body?.cancel().catch(() => {});
}

function errorPreview(error: unknown): string {
  const parts: string[] = [];
  let cause = error;
  for (let depth = 0; depth < 3 && cause; depth += 1) {
    if (cause instanceof Error) {
      parts.push(cause.message.slice(0, 1024));
      cause = cause.cause;
    } else {
      if (typeof cause === "object" && "detail" in cause && typeof cause.detail === "string") {
        parts.push(cause.detail.slice(0, 1024));
      } else if (typeof cause === "string") parts.push(cause.slice(0, 1024));
      break;
    }
  }
  return normalizeErrorPreviewText(parts.join(": "), 300);
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
    return {
      status: 405,
      headers: baseHeaders,
      code: "PROXY_POLICY_DENIED",
      reason: "method",
      requestId,
    };
  }
  if (!Number.isInteger(req.protocolVersion) || req.protocolVersion < 1) {
    return {
      status: 422,
      headers: baseHeaders,
      code: "PROXY_POLICY_DENIED",
      reason: "protocol-version",
      requestId,
    };
  }
  let range: ReturnType<typeof requestedByteRange>;
  try {
    range = requestedByteRange(
      Object.entries(req.headers ?? {}).map(([name, value]) => ({ name, value })),
    );
  } catch (error) {
    return {
      status: 422,
      headers: baseHeaders,
      code: "PROXY_POLICY_DENIED",
      reason: "malformed-body",
      requestId,
      preview: errorPreview(error),
    };
  }
  if (range && range.length > maxBytes) {
    return { status: 413, headers: baseHeaders, code: "PROXY_BUDGET_EXCEEDED", requestId };
  }
  const first = validateProxyTarget(req.targetUrl, { resolveHost: deps.resolveHost });
  if (!first.ok) {
    return {
      status: 403,
      headers: baseHeaders,
      code: "PROXY_POLICY_DENIED",
      reason: first.reason ?? "denied",
      requestId,
    };
  }
  if (!deps.disableOriginBucket) {
    const key = proxyOriginKey(req.targetUrl);
    if (key === null) {
      return {
        status: 403,
        headers: baseHeaders,
        code: "PROXY_POLICY_DENIED",
        reason: "origin",
        requestId,
      };
    }
    const nowMs = deps.nowMs?.() ?? Date.now();
    if (!takeOriginToken(key, nowMs)) {
      return { status: 429, headers: baseHeaders, code: "PROXY_RATE_LIMITED", requestId };
    }
  }

  const deadline = AbortSignal.timeout(deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  const interrupted = (): ProxyRelayResult => ({
    status: deps.signal?.aborted ? 499 : 504,
    headers: baseHeaders,
    code: deps.signal?.aborted ? "TRANSPORT_CANCELLED" : "TRANSPORT_NETWORK_ERROR",
    requestId,
  });
  let current = req.targetUrl;
  let hops = 0;
  for (;;) {
    if (signal.aborted) return interrupted();
    // The client's actual headers, filtered to the narrow safe set
    // (cookies, auth, and caller referer/origin never flow upstream).
    // Referer is always the target (legacy /proxy parity).
    const upstreamHeaders = stripUpstreamHeaders(forwardedClientHeaders(req.headers ?? {}));
    if (upstreamHeaders.accept === undefined) upstreamHeaders.accept = "*/*";
    upstreamHeaders.referer = req.targetUrl;
    const ifNoneMatch = req.ifNoneMatch ?? headerCase(req.headers ?? {}, "if-none-match");
    if (ifNoneMatch) upstreamHeaders["if-none-match"] = ifNoneMatch;
    const ifModifiedSince =
      req.ifModifiedSince ?? headerCase(req.headers ?? {}, "if-modified-since");
    if (ifModifiedSince) upstreamHeaders["if-modified-since"] = ifModifiedSince;
    let res: UpstreamResponse;
    let rateLimitAttempts = 0;
    for (;;) {
      try {
        // Upstream is always GET.
        res = await deps.fetchUpstream(current, {
          method: "GET",
          headers: upstreamHeaders,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return interrupted();
        return {
          status: 502,
          headers: baseHeaders,
          code: "TRANSPORT_NETWORK_ERROR",
          requestId,
          preview: errorPreview(error),
        };
      }
      if (res.status !== 429 || rateLimitAttempts >= 1) break;
      cancelBody(res);
      rateLimitAttempts += 1;
      await delayBeforeRetry(retryDelayMs, signal);
      if (signal.aborted) return interrupted();
    }
    // Upstream revalidation: a 304 stays a 304 with validators, no body.
    if (res.status === 304) {
      cancelBody(res);
      const notModifiedHeaders: Record<string, string> = { ...baseHeaders };
      const notModifiedExposed: string[] = [];
      const notModifiedEtag = res.headers.get("etag");
      if (notModifiedEtag) {
        notModifiedHeaders.etag = notModifiedEtag;
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
      cancelBody(res);
      const loc = res.headers.get("location");
      if (!loc) {
        return { status: 502, headers: baseHeaders, code: "TRANSPORT_NETWORK_ERROR", requestId };
      }
      hops += 1;
      if (hops > maxRedirects) {
        return {
          status: 508,
          headers: baseHeaders,
          code: "PROXY_POLICY_DENIED",
          reason: "redirect-limit",
          requestId,
        };
      }
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return {
          status: 502,
          headers: baseHeaders,
          code: "PROXY_POLICY_DENIED",
          reason: "redirect-target",
          requestId,
        };
      }
      const hopCheck = validateProxyTarget(next, { resolveHost: deps.resolveHost });
      if (!hopCheck.ok) {
        return {
          status: 403,
          headers: baseHeaders,
          code: "PROXY_POLICY_DENIED",
          reason: hopCheck.reason ?? "redirect-target",
          requestId,
        };
      }
      current = next;
      continue;
    }
    if (res.status < 200 || res.status > 299) {
      const code = res.status === 429 ? "PROXY_RATE_LIMITED" : "TRANSPORT_HTTP_ERROR";
      const previewSignal = AbortSignal.any([signal, AbortSignal.timeout(500)]);
      const preview = await readErrorPreview(res, previewSignal);
      return {
        status: res.status,
        headers: baseHeaders,
        code,
        requestId,
        ...(preview ? { preview } : {}),
      };
    }
    const contentType = res.headers.get("content-type");
    if (!isAllowedSourceContentType(contentType)) {
      cancelBody(res);
      return {
        status: 415,
        headers: baseHeaders,
        code: "PROXY_POLICY_DENIED",
        reason: "content-type",
        requestId,
      };
    }
    let body: ArrayBuffer;
    try {
      body = (await readRequestedBytes(res, range, maxBytes, signal)).buffer;
    } catch (error) {
      if (signal.aborted) return interrupted();
      if (
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        error.kind === "size-limit"
      ) {
        return range
          ? {
              status: 502,
              headers: baseHeaders,
              code: "TRANSPORT_NETWORK_ERROR",
              requestId,
              preview: `invalid byte-range response: body exceeds the requested ${range.length} bytes`,
            }
          : { status: 413, headers: baseHeaders, code: "PROXY_BUDGET_EXCEEDED", requestId };
      }
      cancelBody(res);
      return {
        status: 502,
        headers: baseHeaders,
        code: "TRANSPORT_NETWORK_ERROR",
        requestId,
        preview: errorPreview(error),
      };
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
    const contentRange = res.headers.get("content-range");
    if (contentRange) {
      outHeaders["content-range"] = contentRange;
      exposed.push("content-range");
    }
    const etag = res.headers.get("etag");
    if (etag) {
      outHeaders.etag = etag;
      exposed.push("etag");
    }
    const lastModified = res.headers.get("last-modified");
    if (lastModified) {
      outHeaders["last-modified"] = lastModified;
      exposed.push("last-modified");
    }
    outHeaders["access-control-expose-headers"] = exposed.join(", ");
    return {
      status: res.status === 206 ? 206 : 200,
      headers: outHeaders,
      body,
      requestId,
      upstreamUrl: current,
    };
  }
}
