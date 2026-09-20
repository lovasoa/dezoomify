// Pure FIFO lifecycle shared by products with a single active engine job.
// Product integrations validate input and keep product-specific payloads;
// this module owns activation, terminal advancement, cancellation, retry, and
// status totals only.

export type QueueStatus = "queued" | "active" | "done" | "failed" | "cancelled";

export interface QueueEntry {
  readonly id: string;
  readonly status: QueueStatus;
  readonly errorCode?: string;
}

export interface SequentialQueue<E extends QueueEntry> {
  readonly entries: E[];
  readonly activeId: string | null;
  readonly nextId: number;
  readonly idPrefix: string;
}

export interface QueueSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly pending: number;
}

export function createSequentialQueue<E extends QueueEntry>(idPrefix: string): SequentialQueue<E> {
  return { entries: [], activeId: null, nextId: 0, idPrefix };
}

function changeEntry<E extends QueueEntry>(
  queue: SequentialQueue<E>,
  id: string,
  status: QueueStatus,
  errorCode?: string,
): SequentialQueue<E> {
  const entries = queue.entries.map((entry) => {
    if (entry.id !== id) return entry;
    const { errorCode: _previous, ...rest } = entry;
    return { ...rest, status, ...(errorCode === undefined ? {} : { errorCode }) } as E;
  });
  return { ...queue, entries };
}

export function enqueueSequential<E extends QueueEntry>(
  queue: SequentialQueue<E>,
  makeEntry: (id: string, status: QueueStatus) => E,
): { queue: SequentialQueue<E>; entry: E } {
  const id = `${queue.idPrefix}${queue.nextId}`;
  const status: QueueStatus = queue.activeId === null ? "active" : "queued";
  const entry = makeEntry(id, status);
  return {
    queue: {
      ...queue,
      entries: [...queue.entries, entry],
      activeId: status === "active" ? id : queue.activeId,
      nextId: queue.nextId + 1,
    },
    entry,
  };
}

export function activeQueueEntry<E extends QueueEntry>(queue: SequentialQueue<E>): E | null {
  return queue.entries.find((entry) => entry.id === queue.activeId) ?? null;
}

export function pendingQueueEntries<E extends QueueEntry>(queue: SequentialQueue<E>): E[] {
  return queue.entries.filter((entry) => entry.status === "queued");
}

export function finishActiveQueueEntry<E extends QueueEntry>(
  queue: SequentialQueue<E>,
  outcome: "done" | "failed" | "cancelled",
  errorCode?: string,
): { queue: SequentialQueue<E>; next: E | null } {
  const active = activeQueueEntry(queue);
  if (!active || active.status !== "active") return { queue, next: null };
  let nextQueue = changeEntry(queue, active.id, outcome, errorCode);
  const waiting = nextQueue.entries.find((entry) => entry.status === "queued");
  if (!waiting) return { queue: { ...nextQueue, activeId: null }, next: null };
  nextQueue = changeEntry(nextQueue, waiting.id, "active");
  const next = nextQueue.entries.find((entry) => entry.id === waiting.id) ?? null;
  return { queue: { ...nextQueue, activeId: waiting.id }, next };
}

export function cancelQueueEntry<E extends QueueEntry>(
  queue: SequentialQueue<E>,
  id: string,
): { queue: SequentialQueue<E>; next: E | null; code: string } {
  const found = queue.entries.find((entry) => entry.id === id);
  if (!found) return { queue, next: null, code: "job.unknown" };
  if (found.status === "done" || found.status === "failed" || found.status === "cancelled") {
    return { queue, next: null, code: "job.stale" };
  }
  if (id === queue.activeId) return { ...finishActiveQueueEntry(queue, "cancelled"), code: "ok" };
  const nextQueue = changeEntry(queue, id, "cancelled");
  return { queue: nextQueue, next: activeQueueEntry(nextQueue), code: "ok" };
}

export function cancelAllQueueEntries<E extends QueueEntry>(queue: SequentialQueue<E>): SequentialQueue<E> {
  const entries = queue.entries.map((entry) =>
    entry.status === "queued" || entry.status === "active"
      ? ({ ...entry, status: "cancelled" } as E)
      : entry,
  );
  return { ...queue, entries, activeId: null };
}

export function retryQueueEntry<E extends QueueEntry>(
  queue: SequentialQueue<E>,
  id: string,
  makeEntry: (id: string, previous: E, status: QueueStatus) => E,
): { queue: SequentialQueue<E>; entry: E | null; code: string } {
  const found = queue.entries.find((entry) => entry.id === id);
  if (!found) return { queue, entry: null, code: "job.unknown" };
  if (found.status !== "failed" && found.status !== "cancelled") {
    return { queue, entry: null, code: "job.invalid-state" };
  }
  const freshId = `${queue.idPrefix}${queue.nextId}`;
  const status: QueueStatus = queue.activeId === null ? "active" : "queued";
  const entry = makeEntry(freshId, found, status);
  return {
    queue: {
      ...queue,
      entries: [...queue.entries.filter((item) => item.id !== id), entry],
      activeId: status === "active" ? freshId : queue.activeId,
      nextId: queue.nextId + 1,
    },
    entry,
    code: "ok",
  };
}

export function summarizeQueue<E extends QueueEntry>(queue: SequentialQueue<E>): QueueSummary {
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let pending = 0;
  for (const entry of queue.entries) {
    if (entry.status === "done") succeeded += 1;
    else if (entry.status === "failed") failed += 1;
    else if (entry.status === "cancelled") cancelled += 1;
    else pending += 1;
  }
  return { total: queue.entries.length, succeeded, failed, cancelled, pending };
}

export function humanQueueSummary(summary: { succeeded: number; failed: number; total: number }): string {
  return `bulk: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.total} total`;
}
