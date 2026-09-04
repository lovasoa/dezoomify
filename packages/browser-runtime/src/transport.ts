// Direct browser fetch transport with dependency-injected fetch.
// No DOM, no cookies, no proxy knowledge.
import type {
  FallbackCapabilityId,
  TileResponse,
} from "./types.ts";
import { ERROR_CODES } from "./types.ts";

export interface DirectTransportOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DirectTransport {
  fetchResource(url: string, opts?: DirectTransportOptions): Promise<TileResponse>;
}

export type FetchImpl = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{
  url?: string;
  status: number;
  headers?: unknown;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

function hasCredentialHeader(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === "cookie" || lower === "authorization" || lower === "proxy-authorization") {
      return key;
    }
  }
  return null;
}

function hasUserinfo(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return u.username !== "" || u.password !== "";
  } catch {
    return false;
  }
}

function toSafeHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  try {
    const h = input as {
      forEach?: (cb: (v: string, k: string) => void) => void;
      entries?: () => Iterable<[string, string]>;
    } & Record<string, string>;
    if (typeof h.forEach === "function") {
      h.forEach((v: string, k: string) => {
        out[String(k).toLowerCase()] = String(v);
      });
      return out;
    }
    if (typeof h.entries === "function") {
      for (const [k, v] of h.entries()) out[String(k).toLowerCase()] = String(v);
      return out;
    }
    if (typeof input === "object") {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[String(k).toLowerCase()] = String(v);
      }
    }
  } catch {
    // fall through with empty headers
  }
  return out;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const e = err as { name?: string; code?: number } | null;
  if (e && e.name === "AbortError") return true;
  return false;
}

export function createDirectTransport(fetchImpl: FetchImpl): DirectTransport {
  async function fetchResource(url: string, opts?: DirectTransportOptions): Promise<TileResponse> {
    const badHeader = hasCredentialHeader(opts?.headers);
    if (badHeader) {
      return {
        outcome: "policy-denied",
        reason: `credential-header-rejected:${badHeader.toLowerCase()}`,
        code: ERROR_CODES.TRANSPORT_POLICY_DENIED,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        outcome: "policy-denied",
        reason: "invalid-url",
        code: ERROR_CODES.INVALID_INPUT,
      };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return {
        outcome: "policy-denied",
        reason: "url-userinfo-rejected",
        code: ERROR_CODES.TRANSPORT_POLICY_DENIED,
      };
    }
    if (opts?.signal?.aborted) {
      return { outcome: "cancelled", reason: "aborted-before-fetch" };
    }
    void hasUserinfo;
    let response: {
      url?: string;
      status: number;
      headers?: unknown;
      arrayBuffer(): Promise<ArrayBuffer>;
    };
    try {
      response = await fetchImpl(url, {
        redirect: "follow",
        credentials: "omit",
        signal: opts?.signal,
        headers: opts?.headers ? { ...opts.headers } : undefined,
      });
    } catch (err: unknown) {
      if (opts?.signal?.aborted || isAbortError(err)) {
        return { outcome: "cancelled", reason: "aborted" };
      }
      const reason = err instanceof Error ? err.message : "fetch-rejected";
      return { outcome: "network-error", reason };
    }
    if (opts?.signal?.aborted) {
      return { outcome: "cancelled", reason: "aborted-after-response" };
    }
    const finalUrl = typeof response.url === "string" && response.url !== "" ? response.url : url;
    const status = response.status;
    const headers = toSafeHeaders(response.headers);
    // Do not infer CORS failure from status: a rejected fetch has no status.
    // Any resolved response is classified by status only.
    if (status >= 200 && status <= 299) {
      try {
        const bytes = await response.arrayBuffer();
        if (opts?.signal?.aborted) {
          return { outcome: "cancelled", reason: "aborted-during-body" };
        }
        return { outcome: "readable", finalUrl, status, headers, bytes };
      } catch (err: unknown) {
        if (opts?.signal?.aborted || isAbortError(err)) {
          return { outcome: "cancelled", reason: "aborted-during-body" };
        }
        const reason = err instanceof Error ? err.message : "body-read-failed";
        return { outcome: "network-error", reason };
      }
    }
    return { outcome: "http-error", finalUrl, status, headers };
  }

  return { fetchResource };
}

/** Only a classified network-error (fetch rejection, e.g. CORS) allows fallback. */
export function isClassifiedCorsOrNetworkFailure(response: TileResponse): boolean {
  return response.outcome === "network-error";
}

/**
 * Direct-first fallback policy. Returns host-supplied transports only after a
 * classified CORS/network failure. Never embeds proxy URLs or extension IDs:
 * callers pass opaque capability ids.
 */
export function allowedFallbacksFor(
  directOutcome: TileResponse,
  hostSupplied: FallbackCapabilityId[],
): FallbackCapabilityId[] {
  if (directOutcome.outcome === "network-error") return [...hostSupplied];
  return [];
}

export function describeActiveTransport(attempt: number, transport: string): string {
  return `attempt ${attempt}: ${transport}`;
}
