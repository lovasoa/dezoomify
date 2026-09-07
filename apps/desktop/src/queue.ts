// Desktop queue (todo 5.3): sequential multi-job table in the integration
// layer, over the single-job engine.
//
// One active job at a time; further submits wait FIFO. Tracks progress per
// job, cancel one/all, and retry of failed or cancelled entries. A failed
// entry never stops the rest; totals mirror the CLI bulk contract
// (`bulk: X succeeded, Y failed, Z total`). Pure, no I/O, no clocks, no Tauri
// globals. Keep erasable-syntax-only so node type-stripping can import it.

export type DesktopQueueStatus = "queued" | "active" | "done" | "failed" | "cancelled";

export interface DesktopQueueProgress {
  readonly acquired: number;
  readonly total: number;
}

export interface DesktopQueueEntry {
  readonly id: string;
  readonly inputUrl: string;
  readonly origin: string;
  readonly status: DesktopQueueStatus;
  readonly progress: DesktopQueueProgress;
  readonly errorCode?: string;
  readonly outputHash?: string;
}

export interface DesktopQueue {
  readonly entries: Array<DesktopQueueEntry>;
  readonly activeId: string | null;
  readonly nextId: number;
}

export interface DesktopQueueCapabilities {
  readonly bulkSupported?: boolean;
}

/** Whether the negotiated capabilities offer the desktop queue. */
export function isDesktopQueueAvailable(caps: DesktopQueueCapabilities | null | undefined): boolean {
  if (!caps) return false;
  return caps.bulkSupported === true;
}

/** Empty queue. */
export function createDesktopQueue(): DesktopQueue {
  return { entries: [], activeId: null, nextId: 0 };
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
  const id = `jobq:${queue.nextId}`;
  const becomesActive = queue.activeId === null;
  const entry: DesktopQueueEntry = {
    id,
    inputUrl: trimmed,
    origin: redactedOriginForQueue(trimmed),
    status: becomesActive ? "active" : "queued",
    progress: { acquired: 0, total: 0 },
  };
  const next: DesktopQueue = {
    entries: [...queue.entries, entry],
    activeId: becomesActive ? id : queue.activeId,
    nextId: queue.nextId + 1,
  };
  return { queue: next, entry, code: "ok" };
}

/** The active entry, if any. */
export function activeDesktopEntry(queue: DesktopQueue): DesktopQueueEntry | null {
  if (!queue.activeId) return null;
  for (const entry of queue.entries) {
    if (entry.id === queue.activeId) return entry;
  }
  return null;
}

/** Waiting entries in FIFO order, never the active job. */
export function pendingDesktopEntries(queue: DesktopQueue): Array<DesktopQueueEntry> {
  return queue.entries.filter((entry) => entry.status === "queued");
}

function replaceEntry(queue: DesktopQueue, next: DesktopQueueEntry): DesktopQueue {
  const entries = queue.entries.map((entry) => (entry.id === next.id ? next : entry));
  return { entries, activeId: queue.activeId, nextId: queue.nextId };
}

/**
 * Advance after the active job reaches a terminal outcome. Marks the active
 * entry done/failed/cancelled (with hash or error code) and promotes the
 * first queued entry, if any. Returns the next entry to start (or null).
 */
export function finishActiveDesktopEntry(
  queue: DesktopQueue,
  outcome: "done" | "failed" | "cancelled",
  detail?: { outputHash?: string; errorCode?: string },
): { queue: DesktopQueue; next: DesktopQueueEntry | null } {
  const activeId = queue.activeId;
  if (!activeId) return { queue, next: null };
  const found = queue.entries.find((entry) => entry.id === activeId) ?? null;
  if (!found) return { queue, next: null };
  if (found.status !== "active") return { queue, next: null };
  const finished: DesktopQueueEntry = {
    id: found.id,
    inputUrl: found.inputUrl,
    origin: found.origin,
    status: outcome,
    progress: found.progress,
    ...(detail?.outputHash ? { outputHash: detail.outputHash } : {}),
    ...(detail?.errorCode ? { errorCode: detail.errorCode } : {}),
  };
  let nextQueue = replaceEntry(queue, finished);
  const waiting = nextQueue.entries.find((entry) => entry.status === "queued") ?? null;
  if (waiting) {
    const promoted: DesktopQueueEntry = {
      id: waiting.id,
      inputUrl: waiting.inputUrl,
      origin: waiting.origin,
      status: "active",
      progress: waiting.progress,
    };
    nextQueue = replaceEntry(nextQueue, promoted);
    nextQueue = { entries: nextQueue.entries, activeId: waiting.id, nextId: nextQueue.nextId };
    const out = nextQueue.entries.find((entry) => entry.id === waiting.id) ?? null;
    return { queue: nextQueue, next: out };
  }
  nextQueue = { entries: nextQueue.entries, activeId: null, nextId: nextQueue.nextId };
  return { queue: nextQueue, next: null };
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
    ...(found.outputHash ? { outputHash: found.outputHash } : {}),
  };
  return { queue: replaceEntry(queue, next), code: "ok" };
}

