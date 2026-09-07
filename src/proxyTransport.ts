// Browser-side proxy client: POST same-origin /api/proxy, credentials omit.
//
// The response-size cap mirrors the server limit (`PROXY_MAX_BYTES` in
// `src/server/security.ts`): the server stays authoritative, this browser-side
// guard only fails closed early instead of buffering an over-budget body.
export const PROXY_METADATA_MAX_BYTES = 2 * 1024 * 1024;

export const PROXY_UPSTREAM_URL_HEADER = "x-proxy-upstream-url";

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  code?: string;
  /** Machine-readable policy reason from the relay (`scheme`,
   * `private-host`, `content-type`, `redirect-limit`, ...) or from the
   * client-side guard (`invalid-url`, `userinfo`). Present on
   * `PROXY_POLICY_DENIED` results so callers can tell our policy apart
   * from an upstream HTTP status. */
  reason?: string;
  bytes?: ArrayBuffer;
  contentType?: string;
  /** Post-redirect upstream URL reported by the relay (success only). */
  finalUrl?: string;
  /** Parsed Retry-After delay in ms (429 only, when the relay sent one). */
  retryAfterMs?: number;
}

export type ProxyFetchImpl = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{
  status: number;
  headers?: unknown;
  json?: () => Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

function safeHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  try {
    const h = input as {
      get?: (k: string) => string | null;
      forEach?: (cb: (v: string, k: string) => void) => void;
    };
    if (typeof h.get === "function") {
      for (const k of ["content-type", "content-length", "retry-after", PROXY_UPSTREAM_URL_HEADER]) {
        const v = h.get(k);
        if (v !== null && v !== undefined) out[k] = String(v);
      }
      return out;
    }
    if (typeof h.forEach === "function") {
      h.forEach((v: string, k: string) => {
        out[String(k).toLowerCase()] = String(v);
      });
      return out;
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Parse a Retry-After response value (delay seconds or HTTP date) into
 * milliseconds, capped so a stale far-future date never stalls metadata.
 * Returns undefined when absent or unparsable; callers apply their own
 * backoff default and UX-budget cap.
 */
export function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) {
    const secs = Number(v);
    if (!Number.isFinite(secs) || secs < 0) return undefined;
    return Math.min(secs * 1000, 30000);
  }
  const when = Date.parse(v);
  if (Number.isFinite(when)) {
    const delta = when - Date.now();
    if (delta <= 0) return 0;
    return Math.min(delta, 30000);
  }
  return undefined;
}

/**
 * Frontend guard for the Cloudflare metadata CORS proxy: at most 4 proxy
 * requests in flight at a time and at most 4 proxy request starts per
 * second. The backend enforces its own limit; this client-side gate keeps a
 * single page (discovery fan-out plus any tile-image fetches that also use
 * the proxy, e.g. Google Arts encrypted tiles) from bursting against it.
 * Direct tile requests never go through this gate and keep their own more
 * generous politeness policy.
 */
export const PROXY_MAX_INFLIGHT = 4;
export const PROXY_MAX_REQUESTS_PER_SECOND = 4;
export const PROXY_RATE_WINDOW_MS = 1000;

export interface ProxyRateClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ProxyRateLimiter {
  acquire(signal?: AbortSignal): Promise<(() => void) | null>;
  reset(): void;
}

function defaultProxySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared admission gate: one mutex serializes the check-and-reserve step so
 * concurrent callers cannot both observe a free slot, while the actual waits
 * happen outside the mutex. Start timestamps are recorded at admission, and
 * the caller starts its fetch synchronously after (no awaited delay in
 * between), so observed network starts honor the same window.
 */
export function createProxyRateLimiter(clock?: ProxyRateClock): ProxyRateLimiter {
  const nowFn = clock?.now ?? Date.now;
  const sleepFn = clock?.sleep ?? defaultProxySleep;
  let inflight = 0;
  let starts: number[] = [];
  let mutex: Promise<void> = Promise.resolve();
  const inflightWaiters = new Set<() => void>();

  function withMutex<T>(fn: () => T): Promise<T> {
    const prev = mutex;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutex = current;
    const run = (async () => {
      await prev;
      try {
        return fn();
      } finally {
        release();
      }
    })();
    return run;
  }

  function notifyInflight(): void {
    for (const w of Array.from(inflightWaiters)) {
      try {
        w();
      } catch {
        // A broken waiter must never stall the gate.
      }
    }
  }

  function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(signal?.aborted ?? false);
    // Race the injectable clock against caller aborts. On abort the sleep
    // promise still settles underneath, but its late completion is ignored.
    return new Promise((resolve) => {
      let settled = false;
      const done = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        try {
          signal?.removeEventListener("abort", onAbort);
        } catch {
          // Detach is best-effort.
        }
        resolve(aborted);
      };
      const onAbort = () => done(true);
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
      } catch {
        // Signals without addEventListener stay non-abortable here.
      }
      try {
        const waited = sleepFn(ms);
        Promise.resolve(waited).then(
          () => done(signal?.aborted ?? false),
          () => done(signal?.aborted ?? false),
        );
      } catch {
        done(signal?.aborted ?? false);
      }
    });
  }

  function waitForInflight(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onNotify = () => {
        cleanup();
        resolve(false);
      };
      const onAbort = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        inflightWaiters.delete(onNotify);
        try {
          signal?.removeEventListener("abort", onAbort);
        } catch {
          // Detach is best-effort.
        }
      };
      inflightWaiters.add(onNotify);
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
      } catch {
        // Signals without addEventListener stay non-abortable here.
      }
    });
  }

  async function acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return null;
    for (;;) {
      type Step = { kind: "admit" } | { kind: "abort" } | { kind: "wait-rate"; ms: number } | { kind: "wait-inflight" };
      const step: Step = await withMutex((): Step => {
        if (signal?.aborted) return { kind: "abort" };
        const now = nowFn();
        while (starts.length > 0 && (starts[0] as number) <= now - PROXY_RATE_WINDOW_MS) {
          starts.shift();
        }
        if (inflight >= PROXY_MAX_INFLIGHT) return { kind: "wait-inflight" };
        if (starts.length >= PROXY_MAX_REQUESTS_PER_SECOND) {
          const waitMs = (starts[0] as number) + PROXY_RATE_WINDOW_MS - nowFn();
          return { kind: "wait-rate", ms: waitMs > 0 ? waitMs : 0 };
        }
        starts.push(nowFn());
        inflight += 1;
        return { kind: "admit" };
      });
      if (step.kind === "admit") {
        if (signal?.aborted) {
          await withMutex(() => {
            inflight = Math.max(0, inflight - 1);
          });
          notifyInflight();
          return null;
        }
        let done = false;
        return () => {
          if (done) return;
          done = true;
          inflight = Math.max(0, inflight - 1);
          notifyInflight();
        };
      }
      if (step.kind === "abort") return null;
      if (step.kind === "wait-rate") {
        const aborted = await abortableSleep(step.ms, signal);
        if (aborted || signal?.aborted) return null;
        continue;
      }
      const aborted = await waitForInflight(signal);
      if (aborted || signal?.aborted) return null;
    }
  }

  function reset(): void {
    inflight = 0;
    starts = [];
    for (const w of Array.from(inflightWaiters)) {
      try {
        w();
      } catch {
        // Reset must never throw.
      }
    }
    inflightWaiters.clear();
  }

  return { acquire, reset };
}

