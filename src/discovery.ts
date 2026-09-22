// Website discovery hint: cheap substring signals for whether fetched
// metadata bytes look like a zoomable image source.
//
// Pure and host-neutral: no fetch, DOM, or storage. The WASM core is the
// single authority for discovery (it follows secondary resources such as
// info.json, tour.xml, or tile-info XML); this classifier is a UI hint only
// and never gates the core. A generic article page (no zoom viewer) still
// ends as a structured NO_IMAGE_FOUND failure from the engine, never fake
// tile counts -- but a head without literals must still reach the core, which
// is why the website forwards every readable payload to WASM (extension
// parity: it tries ranked candidates directly).
//
// Keep this file erasable-syntax-only so node type-stripping can import it
// directly in tests; Vite/WXT bundle it for browsers.

export interface DiscoveryStructuredError {
  code: string;
  category: string;
  retryable: boolean;
  message?: string;
  transport?: string;
  phase?: string;
}

export interface DiscoveryVerdict {
  found: boolean;
  via?: string;
  cancelled?: boolean;
  error?: DiscoveryStructuredError;
}

// Strong content signals. Each entry is a lowercased substring that is
// specific enough to not appear on generic article pages. Weak words such as
// "manifest", "width", or "@context" alone are deliberately absent: many
// ordinary pages embed a PWA manifest link or JSON-LD schema.org blocks.
const STRONG_CONTENT_MARKERS: readonly string[] = [
  ".dzi",
  "_files/",
  "imageproperties.xml",
  "zoomifyimagepath",
  "showimage",
  "seadragon",
  "openseadragon",
  "tilesources",
  "tile_sources",
  "dziurltemplate",
  "tilegroup",
  "krpano",
  "lizardtech/iserv",
  "hungaricana",
  ".ecw",
  "micr-io",
  "micrio",
  "pic-mediabank",
  "memorix",
  "topviewer",
  "thumbview",
  "pageview",
  "/zoom/",
  "wmts",
  "mapserver",
  "arcgis",
  "iipimage",
  "?fif=",
  "&fif=",
  "fif=image",
  "/server?source=",
  "/server&source=",
  "fsi viewer",
  "artsandculture",
  "arts-culture",
  "xlimage",
  ".imgi",
  "entity/object",
  "ete-openlayers-src",
  "accessnumber",
  "deepzoom",
  "zoomify",
  "iiif",
  "tile_group",
  "zoomifyimage",
  "image-service",
  "image_api",
];

const XML_MARKERS: readonly string[] = [
  "imageproperties",
  "dzi:image",
  "<image",
  "tilesize",
  "<krpano",
  "<imageserver",
  "wmtscapabilities",
  "<capabilities",
  "<tilemap",
  // Google Arts & Culture tile information (served at "<base_url>=g").
  "<tileinfo",
  "pyramid_level",
];