/**
 * Cancel one entry. Cancelling the active job marks it cancelled and promotes
 * the next queued entry (the caller stops the engine job and removes
 * uncommitted output first). Cancelling a queued entry keeps the active job.
 */
export function cancelDesktopEntry(
  queue: DesktopQueue,
  id: string,
): { queue: DesktopQueue; next: DesktopQueueEntry | null; code: string } {
  const found = queue.entries.find((entry) => entry.id === id) ?? null;
  if (!found) return { queue, next: null, code: "job.unknown" };
  if (found.status === "done" || found.status === "failed" || found.status === "cancelled") {
    return { queue, next: null, code: "job.stale" };
  }
  if (id === queue.activeId) {
    return { ...finishActiveDesktopEntry(queue, "cancelled"), code: "ok" };
  }
  const nextEntry: DesktopQueueEntry = {
    id: found.id,
    inputUrl: found.inputUrl,
    origin: found.origin,
    status: "cancelled",
    progress: found.progress,
  };
  const nextQueue = replaceEntry(queue, nextEntry);
  return { queue: nextQueue, next: activeDesktopEntry(nextQueue), code: "ok" };
}

/** Cancel the active job plus every waiting entry: no new work is issued. */
export function cancelAllDesktop(queue: DesktopQueue): DesktopQueue {
  const entries = queue.entries.map((entry) => {
    if (entry.status === "queued" || entry.status === "active") {
      return {
        id: entry.id,
        inputUrl: entry.inputUrl,
        origin: entry.origin,
        status: "cancelled" as DesktopQueueStatus,
        progress: entry.progress,
      };
    }
    return entry;
  });
  return { entries, activeId: null, nextId: queue.nextId };
}

/** Re-queue a failed or cancelled entry behind the waiting line. */
export function retryDesktopEntry(
  queue: DesktopQueue,
  id: string,
): { queue: DesktopQueue; entry: DesktopQueueEntry | null; code: string } {
  const found = queue.entries.find((entry) => entry.id === id) ?? null;
  if (!found) return { queue, entry: null, code: "job.unknown" };
  if (found.status !== "failed" && found.status !== "cancelled") {
    return { queue, entry: null, code: "job.invalid-state" };
  }
  const kept = queue.entries.filter((entry) => entry.id !== id);
  const freshId = `jobq:${queue.nextId}`;
  const fresh: DesktopQueueEntry = {
    id: freshId,
    inputUrl: found.inputUrl,
    origin: found.origin,
    status: "queued",
    progress: { acquired: 0, total: 0 },
  };
  const idle = queue.activeId === null;
  const entries = idle
    ? [...kept, { ...fresh, status: "active" as DesktopQueueStatus }]
    : [...kept, fresh];
  const next: DesktopQueue = {
    entries,
    activeId: idle ? freshId : queue.activeId,
    nextId: queue.nextId + 1,
  };
  const out = next.entries.find((entry) => entry.id === freshId) ?? null;
  return { queue: next, entry: out, code: "ok" };
}

export interface DesktopQueueSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly pending: number;
}

/** Totals over all entries. A failed entry never stops the rest. */
export function summarizeDesktopQueue(queue: DesktopQueue): DesktopQueueSummary {
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

/** Human totals line sharing the CLI bulk contract verbatim. */
export function humanDesktopQueueSummary(summary: DesktopQueueSummary): string {
  return `bulk: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.total} total`;
}

/** Machine totals record sharing the CLI `bulk-completed` shape. */
export function machineDesktopQueueSummary(summary: DesktopQueueSummary): string {
  return JSON.stringify({
    kind: "bulk-completed",
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
  });
}
