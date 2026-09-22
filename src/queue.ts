// Website-specific URL validation over the shared FIFO job queue. The
// shared model owns activation, advancement, cancellation, retry, and totals.

import {
  createSequentialQueue,
  enqueueSequential,
  isValidInputUrl,
  type QueueEntry,
  retryQueueEntry,
  type SequentialQueue,
} from "@dezoomify/app-model";

export interface WebQueueEntry extends QueueEntry {
  readonly url: string;
}

export type WebQueue = SequentialQueue<WebQueueEntry>;

export function createWebQueue(): WebQueue {
  return createSequentialQueue<WebQueueEntry>("webq:");
}

export function enqueueWebQueue(
  queue: WebQueue,
  url: string,
): { queue: WebQueue; entry: WebQueueEntry | null; code: string } {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidInputUrl(trimmed)) return { queue, entry: null, code: "job.invalid-input" };
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
