// Latest-snapshot store with identity and revision guards.
// React-free: subscribe/getSnapshot match the useSyncExternalStore shape, so
// the shared UI mounts them without any extra wiring. The store keeps one
// snapshot per job id; snapshots for unknown jobs and stale revisions are
// dropped at the async subscription boundary.

import type { JobSnapshot } from "./types.ts";

export interface SnapshotStore {
  /** Current snapshot for a job, or undefined before the first event. */
  get(jobId: string): JobSnapshot | undefined;
  /** Publish a snapshot; stale revisions and empty ids are ignored. */
  publish(snapshot: JobSnapshot): boolean;
  /** Remove a job (dispose path). Listeners see undefined afterwards. */
  remove(jobId: string): void;
  /** Subscribe to one job. Returns the unsubscribe function. */
  subscribe(jobId: string, listener: () => void): () => void;
  /** useSyncExternalStore-compatible snapshot getter for one job. */
  getSnapshot(jobId: string): () => JobSnapshot | undefined;
}

export function createSnapshotStore(): SnapshotStore {
  const latest = new Map<string, JobSnapshot>();
  const listeners = new Map<string, Set<() => void>>();

  function notify(jobId: string): void {
    const set = listeners.get(jobId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener();
      } catch {
        // One bad listener never blocks the rest of the UI.
      }
    }
  }

  function get(jobId: string): JobSnapshot | undefined {
    if (typeof jobId !== "string" || jobId === "") return undefined;
    return latest.get(jobId);
  }

  function publish(snapshot: JobSnapshot): boolean {
    if (!snapshot || typeof snapshot.jobId !== "string" || snapshot.jobId === "") return false;
    if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) return false;
    const current = latest.get(snapshot.jobId);
    if (current && snapshot.revision <= current.revision) return false;
    latest.set(snapshot.jobId, snapshot);
    notify(snapshot.jobId);
    return true;
  }

  function remove(jobId: string): void {
    if (latest.delete(jobId)) notify(jobId);
  }

  function subscribe(jobId: string, listener: () => void): () => void {
    let set = listeners.get(jobId);
    if (!set) {
      set = new Set();
      listeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      const live = listeners.get(jobId);
      if (!live) return;
      live.delete(listener);
      if (live.size === 0) listeners.delete(jobId);
    };
  }

  function getSnapshot(jobId: string): () => JobSnapshot | undefined {
    return () => get(jobId);
  }

  return { get, publish, remove, subscribe, getSnapshot };
}
