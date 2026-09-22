// Website fetch orchestration shared by browser products.
// Direct browser fetch first; the metadata CORS proxy is an automatic
// fallback for eligible public metadata only (never tiles, never
// credentials). The single-policy proxy transport instance is supplied by
// the caller (`src/proxyTransport.ts`); UI copy and the readable-bytes
// classifier live in the caller too (`src/discovery.ts`) and arrive as plain
// data, so this module never imports app layers. Progress and log hooks
// drive the caller's live job view. Keep erasable-syntax-only.

import type { FetchFailureCode } from "@dezoomify/wasm-bindings";
import type { FetchCause, StructuredFailure } from "./failure.ts";
import { blockedReason, fetchFailure } from "./failure.ts";
import {
  combineTimeout,
  DIRECT_METADATA_TIMEOUT_MS,
  proxyRateLimitDelayMs,
  REQUEST_TIMEOUT_MS,
  shortUrl,
  sleep,
  tileFailedError,
} from "./tile-policy.ts";
import { extractErrorSignal } from "./transport.ts";

export interface DirectOutcome {
  outcome: "readable" | "http-error" | "network-error" | "cancelled";
  finalUrl?: string;
  status?: number;
  bytes?: ArrayBuffer;
  contentType?: string;
  retryAfterMs?: number;
  /** Bounded server signal from an HTTP error body (best effort). */
  preview?: string;
}

export type FetchImplLike = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{
  url?: string;
  status: number;
  headers?: unknown;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ProxyTransportLike {
  fetchViaProxy(
    targetUrl: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    bytes?: ArrayBuffer;
    code?: string;
    reason?: string;
    finalUrl?: string;
    retryAfterMs?: number;
  }>;
}

export interface ProxyEligibility {
  eligible: boolean;
  reason: string;
}

/** Live job-view hooks owned by the orchestrator (activity + repaint). */
export interface WebFetchHooks {
  onRequestStart(label: string): number;
  onRequestEnd(id: number, ok: boolean): void;
  onLog(line: string): void;
  onUpdate(): void;
  onMetadataAttempt?(attempt: {
    startedAt: number;
    transport: "direct" | "metadata proxy";
    target: string;
    outcome: string;
    bytes?: number;
  }): void;
  onTileAttempt?(): void;
}

/** Caller-owned UI copy plus the readable-bytes hint (never gates). */
export interface WebFetchMessages {
  rateLimitedBySite: string;
  siteBusy: string;
  discoveryFailed: (via: string) => string;
}

export interface WebFetchDeps {
  fetchImpl?: FetchImplLike;
  proxyTransport?: ProxyTransportLike;
  isProxyEligible(req: {
    url: string;
    kind: "metadata" | "tile";
    headers?: Record<string, string>;
  }): ProxyEligibility;
  classifyHint?: (
    bytes: ArrayBuffer,
    info: { via: string; contentType?: string },
  ) => { found: boolean };
  hooks: WebFetchHooks;
  messages: WebFetchMessages;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  throttle?: (url: string) => Promise<void>;
  timeouts?: { requestMs?: number; metadataMs?: number };
}

export interface WebFetcher {
  fetchDirect(
    url: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    ms?: number,
    logTimeout?: boolean,
  ): Promise<DirectOutcome>;
  fetchViaProxy(
    targetUrl: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    bytes?: ArrayBuffer;
    code?: string;
    reason?: string;
    finalUrl?: string;
    retryAfterMs?: number;
  }>;
  fetchMetadataFor(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer; finalUri?: string; via: string }>;
  fetchTileFor(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer }>;
  getActiveTransport(): string | null;
  resetActiveTransport(): void;
}

/**
 * Plain words for a relay policy `reason` (never credentials, never URLs).
 * Keeps the prominent message specific without leaking jargon: the exact
 * `reason` still travels in the technical chain.
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

export interface ClassifiedProxyFailure {
  code: FetchFailureCode;
  message: string;
  retryable: boolean;
  /** Typed cause for the engine: the diagnostics grouping key. */
  cause: FetchCause;
}

/**
 * Classify a failed proxy result into a user sentence plus a typed cause.
 * Our policy denial and an upstream HTTP refusal are genuinely different
 * (retrying a 403 from the viewed site never helps, while a 502 might), so
 * they never share a message or a retryable flag. The exact relay `reason`
 * travels inside the cause, never as free text.
 */
