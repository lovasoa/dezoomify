// Sequential job queue over the single-job engine.
// One active job at a time, FIFO order. Queue failures are isolated: a
// failed entry is retained with its error while the queue moves on, and
// cancel-one/all plus retry never disturb other entries. Host-neutral: the
// queue only speaks the JobService contract plus an injected clock.

import type {
  ErrorDto,
  HostStatus,
  JobHandle,
  JobObserver,
  JobService,
  JobSnapshot,
  JobStartRequest,
} from "./types.ts";
import { initialHostStatus } from "./types.ts";

export type QueueEntryStatus = "queued" | "active" | "done" | "failed" | "cancelled";

export interface QueueEntry {
  id: string;
  request: JobStartRequest;
  status: QueueEntryStatus;
  snapshots: JobSnapshot[];
  host: HostStatus;
  error?: ErrorDto;
}

export interface QueueEntryHandle {
  readonly id: string;
  cancel(): void;
  retry(): void;
}

export interface JobQueue {
  enqueue(request: JobStartRequest): QueueEntryHandle;
  cancel(id: string): void;
  cancelAll(): void;
  retry(id: string): void;
  entries(): QueueEntry[];
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

export interface QueueOptions {
  now?: () => number;
}

function isTerminalState(state: string): boolean {
  return (
    state === "Completed" ||
    state === "PartiallyCompleted" ||
    state === "Failed" ||
    state === "Cancelled"
  );
}

function terminalErrorOf(snapshot: JobSnapshot): ErrorDto | undefined {
  if (snapshot.terminal?.kind === "failed") return snapshot.terminal.error;
  return undefined;
}

export function createJobQueue(service: JobService, opts?: QueueOptions): JobQueue {
  const now = opts?.now ?? Date.now;
  void now;
  let seq = 0;
  const order: QueueEntry[] = [];
  const byId = new Map<string, QueueEntry>();
  const listeners = new Set<() => void>();
  let activeId: string | null = null;
  let activeHandle: JobHandle | null = null;
  let disposed = false;

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Listener faults never break queue accounting.
      }
    }
  }

  function pump(): void {
    if (disposed || activeId !== null) return;
    const next = order.find((entry) => entry.status === "queued");
    if (!next) return;
    void startEntry(next);
  }

  async function startEntry(entry: QueueEntry): Promise<void> {
    entry.status = "active";
    activeId = entry.id;
    notify();
    const observer: JobObserver = {
      snapshot(snapshot: JobSnapshot): void {
        if (disposed || entry.id !== activeId) return;
        entry.snapshots = [...entry.snapshots, snapshot].slice(-50);
        if (snapshot.terminal !== null && isTerminalState(snapshot.state)) {
          finishActive(entry, snapshot);
        } else if (snapshot.terminal !== null) {
          finishActive(entry, snapshot);
        }
        notify();
      },
      hostStatus(status: HostStatus): void {
        if (disposed || entry.id !== activeId) return;
        entry.host = status;
        notify();
      },
    };
    try {
      const handle = await service.start(entry.request, observer);
      if (disposed || entry.status !== "active" || entry.id !== activeId) {
        await handle.dispose().catch(() => undefined);
        return;
      }
      activeHandle = handle;
    } catch (error) {
      if (entry.id === activeId) {
        entry.status = "failed";
        entry.error = toQueueError(error);
        activeId = null;
        activeHandle = null;
        notify();
        pump();
      }
    }
  }

  function finishActive(entry: QueueEntry, snapshot: JobSnapshot): void {
    if (entry.id !== activeId) return;
    const kind = snapshot.terminal?.kind;
    if (kind === "cancelled") {
      entry.status = "cancelled";
    } else if (kind === "failed") {
      entry.status = "failed";
      entry.error = terminalErrorOf(snapshot);
    } else {
      entry.status = "done";
    }
    activeId = null;
    activeHandle = null;
    notify();
    pump();
  }

  function toQueueError(error: unknown): ErrorDto {
    if (error && typeof error === "object" && "code" in (error as Record<string, unknown>)) {
      return error as ErrorDto;
    }
    return {
      code: "queue.start-failed",
      phase: "validation",
      retryable: true,
      message: error instanceof Error ? error.message : "The queued job could not start.",
      recovery: [],
    };
  }

  function enqueue(request: JobStartRequest): QueueEntryHandle {
    seq += 1;
    const id = `queue:${seq}`;
    const entry: QueueEntry = {
      id,
      request,
      status: "queued",
      snapshots: [],
      host: initialHostStatus(),
    };
    order.push(entry);
    byId.set(id, entry);
    notify();
    pump();
    return {
      id,
      cancel: () => cancel(id),
      retry: () => retry(id),
    };
  }

  function cancel(id: string): void {
    const entry = byId.get(id);
    if (!entry) return;
    if (entry.status === "queued") {
      entry.status = "cancelled";
      notify();
      pump();
      return;
    }
    if (entry.status === "active" && id === activeId && activeHandle) {
      const handle = activeHandle;
      activeHandle = null;
      handle.command({ type: "cancel" }).catch(() => undefined);
    }
  }

  function cancelAll(): void {
    for (const entry of order) {
      if (entry.status === "queued") entry.status = "cancelled";
    }
    if (activeId !== null && activeHandle) {
      const handle = activeHandle;
      activeHandle = null;
      handle.command({ type: "cancel" }).catch(() => undefined);
    }
    notify();
  }

  function retry(id: string): void {
    const entry = byId.get(id);
    if (!entry) return;
    if (entry.status === "active") return;
    if (entry.status !== "failed" && entry.status !== "cancelled" && entry.status !== "done") return;
    entry.status = "queued";
    entry.error = undefined;
    entry.snapshots = [];
    entry.host = initialHostStatus();
    notify();
    pump();
  }

  function entries(): QueueEntry[] {
    return order.map((entry) => ({
      ...entry,
      snapshots: entry.snapshots.slice(),
    }));
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const handle = activeHandle;
    activeHandle = null;
    activeId = null;
    if (handle) await handle.dispose().catch(() => undefined);
  }

  return { enqueue, cancel, cancelAll, retry, entries, subscribe, dispose };
}
