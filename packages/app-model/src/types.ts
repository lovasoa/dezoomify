// Host-neutral application model: the shared job service contract.
// React-free and host-global-free: no window, document, fetch, chrome,
// tauri, localStorage, or canvas access. Hosts inject effects (the
// HostRunner), storage (HistoryStore), and clocks (`now` callbacks); this
// package owns identity, revision guards, sequencing, and shared history.
//
// Cross-language types are imported from the generated bindings and never
// redeclared here. JobSnapshot is a client-side fold of generated JobEvents
// (see snapshot.ts); if the protocol ever publishes a canonical snapshot,
// this alias switches to it.

import type {
  CatalogDto,
  ErrorDto,
  JobCommand,
  JobEvent,
  JobInputDto,
  JobState,
  RecoveryAction,
  SessionConfig,
} from "@dezoomify/wasm-bindings";

export type {
  CatalogDto,
  ErrorDto,
  JobCommand,
  JobEvent,
  JobInputDto,
  JobState,
  RecoveryAction,
  SessionConfig,
};

// ---------------------------------------------------------------------------
// Commands and requests
// ---------------------------------------------------------------------------

/** Commands the shared UI may send for a job. Generated, never redeclared. */
export type UserCommand = JobCommand;

/**
 * Browser execution: the host assembles output from readable bytes.
 * sourceUrl names the data source the host fetches (mirrors inputs[0].url);
 * the exec spec carries it so hosts never re-derive data from UI state.
 */
export interface BrowserExecSpec {
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
export interface NativeExecSpec {
  kind: "native";
  destination: NativeDestination;
}

/**
 * Product-local execution spec. The browser assembly and the native
 * destination are distinct variants; the engine options stay shared.
 */
export type ExecSpec = BrowserExecSpec | NativeExecSpec;

/** One end-to-end user request: engine options plus the product-local spec. */
export interface JobStartRequest {
  inputs: JobInputDto[];
  engine: SessionConfig;
  exec: ExecSpec;
}

// ---------------------------------------------------------------------------
// Snapshots (authoritative UI state)
// ---------------------------------------------------------------------------

/** Current image/level selection; null until the engine offers a choice. */
export interface JobSelection {
  image: number | null;
  level: number | null;
}

/** Terminal outcome. Set exactly once; late events after it are ignored. */
export interface TerminalOutcome {
  kind: "completed" | "partial-completed" | "failed" | "cancelled";
  error?: ErrorDto;
}

/**
 * Honest output account. doneTiles counts finalized tiles only; failedTiles
 * counts tiles the engine gave up on; missingTiles names the gaps behind a
 * kept partial. partial is true only for PartiallyCompleted jobs.
 * siblingName is the basename of the `.partial` file actually written
 * (never the granted path), when the host reports one.
 */
export interface OutputSummary {
  doneTiles: number;
  totalTiles: number | null;
  failedTiles: number;
  partial: boolean;
  format: string | null;
  width: number | null;
  height: number | null;
  missingTiles: string[];
  siblingName?: string;
}

/**
 * Outstanding recovery decision. actions are the typed choices the host may
 * offer; missing/failed/total carry the partial ledger when the host
 * reports one (desktop native recovery events).
 */
export interface RecoveryRequest {
  generation: number;
  actions: RecoveryAction[];
  missing?: string[];
  failed?: number;
  total?: number;
}

/**
 * Authoritative per-job state. Snapshots are absolute: the shared UI renders
 * the latest snapshot and never reconstructs phases from event walks.
 * revision increases on every applied event; observers drop stale revisions.
 */
export interface JobSnapshot {
  jobId: string;
  revision: number;
  state: JobState;
  catalog: CatalogDto | null;
  acquired: number;
  total: number | null;
  paused: boolean;
  selection: JobSelection;
  warnings: ErrorDto[];
  recovery: RecoveryRequest | null;
  terminal: TerminalOutcome | null;
  output: OutputSummary | null;
  /** True while tiles render as ordinary image elements with no byte access. */
  displayOnly: boolean;
  updatedAt: number;
}

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
}

/** Host-neutral job service. Products inject effects; UI consumes snapshots. */
export interface JobService {
  start(request: JobStartRequest, observer: JobObserver): Promise<JobHandle>;
}

/**
 * Host-injected effect layer behind a JobService. start() runs the request,
 * emits ordered JobEvents plus host presentation state, and returns control.
 * The browser assembly and the native runner implement this; the service adds
 * identity and revision guards at the async subscription boundary.
 */
export interface RunnerHandle {
  command(command: UserCommand): Promise<void>;
  dispose(): Promise<void>;
}

export interface HostRunner {
  start(
    request: JobStartRequest,
    emit: (event: JobEvent, host: HostStatus) => void,
  ): Promise<RunnerHandle>;
}