function toUint8(bytes: unknown): Uint8Array | null {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (typeof SharedArrayBuffer !== "undefined" && bytes instanceof SharedArrayBuffer) {
    return null;
  }
  if (Array.isArray(bytes)) {
    try {
      return Uint8Array.from(bytes as number[]);
    } catch {
      return null;
    }
  }
  // Node Buffer is a Uint8Array subclass, already handled above.
  // ArrayBuffer views (DataView) expose .buffer.
  if (
    bytes !== null &&
    typeof bytes === "object" &&
    "buffer" in (bytes as Record<string, unknown>) &&
    "byteLength" in (bytes as Record<string, unknown>)
  ) {
    try {
      const view = bytes as { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number };
      if (view.buffer instanceof ArrayBuffer) {
        const off = typeof view.byteOffset === "number" ? view.byteOffset : 0;
        const len =
          typeof view.byteLength === "number" ? view.byteLength : view.buffer.byteLength - off;
        return new Uint8Array(view.buffer, off, len);
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function bytesToTextPreview(input: unknown, maxBytes = 256 * 1024): string {
  const bytes = toUint8(input);
  if (!bytes || bytes.length === 0) return "";
  const slice = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  try {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8", { fatal: false }).decode(slice);
    }
  } catch {
    // fall through to manual latin1 fallback
  }
  let out = "";
  const n = Math.min(slice.length, 65536);
  for (let i = 0; i < n; i++) out += String.fromCharCode(slice[i] as number);
  return out;
}

export function textToBytes(text: string): ArrayBuffer {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
  }
  const arr = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) arr[i] = text.charCodeAt(i) & 0xff;
  return arr.buffer;
}

export function hasZoomableUrlHint(url: string): boolean {
  const lower = String(url ?? "").toLowerCase();
  if (!lower) return false;
  return (
    lower.includes(".dzi") ||
    lower.includes("_files/") ||
    lower.includes("imageproperties.xml") ||
    lower.includes("info.json") ||
    lower.includes("manifest.json") ||
    lower.includes("tilegroup") ||
    lower.includes("zoomify") ||
    lower.includes("seadragon") ||
    lower.includes("openseadragon") ||
    lower.includes("iiif") ||
    lower.includes("krpano") ||
    lower.includes("tiles.xml") ||
    lower.includes("wmts") ||
    lower.includes("mapserver") ||
    lower.includes("arcgis") ||
    lower.includes("lizardtech/iserv") ||
    lower.includes("hungaricana") ||
    lower.includes(".ecw") ||
    lower.includes("?fif") ||
    lower.includes("&fif") ||
    lower.includes("topviewer") ||
    lower.includes("memorix") ||
    lower.includes("micrio") ||
    lower.includes("micr-io")
  );
}

function lowerHas(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

export function looksLikeZoomableJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(0, 512 * 1024));
  } catch {
    return false;
  }
  const seen: string[] = [];
  const stack: unknown[] = [parsed];
  let depth = 0;
  // Shallow walk: collect up to 200 string keys/values without recursion blowup.
  while (stack.length > 0 && depth < 500) {
    depth++;
    const node = stack.pop();
    if (node === null || node === undefined) continue;
    if (typeof node === "string") {
      const l = node.toLowerCase();
      if (l.includes("iiif.io/api/image") || l.includes("iiif.io/api/presentation")) return true;
      if (seen.length < 200) seen.push(l);
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && stack.length < 200; i++) stack.push(node[i]);
      continue;
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const keys = Object.keys(obj);
      for (const k of keys) {
        const lk = k.toLowerCase();
        if (lk === "@context") {
          const v = String(obj[k] ?? "").toLowerCase();
          if (v.includes("iiif")) return true;
        }
        if (lk === "protocol") {
          const v = String(obj[k] ?? "").toLowerCase();
          if (v.includes("iiif")) return true;
        }
        if (lk === "tiles" || lk === "tile" || lk === "profile" || lk === "@id" || lk === "@type") {
          seen.push(
            lk +
              ":" +
              String(obj[k] ?? "")
                .toLowerCase()
                .slice(0, 120),
          );
        } else if (seen.length < 200) {
          seen.push(lk);
        }
        if (stack.length < 200) stack.push(obj[k]);
      }
      // IIIF image-service shape: id + dimensions + tiles/profile.
      const hasId = "id" in obj || "@id" in obj;
      const hasDims = "width" in obj && "height" in obj;
      const hasTiles = "tiles" in obj || "tile" in obj || "profile" in obj;
      if (
        (hasId && hasDims && hasTiles) ||
        (hasDims && hasTiles && seen.join(" ").includes("iiif"))
      ) {
        return true;
      }
      // IIIF presentation shape: sequences/items with canvases.
      if ("sequences" in obj || "items" in obj || "manifest" in obj) {
        const blob = JSON.stringify(obj).toLowerCase().slice(0, 8192);
        if (blob.includes("iiif") || blob.includes("canvas") || blob.includes("sequences")) {
          // Require an iiif signal, not just any "items" array (PWA manifests
          // also have unrelated structures but never iiif/canvas).
          if (blob.includes("iiif") || (blob.includes("canvas") && blob.includes("@"))) {
            return true;
          }
        }
      }
    }
  }
  const joined = seen.join("\n");
  if (joined.includes("iiif.io/api/image")) return true;
  return false;
}

