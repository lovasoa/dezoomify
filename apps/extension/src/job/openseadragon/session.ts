import { isJobError, SOURCE_FETCH_BYTE_LIMIT, unknownDetail } from "@dezoomify/browser-runtime";
import { transportError } from "../../runtime/fetch.ts";
import type { fetchSource } from "../source-operations.ts";
import { projectMetadata } from "./metadata.ts";
import { readLivePyramid, tileCoordinates } from "./pyramid.ts";
import { loadOpenSeadragonTile } from "./tile-loader.ts";
import type { MetadataContext } from "./types.ts";

type TileRequest = { url: string; result?: ReturnType<typeof fetchSource> };

/** These fragments name live page capabilities, never HTTP resources. */
export function isOpenSeadragonTile(url: string): boolean {
  return url.includes("#dezoomify-openseadragon-tile/");
}

export function tileResourceBase(url: string): string | undefined {
  return /^(.*#dezoomify-openseadragon-tile\/[\w-]+\/image)\/\d+\/\d+_\d+\.png$/.exec(url)?.[1];
}

/** Keep live objects in a closure, reached by a unique event type per image.
 * Requests carry their result promise; an event without detail removes the listener.
 * No page globals or viewer properties are installed.
 * Source-access owns the bounded RPC and validates the ordinary source-fetch payload.
 */
export function registerTileSource(source: object, item: object, context: MetadataContext) {
  const identity = new URL(context.documentUrl);
  identity.hash = `dezoomify-openseadragon-tile/${crypto.getRandomValues(new Uint32Array(4)).join("-")}/image`;
  const base = identity.href;
  const shape = readLivePyramid(source, base);
  const handle = (event: Event) => {
    const request = (event as CustomEvent<TileRequest>).detail;
    if (request) request.result = load(request.url);
    else document.removeEventListener(base, handle);
  };
  document.addEventListener(base, handle);
  return projectMetadata(shape, context);

  async function load(url: string): ReturnType<typeof fetchSource> {
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
  }
}

/** Serialized into the main world, so these entry points have no runtime dependencies. */
export function readOpenSeadragonTile(url: string, base: string) {
  const request: TileRequest = { url };
  document.dispatchEvent(new CustomEvent(base, { detail: request }));
  return (
    request.result ?? {
      documentUrl: location.href,
      ok: false,
      error: {
        kind: "policy-denied",
        blocked_reason: "source-document-lost",
        transport: "browser-session",
      },
    }
  );
}

export function releaseOpenSeadragonTiles(bases: string[]) {
  for (const base of bases) document.dispatchEvent(new Event(base));
}
