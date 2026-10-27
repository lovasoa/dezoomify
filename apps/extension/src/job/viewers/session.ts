import {
  CancelledError,
  errorPayload,
  InternalError,
  InvalidInputError,
  isJobError,
  SizeLimitError,
  SOURCE_FETCH_BYTE_LIMIT,
  unknownDetail,
} from "@dezoomify/browser-runtime";
import type {
  Error as JobError,
  Size,
  ViewerLevel,
  ViewerObservation,
  ViewerTileRequest,
} from "@dezoomify/wasm-bindings";
import { imageBlob } from "./tile-image.ts";
import type { MetadataContext, ViewerEvidence } from "./types.ts";

export type ViewerTileResult = { documentUrl: string } & (
  | { ok: true; bytes: number; data: string }
  | { ok: false; error: JobError }
);
type TileCall = { request: ViewerTileRequest; extent: Size; result?: Promise<ViewerTileResult> };
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

/** Retain the loader in the page until release. Only the core computes tile
 * positions/crops; the adapter receives its native level and grid coordinates.
 * Release invalidates in-flight results and asks cooperative loaders to stop. */
export function registerViewer(
  levels: ViewerLevel[],
  context: MetadataContext,
  loader: ViewerLoader,
): ViewerEvidence {
  const id = crypto.getRandomValues(new Uint32Array(4)).join("-");
  const eventName = `dezoomify-viewer:${id}`;
  const lifetime = new AbortController();
  const handle = (event: Event) => {
    const call = (event as CustomEvent<TileCall>).detail;
    if (call) call.result = load(call.request, call.extent);
    else {
      lifetime.abort();
      document.removeEventListener(eventName, handle);
    }
  };
  const observation: ViewerObservation = {
    dezoomify_viewer: { source_url: context.documentUrl, handle: id, levels },
  };
  const contents = JSON.stringify(observation);
  document.addEventListener(eventName, handle);
  const identity = new URL(context.documentUrl);
  identity.hash = `dezoomify-observation-${id}`;
  return {
    handle: id,
    input: {
      kind: "observed-viewer",
      url: identity.href,
      contents,
    },
  };

  async function load(request: ViewerTileRequest, extent: Size): Promise<ViewerTileResult> {
    const documentUrl = location.href;
    let operation = "loading";
    try {
      if (request.handle !== id || request.source_url !== context.documentUrl)
        throw new InvalidInputError("Viewer tile belongs to a different source document");
      lifetime.signal.throwIfAborted();
      const result = await loader(request.level, request.column, request.row, lifetime.signal);
      operation = "encoding";
      const blob = await imageBlob(result.image, extent, result.owned);
      lifetime.signal.throwIfAborted();
      if (blob.size > SOURCE_FETCH_BYTE_LIMIT) throw new SizeLimitError(SOURCE_FETCH_BYTE_LIMIT);
      return {
        documentUrl,
        ok: true,
        bytes: blob.size,
        data: new Uint8Array(await blob.arrayBuffer()).toBase64(),
      };
    } catch (cause) {
      const error = lifetime.signal.aborted
        ? new CancelledError()
        : isJobError(cause)
          ? cause
          : new InternalError(
              `Unexpected exception while ${operation} viewer tile (level ${request.level}, column ${request.column}, row ${request.row}): ${unknownDetail(cause)}`,
              { cause },
            );
      return { documentUrl, ok: false, error: errorPayload(error) };
    }
  }
}

/** Serialized into the main world: no runtime imports or external closures. */
export function readViewerTile(
  request: ViewerTileRequest,
  extent: Size,
): Promise<ViewerTileResult> | ViewerTileResult {
  const call: TileCall = { request, extent };
  document.dispatchEvent(new CustomEvent(`dezoomify-viewer:${request.handle}`, { detail: call }));
  return (
    call.result ?? {
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

export function releaseViewerTiles(handles: string[]) {
  for (const handle of handles) document.dispatchEvent(new Event(`dezoomify-viewer:${handle}`));
}
