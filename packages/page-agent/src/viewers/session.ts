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
  | { ok: true; url: string }
  | { ok: false; error: JobError }
);
interface Session {
  lifetime: AbortController;
  load: (request: ViewerTileRequest, extent: Size) => Promise<ViewerTileResult>;
}

/** Keep viewer handles across scanner reinjection; only an explicit release or
 * document teardown retires them. */
function liveLoaders(): Map<string, Session> {
  const globals = globalThis as { __dezoomify_viewer_loaders__?: Map<string, Session> };
  globals.__dezoomify_viewer_loaders__ ??= new Map();
  return globals.__dezoomify_viewer_loaders__;
}
export type ViewerTile = { image: unknown; owned?: boolean } | { url: string };
export type ViewerLoader = (
  level: number,
  column: number,
  row: number,
  signal: AbortSignal,
) => Promise<ViewerTile>;

/** Retain each discovered loader behind a document-scoped handle. The host
 * receives only the handle, not the page's viewer objects or credentials.
 * Release invalidates in-flight results and asks cooperative loaders to stop. */
export function registerViewer(
  levels: ViewerLevel[],
  context: MetadataContext,
  loader: ViewerLoader,
): ViewerEvidence {
  const id = crypto.getRandomValues(new Uint32Array(4)).join("-");
  const lifetime = new AbortController();
  liveLoaders().set(id, { lifetime, load });
  const observation: ViewerObservation = {
    dezoomify_viewer: { source_url: context.documentUrl, handle: id, levels },
  };
  const contents = JSON.stringify(observation);
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
      if ("url" in result) {
        lifetime.signal.throwIfAborted();
        return { documentUrl, ok: true, url: result.url };
      }
      operation = "encoding";
      const blob = await imageBlob(result.image, extent, result.owned);
      lifetime.signal.throwIfAborted();
      return { documentUrl, ok: true, ...(await encodedTile(blob)) };
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

async function encodedTile(blob: Blob): Promise<{ bytes: number; data: string }> {
  if (blob.size > SOURCE_FETCH_BYTE_LIMIT) throw new SizeLimitError(SOURCE_FETCH_BYTE_LIMIT);
  return { bytes: blob.size, data: new Uint8Array(await blob.arrayBuffer()).toBase64() };
}

/** Injected directly into the main world. Keep this function self-contained:
 * the loader closure itself was already registered by the bundled scanner. */
export function readViewerTile(
  request: ViewerTileRequest,
  extent: Size,
): Promise<ViewerTileResult> | ViewerTileResult {
  const globals = globalThis as { __dezoomify_viewer_loaders__?: Map<string, Session> };
  const session = globals.__dezoomify_viewer_loaders__?.get(request.handle);
  return session
    ? session.load(request, extent)
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

/** Injected directly into the main world; unknown handles are safe to release. */
export function releaseViewerTiles(handles: string[]): void {
  const globals = globalThis as { __dezoomify_viewer_loaders__?: Map<string, Session> };
  const sessions = globals.__dezoomify_viewer_loaders__;
  if (!sessions) return;
  for (const handle of handles) {
    const session = sessions.get(handle);
    if (!session) continue;
    sessions.delete(handle);
    session.lifetime.abort();
  }
}