// Global gate: every proxyTransport instance on the page shares one limiter,
// so metadata discovery fan-out and tile-image fetches through the proxy
// draw from the same 4-inflight / 4-qps budget. Direct tile requests never
// touch this gate.
let globalProxyRateLimiter: ProxyRateLimiter | null = null;

function globalLimiter(): ProxyRateLimiter {
  if (!globalProxyRateLimiter) globalProxyRateLimiter = createProxyRateLimiter();
  return globalProxyRateLimiter;
}

/**
 * Decode a relay error body (`{code, reason?}` JSON) without ever throwing.
 * Returns an empty object when the body is not a relay error payload, in
 * which case callers fall back to status-based classification.
 */
export function parseRelayError(bytes: ArrayBuffer): { code?: string; reason?: string } {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > 4096) return {};
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as { code?: unknown; reason?: unknown };
    if (typeof parsed?.code !== "string" || parsed.code === "") return {};
    const out: { code?: string; reason?: string } = { code: parsed.code };
    if (typeof parsed.reason === "string" && parsed.reason !== "") out.reason = parsed.reason;
    return out;
  } catch {
    return {};
  }
}

/** Test seam: drop global proxy rate state between isolated checks. */
export function resetProxyRateLimit(): void {
  try {
    globalProxyRateLimiter?.reset();
  } catch {
    // Reset must never throw.
  }
}

