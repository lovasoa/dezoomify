import {
  createSequentialQueue,
  enqueueSequential,
  isValidInputUrl,
  type QueueEntry,
  type QueueResultCode,
  retryQueueEntry,
  type SequentialQueue,
} from "@dezoomify/shared-ui";

export interface DesktopQueueProgress {
  readonly acquired: number;
  readonly total: number;
}

export interface DesktopQueueEntry extends QueueEntry {
  readonly inputUrl: string;
  readonly progress: DesktopQueueProgress;
}

export type DesktopQueue = SequentialQueue<DesktopQueueEntry>;

/** Empty queue. */
export function createDesktopQueue(): DesktopQueue {
  return createSequentialQueue<DesktopQueueEntry>("jobq:");
}

/**
 * Enqueue one validated single-job request. Invalid input is rejected with
 * `job.invalid-input` and no state change. The first entry while idle becomes
 * active immediately so the caller starts it; otherwise it waits FIFO.
 */
export function enqueueDesktopQueue(
  queue: DesktopQueue,
  inputUrl: string,
): { queue: DesktopQueue; entry: DesktopQueueEntry | null; code: QueueResultCode } {
  const trimmed = typeof inputUrl === "string" ? inputUrl.trim() : "";
  if (!isValidInputUrl(trimmed)) {
    return { queue, entry: null, code: "job.invalid-input" };
  }
  const result = enqueueSequential(queue, (id, status) => ({
    id,
    inputUrl: trimmed,
    status,
    progress: { acquired: 0, total: 0 },
  }));
  return { ...result, code: "ok" };
}

function replaceEntry(queue: DesktopQueue, next: DesktopQueueEntry): DesktopQueue {
  const entries = queue.entries.map((entry) => (entry.id === next.id ? next : entry));
  return { ...queue, entries };
}

/**
 * Fold monotonic progress for one live entry. Retries and cache hits never
 * move counts backwards; unknown totals stay 0 and never claim completeness.
 */
export function recordDesktopProgress(
  queue: DesktopQueue,
  id: string,
  acquired: number,
  total: number,
): { queue: DesktopQueue; code: QueueResultCode } {
  const found = queue.entries.find((entry) => entry.id === id) ?? null;
  if (!found) return { queue, code: "job.unknown" };
  if (found.status === "done" || found.status === "failed" || found.status === "cancelled") {
    return { queue, code: "job.stale" };
  }
  const safeAcquired = Number.isFinite(acquired) && acquired >= 0 ? Math.floor(acquired) : 0;
  const safeTotal = Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;
  const next: DesktopQueueEntry = {
    id: found.id,
    inputUrl: found.inputUrl,
    status: found.status,
    progress: {
      acquired: Math.max(found.progress.acquired, safeAcquired),
      total: Math.max(found.progress.total, safeTotal),
    },
    ...(found.errorCode ? { errorCode: found.errorCode } : {}),
  };
  return { queue: replaceEntry(queue, next), code: "ok" };
}

/** Re-queue a failed or cancelled entry behind the waiting line. */
export function retryDesktopEntry(
  queue: DesktopQueue,
  id: string,
): { queue: DesktopQueue; entry: DesktopQueueEntry | null; code: QueueResultCode } {
  return retryQueueEntry(queue, id, (freshId, previous, status) => ({
    id: freshId,
    inputUrl: previous.inputUrl,
    status,
    progress: { acquired: 0, total: 0 },
  }));
}
