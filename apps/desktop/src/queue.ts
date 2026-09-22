// Desktop queue: sequential multi-job table in the integration
// layer, over the single-job engine.
//
// One active job at a time; further submits wait FIFO. Tracks progress per
// job, cancel one/all, and retry of failed or cancelled entries. A failed
// entry never stops the rest; totals mirror the CLI bulk contract
// (`bulk: X succeeded, Y failed, Z total`). Pure, no I/O, no clocks, no Tauri
// globals. Keep erasable-syntax-only so node type-stripping can import it.

import {
  createSequentialQueue,
  enqueueSequential,
  type QueueEntry,
  type QueueSummary,
  retryQueueEntry,
  type SequentialQueue,
} from "@dezoomify/app-model";

export interface DesktopQueueProgress {
  readonly acquired: number;
  readonly total: number;
}

export interface DesktopQueueEntry extends QueueEntry {
  readonly inputUrl: string;
  readonly origin: string;
  readonly progress: DesktopQueueProgress;
}

export type DesktopQueue = SequentialQueue<DesktopQueueEntry>;

/** Empty queue. */
export function createDesktopQueue(): DesktopQueue {
  return createSequentialQueue<DesktopQueueEntry>("jobq:");
}

/** Redacted origin (`scheme://host[:port]`) for reports; never full URLs. */
export function redactedOriginForQueue(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "";
  }
}

function isValidDesktopQueueUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  const afterScheme = trimmed.split("://")[1] ?? "";
  const authority = afterScheme.split("/")[0]?.split("?")[0] ?? "";
  if (authority.includes("@")) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username !== "" || u.password !== "") return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Enqueue one validated single-job request. Invalid input is rejected with
 * `job.invalid-input` and no state change. The first entry while idle becomes
 * active immediately so the caller starts it; otherwise it waits FIFO.
 */
export function enqueueDesktopQueue(
  queue: DesktopQueue,
  inputUrl: string,
): { queue: DesktopQueue; entry: DesktopQueueEntry | null; code: string } {
  const trimmed = typeof inputUrl === "string" ? inputUrl.trim() : "";
  if (!isValidDesktopQueueUrl(trimmed)) {
    return { queue, entry: null, code: "job.invalid-input" };
  }
  const result = enqueueSequential(queue, (id, status) => ({
    id,
    inputUrl: trimmed,
    origin: redactedOriginForQueue(trimmed),
    status,
    progress: { acquired: 0, total: 0 },
  }));
  return { ...result, code: "ok" };
}

/** The active entry, if any. */
function replaceEntry(queue: DesktopQueue, next: DesktopQueueEntry): DesktopQueue {
  const entries = queue.entries.map((entry) => (entry.id === next.id ? next : entry));
  return { ...queue, entries };
}

/**
 * Advance after the active job reaches a terminal outcome. Marks the active
 * entry done/failed/cancelled (with an error code when applicable) and promotes the
 * first queued entry, if any. Returns the next entry to start (or null).
 */
/**
 * Fold monotonic progress for one live entry. Retries and cache hits never
 * move counts backwards; unknown totals stay 0 and never claim completeness.
 */
export function recordDesktopProgress(
  queue: DesktopQueue,
  id: string,
  acquired: number,
  total: number,
): { queue: DesktopQueue; code: string } {
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
    origin: found.origin,
    status: found.status,
    progress: {
      acquired: Math.max(found.progress.acquired, safeAcquired),
      total: Math.max(found.progress.total, safeTotal),
    },
    ...(found.errorCode ? { errorCode: found.errorCode } : {}),
  };
  return { queue: replaceEntry(queue, next), code: "ok" };
}

/**
 * Cancel one entry. Cancelling the active job marks it cancelled and promotes
 * the next queued entry (the caller stops the engine job and removes
 * uncommitted output first). Cancelling a queued entry keeps the active job.
 */
/** Re-queue a failed or cancelled entry behind the waiting line. */
export function retryDesktopEntry(
  queue: DesktopQueue,
  id: string,
): { queue: DesktopQueue; entry: DesktopQueueEntry | null; code: string } {
  return retryQueueEntry(queue, id, (freshId, previous, status) => ({
    id: freshId,
    inputUrl: previous.inputUrl,
    origin: previous.origin,
    status,
    progress: { acquired: 0, total: 0 },
  }));
}

/** Machine totals record sharing the CLI `bulk-completed` shape. */
export function machineDesktopQueueSummary(summary: QueueSummary): string {
  return JSON.stringify({
    kind: "bulk-completed",
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
  });
}
