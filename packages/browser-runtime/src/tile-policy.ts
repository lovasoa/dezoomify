// Direct metadata gets a shorter timeout so eligible proxy fallback remains
// responsive. Tile retry and pacing decisions belong to Rust.

export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Proxy fallback starts only after the direct request settles. This is a timeout,
 * not a race between two requests that could consume the source twice.
 */
export const DIRECT_METADATA_TIMEOUT_MS = 1500;

export const BROWSER_MAX_CONCURRENCY = 6;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PROXY_RATE_LIMIT_RETRY_BASE_MS = 1000;
export const PROXY_RATE_LIMIT_RETRY_MAX_MS = 5000;

/** Null declines a retry rather than truncating a server's long Retry-After.
 * This bounds the metadata wait without retrying earlier than requested. */
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

/** Always call cleanup after the request body settles. The fallback owns a
 * timer and parent listener; cleanup does not abort the returned signal. */
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
