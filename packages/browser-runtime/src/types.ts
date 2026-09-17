// Browser runtime public types. Pure types + tiny helpers, no I/O.
// Keep this file erasable-syntax-only so node type-stripping can import it.

export const SAVE_REQUIRES_READABLE_BYTES = "SAVE_REQUIRES_READABLE_BYTES" as const;

export const ERROR_CODES = {
  SAVE_REQUIRES_READABLE_BYTES,
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

export type TileResourceKind = "metadata" | "tile";

export interface TileRequest {
  url: string;
  kind: TileResourceKind;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

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

export interface TileSurface {
  readonly originClean: boolean;
  readonly saveGuidance: string;
  dispose(): void;
}

export type SaveCapability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly code: typeof SAVE_REQUIRES_READABLE_BYTES;
      readonly reason: string;
    };

export interface BrowserLimits {
  maxWidth: number;
  maxHeight: number;
  maxArea: number;
  maxBytes: number;
}

export type FallbackCapabilityId =
  | "ordinary-image-display"
  | "metadata-proxy"
  | "extension"
  | "native";

export {
  BROWSER_SESSION_TRANSPORT_LABEL,
  DIRECT_TRANSPORT_LABEL,
  DISPLAY_TRANSPORT_LABEL,
  NATIVE_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
} from "./transport-labels.ts";

export function saveCapabilityFor(originClean: boolean): SaveCapability {
  if (originClean) return { available: true };
  return {
    available: false,
    code: SAVE_REQUIRES_READABLE_BYTES,
    reason: "Readable tile bytes are required for programmatic save.",
  };
}
