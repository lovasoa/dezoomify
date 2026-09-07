// Website fetch orchestration (todo 2.2 home, moved from `src/main.ts`).
//
// Direct browser fetch first; the metadata CORS proxy is an automatic
// fallback for eligible public metadata only (never tiles, never
// credentials). The single-policy proxy transport instance is supplied by
// the caller (`src/proxyTransport.ts`); UI copy and the readable-bytes
// classifier live in the caller too (`src/discovery.ts`) and arrive as plain
// data, so this module never imports app layers. Progress and log hooks
// drive the caller's live job view. Keep erasable-syntax-only.
import { failure } from "./session.ts";
import type { StructuredFailure } from "./session.ts";
import {
  DIRECT_METADATA_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  TILE_MAX_RETRIES,
  combineTimeout,
  proxyRateLimitDelayMs,
  shortUrl,
  tileRetryDelayMs,
  sleep,
  tileFailedError,
} from "./tile-policy.ts";
import {
  DIRECT_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
} from "./transport-labels.ts";

export interface DirectOutcome {
  outcome: "readable" | "http-error" | "network-error" | "cancelled";
  finalUrl?: string;
  status?: number;
  bytes?: ArrayBuffer;
  contentType?: string;
}

export interface FetchImplLike {
  (input: string, init?: Record<string, unknown>): Promise<{
    url?: string;
    status: number;
    headers?: unknown;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface ProxyTransportLike {
  fetchViaProxy(
    targetUrl: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    bytes?: ArrayBuffer;
    code?: string;
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
  isProxyEligible(req: { url: string; kind: "metadata" | "tile"; headers?: Record<string, string> }): ProxyEligibility;
  classifyHint?: (bytes: ArrayBuffer, info: { via: string; contentType?: string }) => { found: boolean };
  hooks: WebFetchHooks;
  messages: WebFetchMessages;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  throttle?: (url: string) => Promise<void>;
  timeouts?: { requestMs?: number; metadataMs?: number };
}

export interface WebFetcher {
  fetchDirect(url: string, headers?: Record<string, string>, signal?: AbortSignal, ms?: number): Promise<DirectOutcome>;
  fetchViaProxy(targetUrl: string, signal?: AbortSignal): Promise<{
    ok: boolean;
    status: number;
    bytes?: ArrayBuffer;
    code?: string;
    finalUrl?: string;
    retryAfterMs?: number;
  }>;
  fetchMetadataFor(url: string, headers: Record<string, string>): Promise<{ bytes: ArrayBuffer; finalUri?: string; via: string }>;
  fetchTileFor(url: string, headers: Record<string, string>): Promise<{ bytes: ArrayBuffer }>;
  getActiveTransport(): string | null;
  resetActiveTransport(): void;
}

function defaultFetchImpl(): FetchImplLike | null {
  try {
    const impl = (globalThis as unknown as { fetch?: unknown }).fetch;
    if (typeof impl === "function") {
      return (input: string, init?: Record<string, unknown>) =>
        (impl as (i: string, o?: unknown) => Promise<{
          url?: string;
          status: number;
          headers?: unknown;
          arrayBuffer(): Promise<ArrayBuffer>;
        }>)(input, { ...(init ?? {}), credentials: "omit" });
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
  const hooks = deps.hooks;
  let activeTransport: string | null = null;

  async function fetchDirect(
    url: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    ms: number = requestMs,
  ): Promise<DirectOutcome> {
    if (!fetchImpl) return { outcome: "network-error" };
    const reqId = hooks.onRequestStart("direct");
    const combined = combineTimeout(signal, ms);
    try {
      const res = await fetchImpl(url, { headers, signal: combined.signal });
      if (!(res.status >= 200 && res.status <= 299)) {
        hooks.onRequestEnd(reqId, false);
        return { outcome: "http-error", finalUrl: typeof res.url === "string" ? res.url : url, status: res.status };
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
        hooks.onLog(`Direct fetch did not complete within ${ms} ms: ${shortUrl(url)}`);
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
  ): Promise<{ ok: boolean; status: number; bytes?: ArrayBuffer; code?: string; finalUrl?: string; retryAfterMs?: number }> {
    if (!deps.proxyTransport) return { ok: false, status: 502, code: "PROXY_ERROR" };
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
      if (((e as { name?: string })?.name === "TimeoutError") || (combined.timedOut && combined.timedOut())) {
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
   * failure (first-wins: the loser is aborted via AbortController so direct
   * and proxy bytes never overlap). Every readable payload reaches the WASM
   * core, which is the single authority for discovery. The substring
   * classifier is a UI hint only and never gates.
   *
   * Eligibility stays owned by the caller (isProxyEligible on a metadata
   * request). Tiles never use the proxy. A transient PROXY_RATE_LIMITED
   * retries once after Retry-After/backoff; a persistent throttle fails fast
   * with extension/desktop guidance.
   *
   * Every thrown failure carries two layers: `message` (a plain, actionable
   * sentence for the UI) and `technical` (transport, HTTP status, proxy code,
   * trimmed URL) which the engine feeds into its per-candidate diagnostics
   * and the technical-details section. The two never mix.
   */
  async function fetchMetadataFor(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ bytes: ArrayBuffer; finalUri?: string; via: string }> {
    const target = shortUrl(url);
    activeTransport = DIRECT_TRANSPORT_LABEL;
    // AbortController dedupe: the direct loser is aborted before the proxy
    // starts so the two transports never overlap on the same resource.
    const directCtrl = new AbortController();
    const direct = await fetchDirect(url, headers, directCtrl.signal, metadataMs);
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
      if (typeof direct.contentType === "string" && direct.contentType !== "") contentType = direct.contentType;
    } else if (
      direct.outcome === "network-error" &&
      deps.isProxyEligible({ url, kind: "metadata", headers }).eligible
    ) {
      try {
        directCtrl.abort();
      } catch {
        // Abort is idempotent when the head-start timeout already fired; it
        // must never break the automatic proxy fallback.
      }
      activeTransport = PROXY_TRANSPORT_LABEL;
      via = "proxy";
      let proxied = await fetchViaProxy(url);
      // Retry-After + backoff: one bounded retry converts a transient
      // token-bucket 429 into success. A persistent throttle, or a
      // Retry-After beyond the UX budget, still fails fast below with the
      // extension/desktop guidance (never tiles, never wider eligibility).
      if (!proxied.ok && proxied.code === "PROXY_RATE_LIMITED") {
        const delay = proxyRateLimitDelayMs(proxied.retryAfterMs);
        if (delay !== null) {
          hooks.onLog(`Metadata proxy rate-limited; retrying once after ${delay} ms.`);
          await sleepFn(delay);
          proxied = await fetchViaProxy(url);
        }
      }
      if (!proxied.ok || !proxied.bytes) {
        if (proxied.code === "PROXY_RATE_LIMITED") {
          throw failure(
            "UPSTREAM_RATE_LIMITED",
            deps.messages.rateLimitedBySite,
            true,
            undefined,
            `metadata proxy: upstream rate limit (HTTP 429, PROXY_RATE_LIMITED) fetching ${target}`,
          );
        }
        throw failure(
          "PROXY_ERROR",
          "The metadata proxy could not fetch this address. Try again shortly.",
          false,
          undefined,
          `metadata proxy: ${proxied.code ?? "PROXY_ERROR"} (HTTP ${proxied.status || 0}) fetching ${target}`,
        );
      }
      bytes = proxied.bytes;
      if (typeof proxied.finalUrl === "string" && proxied.finalUrl !== "") finalUri = proxied.finalUrl;
    } else if (direct.outcome === "http-error") {
      if (direct.status === 429) {
        // A direct fetch uses the user's own connection, so this throttle is
        // on their IP, not on our server; the fix is waiting, not another app.
        throw failure(
          "UPSTREAM_RATE_LIMITED",
          deps.messages.siteBusy,
          true,
          undefined,
          `direct fetch: HTTP 429 Too Many Requests from ${target}`,
        );
      }
      throw failure(
        "DISCOVERY_HTTP_ERROR",
        "This page could not be opened. Check the address and try again.",
        false,
        undefined,
        `direct fetch: HTTP ${direct.status} from ${target}`,
      );
    } else {
      throw failure(
        "DISCOVERY_FAILED",
        deps.messages.discoveryFailed(via),
        true,
        undefined,
        `direct fetch: no readable response (network error or blocked read) fetching ${target}`,
      );
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
        hooks.onLog(`content hint: no zoomable marker in first bytes (${via}); running full discovery…`);
      }
    }
    return { bytes: bytes as ArrayBuffer, finalUri, via };
  }

  async function fetchTileFor(url: string, headers: Record<string, string>): Promise<{ bytes: ArrayBuffer }> {
    let lastOutcome = "network-error";
    let lastStatus: number | undefined;
    for (let attempt = 0; ; attempt++) {
      if (deps.throttle) {
        try {
          await deps.throttle(url);
        } catch {
          // Throttle waits must never fail a tile.
        }
      }
      const direct = await fetchDirect(url, headers);
      if (direct.outcome === "readable" && direct.bytes) {
        return { bytes: direct.bytes };
      }
      lastOutcome = direct.outcome;
      lastStatus = direct.status;
      if (direct.outcome === "cancelled" || attempt >= TILE_MAX_RETRIES) {
        break;
      }
      await sleepFn(tileRetryDelayMs(attempt, deps.randomFn));
    }
    const error: StructuredFailure = tileFailedError(lastOutcome, lastStatus, url);
    throw error;
  }

  function getActiveTransport(): string | null {
    return activeTransport;
  }

  function resetActiveTransport(): void {
    activeTransport = null;
  }

  return { fetchDirect, fetchViaProxy, fetchMetadataFor, fetchTileFor, getActiveTransport, resetActiveTransport };
}
