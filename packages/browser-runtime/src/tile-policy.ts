// Browser tile policy: politeness, resilience, and timeouts.
//
// Request timeouts and proxy retry delays. Rust owns tile pacing and retries.

/** Per-request timeout applied to every individual HTTP request (30 s). */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Head-start window for the direct metadata fetch: if the site does not
 * answer within 1500 ms, the eligible website proxy takes over
 * automatically after the direct request settles.
 * Tiles keep the full 30 s timeout before eligible proxy fallback.
 */
export const DIRECT_METADATA_TIMEOUT_MS = 1500;

/** Maximum concurrent tile requests in browser products. */
export const BROWSER_MAX_CONCURRENCY = 6;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay before a single retry after PROXY_RATE_LIMITED. Honors
 * the relay's Retry-After hint when present, otherwise backs off 1 s.
 * Returns null when the hint exceeds the UX budget: fail fast with
 * extension/desktop guidance instead of stalling the job on a long throttle.
 */
export const PROXY_RATE_LIMIT_RETRY_BASE_MS = 1000;
export const PROXY_RATE_LIMIT_RETRY_MAX_MS = 5000;

export function proxyRateLimitDelayMs(retryAfterMs?: number): number | null {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
    if (retryAfterMs <= 0) return 0;
    if (retryAfterMs > PROXY_RATE_LIMIT_RETRY_MAX_MS) return null;
    return Math.min(Math.floor(retryAfterMs), PROXY_RATE_LIMIT_RETRY_MAX_MS);
  }
  return PROXY_RATE_LIMIT_RETRY_BASE_MS;
}

export interface TimeoutCombined {
  signal: AbortSignal;
  cleanup(): void;
  timedOut?: () => boolean;
}

/**
 * Combine a caller signal with the per-request timeout.
 * Uses AbortSignal.any/timeout when available, manual wiring otherwise.
 */
export function combineTimeout(
  parentSignal?: AbortSignal,
  ms: number = REQUEST_TIMEOUT_MS,
): TimeoutCombined {
  const AS = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof AbortSignal !== "undefined" && typeof AS.timeout === "function") {
    const timeout = (AS.timeout as (ms: number) => AbortSignal)(ms);
    if (parentSignal && typeof AS.any === "function") {
      return {
        signal: (AS.any as (s: AbortSignal[]) => AbortSignal)([parentSignal, timeout]),
        cleanup() {},
      };
    }
    if (!parentSignal) return { signal: timeout, cleanup() {} };
  }
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (parentSignal && onAbort) parentSignal.removeEventListener("abort", onAbort);
  };
  if (parentSignal?.aborted) {
    ctrl.abort((parentSignal as AbortSignal & { reason?: unknown }).reason);
    return { signal: ctrl.signal, cleanup() {}, timedOut: () => false };
  }
  let timedOut = false;
  timer = setTimeout(() => {
    timedOut = true;
    try {
      ctrl.abort(new DOMException(`Request timed out after ${ms / 1000}s`, "TimeoutError"));
    } catch {
      ctrl.abort();
    }
  }, ms);
  if (parentSignal) {
    onAbort = () => {
      cleanup();
      try {
        ctrl.abort((parentSignal as AbortSignal & { reason?: unknown }).reason);
      } catch {
        ctrl.abort();
      }
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, cleanup, timedOut: () => timedOut };
}