export function createProxyTransport(
  fetchImpl: ProxyFetchImpl,
  opts: {
    protocolVersion: number;
    maxBytes: number;
    proxyPath?: string;
    rateLimiter?: ProxyRateLimiter;
  },
): {
  fetchViaProxy(
    targetUrl: string,
    callOpts?: { signal?: AbortSignal },
  ): Promise<ProxyFetchResult>;
} {
  const proxyPath = opts.proxyPath ?? "/api/proxy";
  const limiter = opts.rateLimiter ?? globalLimiter();

  async function fetchViaProxy(
    targetUrl: string,
    callOpts?: { signal?: AbortSignal },
  ): Promise<ProxyFetchResult> {
    // Reject credential-bearing targets before any proxy request.
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { ok: false, status: 0, code: "PROXY_POLICY_DENIED", reason: "invalid-url" };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { ok: false, status: 0, code: "PROXY_POLICY_DENIED", reason: "userinfo" };
    }
    if (callOpts?.signal?.aborted) {
      return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    }
    const release = await limiter.acquire(callOpts?.signal);
    if (!release) {
      return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    }
    let response: {
      status: number;
      headers?: unknown;
      arrayBuffer(): Promise<ArrayBuffer>;
    };
    try {
      response = await fetchImpl(proxyPath, {
        method: "POST",
        credentials: "omit",
        signal: callOpts?.signal,
        headers: { "content-type": "application/json" },
        // Only target URL + protocol version; no cookies/auth/referrer/user headers.
        body: JSON.stringify({ targetUrl, protocolVersion: opts.protocolVersion }),
      });
    } catch (err: unknown) {
      if (callOpts?.signal?.aborted) {
        return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
      }
      void err;
      return { ok: false, status: 0, code: "TRANSPORT_NETWORK_ERROR" };
    } finally {
      release();
    }
    if (callOpts?.signal?.aborted) {
      return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    }
    const headers = safeHeaders(response.headers);
    // Response-size guard before trusting body.
    const declared = headers["content-length"] ? Number(headers["content-length"]) : NaN;
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      return { ok: false, status: response.status, code: "PROXY_BUDGET_EXCEEDED" };
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch {
      return { ok: false, status: response.status, code: "TRANSPORT_NETWORK_ERROR" };
    }
    if (bytes.byteLength > opts.maxBytes) {
      return { ok: false, status: response.status, code: "PROXY_BUDGET_EXCEEDED" };
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(headers["retry-after"]);
      return {
        ok: false,
        status: 429,
        code: "PROXY_RATE_LIMITED",
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    if (response.status === 413) return { ok: false, status: 413, code: "PROXY_BUDGET_EXCEEDED" };
    if (response.status < 200 || response.status > 299) {
      // The relay reports its own decision as JSON `{code, reason?}`; an
      // upstream 403/404 arrives as TRANSPORT_HTTP_ERROR while our own
      // policy arrives as PROXY_POLICY_DENIED. Never infer the cause from
      // the HTTP status alone: a 403 from the viewed site used to
      // masquerade as a policy denial.
      const relay = parseRelayError(bytes);
      if (relay.code !== undefined) {
        return {
          ok: false,
          status: response.status,
          code: relay.code,
          ...(relay.reason !== undefined ? { reason: relay.reason } : {}),
        };
      }
      if (response.status === 403 || response.status === 422) {
        return { ok: false, status: response.status, code: "PROXY_POLICY_DENIED" };
      }
      return { ok: false, status: response.status, code: "TRANSPORT_HTTP_ERROR" };
    }
    const upstream = headers[PROXY_UPSTREAM_URL_HEADER];
    return {
      ok: true,
      status: response.status,
      bytes,
      contentType: headers["content-type"],
      ...(typeof upstream === "string" && upstream !== "" ? { finalUrl: upstream } : {}),
    };
  }

  return { fetchViaProxy };
}
