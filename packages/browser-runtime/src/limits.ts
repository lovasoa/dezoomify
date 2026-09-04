// Browser resource limits with overflow-safe arithmetic.
import type { BrowserLimits } from "./types.ts";

export type LimitVerdict = "ok" | "browser-risk" | "native-required";

export interface LimitDecision {
  verdict: LimitVerdict;
  reason: string;
  area: number | null;
}

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
