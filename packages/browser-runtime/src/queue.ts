// Website-specific URL validation over the shared FIFO job queue. The
// shared model owns activation, advancement, cancellation, retry, and totals.

import {
  createSequentialQueue,
  enqueueSequential,
  retryQueueEntry,
  type QueueEntry,
  type SequentialQueue,
} from "@dezoomify/app-model";

export interface WebQueueEntry extends QueueEntry {
  readonly url: string;
}

export type WebQueue = SequentialQueue<WebQueueEntry>;

export function createWebQueue(): WebQueue {
  return createSequentialQueue<WebQueueEntry>("webq:");
}

function isValidQueueUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export function enqueueWebQueue(
  queue: WebQueue,
  url: string,
): { queue: WebQueue; entry: WebQueueEntry | null; code: string } {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidQueueUrl(trimmed)) return { queue, entry: null, code: "job.invalid-input" };
  const result = enqueueSequential(queue, (id, status) => ({ id, url: trimmed, status }));
  return { ...result, code: "ok" };
}

export function retryWebEntry(
  queue: WebQueue,
  id: string,
): { queue: WebQueue; entry: WebQueueEntry | null; code: string } {
  return retryQueueEntry(queue, id, (freshId, previous, status) => ({
    id: freshId,
    url: previous.url,
    status,
  }));
}
