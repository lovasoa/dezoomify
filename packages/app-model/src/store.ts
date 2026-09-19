// Single-cell snapshot store for one active job.
// React-free: subscribe/getSnapshot match the useSyncExternalStore shape, so
// the shared UI mounts them without any extra wiring. The store holds the
// latest engine snapshot verbatim: no revision guards, no per-job map. The
// engine sequence is authoritative; stale revisions are dropped at the
// transport edge (the runner) before they ever reach this cell.

import type { JobSnapshot } from "./types.ts";

export interface SnapshotStore {
  /** Latest snapshot, or undefined before the first engine emission. */
  get(): JobSnapshot | undefined;
  /** Replace the cell and notify listeners. */
  set(snapshot: JobSnapshot): void;
  /** Clear the cell (dispose path). Listeners see undefined afterwards. */
  clear(): void;
  /** Subscribe to the cell. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** useSyncExternalStore-compatible snapshot getter. */
  getSnapshot(): () => JobSnapshot | undefined;
}

export function createSnapshotStore(): SnapshotStore {
  let current: JobSnapshot | undefined;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One bad listener never blocks the rest of the UI.
      }
    }
  }

  function get(): JobSnapshot | undefined {
    return current;
  }

  function set(snapshot: JobSnapshot): void {
    if (!snapshot || typeof snapshot !== "object") return;
    current = snapshot;
    notify();
  }

  function clear(): void {
    current = undefined;
    notify();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): () => JobSnapshot | undefined {
    return () => get();
  }

  return { get, set, clear, subscribe, getSnapshot };
}
