import { errorPayload, InternalError, isJobError, unknownDetail } from "@dezoomify/browser-runtime";
import type { ViewerTileResult } from "@dezoomify/page-agent";
import type { Size, ViewerTileRequest } from "@dezoomify/wasm-bindings";

type ViewerTileReader = (
  request: ViewerTileRequest,
  extent: Size,
) => Promise<ViewerTileResult> | ViewerTileResult;

/** How long a scanned session waits for its channel before retiring itself. */
const CLAIM_TIMEOUT_MS = 30_000;

/** Own one job-scoped page listener for a scan's captured viewer loaders.
 * Runs in the scanned page's main world and must be attached in the same
 * injection that ran the scan, with the same handles, so requests route to
 * their own channel and repeated or concurrent scans can never answer for
 * each other's viewers. The isolated bridge hands over a MessagePort through
 * one window message; tile bytes then cross worlds as transferred
 * ArrayBuffers. A session that no bridge claims retires itself, and closing
 * the port releases the scan's handles. */
export function attachViewerTransport(
  channelId: string,
  viewer: { handles: string[]; read: ViewerTileReader; dispose: () => void },
): void {
  const owned = new Set(viewer.handles);
  let port: MessagePort | undefined;
  let closed = false;
  const claim = setTimeout(close, CLAIM_TIMEOUT_MS);

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(claim);
    window.removeEventListener("message", onHandoff);
    port?.close();
    viewer.dispose();
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
      viewer.dispose();
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
      .then(() => viewer.read(request, message.extent as Size))
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
