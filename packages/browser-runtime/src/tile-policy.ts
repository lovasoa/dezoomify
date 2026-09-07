// Website tile policy (todo 2.2 home): politeness, resilience, timeouts.
//
// Moved from `src/main.ts` so the website orchestrator stays thin: this
// module owns every tile-fetch tuning constant plus the per-host throttle,
// the retry backoff, the adaptive concurrency picker, the combined timeout
// signal, and the proxy rate-limit delay. Pure and dependency-injected where
// the host clock or randomness is involved, so node tests drive it with
// fakes. Keep erasable-syntax-only for the browser `.js` mirrors.
import { failure } from "./session.ts";
import type { StructuredFailure } from "./session.ts";

/** Per-request timeout applied to every individual HTTP request (30 s). */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Head-start window for the direct metadata fetch: if the site does not
 * answer within 1500 ms, the eligible metadata proxy takes over
 * automatically. 250 ms proved too aggressive on slow sites and caused false
 * proxy fallback; 1500 ms keeps direct-first while failing over promptly.
 * Tiles keep the full 30 s timeout (they never use the proxy).
 */
export const DIRECT_METADATA_TIMEOUT_MS = 1500;

/**
 * Tile politeness + resilience plus capability-negotiated concurrency
 * (todo 3.2). At most 5 tile request starts per second per host (legacy
 * ZoomManager.MAX_REQUESTS_PER_SECOND parity: 1000/5 ms spacing between
 * starts). Each tile retries twice (3 attempts) with exponential backoff +
 * jitter; the exhausted failure still maps to TILE_FAILED (never a display
 * string). Capability policy: website 6, extension 6, native 16
 * (protocol `browser_baseline` 6 vs `native_baseline` 16 vs
 * `extension_baseline` 6). The website picker below stays adaptive 6-12
 * for future caps but the live website path negotiates to the browser
 * baseline 6; native/CLI keep their own 16 and never read the browser cap.
 */
export const TILE_MAX_REQUESTS_PER_SECOND = 5;
export const TILE_MIN_INTERVAL_MS = 1000 / TILE_MAX_REQUESTS_PER_SECOND;
export const TILE_MAX_RETRIES = 2;
export const TILE_RETRY_BASE_MS = 250;

/**
 * Website tile concurrency bounds. The adaptive picker range is 6-12;
 * 4 is the absolute floor for unknown or constrained hosts. The generic
 * picker cap stays 12 for `pickTileConcurrency` callers; the live website
 * path negotiates to `BROWSER_CAPABILITY_MAX_CONCURRENCY` 6 (protocol
 * `browser_baseline`), the extension runs a fixed 6, and native/CLI stay
 * at their own 16 and never read the browser cap.
 */
export const TILE_CONCURRENCY_FLOOR = 4;
export const TILE_CONCURRENCY_MIN = 6;
export const TILE_CONCURRENCY_MAX = 12;
export const TILE_CONCURRENCY_CAP = 12;
/** Browser capability baseline: 6 concurrent tiles (protocol dto). */
export const BROWSER_CAPABILITY_MAX_CONCURRENCY = 6;
export const TILE_RTT_MEDIUM_MS = 400;
export const TILE_RTT_SLOW_MS = 800;

/**
 * Pure adaptive concurrency: base from core count, minus for slow RTT,
 * clamped to 6-12, then within the capability cap with a floor of 4.
 * Slow networks back off so extra workers do not pile onto timeouts.
 */
