// Browser resource limits with overflow-safe arithmetic.
import type { BrowserLimits } from "./types.ts";

export type LimitVerdict = "ok" | "browser-risk" | "native-required";

export interface LimitDecision {
  verdict: LimitVerdict;
  reason: string;
  area: number | null;
}

/**
 * Client hints used to pick the device limit tier. `userAgentData.mobile`
 * (User-Agent Client Hints) decides where the browser reports it; the
 * `userAgent` string is the iOS/Android fallback.
 */
export interface ClientHints {
  userAgentData?: { mobile?: boolean } | null;
  userAgent?: string;
}

// Tested on Chrome 153: saved 32768×8192 but failed at 32768×8193.
// WebKit CanvasBase.cpp caps desktop area at 16384² and iOS at 8192²;
// IOSurface.mm caps sides at 32768 on macOS and 8192 on iOS.
// The values are a reasonable tradeoff between image size and failure rate
export const BROWSER_MAX_CANVAS_AREA = 268435456;
export const BROWSER_MAX_CANVAS_SIDE = 32768;
export const BROWSER_MOBILE_MAX_CANVAS_AREA = 67108864;
export const BROWSER_MOBILE_MAX_CANVAS_SIDE = 8192;

export const BROWSER_LIMITS: BrowserLimits = {
  maxWidth: BROWSER_MAX_CANVAS_SIDE,
  maxHeight: BROWSER_MAX_CANVAS_SIDE,
  maxArea: BROWSER_MAX_CANVAS_AREA,
  maxBytes: BROWSER_MAX_CANVAS_AREA * 4,
};

export const BROWSER_MOBILE_LIMITS: BrowserLimits = {
  maxWidth: BROWSER_MOBILE_MAX_CANVAS_SIDE,
  maxHeight: BROWSER_MOBILE_MAX_CANVAS_SIDE,
  maxArea: BROWSER_MOBILE_MAX_CANVAS_AREA,
  maxBytes: BROWSER_MOBILE_MAX_CANVAS_AREA * 4,
};

/** Automatic selection caps (`SessionConfig.browser_selection`). */
export interface SelectionLimits {
  maxWidth: number;
  maxHeight: number;
  maxArea: number;
}

/** True on phones and tablets: client-hints flag first, UA fallback after. */
export function isMobileClient(hints?: ClientHints | null): boolean {
  const flag = hints?.userAgentData?.mobile;
  if (typeof flag === "boolean") return flag;
  const ua = String(hints?.userAgent ?? "").toLowerCase();
  return /iphone|ipad|ipod|android/.test(ua);
}

/** Canvas limits for this client (mobile tier on mobile, desktop otherwise). */
export function browserLimitsFor(hints?: ClientHints | null): BrowserLimits {
  return isMobileClient(hints) ? BROWSER_MOBILE_LIMITS : BROWSER_LIMITS;
}

/** Automatic selection limits for this client, shaped for `browser_selection`. */
export function selectionLimitsFor(hints?: ClientHints | null): SelectionLimits {
  const limits = browserLimitsFor(hints);
  return {
    maxWidth: limits.maxWidth,
    maxHeight: limits.maxHeight,
    maxArea: limits.maxArea,
  };
}

/**
 * Selection caps for a "Try maximum" attempt: unbounded, so the engine takes
 * the largest known level and the canvas gate reports what cannot work
 * (allocation, context, or PNG encoding) with a desktop-app action.
 */
export const MAXIMUM_SELECTION_LIMITS: SelectionLimits = {
  maxWidth: 4294967295,
  maxHeight: 4294967295,
  maxArea: Number.MAX_SAFE_INTEGER,
};

/** Upper bound on tiles materialized into one website plan (allocation guard). */
export const BROWSER_MAX_PLAN_TILES = 100_000;

export function safeArea(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  // Overflow-safe: check division before multiplying. JS is float64 but we
  // guard against exceeding MAX_SAFE_INTEGER as well.
  if (width > Number.MAX_SAFE_INTEGER / height) return null;
  return width * height;
}

export function probeLimits(
  req: { width: number; height: number; estimatedBytes?: number },
  limits: BrowserLimits,
): LimitDecision {
  const { width, height, estimatedBytes } = req;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { verdict: "native-required", reason: "zero-or-invalid-dimension", area: null };
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { verdict: "native-required", reason: "non-integer-dimension", area: null };
  }
  if (width > limits.maxWidth) {
    return { verdict: "native-required", reason: "width-exceeds-limit", area: null };
  }
  if (height > limits.maxHeight) {
    return { verdict: "native-required", reason: "height-exceeds-limit", area: null };
  }
  // Overflow-safe area comparison without multiplying first.
  if (limits.maxArea >= 0 && height !== 0 && width > limits.maxArea / height) {
    return { verdict: "native-required", reason: "area-exceeds-limit", area: null };
  }
  const area = width * height;
  if (!Number.isSafeInteger(area) || area > limits.maxArea) {
    return { verdict: "native-required", reason: "area-exceeds-limit", area: null };
  }
  if (
    estimatedBytes !== undefined &&
    Number.isFinite(estimatedBytes) &&
    estimatedBytes > limits.maxBytes
  ) {
    return { verdict: "browser-risk", reason: "memory-uncertain", area };
  }
  return { verdict: "ok", reason: "within-limits", area };
}
