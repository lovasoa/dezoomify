import type { ResourceRequest } from "@dezoomify/wasm-bindings";
import type { HostFailure } from "./engine-host.ts";

// Shared probe-size helper for browser hosts.
//
// Probing only needs decoded dimensions: fetch one tile as readable bytes,
// decode it far enough to report its size, and fall back to a plain <img>
// measurement when readable bytes are unavailable (CORS-blocked without a
// grant). The website and the extension share this implementation so
// probe-driven levels behave identically on both products.

export type ProbeSize =
  | { status: "missing" }
  | {
      status: "available";
      width: number;
      height: number;
      /** Readable bytes retained when the probe can also satisfy output. */
      bytes?: ArrayBuffer;
      /** Plain image retained when probing succeeded through display fallback. */
      image?: ProbeImage;
    };

export interface ProbeImage {
  naturalWidth: number;
  naturalHeight: number;
}

export interface ProbeBitmap {
  width: number;
  height: number;
  close(): void;
}

export interface ProbeSizeDeps {
  classifyFailure?(error: unknown): HostFailure;
  /** Fetch one tile as readable bytes. The engine request id lets a host route the probe without colliding with tile requests. */
  fetchResource(request: ResourceRequest, signal: AbortSignal): Promise<{ bytes: Uint8Array }>;
  /** Decode fetched bytes far enough to report dimensions. */
  decode(bytes: ArrayBuffer): Promise<ProbeBitmap>;
  /** Measure dimensions without byte access (plain <img> fallback). */
  loadImage?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ width: number; height: number; image?: ProbeImage }>;
}

function observedSize(
  width: number,
  height: number,
  retained: { bytes?: ArrayBuffer; image?: ProbeImage } = {},
): ProbeSize {
  return width > 0 && height > 0
    ? { status: "available", width, height, ...retained }
    : { status: "missing" };
}

export function createProbeSize(
  deps: ProbeSizeDeps,
): (request: ResourceRequest, signal: AbortSignal) => Promise<ProbeSize> {
  return async (request: ResourceRequest, signal: AbortSignal): Promise<ProbeSize> => {
    signal.throwIfAborted();
    let bytes: ArrayBuffer;
    try {
      const result = await deps.fetchResource(request, signal);
      bytes = result.bytes.slice().buffer;
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (deps.classifyFailure?.(error).code === "TRANSPORT_POLICY_DENIED") throw error;
      if (!deps.loadImage) return { status: "missing" };
      try {
        const observed = await deps.loadImage(request.uri, signal);
        return observedSize(
          observed.width,
          observed.height,
          observed.image ? { image: observed.image } : {},
        );
      } catch {
        signal.throwIfAborted();
        return { status: "missing" };
      }
    }
    try {
      const bitmap = await deps.decode(bytes);
      const size = observedSize(bitmap.width, bitmap.height, { bytes });
      try {
        bitmap.close();
      } catch {
        // Bitmap cleanup is best-effort.
      }
      signal.throwIfAborted();
      return size;
    } catch {
      signal.throwIfAborted();
      // Readable bytes are unavailable (e.g. no CORS grant). Probing only
      // needs dimensions, which a plain <img> reports without byte access.
      if (!deps.loadImage) return { status: "missing" };
      try {
        const observed = await deps.loadImage(request.uri, signal);
        return observedSize(
          observed.width,
          observed.height,
          observed.image ? { image: observed.image } : {},
        );
      } catch {
        signal.throwIfAborted();
        return { status: "missing" };
      }
    }
  };
}