export function pickTileConcurrency(opts?: {
  hardwareConcurrency?: unknown;
  rttMs?: unknown;
  capabilityCap?: unknown;
}): number {
  let cap = TILE_CONCURRENCY_CAP;
  if (typeof opts?.capabilityCap === "number" && Number.isFinite(opts.capabilityCap as number)) {
    cap = Math.floor(opts.capabilityCap as number);
  }
  let cores = 4;
  if (
    typeof opts?.hardwareConcurrency === "number" &&
    Number.isFinite(opts.hardwareConcurrency as number)
  ) {
    cores = Math.floor(opts.hardwareConcurrency as number);
  }
  let base: number;
  if (cores <= 2) base = TILE_CONCURRENCY_MIN;
  else if (cores <= 4) base = 8;
  else if (cores <= 8) base = 10;
  else base = TILE_CONCURRENCY_MAX;
  const rtt = opts?.rttMs;
  if (typeof rtt === "number" && Number.isFinite(rtt)) {
    if (rtt >= TILE_RTT_SLOW_MS) base -= 2;
    else if (rtt >= TILE_RTT_MEDIUM_MS) base -= 1;
  }
  const clamped = Math.min(Math.max(base, TILE_CONCURRENCY_MIN), TILE_CONCURRENCY_MAX);
  return Math.max(TILE_CONCURRENCY_FLOOR, Math.min(clamped, cap));
}

export interface HostConcurrencyHints {
  hardwareConcurrency?: unknown;
  connection?: { rtt?: unknown };
}

/**
 * Website concurrency from host hints, negotiated to the browser capability
 * baseline (6). hardwareConcurrency sizes the pool and NetworkInformation.rtt
 * (ms, when present) backs off slow links, then the result is capped at the
 * browser baseline so the website, extension (fixed 6), and native (16) stay
 * on the capability-negotiated policy. Every read is best-effort: unknown
 * hosts get the deterministic default (4 cores, no RTT), which still
 * respects the floor. Pass explicit hints in tests; when omitted, the global
 * navigator is read best-effort and ignored when absent.
 */
export function websiteTileConcurrency(host?: HostConcurrencyHints): number {
  let cores = 4;
  let rtt: number | undefined;
  try {
    const nav =
      host ??
      (typeof navigator !== "undefined"
        ? (navigator as unknown as HostConcurrencyHints)
        : undefined);
    if (
      nav &&
      typeof nav.hardwareConcurrency === "number" &&
      Number.isFinite(nav.hardwareConcurrency)
    ) {
      cores = Math.floor(nav.hardwareConcurrency);
    }
    const connRtt = nav?.connection?.rtt;
    if (typeof connRtt === "number" && Number.isFinite(connRtt)) rtt = connRtt;
  } catch {
    // Host globals are best-effort; defaults keep the floor.
  }
  return pickTileConcurrency({ hardwareConcurrency: cores, rttMs: rtt, capabilityCap: BROWSER_CAPABILITY_MAX_CONCURRENCY });
}

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
 * parallel workers share one spacing clock: each starter waits for the
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

/** Exponential backoff with jitter between tile attempts. */
export function tileRetryDelayMs(retryIndex: number, random: () => number = Math.random): number {
  return TILE_RETRY_BASE_MS * Math.pow(2, retryIndex) + random() * 100;
}

/**
 * Delay before a single retry after PROXY_RATE_LIMITED (todo 5.1). Honors
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
export function combineTimeout(parentSignal?: AbortSignal, ms: number = REQUEST_TIMEOUT_MS): TimeoutCombined {
  const AS = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof AbortSignal !== "undefined" && typeof AS.timeout === "function") {
    const timeout = (AS.timeout as (ms: number) => AbortSignal)(ms);
    if (parentSignal && typeof AS.any === "function") {
      return { signal: (AS.any as (s: AbortSignal[]) => AbortSignal)([parentSignal, timeout]), cleanup() {} };
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

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? `…${u.pathname.slice(-39)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return String(url).slice(0, 60);
  }
}

/** Hostname of a job's website, for plain-language progress messages. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}

/** Exhausted tile retries map to TILE_FAILED (never a display string). */
export function tileFailedError(
  lastOutcome: string,
  lastStatus: number | undefined,
  url: string,
): StructuredFailure {
  return failure(
    "TILE_FAILED",
    "Part of the image could not be saved. Try again in a moment.",
    true,
    undefined,
    `tile fetch: ${lastOutcome} (HTTP ${lastStatus ?? "n/a"}) from ${shortUrl(url)} after ${TILE_MAX_RETRIES + 1} attempts`,
  );
}

