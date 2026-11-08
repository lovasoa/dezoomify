import {
  CancelledError,
  InternalError,
  InvalidInputError,
  isJobError,
  PolicyDeniedError,
  SizeLimitError,
  SOURCE_FETCH_BYTE_LIMIT,
  unknownDetail,
} from "@dezoomify/browser-runtime";
import type {
  Size,
  ViewerLevel,
  ViewerObservation,
  ViewerTileRequest,
} from "@dezoomify/wasm-bindings";
import type { ViewerTileResult } from "../messages.ts";
import { imageBlob } from "./tile-image.ts";
import type { MetadataContext, ViewerEvidence } from "./types.ts";

export type ViewerTile = { image: unknown; owned?: boolean } | { url: string };
export type ViewerLoader = (
  level: number,
  column: number,
  row: number,
  signal: AbortSignal,
) => Promise<ViewerTile>;

interface Session {
  loader: ViewerLoader;
  lifetime: AbortController;
  sourceUrl: string;
}

/** This document's live viewer loaders, keyed by the opaque handle each one
 * reported in its observation.
 *
 * The map belongs on the global object rather than in module scope because hosts
 * inject the agent bundle more than once per document, once per job. A
 * module-level map would be rebuilt empty by the second injection and strand
 * every handle the first one registered. */
const loaders: Map<string, Session> = liveLoaders();

function liveLoaders(): Map<string, Session> {
  const globals = globalThis as { __dezoomify_viewer_loaders__?: Map<string, Session> };
  globals.__dezoomify_viewer_loaders__ ??= new Map();
  return globals.__dezoomify_viewer_loaders__;
}

/** Register one identified viewer source and return the observation that
 * describes it. The handle stays valid until `releaseViewerTiles` retires it or
 * the document goes away; only the core computes tile positions and crops, so
 * the loader receives its native level and grid coordinates.
 *
 * A live session is the fallback for a source with no detachable metadata. The
 * collector owns deduplication and releases the handle of a source it drops. */
export function registerViewer(
  levels: ViewerLevel[],
  context: MetadataContext,
  loader: ViewerLoader,
): ViewerEvidence {
  const handle = crypto.getRandomValues(new Uint32Array(4)).join("-");
  loaders.set(handle, { loader, lifetime: new AbortController(), sourceUrl: context.documentUrl });
  const observation: ViewerObservation = {
    dezoomify_viewer: { source_url: context.documentUrl, handle, levels },
  };
  const identity = new URL(context.documentUrl);
  identity.hash = `dezoomify-observation-${handle}`;
  return {
    handle,
    input: { kind: "observed-viewer", url: identity.href, contents: JSON.stringify(observation) },
  };
}

/** Load one tile through the viewer that registered `request.handle`, returning
 * either an ordinary image URL to fetch or owned encoded pixels.
 *
 * Throws instead of returning a failure: the reply envelope is built once at the
 * agent boundary. Retiring a handle aborts its loader and invalidates its
 * in-flight results, and cancellation here never stops a load the host is still
 * waiting on through another handle. */
export async function readViewerTile(
  request: ViewerTileRequest,
  extent: Size,
): Promise<ViewerTileResult> {
  // A handle the page no longer knows means the source went away; a handle the
  // page knows under another document means this request reached the wrong one.
  const session = loaders.get(request.handle);
  if (!session)
    throw new PolicyDeniedError({
      blocked_reason: "source-document-lost",
      transport: "browser-session",
    });
  if (session.sourceUrl !== request.source_url)
    throw new InvalidInputError("Viewer tile belongs to a different source document");
  let operation = "loading";
  try {
    session.lifetime.signal.throwIfAborted();
    const result = await session.loader(
      request.level,
      request.column,
      request.row,
      session.lifetime.signal,
    );
    if ("url" in result) {
      session.lifetime.signal.throwIfAborted();
      return { url: result.url };
    }
    operation = "encoding";
    const blob = await imageBlob(result.image, extent, result.owned);
    session.lifetime.signal.throwIfAborted();
    return await encodedTile(blob);
  } catch (cause) {
    throw session.lifetime.signal.aborted
      ? new CancelledError()
      : isJobError(cause)
        ? cause
        : new InternalError(
            `Unexpected exception while ${operation} viewer tile (level ${request.level}, column ${request.column}, row ${request.row}): ${unknownDetail(cause)}`,
            { cause },
          );
  }
}

/** Retire handles and stop their outstanding loads. Idempotent; unknown handles
 * are ignored so a host can retire a set it only partly still believes in. */
export function releaseViewerTiles(handles: string[]): void {
  for (const handle of handles) {
    const session = loaders.get(handle);
    if (!session) continue;
    loaders.delete(handle);
    session.lifetime.abort();
  }
}

async function encodedTile(blob: Blob): Promise<ViewerTileResult> {
  if (blob.size > SOURCE_FETCH_BYTE_LIMIT) throw new SizeLimitError(SOURCE_FETCH_BYTE_LIMIT);
  return { bytes: blob.size, data: new Uint8Array(await blob.arrayBuffer()).toBase64() };
}
