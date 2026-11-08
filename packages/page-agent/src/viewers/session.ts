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

/** Loader closures belong to this scanner injection, not to the page's global
 * object. A job-scoped message listener below is the only way back in. */
const loaders = new Map<string, Session>();
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
  loaders.set(id, { lifetime, load });
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

/** Direct helpers for page-side tests and the message listener.
 * They never cross an extension execution boundary themselves. */
export function readViewerTile(
  request: ViewerTileRequest,
  extent: Size,
): Promise<ViewerTileResult> | ViewerTileResult {
  const session = loaders.get(request.handle);
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

/** Retire a scan's handles, aborting only that scan's outstanding loader work. */
export function releaseViewerTiles(handles: string[]): void {
  for (const handle of handles) {
    const session = loaders.get(handle);
    if (!session) continue;
    loaders.delete(handle);
    session.lifetime.abort();
  }
}

/** Keep this scan's loaders available to the isolated content-script bridge.
 * The random channel ID makes a later scan independent of earlier listeners.
 * No page global or permanent agent is installed. */
export function listenViewerChannel(channelId: string, handles: string[]): void {
  const owned = new Set(handles);
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    const message = event.data;
    if (
      !message ||
      message.type !== "dezoomify-viewer-request" ||
      message.channelId !== channelId
    )
      return;
    if (message.method === "close") {
      window.removeEventListener("message", onMessage);
      releaseViewerTiles(handles);
      if (Number.isSafeInteger(message.id))
        window.postMessage(
          {
            type: "dezoomify-viewer-response",
            channelId,
            id: message.id,
            result: { documentUrl: location.href, ok: true },
          },
          location.origin,
        );
      return;
    }
    if (
      message.method !== "read-tile" ||
      !Number.isSafeInteger(message.id) ||
      !message.request ||
      !owned.has(message.request.handle)
    )
      return;
    void Promise.resolve()
      .then(() => readViewerTile(message.request, message.extent))
      .catch((cause: unknown): ViewerTileResult => ({
        documentUrl: location.href,
        ok: false,
        error: errorPayload(
          isJobError(cause) ? cause : new InternalError(`Invalid viewer request: ${unknownDetail(cause)}`),
        ),
      }))
      .then((result) => {
        window.postMessage(
          { type: "dezoomify-viewer-response", channelId, id: message.id, result },
          location.origin,
        );
      });
  };
  window.addEventListener("message", onMessage);
}