export function classifyProxyFailure(proxied: {
  status: number;
  code?: string;
  reason?: string;
}): ClassifiedProxyFailure {
  const code = proxied.code ?? "PROXY_ERROR";
  const status = proxied.status || 0;
  const cause: FetchCause = { code, transport: "metadata-proxy" };
  if (status > 0) cause.http = status;
  const reason = blockedReason(proxied.reason);
  if (reason) cause.reason = reason;
  if (code === "PROXY_POLICY_DENIED") {
    const hint = proxyPolicyReasonText(proxied.reason) ?? "Check the address and try again.";
    return {
      code: "TRANSPORT_POLICY_DENIED",
      message:
        `This address cannot be opened through the website. ${hint} ` +
        "The browser extension or the desktop app may still work.",
      retryable: false,
      cause: { ...cause, code: "TRANSPORT_POLICY_DENIED" },
    };
  }
  if (code === "PROXY_BUDGET_EXCEEDED") {
    return {
      code: "PROXY_BUDGET_EXCEEDED",
      message: "This page is too large to check here. Try the desktop app for very large images.",
      retryable: false,
      cause,
    };
  }
  if (code === "TRANSPORT_HTTP_ERROR" || status === 401 || status === 403) {
    if (status === 404) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message: "This page could not be found. Check the address and try again.",
        retryable: false,
        cause: { ...cause, code: "TRANSPORT_HTTP_ERROR" },
      };
    }
    if (status === 401 || status === 403 || status === 406) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message:
          `The site refused to share this file (HTTP ${status}). It may block shared servers; ` +
          "the browser extension or the desktop app may still work.",
        retryable: false,
        cause: { ...cause, code: "TRANSPORT_HTTP_ERROR" },
      };
    }
    if (status >= 500 && status <= 599) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message: "The site had a problem opening this page. Try again shortly.",
        retryable: true,
        cause: { ...cause, code: "TRANSPORT_HTTP_ERROR" },
      };
    }
    if (status >= 400 && status <= 499) {
      return {
        code: "TRANSPORT_HTTP_ERROR",
        message: "This page could not be opened. Check the address and try again.",
        retryable: false,
        cause: { ...cause, code: "TRANSPORT_HTTP_ERROR" },
      };
    }
  }
  if (
    code === "TRANSPORT_NETWORK_ERROR" ||
    code === "PROXY_NETWORK_ERROR" ||
    code === "PROXY_ERROR"
  ) {
    return {
      code: "PROXY_ERROR",
      message: "The metadata proxy could not fetch this address. Try again shortly.",
      retryable: true,
      cause: { ...cause, code: "PROXY_ERROR" },
    };
  }
  return {
    code: "PROXY_ERROR",
    message: "The metadata proxy could not fetch this address. Try again shortly.",
    retryable: status >= 500 || status === 0,
    cause,
  };
}

/**
 * Bounded error-body signal for HTTP failures. Reads at most one small
 * body; oversized or unreadable bodies yield no preview. Never throws.
 */
