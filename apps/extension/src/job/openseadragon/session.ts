import { isJobError, SOURCE_FETCH_BYTE_LIMIT, unknownDetail } from "@dezoomify/browser-runtime";
import { transportError } from "../../runtime/fetch.ts";
import type { fetchSource } from "../source-operations.ts";
import { projectMetadata } from "./metadata.ts";
import { readLivePyramid, tileCoordinates } from "./pyramid.ts";
import { loadOpenSeadragonTile } from "./tile-loader.ts";
import type { MetadataContext } from "./types.ts";

type LoadTile = (url: string) => ReturnType<typeof fetchSource>;
type Page = typeof globalThis & { __dezoomifyOpenSeadragon?: Map<string, LoadTile> };

/** These fragments name live page capabilities, never HTTP resources. */
export function isOpenSeadragonTile(url: string): boolean {
  return url.includes("#dezoomify-openseadragon-tile/");
}

export function tileResourceBase(url: string): string | undefined {
  return /^(.*#dezoomify-openseadragon-tile\/[\w-]+\/image)\/\d+\/\d+_\d+\.png$/.exec(url)?.[1];
}

/** The scanner retains live objects in the page; only metadata crosses to Rust.
 * Synthetic DZI requests come back through source-access's existing bounded RPC.
 * Each registered function returns the same validated payload as an HTTP source fetch.
 */
export function createTileSession() {
  const page = globalThis as Page;
  page.__dezoomifyOpenSeadragon ??= new Map();
  const sources = page.__dezoomifyOpenSeadragon;
  return (source: object, item: object, context: MetadataContext) => {
    const identity = new URL(context.documentUrl);
    identity.hash = `dezoomify-openseadragon-tile/${crypto.getRandomValues(new Uint32Array(4)).join("-")}/image`;
    const base = identity.href;
    const shape = readLivePyramid(source, base);
    sources.set(base, async (url) => {
      const documentUrl = location.href;
      try {
        const blob = await loadOpenSeadragonTile(source, item, ...tileCoordinates(url, shape));
        if (blob.size > SOURCE_FETCH_BYTE_LIMIT)
          throw { kind: "size-limit", max_bytes: SOURCE_FETCH_BYTE_LIMIT };
        return {
          documentUrl,
          ok: true,
          status: 200,
          url,
          bytes: blob.size,
          data: new Uint8Array(await blob.arrayBuffer()).toBase64(),
          contentType: blob.type,
        };
      } catch (cause) {
        const error = isJobError(cause)
          ? cause
          : transportError("network-failure", unknownDetail(cause).slice(0, 4096));
        return { documentUrl, ok: false, error };
      }
    });
    return projectMetadata(shape, context);
  };
}

/** Serialized into the main world, so these entry points have no runtime dependencies. */
export function readOpenSeadragonTile(url: string, base: string) {
  const load = (globalThis as Page).__dezoomifyOpenSeadragon?.get(base);
  return load
    ? load(url)
    : {
        documentUrl: location.href,
        ok: false,
        error: {
          kind: "policy-denied",
          blocked_reason: "source-document-lost",
          transport: "browser-session",
        },
      };
}

export function releaseOpenSeadragonTiles(bases: string[]) {
  for (const base of bases) (globalThis as Page).__dezoomifyOpenSeadragon?.delete(base);
}
