// Browser tile policy: politeness, resilience, and timeouts.
//
// Request limits, per-host spacing, timeout signals, and proxy retry delays.
// Tile retries belong to the Rust algorithm. Tests inject the throttle clock.

/** Per-request timeout applied to every individual HTTP request (30 s). */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Head-start window for the direct metadata fetch: if the site does not
 * answer within 1500 ms, the eligible metadata proxy takes over
 * automatically after the direct request settles.
 * Tiles keep the full 30 s timeout (they never use the proxy).
 */
export const DIRECT_METADATA_TIMEOUT_MS = 1500;

/** Space request starts by at least 200 ms per host. Rust owns tile retries. */
export const TILE_MAX_REQUESTS_PER_SECOND = 5;
export const TILE_MIN_INTERVAL_MS = 1000 / TILE_MAX_REQUESTS_PER_SECOND;

/** Maximum concurrent tile requests in browser products. */
export const BROWSER_MAX_CONCURRENCY = 6;

export function tileHostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ThrottleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Stagger tile request starts per host to <=5/s. Chained per host so the
 * concurrent requests share one spacing clock: each starter waits for the
 * previous starter for that host, enforces the 200 ms gap, then releases
 * the next waiter. The clock is injectable so tests assert spacing without
 * wall-clock waits.
 */
export function createTileThrottle(clock?: ThrottleClock): {
  throttle(url: string): Promise<void>;
  reset(): void;
} {
  const now = clock?.now ?? Date.now;
  const wait = clock?.sleep ?? sleep;
  const last = new Map<string, number>();
  const queue = new Map<string, Promise<void>>();
  function throttle(url: string): Promise<void> {
    const host = tileHostOf(url) || "global";
    const prev = queue.get(host) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.set(host, current);
    const run = (async () => {
      await prev;
      const at = now();
      const previous = last.get(host) ?? 0;
      const gap = TILE_MIN_INTERVAL_MS - (at - previous);
      if (gap > 0) await wait(gap);
      last.set(host, now());
    })();
    return run.finally(release);
  }
  function reset(): void {
    last.clear();
    queue.clear();
  }
  return { throttle, reset };
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

/** Hostname of a job's website, for plain-language progress messages. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}
