import { isJobError, SOURCE_FETCH_BYTE_LIMIT, unknownDetail } from "@dezoomify/browser-runtime";
import type { ViewerLevel, ViewerObservation } from "@dezoomify/wasm-bindings";
import { transportError } from "../../runtime/fetch.ts";
import type { fetchSource } from "../source-operations.ts";
import { imageBlob } from "./tile-image.ts";
import type { MetadataContext, ViewerEvidence } from "./types.ts";

type TileRequest = { url: string; result?: ReturnType<typeof fetchSource> };
export interface ViewerTile {
  image: unknown;
  owned?: boolean;
}
export type ViewerLoader = (
  level: number,
  column: number,
  row: number,
  signal: AbortSignal,
) => Promise<ViewerTile>;

/** Addresses name capabilities owned by one source document, never HTTP fallbacks. */
export function isViewerTile(url: string): boolean {
  return url.includes("#dezoomify-viewer-tile/");
}

export function tileResourceBase(url: string): string | undefined {
  return /^(.*#dezoomify-viewer-tile\/[\w-]+\/image)\/\d+\/\d+\/\d+\/\d+\/\d+\.png$/.exec(url)?.[1];
}

/** Retain the loader in the page until release. Only the core computes tile
 * positions/crops; the adapter receives its native level and grid coordinates.
 * Release invalidates in-flight results and asks cooperative loaders to stop. */
export function registerViewer(
  levels: ViewerLevel[],
  context: MetadataContext,
  loader: ViewerLoader,
): ViewerEvidence {
  const identity = new URL(context.documentUrl);
  identity.hash = `dezoomify-viewer-tile/${crypto.getRandomValues(new Uint32Array(4)).join("-")}/image`;
  const base = identity.href;
  const lifetime = new AbortController();
  const handle = (event: Event) => {
    const request = (event as CustomEvent<TileRequest>).detail;
    if (request) request.result = load(request.url);
    else {
      lifetime.abort();
      document.removeEventListener(base, handle);
    }
  };
  const observation: ViewerObservation = {
    dezoomify_viewer: { source_url: context.documentUrl, resource_base: base, levels },
  };
  const contents = JSON.stringify(observation);
  document.addEventListener(base, handle);
  return {
    resource: base,
    input: {
      kind: "observed-metadata",
      url: `${base}/metadata`,
      contents,
    },
  };

  async function load(url: string): ReturnType<typeof fetchSource> {
    const documentUrl = location.href;
    try {
      if (tileResourceBase(url) !== base)
        throw { kind: "bad-url", detail: "invalid viewer tile address" };
      const [level, column, row, width, height] = url
        .slice(base.length + 1, -4)
        .split("/")
        .map(Number);
      lifetime.signal.throwIfAborted();
      const result = await loader(level, column, row, lifetime.signal);
      const blob = await imageBlob(result.image, { width, height }, result.owned);
      lifetime.signal.throwIfAborted();
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
      const error = lifetime.signal.aborted
        ? { kind: "cancelled" as const }
        : isJobError(cause)
          ? cause
          : transportError("network-failure", unknownDetail(cause).slice(0, 4096));
      return { documentUrl, ok: false, error };
    }
  }
}

/** Serialized into the main world: no runtime imports or external closures. */
export function readViewerTile(url: string, base: string) {
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

export function releaseViewerTiles(bases: string[]) {
  for (const base of bases) document.dispatchEvent(new Event(base));
}