async function readErrorPreview(res: {
  headers?: unknown;
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<string> {
  try {
    const headersLike = res.headers as { get?: (k: string) => string | null } | null;
    const declared = Number(headersLike?.get?.("content-length"));
    if (Number.isSafeInteger(declared) && declared > 16 * 1024) return "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    return extractErrorSignal(bytes.slice(0, 4096));
  } catch {
    return "";
  }
}

function parseRetryAfterMs(headers: unknown, at: number): number | undefined {
  try {
    const value = headers as {
      get?: (name: string) => string | null;
      [name: string]: unknown;
    } | null;
    const raw =
      typeof value?.get === "function"
        ? value.get("retry-after")
        : (value?.["retry-after"] ?? value?.["Retry-After"]);
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - at) : undefined;
  } catch {
    return undefined;
  }
}

function cancelledFailure(url: string): StructuredFailure {
  return fetchFailure("The request was cancelled.", false, {
    cause: { code: "TRANSPORT_CANCELLED", transport: "direct" },
    code: "TRANSPORT_CANCELLED",
    url,
    transportKind: "direct",
  });
}

/**
 * Wait out a retry backoff unless the job is cancelled first. Returns true
 * when the wait was abandoned so the caller stops without another attempt.
 */
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

function defaultFetchImpl(): FetchImplLike | null {
  try {
    const impl = (globalThis as unknown as { fetch?: unknown }).fetch;
    if (typeof impl === "function") {
      return (input: string, init?: Record<string, unknown>) =>
        (
          impl as (
            i: string,
            o?: unknown,
          ) => Promise<{
            url?: string;
            status: number;
            headers?: unknown;
            arrayBuffer(): Promise<ArrayBuffer>;
          }>
        )(input, { ...(init ?? {}), credentials: "omit" });
    }
  } catch {
    // No host fetch available; the caller must inject one.
  }
  return null;
}

export function createWebFetcher(deps: WebFetchDeps): WebFetcher {
  const fetchImpl = deps.fetchImpl ?? defaultFetchImpl();
  const requestMs = deps.timeouts?.requestMs ?? REQUEST_TIMEOUT_MS;
  const metadataMs = deps.timeouts?.metadataMs ?? DIRECT_METADATA_TIMEOUT_MS;
  const sleepFn = deps.sleepFn ?? sleep;
  const now = deps.nowFn ?? Date.now;
  const hooks = deps.hooks;
  let activeTransport: string | null = null;

  async function fetchDirect(
    url: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    ms: number = requestMs,
    logTimeout: boolean = true,
  ): Promise<DirectOutcome> {
    if (!fetchImpl) return { outcome: "network-error" };
    const reqId = hooks.onRequestStart("direct");
    const combined = combineTimeout(signal, ms);
    try {
      const res = await fetchImpl(url, { headers, signal: combined.signal });
      if (!(res.status >= 200 && res.status <= 299)) {
        hooks.onRequestEnd(reqId, false);
        const preview = await readErrorPreview(res);
        const retryAfterMs = parseRetryAfterMs(res.headers, now());
        return {
          outcome: "http-error",
          finalUrl: typeof res.url === "string" ? res.url : url,
          status: res.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(preview ? { preview } : {}),
        };
      }
      const bytes = await res.arrayBuffer();
      hooks.onRequestEnd(reqId, true);
      let contentType: string | undefined;
      try {
        const headersLike = res.headers as { get?: (k: string) => string | null } | null;
        const ct = headersLike?.get?.("content-type");
        if (typeof ct === "string" && ct !== "") contentType = ct;
      } catch {
        // A missing/unreadable header must never break the readable path.
      }
      return {
        outcome: "readable",
        finalUrl: typeof res.url === "string" && res.url !== "" ? res.url : url,
        status: res.status,
        bytes,
        ...(contentType ? { contentType } : {}),
      };
    } catch (e) {
      hooks.onRequestEnd(reqId, false);
      if (signal?.aborted) return { outcome: "cancelled" };
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || (combined.timedOut && combined.timedOut())) {
        if (logTimeout)
          hooks.onLog(`Direct metadata fetch did not complete within ${ms} ms: ${shortUrl(url)}`);
        return { outcome: "network-error" };
      }
      return { outcome: "network-error" };
    } finally {
      combined.cleanup();
      hooks.onUpdate();
    }
  }

  async function fetchViaProxy(
    targetUrl: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    bytes?: ArrayBuffer;
    code?: string;
    reason?: string;
    finalUrl?: string;
    retryAfterMs?: number;
  }> {
    if (!deps.proxyTransport) return { ok: false, status: 502, code: "PROXY_ERROR" };
    if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    // Proxy admission budget lives in exactly one owner: the injected
    // product transport (`src/proxyTransport.ts`, server limits
    // authoritative). This orchestration never re-gates it.
    const reqId = hooks.onRequestStart("proxy");
    const combined = combineTimeout(signal, requestMs);
    try {
      const res = await deps.proxyTransport.fetchViaProxy(targetUrl, { signal: combined.signal });
      if (!res.ok) {
        hooks.onRequestEnd(reqId, false);
        return {
          ok: false,
          status: res.status,
          code: res.code ?? "PROXY_ERROR",
          ...(typeof res.reason === "string" && res.reason !== "" ? { reason: res.reason } : {}),
          ...(typeof res.retryAfterMs === "number" ? { retryAfterMs: res.retryAfterMs } : {}),
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
      if (
        (e as { name?: string })?.name === "TimeoutError" ||
        (combined.timedOut && combined.timedOut())
      ) {
        hooks.onLog("Metadata proxy request timed out after 30 s.");
        return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
      }
      return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
    } finally {
      combined.cleanup();
      hooks.onUpdate();
    }
  }

  /**
   * Fetch one metadata resource for discovery: direct first with a 1500 ms
   * head start, then the eligible metadata proxy after a classified network
   * failure. Direct settles before the proxy starts, so the two transports
   * never overlap on the same resource; a caller abort before or during the
   * fetch rejects as cancelled with no proxy fallback. Every readable payload reaches the WASM
   * core, which is the single authority for discovery. The substring
   * classifier is a UI hint only and never gates.
   *
   * Eligibility stays owned by the caller (isProxyEligible on a metadata
   * request). Tiles never use the proxy. A transient PROXY_RATE_LIMITED
   * retries once after Retry-After/backoff; a persistent throttle fails fast
   * with extension/desktop guidance.
   *
   * Every thrown failure carries its typed cause: `message` is a plain,
   * actionable sentence for the prominent UI slot, while `cause`
   * (transport, HTTP status, proxy code, policy reason) plus `url` and
   * the bounded `preview` server signal feed the engine diagnostics and
   * the technical-details section. The two layers never mix, and user
   * copy never enters the engine.
   */
  async function fetchMetadataFor(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer; finalUri?: string; via: string }> {
    // A retired job performs no fetch and never falls back to the proxy.
    if (signal?.aborted) throw cancelledFailure(url);
    const target = shortUrl(url);
    activeTransport = "direct";
    const directStartedAt = now();
    const direct = await fetchDirect(url, headers, signal, metadataMs);
    hooks.onMetadataAttempt?.({
      startedAt: directStartedAt,
      transport: "direct",
      target,
      outcome: direct.outcome === "http-error" ? `HTTP ${direct.status ?? 0}` : direct.outcome,
      ...(direct.bytes ? { bytes: direct.bytes.byteLength } : {}),
    });
    let via = "direct";
    let bytes: ArrayBuffer | null = null;
    let contentType: string | undefined;
    // Post-redirect base for relative tile URLs. Direct fetches report
    // res.url; proxied fetches must fall back to the requested URL (the relay
    // follows redirects internally without exposing the upstream final URL).
    let finalUri: string = url;
    if (direct.outcome === "readable" && direct.bytes) {
      bytes = direct.bytes;
      if (typeof direct.finalUrl === "string" && direct.finalUrl !== "") finalUri = direct.finalUrl;
      if (typeof direct.contentType === "string" && direct.contentType !== "")
        contentType = direct.contentType;
    } else if (
      direct.outcome === "network-error" &&
      !signal?.aborted &&
      deps.isProxyEligible({ url, kind: "metadata", headers }).eligible
    ) {
      activeTransport = "metadata-proxy";
      via = "proxy";
      let proxyStartedAt = now();
      let proxied = await fetchViaProxy(url, signal);
      hooks.onMetadataAttempt?.({
        startedAt: proxyStartedAt,
        transport: "metadata proxy",
        target,
        outcome: proxied.ok ? `HTTP ${proxied.status}` : (proxied.code ?? `HTTP ${proxied.status}`),
        ...(proxied.bytes ? { bytes: proxied.bytes.byteLength } : {}),
      });
      // Retry-After + backoff: one bounded retry converts a transient
      // token-bucket 429 into success. A persistent throttle, or a
      // Retry-After beyond the UX budget, still fails fast below with the
      // extension/desktop guidance (never tiles, never wider eligibility).
      if (!proxied.ok && proxied.code === "PROXY_RATE_LIMITED") {
        const delay = proxyRateLimitDelayMs(proxied.retryAfterMs);
        if (delay !== null) {
          hooks.onLog(`Metadata proxy rate-limited; retrying once after ${delay} ms.`);
          if (await sleepUnlessAborted(delay, sleepFn, signal)) throw cancelledFailure(url);
          proxyStartedAt = now();
          proxied = await fetchViaProxy(url, signal);
          hooks.onMetadataAttempt?.({
            startedAt: proxyStartedAt,
            transport: "metadata proxy",
            target,
            outcome: proxied.ok
              ? `HTTP ${proxied.status}`
              : (proxied.code ?? `HTTP ${proxied.status}`),
            ...(proxied.bytes ? { bytes: proxied.bytes.byteLength } : {}),
          });
        }
      }
      if (!proxied.ok || !proxied.bytes) {
        if (signal?.aborted || proxied.code === "TRANSPORT_CANCELLED") throw cancelledFailure(url);
        if (proxied.code === "PROXY_RATE_LIMITED") {
          throw fetchFailure(deps.messages.rateLimitedBySite, true, {
            cause: { code: "UPSTREAM_RATE_LIMITED", http: 429, transport: "metadata-proxy" },
            code: "UPSTREAM_RATE_LIMITED",
            url,
          });
        }
        const classified = classifyProxyFailure(proxied);
        throw fetchFailure(classified.message, classified.retryable, {
          cause: classified.cause,
          code: classified.code,
          url,
          transportKind: "metadata-proxy",
        });
      }
      bytes = proxied.bytes;
      if (typeof proxied.finalUrl === "string" && proxied.finalUrl !== "")
        finalUri = proxied.finalUrl;
    } else if (direct.outcome === "cancelled" || signal?.aborted) {
      // A retired job never falls back to the proxy and never reports a
      // retryable discovery failure for its own cancellation.
      throw cancelledFailure(url);
    } else if (direct.outcome === "http-error") {
      // The typed cause carries the HTTP status and the bounded server
      // signal; both stay in local-only diagnostics (see the redact hint
      // in the shared UI) and never in the prominent message.
      if (direct.status === 429) {
        // A direct fetch uses the user's own connection, so this throttle is
        // on their IP, not on our server; the fix is waiting, not another app.
        throw fetchFailure(deps.messages.siteBusy, true, {
          cause: { code: "UPSTREAM_RATE_LIMITED", http: 429, transport: "direct" },
          code: "UPSTREAM_RATE_LIMITED",
          url,
          preview: direct.preview,
          transportKind: "direct",
        });
      }
      throw fetchFailure("This page could not be opened. Check the address and try again.", false, {
        cause: {
          code: "DISCOVERY_HTTP_ERROR",
          ...(direct.status ? { http: direct.status } : {}),
          transport: "direct",
        },
        code: "DISCOVERY_HTTP_ERROR",
        url,
        preview: direct.preview,
        transportKind: "direct",
      });
    } else {
      throw fetchFailure(deps.messages.discoveryFailed(via), true, {
        cause: { code: "DISCOVERY_FAILED", transport: "direct" },
        code: "DISCOVERY_FAILED",
        url,
        transportKind: "direct",
      });
    }
    // WASM core is authoritative: always forward readable bytes so formats
    // whose first head carries no zoomable literal still resolve. The
    // classifier is a UI hint only.
    if (bytes && deps.classifyHint) {
      let found = true;
      try {
        found = deps.classifyHint(bytes, { via, ...(contentType ? { contentType } : {}) }).found;
      } catch {
        found = true;
      }
      if (!found) {
        hooks.onLog(
          `content hint: no zoomable marker in first bytes (${via}); running full discovery…`,
        );
      }
    }
    return { bytes: bytes as ArrayBuffer, finalUri, via };
  }

  async function fetchTileFor(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer }> {
    if (signal?.aborted) throw cancelledFailure(url);
    hooks.onTileAttempt?.();
    if (deps.throttle) {
      try {
        await deps.throttle(url);
      } catch {
        // Throttle waits must never fail a tile.
      }
    }
    if (signal?.aborted) throw cancelledFailure(url);
    const direct = await fetchDirect(url, headers, signal, requestMs, false);
    if (direct.outcome === "readable" && direct.bytes) return { bytes: direct.bytes };
    if (direct.outcome === "cancelled" || signal?.aborted) throw cancelledFailure(url);
    throw tileFailedError(direct.outcome, direct.status, url, direct.retryAfterMs);
  }

  function getActiveTransport(): string | null {
    return activeTransport;
  }

  function resetActiveTransport(): void {
    activeTransport = null;
  }

  return {
    fetchDirect,
    fetchViaProxy,
    fetchMetadataFor,
    fetchTileFor,
    getActiveTransport,
    resetActiveTransport,
  };
}
