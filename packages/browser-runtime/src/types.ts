// Browser runtime public types. Pure types + tiny helpers, no I/O.
// Keep this file erasable-syntax-only so node type-stripping can import it.

export const ERROR_CODES = {
  TRANSPORT_NETWORK_ERROR: "TRANSPORT_NETWORK_ERROR",
  TRANSPORT_HTTP_ERROR: "TRANSPORT_HTTP_ERROR",
  TRANSPORT_CANCELLED: "TRANSPORT_CANCELLED",
  TRANSPORT_POLICY_DENIED: "TRANSPORT_POLICY_DENIED",
  PROXY_ELIGIBILITY_DENIED: "PROXY_ELIGIBILITY_DENIED",
  PROXY_RATE_LIMITED: "PROXY_RATE_LIMITED",
  PROXY_BUDGET_EXCEEDED: "PROXY_BUDGET_EXCEEDED",
  LIMIT_NATIVE_REQUIRED: "LIMIT_NATIVE_REQUIRED",
  DECODE_FAILED: "DECODE_FAILED",
  INVALID_INPUT: "INVALID_INPUT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ReadableTileResponse {
  outcome: "readable";
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  bytes: ArrayBuffer;
}

export interface OrdinaryImageAllowedResponse {
  outcome: "ordinary-image-allowed";
  finalUrl: string;
}

export interface HttpErrorTileResponse {
  outcome: "http-error";
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  /** Bounded, single-line server signal extracted from the error body (best effort). */
  preview?: string;
}

export interface NetworkErrorTileResponse {
  outcome: "network-error";
  reason: string;
}

export interface CancelledTileResponse {
  outcome: "cancelled";
  reason: string;
}

export interface PolicyDeniedTileResponse {
  outcome: "policy-denied";
  reason: string;
  code: ErrorCode;
}

export type TileResponse =
  | ReadableTileResponse
  | OrdinaryImageAllowedResponse
  | HttpErrorTileResponse
  | NetworkErrorTileResponse
  | CancelledTileResponse
  | PolicyDeniedTileResponse;

export interface BrowserLimits {
  maxWidth: number;
  maxHeight: number;
  maxArea: number;
  maxBytes: number;
}