export function looksLikeZoomableXml(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length === 0) return false;
  // Require an XML-looking document, not just a stray word in HTML prose.
  const looksXml = lower.includes("<?xml") || lower.trimStart().startsWith("<");
  if (!looksXml) {
    // HTML pages embedding a viewer still count via the marker path below,
    // but plain prose mentioning "image" must not count.
    return false;
  }
  for (const m of XML_MARKERS) {
    if (lowerHas(lower, m)) {
      // DZI needs structural confirmation, not just "<image" (which every
      // SVG-bearing page contains). Require tilesize/overlap/format clues.
      if (m === "<image") {
        if (lower.includes("tilesize") || lower.includes("overlap") || lower.includes("dzi"))
          return true;
        continue;
      }
      return true;
    }
  }
  return false;
}

export function hasZoomableContentMarker(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower) return false;
  for (const m of STRONG_CONTENT_MARKERS) {
    if (lowerHas(lower, m)) {
      // Guard the two most generic markers against prose false positives:
      // "iiif" and "zoomify" must appear as viewer/config signals, not as a
      // passing mention. Practically every real embed pairs them with a
      // second signal (tiles, dzi, info.json, viewer, script, config).
      if (m === "iiif" || m === "zoomify") {
        const companion =
          lower.includes(".dzi") ||
          lower.includes("_files/") ||
          lower.includes("info.json") ||
          lower.includes("tiles") ||
          lower.includes("seadragon") ||
          lower.includes("openseadragon") ||
          lower.includes("viewer") ||
          lower.includes("manifest") ||
          lower.includes("imageproperties") ||
          lower.includes("tilegroup") ||
          lower.includes("krpano");
        if (!companion) continue;
      }
      if (m === "viewer") {
        // "viewer" alone is far too generic; only reachable via companions.
        continue;
      }
      return true;
    }
  }
  return false;
}

export function isZoomableContent(text: string): boolean {
  if (!text || text.length === 0) return false;
  if (looksLikeZoomableJson(text)) return true;
  if (looksLikeZoomableXml(text)) return true;
  if (hasZoomableContentMarker(text)) return true;
  return false;
}

// Rate-limit copy. The two cases are genuinely different and must never be
// blurred: an upstream 429 seen through the metadata proxy means OUR server's
// IP was throttled, so the fix is an app that fetches from the user's own IP.
// A direct 429 means the user's own connection was throttled, so waiting is
// the only fix. Keep both free of jargon (no "HTTP 429", "upstream", "proxy").
export const RATE_LIMITED_BY_SITE_MESSAGE =
  "The website hosting this image limits how many pages our server may request from it, and that limit was just reached, so the page could not be opened. " +
  "The browser extension and the desktop app download from your own internet connection instead of our server, so they are not affected by this limit: try one of them below, or try again later.";
export const SITE_BUSY_MESSAGE =
  "The website hosting this image is receiving too many requests right now. Wait a few minutes and try again.";

export function noImageFoundError(via?: string): DiscoveryStructuredError {
  return {
    code: "NO_IMAGE_FOUND",
    category: "discovery",
    retryable: false,
    // Pre-view hint surfaces (fetcher throw path, discovery hook) resolve
    // the headline through the shared failure table at render time; the
    // message here is the throw-time text only.
    message: "No zoomable image was found at this address.",
    transport: via ?? "direct",
    phase: "discovery",
  };
}

/**
 * Cheap UI hint over already-fetched readable bytes. Image binaries, empty
 * bodies, and generic HTML/text without any zoomable signal are negative.
 * Hint only: the website always forwards readable bytes to the WASM core
 * and lets the engine decide; a negative hint never fails the job (the
 * engine still reports NO_IMAGE_FOUND when no candidate accepts).
 */
export function classifyReadableBytes(
  bytes: unknown,
  opts?: { via?: string; contentType?: string },
): DiscoveryVerdict {
  const via = opts?.via ?? "direct";
  const contentType = (opts?.contentType ?? "").toLowerCase();
  if (contentType.startsWith("image/")) {
    return { found: false, via, error: noImageFoundError(via) };
  }
  const u8 = toUint8(bytes);
  if (!u8 || u8.length === 0) {
    return { found: false, via, error: noImageFoundError(via) };
  }
  // Cap the decode: markers always appear early in metadata/HTML.
  const text = bytesToTextPreview(u8, 256 * 1024);
  if (text.length === 0) {
    return { found: false, via, error: noImageFoundError(via) };
  }
  if (isZoomableContent(text)) {
    return { found: true, via };
  }
  return { found: false, via, error: noImageFoundError(via) };
}
