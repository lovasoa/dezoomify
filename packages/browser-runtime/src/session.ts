// Session coordinator with worker-client stub (no real Worker in unit tests).
export interface WorkerClientStub {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
  postedCount?: number;
}

export interface SessionEvent {
  seq: number;
  kind: string;
  [key: string]: unknown;
}

export interface SessionOptions {
  maxPendingBytes?: number;
  workerClient?: WorkerClientStub;
  onEvent?: (ev: SessionEvent) => void;
}

export interface BrowserSessionHandle {
  readonly seq: number;
  readonly pendingBytes: number;
  readonly backpressure: boolean;
  readonly cancelled: boolean;
  readonly disposed: boolean;
  readonly completed: boolean;
  postBuffer(buffer: ArrayBuffer): { transferred: boolean; backpressure: boolean };
  handleWorkerMessage(msg: { seq?: number; kind: string; byteLength?: number } & Record<string, unknown>): void;
  completeOnce(result?: unknown): void;
  cancel(): void;
  dispose(): void;
}

/** Transfer ArrayBuffer ownership; detaches the original (neutering check). */
export function transferBuffer(buffer: ArrayBuffer): ArrayBuffer {
  const len = buffer.byteLength;
  if (typeof (buffer as unknown as { transfer?: () => ArrayBuffer }).transfer === "function") {
    const moved = (buffer as unknown as { transfer: () => ArrayBuffer }).transfer();
    void len;
    return moved;
  }
  // Fallback: copy then detach via resize(0) if resizable, else return copy.
  const copy = buffer.slice(0);
  try {
    const anyBuf = buffer as unknown as { resize?: (n: number) => void };
    if (typeof anyBuf.resize === "function") anyBuf.resize(0);
  } catch {
    // ignore
  }
  return copy;
}

export function createBrowserSession(opts?: SessionOptions): BrowserSessionHandle {
  const maxPendingBytes = opts?.maxPendingBytes ?? 8 * 1024 * 1024;
  const workerClient = opts?.workerClient;
  const onEvent = opts?.onEvent;
  let seq = 0;
  let pendingBytes = 0;
  let cancelled = false;
  let disposed = false;
  let completed = false;
  let completedEmitted = false;

  function emit(kind: string, extra?: Record<string, unknown>): void {
    seq += 1;
    try {
      onEvent?.({ seq, kind, ...extra });
    } catch {
      // never let listener break coordinator
    }
  }

  function postBuffer(buffer: ArrayBuffer): { transferred: boolean; backpressure: boolean } {
    if (cancelled || disposed || completed) return { transferred: false, backpressure: pendingBytes > maxPendingBytes };
    const size = buffer.byteLength;
    const moved = transferBuffer(buffer);
    pendingBytes += moved.byteLength;
    void size;
    try {
      workerClient?.postMessage({ kind: "tile-bytes", byteLength: moved.byteLength }, [moved]);
      if (typeof workerClient?.postedCount === "number") workerClient.postedCount += 1;
    } catch {
      // posting failed; roll back counter
      pendingBytes -= moved.byteLength;
      return { transferred: false, backpressure: pendingBytes > maxPendingBytes };
    }
    return { transferred: true, backpressure: pendingBytes > maxPendingBytes };
  }

  function handleWorkerMessage(
    msg: { seq?: number; kind: string; byteLength?: number } & Record<string, unknown>,
  ): void {
    // Late responses ignored after cancel/dispose.
    if (cancelled || disposed) return;
    if (completed) return;
    if (typeof msg.byteLength === "number" && msg.byteLength > 0) {
      pendingBytes = Math.max(0, pendingBytes - msg.byteLength);
    }
    if (msg.kind === "completed") {
      completeOnce(msg);
      return;
    }
    emit(`worker:${String(msg.kind)}`, { ...msg });
  }

  function completeOnce(result?: unknown): void {
    if (completedEmitted) return;
    if (cancelled || disposed) return;
    completedEmitted = true;
    completed = true;
    emit("completed", result !== undefined ? { result } : undefined);
  }

  function cancel(): void {
    if (cancelled || disposed || completed) return;
    cancelled = true;
    pendingBytes = 0;
    emit("cancelled");
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    pendingBytes = 0;
    try {
      workerClient?.terminate();
    } catch {
      // ignore
    }
  }

  return {
    get seq(): number {
      return seq;
    },
    get pendingBytes(): number {
      return pendingBytes;
    },
    get backpressure(): boolean {
      return pendingBytes > maxPendingBytes;
    },
    get cancelled(): boolean {
      return cancelled;
    },
    get disposed(): boolean {
      return disposed;
    },
    get completed(): boolean {
      return completed;
    },
    postBuffer,
    handleWorkerMessage,
    completeOnce,
    cancel,
    dispose,
  };
}
