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

/**
 * Browser execution: the host assembles output from readable bytes.
 * sourceUrl names the data source the host fetches (mirrors inputs[0].url);
 * the host spec carries it so hosts never re-derive data from UI state.
 */
export interface BrowserHostSpec {
  kind: "browser";
  sourceUrl: string;
}

/** Native execution: the host writes output to a granted destination. */
export interface NativeDestination {
  kind: "file" | "directory";
  suggestedName: string;
  format: string;
}

/** Native execution: the host runs the engine and writes the output. */
export interface NativeHostSpec {
  kind: "native";
  destination: NativeDestination;
}

/**
 * Product-local host spec. The browser assembly and the native
 * destination are distinct variants; the engine options stay shared.
 */
export type HostSpec = BrowserHostSpec | NativeHostSpec;

/** One end-to-end user request: engine options plus the product-local spec. */
export interface JobStartRequest {
  inputs: JobInput[];
  engine: SessionConfig;
  host: HostSpec;
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
// Host status (presentation only, never a phase machine)
// ---------------------------------------------------------------------------

/** Small presentation record for transport/permission/output state. */
export interface HostStatus {
  transport: string | null;
  permission: "granted" | "denied" | "prompt" | "unavailable";
  output: "writable" | "display-only" | "pending" | "unavailable";
  detail?: string;
}

/**
 * Neutral host status before the first host emission: no transport claimed,
 * no permission implied, output undecided. Hosts replace it with their
 * first real emission; the UI never acts on this value.
 */
export function initialHostStatus(): HostStatus {
  return { transport: null, permission: "unavailable", output: "pending" };
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

/** Sink for authoritative snapshots and host presentation state. */
export interface JobObserver {
  snapshot(snapshot: JobSnapshot): void;
  hostStatus(status: HostStatus): void;
}

/** Window-owned job control. command() sends exactly one UserCommand. */
export interface JobHandle {
  readonly id: string;
  command(command: UserCommand): Promise<void>;
  dispose(): Promise<void>;
  /** Resolve a paused host-grant acquisition (browser permission flow). */
  resolvePermission?(granted: boolean): void;
}

/** Host-neutral job service. Products inject effects; UI consumes snapshots. */
export interface JobService {
  start(request: JobStartRequest, observer: JobObserver): Promise<JobHandle>;
}
