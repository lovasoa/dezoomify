// Host-neutral application model: the shared job service contract.
// React-free and host-global-free: no window, document, fetch, chrome,
// tauri, localStorage, or canvas access. Hosts inject effects (the
// JobService); this package owns shared contracts, validation, and history.
//
// Cross-language types are imported from the generated bindings and never
// redeclared here. Snapshot is the only job-state object: the
// engine projects absolute snapshots, hosts forward them, and the shared UI
// renders the latest one. Nothing here folds events or tracks revisions.

import type {
  Catalog,
  Error as EngineError,
  JobCommand,
  JobInput,
  JobState,
  RecoveryAction,
  SessionConfig,
  Snapshot,
  Terminal,
} from "@dezoomify/wasm-bindings";

export type {
  Catalog,
  EngineError as Error,
  JobCommand,
  JobInput,
  JobState,
  RecoveryAction,
  SessionConfig,
  Snapshot,
  Terminal,
};

// ---------------------------------------------------------------------------
// Commands and requests
// ---------------------------------------------------------------------------

/** Commands the shared UI may send for a job. Generated, never redeclared. */
export type UserCommand = JobCommand;

/** Engine inputs and options used by browser execution. */
export interface EngineStartRequest {
  inputs: JobInput[];
  engine: SessionConfig;
}

// ---------------------------------------------------------------------------
// Snapshots (authoritative UI state)
// ---------------------------------------------------------------------------

/**
 * Authoritative per-job state. This is the generated engine projection,
 * unmodified: the shared UI renders the latest snapshot and never
 * reconstructs phases from event walks. `revision` increases on every
 * engine transition; stale revisions are dropped at the transport edge
 * (the runner), never here.
 */
export type JobSnapshot = Snapshot;

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

/** Authoritative engine snapshots and separate terminal runtime faults. */
export interface JobObserver {
  snapshot(snapshot: JobSnapshot): void;
  failure(error: EngineError): void;
}

/** Window-owned job control. command() sends exactly one UserCommand. */
export interface JobHandle {
  readonly id: string;
  command(command: UserCommand): Promise<void>;
  dispose(): Promise<void>;
}

/** Host-neutral job service. Products inject effects; UI consumes snapshots. */
export interface JobService<Request, Handle extends JobHandle = JobHandle> {
  start(request: Request, observer: JobObserver): Promise<Handle>;
}
