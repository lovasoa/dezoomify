import { PolicyDeniedError } from "@dezoomify/browser-runtime";
import type { Size, ViewerTileRequest } from "@dezoomify/wasm-bindings";
import type { WxtBrowser } from "wxt/browser";

type ExtensionPort = ReturnType<WxtBrowser["tabs"]["connect"]>;

/** Injected once into the isolated world of a scanned frame. The Port talks
 * to the extension; paired DOM events talk to the page's MAIN world. */
export function installViewerBridge(channelId: string): { documentUrl: string } {
  type BridgePort = {
    name: string;
    postMessage(message: unknown): void;
    disconnect(): void;
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

  const requestEvent = `dezoomify-viewer:${channelId}:request`;
  const responseEvent = `dezoomify-viewer:${channelId}:response`;
  const dispatch = (message: unknown) =>
    document.dispatchEvent(new CustomEvent(requestEvent, { detail: JSON.stringify(message) }));
  const eventPayload = (event: Event): Record<string, unknown> | undefined => {
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
  };

  const onConnect = (port: BridgePort) => {
    if (port.name !== `dezoomify-viewer:${channelId}`) return;
    runtime.onConnect.removeListener(onConnect);
    const pending = new Set<number>();
    let ready = false;

    const onReady = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const result = value as Record<string, unknown>;
      if (result.ok !== true || typeof result.documentUrl !== "string") return;
      ready = true;
      port.postMessage({ type: "ready", documentUrl: result.documentUrl });
    };
    const onResponse = (event: Event) => {
      const response = eventPayload(event);
      if (!response) return;
      if (response.id === 0) {
        onReady(response.result);
        return;
      }
      const id = response.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || !pending.delete(id)) return;
      port.postMessage({ type: "result", id, result: response.result });
    };

    port.onMessage.addListener((value: unknown) => {
      if (!ready || !value || typeof value !== "object") return;
      const message = value as Record<string, unknown>;
      if (
        (message.type !== "read-tile" && message.type !== "ping") ||
        typeof message.id !== "number" ||
        !Number.isSafeInteger(message.id) ||
        message.id < 1 ||
        pending.has(message.id)
      )
        return;
      pending.add(message.id);
      dispatch(value);
    });
    port.onDisconnect.addListener(() => {
      pending.clear();
      document.removeEventListener(responseEvent, onResponse);
      dispatch({ type: "close" });
    });
    document.addEventListener(responseEvent, onResponse);
    dispatch({ type: "ping", id: 0 });
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

  /** A single pending-call path covers readiness and tile acquisition. */
  function send(
    command: { type: "ping" } | { type: "read-tile"; request: ViewerTileRequest; extent: Size },
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
        port.postMessage({ ...command, id });
      } catch {
        settle(reject, lost());
      }
    });
  }

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

    ping(signal: AbortSignal): Promise<unknown> {
      return send({ type: "ping" }, signal);
    },

    readTile(request: ViewerTileRequest, extent: Size, signal: AbortSignal): Promise<unknown> {
      return send({ type: "read-tile", request, extent }, signal);
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
