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
  /** Fetch one tile as readable bytes. The engine request id lets a host route the probe without colliding with tile requests. */
  fetchTile(
    url: string,
    headers: Record<string, string>,
    requestId?: number,
  ): Promise<{ bytes: ArrayBuffer }>;
  /** Decode fetched bytes far enough to report dimensions. */
  decode(bytes: ArrayBuffer): Promise<ProbeBitmap>;
  /** Measure dimensions without byte access (plain <img> fallback). */
  loadImage?: (url: string) => Promise<{ width: number; height: number; image?: ProbeImage }>;
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
): (url: string, headers: Record<string, string>, requestId?: number) => Promise<ProbeSize> {
  return async (
    url: string,
    headers: Record<string, string>,
    requestId?: number,
  ): Promise<ProbeSize> => {
    let bytes: ArrayBuffer;
    try {
      ({ bytes } = await deps.fetchTile(url, headers, requestId));
    } catch (error) {
      // A missing host grant is actionable (the host pauses for permission),
      // never a silent missing probe. Only other fetch failures fall through
      // to the <img> fallback / missing observation.
      if (
        error !== null &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "permission-denied"
      ) {
        throw error;
      }
      if (!deps.loadImage) return { status: "missing" };
      try {
        const observed = await deps.loadImage(url);
        return observedSize(
          observed.width,
          observed.height,
          observed.image ? { image: observed.image } : {},
        );
      } catch {
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
      return size;
    } catch {
      // Readable bytes are unavailable (e.g. no CORS grant). Probing only
      // needs dimensions, which a plain <img> reports without byte access.
      if (!deps.loadImage) return { status: "missing" };
      try {
        const observed = await deps.loadImage(url);
        return observedSize(
          observed.width,
          observed.height,
          observed.image ? { image: observed.image } : {},
        );
      } catch {
        return { status: "missing" };
      }
    }
  };
}
