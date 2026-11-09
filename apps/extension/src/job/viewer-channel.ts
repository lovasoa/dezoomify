import { PolicyDeniedError } from "@dezoomify/browser-runtime";
import type { Size, ViewerTileRequest } from "@dezoomify/wasm-bindings";
import type { WxtBrowser } from "wxt/browser";

type ExtensionPort = ReturnType<WxtBrowser["tabs"]["connect"]>;

/** Injected once into the isolated world of a scanned frame. It hands the
 * page's MAIN world one MessagePort and forwards messages unchanged between
 * that port and the extension's own Port; endpoints validate their own data. */
export function installViewerBridge(channelId: string): { documentUrl: string } {
  type BridgePort = {
    name: string;
    postMessage(message: unknown): void;
    onMessage: { addListener(fn: (message: unknown) => void): void };
    onDisconnect: { addListener(fn: () => void): void };
  };
  type Runtime = {
    onConnect: {
      addListener(fn: (port: BridgePort) => void): void;
      removeListener(fn: (port: BridgePort) => void): void;
    };
  };
  type Globals = { chrome?: { runtime?: Runtime }; browser?: { runtime?: Runtime } };
  const globals = globalThis as unknown as Globals;
  const runtime = globals.browser?.runtime ?? globals.chrome?.runtime;
  if (!runtime) throw new Error("Extension runtime is unavailable in the source frame");

  const onConnect = (port: BridgePort) => {
    if (port.name !== `dezoomify-viewer:${channelId}`) return;
    runtime.onConnect.removeListener(onConnect);
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => port.postMessage(event.data);
    port.onMessage.addListener((message: unknown) => channel.port1.postMessage(message));
    port.onDisconnect.addListener(() => {
      channel.port1.postMessage({ type: "close" });
      channel.port1.close();
    });
    window.postMessage(channelId, location.origin, [channel.port2]);
  };
  runtime.onConnect.addListener(onConnect);
  return { documentUrl: location.href };
}

/** Own the extension end of one viewer channel bound to an exact document.
 * Replies are untrusted page data; source-access validates every payload and
 * bounds each call's deadline. Disconnect retires the page's scan. */
export function createViewerChannel(port: ExtensionPort, documentUrl: string) {
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  let nextId = 0;
  let closed = false;
  let readyResolve: (value: unknown) => void = () => {};
  let readyReject: (error: unknown) => void = () => {};
  const readyPromise = new Promise<unknown>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // A disconnection after successful setup may occur when nobody is waiting.
  void readyPromise.catch(() => {});

  const lost = () =>
    new PolicyDeniedError({
      blocked_reason: "source-document-lost",
      transport: "browser-session",
    });
  const onMessage = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (message.type === "ready") {
      readyResolve(message);
      return;
    }
    if (message.type !== "result" || typeof message.id !== "number") return;
    pending.get(message.id)?.resolve(message.result);
  };
  const fail = (reason: unknown) => {
    if (closed) return;
    closed = true;
    readyReject(reason);
    for (const call of pending.values()) call.reject(reason);
    pending.clear();
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
  };
  const onDisconnect = () => fail(lost());
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);

  function readTile(
    request: ViewerTileRequest,
    extent: Size,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (closed) return Promise.reject(lost());
    signal.throwIfAborted();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const settle = (callback: (value: unknown) => void, value: unknown) => {
        pending.delete(id);
        signal.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => settle(reject, signal.reason);
      pending.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        port.postMessage({ type: "read-tile", id, request, extent });
      } catch {
        settle(reject, lost());
      }
    });
  }

  return {
    documentUrl,

    /** The page listener's readiness reply. Callers bound their own wait. */
    ready: readyPromise,

    readTile,

    dispose(): void {
      fail(lost());
      try {
        port.disconnect();
      } catch {
        // A navigated frame already closed this channel.
      }
    },
  };
}
