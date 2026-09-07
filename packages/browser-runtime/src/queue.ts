// Website single-queue (todo 5.3): enqueue while a job runs, sequential.
//
// The engine stays single-job; this queue lives in the integration layer
// (the website orchestrator). One active job at a time, further submits wait
// in FIFO order. Cancellation stops issuing new work; a failed entry never
// stops the rest. Pure, no I/O, no clocks, no host globals. Keep
// erasable-syntax-only so node type-stripping can import it.

export type WebQueueStatus = "queued" | "active" | "done" | "failed" | "cancelled";

export interface WebQueueEntry {
  readonly id: string;
  readonly url: string;
  readonly status: WebQueueStatus;
  readonly errorCode?: string;
}

export interface WebQueue {
  readonly entries: Array<WebQueueEntry>;
  readonly activeId: string | null;
  readonly nextId: number;
}

export interface WebQueueCapabilities {
  readonly bulkSupported?: boolean;
}

/** Whether the negotiated capabilities offer the website single-queue. */
export function isWebQueueAvailable(caps: WebQueueCapabilities | null | undefined): boolean {
  if (!caps) return false;
  return caps.bulkSupported === true;
}

/** Empty queue. No active job, no entries, counter at zero. */
export function createWebQueue(): WebQueue {
  return { entries: [], activeId: null, nextId: 0 };
}

function isValidQueueUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return true;
}

/**
 * Enqueue one URL. Invalid URLs are rejected with a stable code and no state
 * change. Valid URLs append as queued; when idle (no active job) the new
 * entry becomes active immediately so the caller starts it.
 */
export function enqueueWebQueue(
  queue: WebQueue,
  url: string,
): { queue: WebQueue; entry: WebQueueEntry | null; code: string } {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidQueueUrl(trimmed)) {
    return { queue, entry: null, code: "job.invalid-input" };
  }
  const id = `webq:${queue.nextId}`;
  const becomesActive = queue.activeId === null;
  const entry: WebQueueEntry = {
    id,
    url: trimmed,
    status: becomesActive ? "active" : "queued",
  };
  const entries = [...queue.entries, entry];
  const next: WebQueue = {
    entries,
    activeId: becomesActive ? id : queue.activeId,
    nextId: queue.nextId + 1,
  };
  return { queue: next, entry, code: "ok" };
}

/** The active entry, if any. */
export function activeWebEntry(queue: WebQueue): WebQueueEntry | null {
  if (!queue.activeId) return null;
  for (const entry of queue.entries) {
    if (entry.id === queue.activeId) return entry;
  }
  return null;
}

/** Queued (waiting) entries in FIFO order, never the active job. */
export function pendingWebEntries(queue: WebQueue): Array<WebQueueEntry> {
  return queue.entries.filter((entry) => entry.status === "queued");
}

function withEntryStatus(
  queue: WebQueue,
  id: string,
  status: WebQueueStatus,
  errorCode?: string,
): WebQueue {
  const entries = queue.entries.map((entry) => {
    if (entry.id !== id) return entry;
    const next: WebQueueEntry = { id: entry.id, url: entry.url, status };
    if (errorCode !== undefined) (next as { errorCode?: string }).errorCode = errorCode;
    else if (entry.errorCode !== undefined) (next as { errorCode?: string }).errorCode = entry.errorCode;
    return next;
  });
  return { entries, activeId: queue.activeId, nextId: queue.nextId };
}

/**
 * Finish the active job and advance: the finished entry becomes done/failed/
 * cancelled, and the first queued entry (if any) becomes active so the caller
 * starts exactly one next job. Engine stays single-job throughout.
 */
export function finishActiveWebEntry(
  queue: WebQueue,
  outcome: "done" | "failed" | "cancelled",
  errorCode?: string,
): { queue: WebQueue; next: WebQueueEntry | null } {
  const activeId = queue.activeId;
  if (!activeId) return { queue, next: null };
  let nextQueue = withEntryStatus(queue, activeId, outcome, errorCode);
  const waiting = nextQueue.entries.find((entry) => entry.status === "queued") ?? null;
  if (waiting) {
    nextQueue = withEntryStatus(nextQueue, waiting.id, "active");
    const promoted = nextQueue.entries.find((entry) => entry.id === waiting.id) ?? null;
    nextQueue = { entries: nextQueue.entries, activeId: waiting.id, nextId: nextQueue.nextId };
    return { queue: nextQueue, next: promoted };
  }
  nextQueue = { entries: nextQueue.entries, activeId: null, nextId: nextQueue.nextId };
  return { queue: nextQueue, next: null };
}

/**
 * Cancel one entry. Cancelling the active job marks it cancelled and promotes
 * the next queued entry (the caller stops the engine job first). Cancelling a
 * queued entry removes it from the run order without touching the active job.
 */
export function cancelWebEntry(
  queue: WebQueue,
  id: string,
): { queue: WebQueue; next: WebQueueEntry | null; code: string } {
  const found = queue.entries.find((entry) => entry.id === id) ?? null;
  if (!found) return { queue, next: null, code: "job.unknown" };
  if (found.status === "done" || found.status === "failed" || found.status === "cancelled") {
    return { queue, next: null, code: "job.stale" };
  }
  if (id === queue.activeId) {
    return { ...finishActiveWebEntry(queue, "cancelled"), code: "ok" };
  }
  const nextQueue = withEntryStatus(queue, id, "cancelled");
  return { queue: nextQueue, next: activeWebEntry(nextQueue), code: "ok" };
}

/** Cancel one queued/active job plus every waiting entry: no new work. */
export function cancelAllWeb(queue: WebQueue): WebQueue {
  const entries = queue.entries.map((entry) => {
    if (entry.status === "queued" || entry.status === "active") {
      return { id: entry.id, url: entry.url, status: "cancelled" as WebQueueStatus };
    }
    return entry;
  });
  return { entries, activeId: null, nextId: queue.nextId };
}

/** Re-queue a failed or cancelled entry behind the current waiting line. */
export function retryWebEntry(
  queue: WebQueue,
  id: string,
): { queue: WebQueue; entry: WebQueueEntry | null; code: string } {
  const found = queue.entries.find((entry) => entry.id === id) ?? null;
  if (!found) return { queue, entry: null, code: "job.unknown" };
  if (found.status !== "failed" && found.status !== "cancelled") {
    return { queue, entry: null, code: "job.invalid-state" };
  }
  // Drop the terminal copy and append a fresh queued entry with the same URL
  // (new id keeps per-entry outcomes distinct for reporting).
  const kept = queue.entries.filter((entry) => entry.id !== id);
  const freshId = `webq:${queue.nextId}`;
  const fresh: WebQueueEntry = { id: freshId, url: found.url, status: "queued" };
  const idle = queue.activeId === null;
  const entries = idle
    ? kept.map((entry) => entry).concat([{ ...fresh, status: "active" as WebQueueStatus }])
    : [...kept, fresh];
  const next: WebQueue = {
    entries,
    activeId: idle ? freshId : queue.activeId,
    nextId: queue.nextId + 1,
  };
  const out = next.entries.find((entry) => entry.id === freshId) ?? null;
  return { queue: next, entry: out, code: "ok" };
}

export interface WebQueueSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly pending: number;
}

/** Totals over all entries. A failed entry never stops the rest. */
export function summarizeWebQueue(queue: WebQueue): WebQueueSummary {
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

/** Human totals line mirroring the CLI bulk contract. */
export function humanWebQueueSummary(summary: WebQueueSummary): string {
  return `bulk: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.total} total`;
}
