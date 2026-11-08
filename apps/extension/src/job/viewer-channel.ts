import { PolicyDeniedError } from "@dezoomify/browser-runtime";
import type { Size, ViewerTileRequest } from "@dezoomify/wasm-bindings";
import type { WxtBrowser } from "wxt/browser";

type ExtensionPort = ReturnType<WxtBrowser["tabs"]["connect"]>;

/** Installed once per scanned frame, in the extension's ISOLATED world.
 * This function is self-contained because executeScript serializes its body.
 * The page never receives a Port or any extension APIs. */
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
    const pending = new Set<number>();
    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (
        data?.type !== "dezoomify-viewer-response" ||
        data.channelId !== channelId ||
        !Number.isSafeInteger(data.id) ||
        !pending.delete(data.id)
      )
        return;
      port.postMessage({ type: "result", id: data.id, result: data.result });
    };
    port.onMessage.addListener((value: unknown) => {
      if (!value || typeof value !== "object") return;
      const message = value as Record<string, unknown>;
      if (
        message.type !== "read-tile" ||
        typeof message.id !== "number" ||
        !Number.isSafeInteger(message.id) ||
        message.id < 1 ||
        pending.has(message.id)
      )
        return;
      pending.add(message.id);
      window.postMessage(
        {
          type: "dezoomify-viewer-request",
          channelId,
          method: "read-tile",
          id: message.id,
          request: message.request,
          extent: message.extent,
        },
        location.origin,
      );
    });
    port.onDisconnect.addListener(() => {
      pending.clear();
      window.removeEventListener("message", onWindowMessage);
      window.postMessage(
        { type: "dezoomify-viewer-request", channelId, method: "close" },
        location.origin,
      );
    });
    window.addEventListener("message", onWindowMessage);
    port.postMessage({ type: "ready", documentUrl: location.href });
  };
  runtime.onConnect.addListener(onConnect);
  return { documentUrl: location.href };
}

/** Own the extension end of a job-scoped Port. The browser targets a specific
 * frame; the page reply is still untrusted and validated by source-access. */
export function createViewerChannel(port: ExtensionPort) {
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

  return {
    async ready(signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        readyPromise.then(
          (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
    },

    readTile(request: ViewerTileRequest, extent: Size, signal: AbortSignal): Promise<unknown> {
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
    },

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
