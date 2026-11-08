import {
  CancelledError,
  errorPayload,
  InternalError,
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

export type ViewerTileResult =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: true; url: string }
  | { ok: false; error: JobError };
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
    let operation = "loading";
    try {
      lifetime.signal.throwIfAborted();
      const result = await loader(request.level, request.column, request.row, lifetime.signal);
      if ("url" in result) {
        lifetime.signal.throwIfAborted();
        return { ok: true, url: result.url };
      }
      operation = "encoding";
      const blob = await imageBlob(result.image, extent, result.owned);
      lifetime.signal.throwIfAborted();
      if (blob.size > SOURCE_FETCH_BYTE_LIMIT) throw new SizeLimitError(SOURCE_FETCH_BYTE_LIMIT);
      return { ok: true, buffer: await blob.arrayBuffer() };
    } catch (cause) {
      const error = lifetime.signal.aborted
        ? new CancelledError()
        : isJobError(cause)
          ? cause
          : new InternalError(
              `Unexpected exception while ${operation} viewer tile (level ${request.level}, column ${request.column}, row ${request.row}): ${unknownDetail(cause)}`,
              { cause },
            );
      return { ok: false, error: errorPayload(error) };
    }
  }
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

/** How long a scanned session waits for its channel before retiring itself. */
const CLAIM_TIMEOUT_MS = 30_000;

/** One job-scoped listener owns the captured viewer loaders. The isolated
 * bridge hands over a MessagePort through one window message; tile bytes then
 * cross worlds as transferred ArrayBuffers. A session that no bridge claims
 * retires itself, and closing the port releases the scan's handles. */
export function listenViewerChannel(channelId: string, handles: string[]): void {
  const owned = new Set(handles);
  let port: MessagePort | undefined;
  let closed = false;
  const claim = setTimeout(close, CLAIM_TIMEOUT_MS);

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(claim);
    window.removeEventListener("message", onHandoff);
    port?.close();
    releaseViewerTiles(handles);
  }

  const onHandoff = (event: MessageEvent) => {
    // An isolated extension world can deliver the handoff with a null source.
    if (event.source !== window && event.source !== null) return;
    const handed = event.ports[0];
    if (event.data !== channelId || !handed) return;
    window.removeEventListener("message", onHandoff);
    clearTimeout(claim);
    port = handed;
    port.onmessage = onMessage;
    port.postMessage({ type: "ready", documentUrl: location.href });
  };

  const onMessage = (event: MessageEvent) => {
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== "object") return;
    if (message.type === "close") {
      const id = Number.isSafeInteger(message.id) ? (message.id as number) : 0;
      releaseViewerTiles(handles);
      port?.postMessage({ type: "result", id, result: { ok: true } });
      close();
      return;
    }
    const request = message.request as ViewerTileRequest | null;
    if (
      message.type !== "read-tile" ||
      !Number.isSafeInteger(message.id) ||
      !request ||
      typeof request !== "object" ||
      !owned.has(request.handle)
    )
      return;
    void Promise.resolve()
      .then(() => readViewerTile(request, message.extent as Size))
      .catch(
        (cause: unknown): ViewerTileResult => ({
          ok: false,
          error: errorPayload(
            isJobError(cause)
              ? cause
              : new InternalError(`Invalid viewer request: ${unknownDetail(cause)}`),
          ),
        }),
      )
      .then((result) => {
        if (closed) return;
        const transfer = result.ok && "buffer" in result ? [result.buffer] : [];
        port?.postMessage({ type: "result", id: message.id, result }, transfer);
      });
  };

  window.addEventListener("message", onHandoff);
}
