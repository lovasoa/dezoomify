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

/** Read only JSON string payloads from the DOM's untrusted event surface. */
function eventPayload(event: Event): Record<string, unknown> | undefined {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(detail);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One job-scoped listener owns the captured viewer loaders. The isolated
 * extension world communicates through the shared DOM, using string payloads
 * so Firefox never needs to expose objects across script worlds. */
export function listenViewerChannel(channelId: string, handles: string[]): void {
  const owned = new Set(handles);
  const requestEvent = `dezoomify-viewer:${channelId}:request`;
  const responseEvent = `dezoomify-viewer:${channelId}:response`;
  let closed = false;

  const reply = (id: number, result: unknown) => {
    if (!closed)
      document.dispatchEvent(
        new CustomEvent(responseEvent, { detail: JSON.stringify({ id, result }) }),
      );
  };
  const isTileCall = (message: Record<string, unknown>) =>
    message.type === "read-tile" &&
    typeof message.id === "number" &&
    Number.isSafeInteger(message.id) &&
    message.request !== null &&
    typeof message.request === "object" &&
    owned.has((message.request as ViewerTileRequest).handle);

  const onRequest = (event: Event) => {
    const message = eventPayload(event);
    if (!message) return;
    if (
      message.type === "ping" &&
      typeof message.id === "number" &&
      Number.isSafeInteger(message.id)
    ) {
      reply(message.id, { ok: true, documentUrl: location.href });
      return;
    }
    if (message.type === "close") {
      releaseViewerTiles(handles);
      reply(Number.isSafeInteger(message.id) ? (message.id as number) : 0, {
        ok: true,
        documentUrl: location.href,
      });
      closed = true;
      document.removeEventListener(requestEvent, onRequest);
      return;
    }
    if (!isTileCall(message)) return;
    const id = message.id as number;
    void Promise.resolve()
      .then(() => readViewerTile(message.request as ViewerTileRequest, message.extent as Size))
      .catch(
        (cause: unknown): ViewerTileResult => ({
          documentUrl: location.href,
          ok: false,
          error: errorPayload(
            isJobError(cause)
              ? cause
              : new InternalError(`Invalid viewer request: ${unknownDetail(cause)}`),
          ),
        }),
      )
      .then((result) => reply(id, result));
  };
  document.addEventListener(requestEvent, onRequest);
}
