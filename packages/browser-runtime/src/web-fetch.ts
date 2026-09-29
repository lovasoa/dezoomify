// Website fetching with direct reads and metadata proxy fallback.
// Direct browser fetch first; the metadata CORS proxy is an automatic
// fallback for eligible public metadata only (never tiles, never
// credentials). The single-policy proxy transport instance is supplied by
// the caller. Progress and diagnostics callbacks update the job view.

import type { ErrorTransport, FetchFailure, ResourceRequest } from "@dezoomify/wasm-bindings";
import type { DiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
import { blockedReason } from "./failure.ts";
import { readErrorPreview, readResponseBytes, retryAfterMs } from "./response-body.ts";
import {
  combineTimeout,
  DIRECT_METADATA_TIMEOUT_MS,
  proxyRateLimitDelayMs,
  REQUEST_TIMEOUT_MS,
  sleep,
} from "./tile-policy.ts";

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

function hasCredentialHeader(headers: ResourceRequest["headers"]): boolean {
  if (!headers) return false;
  for (const { name } of headers) {
    const l = name.toLowerCase();
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

export function isProxyEligible(req: ResourceRequest): { eligible: boolean; reason: string } {
  if (req.purpose !== "metadata") return { eligible: false, reason: "tile-never-proxied" };
  if (hasCredentialHeader(req.headers)) return { eligible: false, reason: "credential-header" };
  if (
    (req.headers ?? []).some(
      ({ name }) => !["accept", "accept-language"].includes(name.toLowerCase()),
    )
  )
    return { eligible: false, reason: "unsupported-header" };
  let u: URL;
  try {
    u = new URL(req.uri);
  } catch {
    return { eligible: false, reason: "invalid-url" };
  }
  if (u.username !== "" || u.password !== "") return { eligible: false, reason: "url-userinfo" };
  if (hasSignedQuery(req.uri)) return { eligible: false, reason: "signed-query" };
  if (isPrivateOrLocalHostname(u.hostname))
    return { eligible: false, reason: "private-local-target" };
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { eligible: false, reason: "scheme" };
  return { eligible: true, reason: "public-non-credential-metadata" };
}

const DIRECT_METADATA_MAX_BYTES = 8 * 1024 * 1024;
const DIRECT_TILE_MAX_BYTES = 64 * 1024 * 1024;

export interface DirectOutcome {
  outcome: "readable" | "http-error" | "network-error" | "cancelled" | "too-large";
  finalUrl?: string;
  status?: number;
  bytes?: ArrayBuffer;
  contentType?: string;
  retryAfterMs?: number;
  /** Bounded server signal from an HTTP error body (best effort). */
  preview?: string;
}

export type FetchImplLike = typeof fetch;

export interface ProxyTransportLike {
  fetchViaProxy(
    request: ResourceRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    bytes?: ArrayBuffer;
    code?: string;
    reason?: string;
    finalUrl?: string;
    retryAfterMs?: number;
    requestId?: string;
    preview?: string;
  }>;
}

export interface ProxyEligibility {
  eligible: boolean;
  reason: string;
}

/** Request activity and repaint callbacks from the browser application. */
export interface WebFetchHooks {
  onRequestStart(): number;
  onRequestEnd(id: number, ok: boolean): void;
  onUpdate(): void;
}

/** Caller-owned UI copy plus the readable-bytes hint (never gates). */
export interface WebFetchMessages {
  rateLimitedBySite: string;
  siteBusy: string;
  discoveryFailed: (via: string) => string;
}

export interface WebFetchDeps {
  diagnostics?: DiagnosticRecorder;
  fetchImpl?: FetchImplLike;
  proxyTransport?: ProxyTransportLike;
  isProxyEligible(req: ResourceRequest): ProxyEligibility;
  hooks: WebFetchHooks;
  messages: WebFetchMessages;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  throttle?: (url: string) => Promise<void>;
  timeouts?: { requestMs?: number; metadataMs?: number };
}

export interface WebFetcher {
  fetchResource(
    request: ResourceRequest,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  getActiveTransport(): ErrorTransport | null;
}

/**
 * Plain words for a relay policy `reason`.
 * Keeps the prominent message specific without leaking jargon: the exact
 * `reason` still appears in diagnostic details.
 */
export function proxyPolicyReasonText(reason?: string): string | null {
  switch (reason) {
    case "invalid-url":
    case "scheme":
    case "userinfo":
    case "signed-query":
    case "non-standard-port":
    case "protocol-version":
    case "malformed-body":
    case "method":
    case "unsupported-header":
      return "Check the address and try again.";
    case "loopback-host":
    case "private-host":
    case "blocked-ipv4":
    case "blocked-ipv6":
    case "dns-rebinding":
    case "dns-rebinding-v6":
      return "The website cannot open private or local addresses.";
    case "content-type":
      return "The site answered with a file type the website does not check here.";
    case "redirect-limit":
    case "redirect-target":
    case "origin":
      return "The site redirected in a way the website cannot follow.";
    default:
      return null;
  }
}

/** Preserve the relay's observed facts with product wording. */
export function classifyProxyFailure(proxied: {
  status: number;
  code?: string;
  reason?: string;
  preview?: string;
  retryAfterMs?: number;
}): FetchFailure {
  const code = proxied.code ?? "PROXY_ERROR";
  const http = proxied.status || undefined;
  const facts = {
    transport: "metadata-proxy" as const,
    detail: `proxy failure: ${code}${proxied.reason ? ` (${proxied.reason})` : ""}`,
    ...(http ? { http } : {}),
    ...(blockedReason(proxied.reason) ? { blocked_reason: blockedReason(proxied.reason) } : {}),
    ...(proxied.preview ? { preview: proxied.preview } : {}),
    ...(proxied.retryAfterMs !== undefined ? { retry_after_ms: proxied.retryAfterMs } : {}),
  };
  if (code === "PROXY_POLICY_DENIED") {
    const hint = proxyPolicyReasonText(proxied.reason) ?? "Check the address and try again.";
    return {
      ...facts,
      code: "TRANSPORT_POLICY_DENIED",
      message: `This address cannot be opened through the website. ${hint} The browser extension or the desktop app may still work.`,
    };
  }
  if (code === "PROXY_BUDGET_EXCEEDED")
    return {
      ...facts,
      code,
      message: "This page is too large to check here. Try the desktop app for very large images.",
    };
  if (code === "TRANSPORT_HTTP_ERROR" || http === 401 || http === 403) {
    const message =
      http === 404
        ? "This page could not be found. Check the address and try again."
        : http === 401 || http === 403 || http === 406
          ? `The site refused to share this file (HTTP ${http}). It may block shared servers; the browser extension or the desktop app may still work.`
          : http !== undefined && http >= 500
            ? "The site had a problem opening this page. Try again shortly."
            : "This page could not be opened. Check the address and try again.";
    return { ...facts, code: "TRANSPORT_HTTP_ERROR", message };
  }
  return {
    ...facts,
    code: "PROXY_ERROR",
    message: "The metadata proxy could not fetch this address. Try again shortly.",
  };
}

function cancelledFailure(): FetchFailure {
  return {
    code: "TRANSPORT_CANCELLED",
    message: "The request was cancelled.",
    transport: "direct",
  };
}

async function sleepUnlessAborted(
  ms: number,
  sleepFn: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return true;
  if (!signal || typeof signal.addEventListener !== "function") {
    await sleepFn(ms);
    return signal?.aborted ?? false;
  }
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(true);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const elapsed = (async () => {
    await sleepFn(ms);
    return signal.aborted ?? false;
  })();
  const result = await Promise.race([elapsed, aborted]);
  if (onAbort) {
    try {
      signal.removeEventListener("abort", onAbort);
    } catch {
      // Detach is best-effort.
    }
  }
  return result;
}

export function createWebFetcher(deps: WebFetchDeps): WebFetcher {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const requestMs = deps.timeouts?.requestMs ?? REQUEST_TIMEOUT_MS;
  const metadataMs = deps.timeouts?.metadataMs ?? DIRECT_METADATA_TIMEOUT_MS;
  const sleepFn = deps.sleepFn ?? sleep;
  const now = deps.nowFn ?? Date.now;
  const hooks = deps.hooks;
  let activeTransport: ErrorTransport | null = null;

  async function fetchDirect(
    request: ResourceRequest,
    signal?: AbortSignal,
    ms: number = requestMs,
    maxBytes = DIRECT_TILE_MAX_BYTES,
  ): Promise<DirectOutcome> {
    const url = request.uri;
    const started = now();
    deps.diagnostics?.count("requests");
    const reqId = hooks.onRequestStart();
    const combined = combineTimeout(signal, ms);
    let responseStatus: number | undefined;
    let ended = false;
    const end = (ok: boolean) => {
      if (ended) return;
      ended = true;
      hooks.onRequestEnd(reqId, ok);
    };
    const report = (fields: Record<string, unknown>, finalUrl?: string) => {
      if (signal?.aborted) return;
      deps.diagnostics?.record(
        request.purpose === "metadata" || fields.outcome !== "readable" ? "debug" : "trace",
        "request",
        {
          purpose: request.purpose,
          transport: "direct",
          url,
          final_url: finalUrl,
          duration_ms: now() - started,
          ...fields,
        },
      );
    };
    try {
      const res = await fetchImpl(url, {
        headers: Object.fromEntries(
          (request.headers ?? []).map(({ name, value }) => [name, value]),
        ),
        signal: combined.signal,
        credentials: "omit",
        redirect: "follow",
      });
      responseStatus = res.status;
      if (!(res.status >= 200 && res.status <= 299)) {
        const preview = await readErrorPreview(res, combined.signal);
        // The status is authoritative even if its optional diagnostic body
        // stalls. Only cancellation by the caller overrides an HTTP refusal.
        signal?.throwIfAborted();
        const retryAfter = retryAfterMs(res.headers.get("retry-after"), now());
        end(false);
        deps.diagnostics?.count("request_failures");
        report(
          {
            outcome: "http-error",
            http: res.status,
            preview,
            retry_after_ms: retryAfter,
            content_type: res.headers.get("content-type"),
          },
          res.url,
        );
        return {
          outcome: "http-error",
          finalUrl: res.url || url,
          status: res.status,
          ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
          ...(preview ? { preview } : {}),
        };
      }
      const bytes = (await readResponseBytes(res, maxBytes, combined.signal)).buffer;
      end(true);
      const contentType = res.headers.get("content-type") || undefined;
      deps.diagnostics?.count("bytes_fetched", bytes.byteLength);
      report(
        {
          outcome: "readable",
          http: res.status,
          bytes: bytes.byteLength,
          content_type: contentType,
        },
        res.url,
      );
      return {
        outcome: "readable",
        finalUrl: res.url || url,
        status: res.status,
        bytes,
        ...(contentType ? { contentType } : {}),
      };
    } catch (e) {
      end(false);
      if (signal?.aborted) return { outcome: "cancelled" };
      deps.diagnostics?.count("request_failures");
      if ((e as { code?: string })?.code === "TRANSPORT_SIZE_LIMIT") {
        report({ outcome: "too-large", limit_bytes: maxBytes, http: responseStatus });
        return { outcome: "too-large" };
      }
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || combined.timedOut?.()) {
        report({ outcome: "timeout", timeout_ms: ms, http: responseStatus, error: e });
        return { outcome: "network-error" };
      }
      report({ outcome: "network-or-cors", http: responseStatus, error: e });
      return { outcome: "network-error" };
    } finally {
      combined.cleanup();
      hooks.onUpdate();
    }
  }

  async function fetchViaProxy(
    request: ResourceRequest,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    bytes?: ArrayBuffer;
    code?: string;
    reason?: string;
    finalUrl?: string;
    retryAfterMs?: number;
    requestId?: string;
    preview?: string;
  }> {
    const targetUrl = request.uri;
    const started = now();
    deps.diagnostics?.count("requests");
    if (!deps.proxyTransport) return { ok: false, status: 502, code: "PROXY_ERROR" };
    if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    // Proxy admission budget lives in exactly one owner: the injected
    // product transport (`src/proxyTransport.ts`, server limits
    // authoritative).
    const reqId = hooks.onRequestStart();
    const combined = combineTimeout(signal, requestMs);
    try {
      const res = await deps.proxyTransport.fetchViaProxy(request, { signal: combined.signal });
      deps.diagnostics?.record("debug", "request", {
        purpose: request.purpose,
        transport: "metadata-proxy",
        url: targetUrl,
        final_url: res.finalUrl,
        http: res.status,
        code: res.code,
        reason: res.reason,
        proxy_request: res.requestId,
        timed_out: combined.timedOut?.(),
        preview: res.preview,
        retry_after_ms: res.retryAfterMs,
        duration_ms: now() - started,
        bytes: res.bytes?.byteLength,
      });
      if (res.ok) deps.diagnostics?.count("bytes_fetched", res.bytes?.byteLength ?? 0);
      else deps.diagnostics?.count("request_failures");
      if (res.code === "TRANSPORT_CANCELLED" && combined.signal.aborted && !signal?.aborted) {
        hooks.onRequestEnd(reqId, false);
        return { ok: false, status: 0, code: "PROXY_NETWORK_ERROR" };
      }
      if (!res.ok) {
        hooks.onRequestEnd(reqId, false);
        return {
          ok: false,
          status: res.status,
          code: res.code ?? "PROXY_ERROR",
          ...(typeof res.reason === "string" && res.reason !== "" ? { reason: res.reason } : {}),
          ...(typeof res.retryAfterMs === "number" ? { retryAfterMs: res.retryAfterMs } : {}),
          requestId: res.requestId,
          preview: res.preview,
        };
      }
      hooks.onRequestEnd(reqId, true);
      // The relay follows upstream redirects internally; surface the
      // post-redirect URL when the transport provides it, otherwise fall back
      // to the requested URL downstream. Never leave the base empty: an empty
      // final URI makes relative tile URLs resolve against the app page and
      // 404.
      const upstream =
        typeof res.finalUrl === "string" && res.finalUrl !== "" ? res.finalUrl : targetUrl;
      return { ok: true, status: res.status, bytes: res.bytes, finalUrl: upstream };
    } catch (e) {
      hooks.onRequestEnd(reqId, false);
      if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
      deps.diagnostics?.count("request_failures");
      deps.diagnostics?.record("debug", "proxy-failed", {
        url: targetUrl,
        error: e,
        timeout_ms: requestMs,
      });
      return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
    } finally {
      combined.cleanup();
      hooks.onUpdate();
    }
  }

  /** Fetch metadata directly, then use the eligible metadata proxy after unreadable responses. */
  async function fetchMetadataFor(
    request: ResourceRequest,
    signal?: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer; finalUri?: string }> {
    if (signal?.aborted) throw cancelledFailure();
    activeTransport = "direct";
    const direct = await fetchDirect(request, signal, metadataMs, DIRECT_METADATA_MAX_BYTES);
    if (direct.outcome === "readable" && direct.bytes)
      return { bytes: direct.bytes, finalUri: direct.finalUrl || request.uri };
    if (
      direct.outcome === "network-error" &&
      !signal?.aborted &&
      deps.isProxyEligible(request).eligible
    ) {
      activeTransport = "metadata-proxy";
      deps.diagnostics?.record("info", "transport-fallback", {
        from: "direct",
        to: "metadata-proxy",
        reason: direct.outcome,
        url: request.uri,
      });
      let proxied = await fetchViaProxy(request, signal);
      if (!proxied.ok && proxied.code === "PROXY_RATE_LIMITED") {
        const delay = proxyRateLimitDelayMs(proxied.retryAfterMs);
        if (delay !== null) {
          deps.diagnostics?.record("debug", "proxy-retry", { delay_ms: delay });
          if (await sleepUnlessAborted(delay, sleepFn, signal)) throw cancelledFailure();
          proxied = await fetchViaProxy(request, signal);
        }
      }
      if (signal?.aborted || proxied.code === "TRANSPORT_CANCELLED") throw cancelledFailure();
      if (proxied.ok && proxied.bytes)
        return { bytes: proxied.bytes, finalUri: proxied.finalUrl || request.uri };
      if (proxied.code === "PROXY_RATE_LIMITED")
        throw {
          code: "UPSTREAM_RATE_LIMITED",
          message: deps.messages.rateLimitedBySite,
          http: 429,
          transport: "metadata-proxy",
          retry_after_ms: proxied.retryAfterMs,
        } satisfies FetchFailure;
      throw classifyProxyFailure(proxied);
    }
    if (direct.outcome === "cancelled" || signal?.aborted) throw cancelledFailure();
    if (direct.outcome === "too-large")
      throw {
        code: "TRANSPORT_SIZE_LIMIT",
        message: "This page is too large to check here. Try the desktop app.",
        transport: "direct",
      } satisfies FetchFailure;
    if (direct.outcome === "http-error")
      throw {
        code: direct.status === 429 ? "UPSTREAM_RATE_LIMITED" : "DISCOVERY_HTTP_ERROR",
        message:
          direct.status === 429
            ? deps.messages.siteBusy
            : "This page could not be opened. Check the address and try again.",
        http: direct.status,
        transport: "direct",
        preview: direct.preview,
        retry_after_ms: direct.retryAfterMs,
      } satisfies FetchFailure;
    throw {
      code: "DISCOVERY_FAILED",
      message: deps.messages.discoveryFailed("direct"),
      transport: "direct",
    } satisfies FetchFailure;
  }

  async function fetchTileFor(
    request: ResourceRequest,
    signal?: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer; finalUri?: string }> {
    if (signal?.aborted) throw cancelledFailure();
    if (deps.throttle) await deps.throttle(request.uri);
    if (signal?.aborted) throw cancelledFailure();
    const direct = await fetchDirect(request, signal, requestMs);
    if (direct.outcome === "readable" && direct.bytes)
      return { bytes: direct.bytes, finalUri: direct.finalUrl };
    if (direct.outcome === "cancelled" || signal?.aborted) throw cancelledFailure();
    if (direct.outcome === "too-large")
      throw {
        code: "TRANSPORT_SIZE_LIMIT",
        message: "This tile is too large for the browser.",
        transport: "direct",
      } satisfies FetchFailure;
    throw {
      code: direct.status ? "TRANSPORT_HTTP_ERROR" : "TRANSPORT_NETWORK_ERROR",
      message: "Part of the image could not be saved. Try again in a moment.",
      http: direct.status,
      transport: "direct",
      preview: direct.preview,
      retry_after_ms: direct.retryAfterMs,
      detail: `tile fetch: ${direct.outcome} (HTTP ${direct.status ?? "n/a"})`,
    } satisfies FetchFailure;
  }

  function getActiveTransport(): ErrorTransport | null {
    return activeTransport;
  }

  async function fetchResource(request: ResourceRequest, signal: AbortSignal) {
    if (request.purpose === "metadata") {
      const result = await fetchMetadataFor(request, signal);
      return { bytes: new Uint8Array(result.bytes), finalUri: result.finalUri };
    }
    const result = await fetchTileFor(request, signal);
    return { bytes: new Uint8Array(result.bytes), finalUri: result.finalUri };
  }

  return { fetchResource, getActiveTransport };
}
