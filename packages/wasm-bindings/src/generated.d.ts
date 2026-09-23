/* tslint:disable */
/* eslint-disable */
/**
 * A closed byte transformation applied before image decoding.
 */
export type ProcessingRecipe = "none" | "google-arts-decrypt";

/**
 * A pixel size (output canvas or planned tile extent).
 */
export interface Size {
    width: number;
    height: number;
}

/**
 * A position in the output image, in pixels from the top-left corner.
 */
export interface Point {
    x: number;
    y: number;
}

/**
 * A resolved image: declared geometry and selectable levels.
 */
export interface Image {
    title?: string;
    format: string;
    size?: Size;
    sourceKind: string;
    levels: Level[];
}

/**
 * A still-deferred catalog entry: the resource to acquire before an image
 * can be planned. The host follows `uri` with a fresh bounded attempt.
 */
export interface ImageRequest {
    title?: string;
    uri: string;
}

/**
 * Authoritative per-job projection. Snapshots are absolute: UIs render
 * the latest snapshot and never reconstruct phases from event walks.
 * `revision` increases on every transition; observers drop stale ones.
 */
export interface Snapshot {
    revision: number;
    lifecycle: JobState;
    paused: boolean;
    progress: Progress;
    selection: Selection;
    decision: Decision | undefined;
    terminal: Terminal | undefined;
    output: OutputSummary | undefined;
}

/**
 * Closed retry category for one classified tile failure.
 */
export type FailureCategory = "permanent" | "transient";

/**
 * Current selection state (positions into the kept catalog).
 */
export interface Selection {
    image: number | undefined;
    level: number | undefined;
    level_count: number;
    /**
     * The kept catalog with full geometry, once discovered. Replaced when
     * a deferred catalog entry is followed within the same job.
     */
    catalog: Catalog | undefined;
    deferred: DeferredEntry[];
}

/**
 * Honest output disposition reported by the host that performed the save.
 */
export type OutputDisposition = "native-publication" | "browser-save-initiated" | "browser-save-ready" | "display-only";

/**
 * Host-neutral placement of one tile in the output image, projected from
 * the core tile plan. `position` is the top-left output corner;
 * `expected_size` is the planned extent when the plan declares it (absent
 * when only decoding reveals the extent); `canvas` is the declared output
 * size when the plan declares one; `processing` is the stable recipe id
 * the host must apply to the acquired bytes before decoding. Native
 * assembly and browser canvas hosts consume the same values.
 */
export interface TilePlacement {
    position: Point;
    expected_size: Size | undefined;
    canvas: Size | undefined;
    processing: ProcessingRecipe;
    /**
     * Whether a successful probe is also part of the final output plan.
     */
    probe_output?: boolean;
}

/**
 * One ordered catalog slot: a ready image or a request to resolve one.
 */
export type CatalogEntry = ({ kind: "image" } & Image) | ({ kind: "image-request" } & ImageRequest);

/**
 * One ordered discovery root. `contents` is omitted when the host only has
 * a reference and discovery should acquire it normally.
 */
export interface JobInput {
    url: string;
    contents?: string;
}

/**
 * One portable resource description. URI text is preserved exactly after
 * the core's approved normalization; secret headers are never carried here
 * (hosts attach scoped authorization out-of-band and redact logs).
 */
export interface ResourceRequest {
    id: number;
    uri: string;
    headers?: Header[];
    purpose: RequestPurpose;
}

/**
 * One still-deferred catalog entry: position plus follow-up URI.
 */
export interface DeferredEntry {
    position: number;
    uri: string;
}

/**
 * One tile settled as missing, with its full structured detail.
 */
export interface MissingTile {
    tile: number;
    failures: TileFailure[];
}

/**
 * Output summary: geometry, completeness, and the honest disposition.
 */
export interface OutputSummary {
    canvas: Size | undefined;
    format: OutputFormat;
    complete: boolean;
    missing: number[];
    disposition: OutputDisposition | undefined;
}

/**
 * Outstanding partial decision payload.
 */
export interface Decision {
    generation: number;
    missing: MissingTile[];
}

/**
 * Positive declared-canvas limits used by browser automatic selection.
 * Non-zero integer types reject invalid limits at the typed boundary.
 */
export interface BrowserSelectionLimits {
    maxWidth: number;
    maxHeight: number;
    maxArea: number;
}

/**
 * Purpose of a resource request (metadata vs tile vs probe).
 */
export type RequestPurpose = "metadata" | "tile" | "probe";

/**
 * Stable code for a host-observed fetch failure.
 *
 * Variant identifiers are the protocol's serialized values, so this enum
 * preserves the pre-existing wire vocabulary without rename tables.
 */
export type FetchFailureCode = "TRANSPORT_HTTP_ERROR" | "DISCOVERY_HTTP_ERROR" | "UPSTREAM_RATE_LIMITED" | "TRANSPORT_POLICY_DENIED" | "PROXY_BUDGET_EXCEEDED" | "PROXY_ERROR" | "PROXY_NETWORK_ERROR" | "PROXY_RATE_LIMITED" | "DISCOVERY_FAILED" | "TRANSPORT_TIMEOUT" | "TRANSPORT_NETWORK_ERROR" | "TRANSPORT_CANCELLED" | "TRANSPORT_BAD_URL" | "TRANSPORT_BAD_REDIRECT" | "TRANSPORT_REDIRECT_LIMIT" | "TRANSPORT_SIZE_LIMIT";

/**
 * Stable ordered catalog projection (never exposes private core enums).
 */
export interface Catalog {
    entries: CatalogEntry[];
}

/**
 * Structured facts for one failed tile attempt (bounded diagnostics).
 */
export interface TileFailure {
    code: string;
    category: FailureCategory;
    http?: number;
    retry_after_ms?: number;
    detail?: string;
}

/**
 * Terminal outcome, set exactly once.
 */
export type Terminal = { type: "completed" } | { type: "partial-completed"; missing: number[] } | { type: "failed"; error: Error } | { type: "cancelled" };

/**
 * The browser output representation requested by the job engine.
 */
export type OutputFormat = "png";

/**
 * Typed argument for the pure WASM tile-processing operation.
 */
export interface ProcessingRequest {
    recipe: ProcessingRecipe;
}

/**
 * Unit progress for the active phase (totals stay unknown until the plan
 * resolves).
 */
export interface Progress {
    completed: number;
    total: number | undefined;
}

export interface Error {
    code: string;
    phase: ErrorPhase;
    retryable: boolean;
    message: string;
    recovery?: RecoveryAction[];
    request?: string;
    transport?: ErrorTransport;
    blocked_reason?: BlockedReason;
    resource_kind?: ResourceKind;
    http?: number;
    preview?: string;
    detail?: string;
}

export interface FetchFailure {
    code: FetchFailureCode;
    retryable: boolean;
    message: string;
    recovery?: RecoveryAction[];
    transport: ErrorTransport;
    blocked_reason?: BlockedReason;
    http?: number;
    /**
     * Host-observed `retry-after` in milliseconds, when the response
     * carried one. The engine waits at least this long before the retry.
     */
    retry_after_ms?: number;
    preview?: string;
    detail?: string;
}

export interface Header {
    name: string;
    value: string;
}

export interface Level {
    label: string;
    size?: Size;
    tileSize?: Size;
}

export interface RecoveryAction {
    id: string;
    kind: RecoveryKind;
    scope: string;
    rationale: string;
}

export interface SessionConfig {
    max_concurrent_fetches?: number;
    max_tiles?: number;
    max_retries?: number;
    /**
     * Opt in to browser selection using the largest ready image and the
     * largest level that fits these declared canvas limits.
     */
    browser_selection?: BrowserSelectionLimits;
}

export type BlockedReason = "access-required" | "blocked-ipv4" | "blocked-ipv6" | "cancelled" | "content-type" | "dns-rebinding" | "dns-rebinding-v6" | "forbidden" | "invalid-url" | "limit-exceeded" | "loopback-host" | "malformed" | "malformed-body" | "method" | "network" | "non-standard-port" | "origin" | "private-host" | "protocol-version" | "redirect-limit" | "redirect-target" | "scheme" | "signed-query" | "source-document-lost" | "throttled" | "userinfo";

export type DispatchResult = { status: "ok"; messages: HostEffect[]; snapshot: Snapshot } | { status: "error"; error: Error };

export type ErrorPhase = "handshake" | "validation" | "discovery" | "acquisition" | "decode" | "processing" | "output" | "publication" | "cleanup";

export type ErrorTransport = "direct" | "metadata-proxy" | "browser-session" | "native" | "display-only";

export type HostCompletion = { type: "provide-resource"; request: number; bytes: number[]; final_uri?: string } | { type: "provide-fetch-failure"; request: number; error: FetchFailure } | { type: "provide-probe-outcome"; request: number; outcome: ProbeOutcome } | { type: "provide-display-outcome"; request: number } | { type: "tile-acquired"; request: number } | { type: "retry-timer-elapsed"; effect: number } | { type: "finalization-succeeded"; effect: number; disposition: OutputDisposition } | { type: "finalization-failed"; effect: number; error: Error };

export type HostEffect = { type: "acquire-resource"; request: ResourceRequest } | { type: "acquire-tile"; request: ResourceRequest; tile: number; placement: TilePlacement } | { type: "finalize-output"; effect: number; partial: boolean; format: OutputFormat; canvas: Size | undefined } | { type: "wait-retry-timer"; effect: number; tile: number; attempt: number; delay_ms: number } | { type: "cancel-work" } | { type: "request-decision"; generation: number };

export type JobCommand = { type: "start"; inputs: JobInput[] } | { type: "select-image"; image: number } | { type: "follow-deferred"; image: number } | { type: "select-level"; level: number } | { type: "answer-partial"; generation: number; decision: RecoveryChoice } | { type: "cancel" } | { type: "pause" } | { type: "resume" };

export type JobState = "Created" | "Discovering" | "AwaitingImageSelection" | "AwaitingLevelSelection" | "Planning" | "AcquiringTiles" | "AwaitingPartialDecision" | "Finalizing" | "Cancelling" | "Completed" | "PartiallyCompleted" | "Failed" | "Cancelled";

export type ProbeOutcome = { status: "missing" } | { status: "available"; width: number; height: number };

export type RecoveryChoice = "keep" | "retry" | "discard";

export type RecoveryKind = "retry" | "edit-input" | "choose-output" | "grant-permission" | "change-transport" | "keep-partial" | "discard-partial" | "handoff-to-native";

export type ResourceKind = "metadata" | "tile" | "probe" | "output";


/**
 * The `Session` export: owns one job.
 */
export class Session {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Apply one core processing recipe to tile bytes (pure: no job
     * state, same recipes as the discovery adapter).
     */
    applyProcessing(request: ProcessingRequest, bytes: Uint8Array): Uint8Array;
    /**
     * Run one typed user command and return its ordered host effects
     * plus the canonical snapshot after the answer. User commands
     * never carry bytes or claim publication.
     */
    command(command: JobCommand): DispatchResult;
    /**
     * Answer one outstanding host effect and return its ordered host
     * effects plus the canonical snapshot after the answer. Only
     * completions carry bytes, failures, observations, and
     * publication claims.
     */
    complete(completion: HostCompletion): DispatchResult;
    /**
     * Cancel/release session resources; repeat-safe (`dispose`).
     */
    dispose(): DispatchResult;
    /**
     * Validate typed configuration and own exactly one job session.
     */
    constructor(config: SessionConfig);
    /**
     * Project the canonical engine snapshot for the active job.
     * Absolute state for UI rendering; issues no work.
     */
    snapshot(): Snapshot;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_session_free: (a: number, b: number) => void;
    readonly session_applyProcessing: (a: number, b: any, c: number, d: number) => [number, number, number, number];
    readonly session_command: (a: number, b: any) => [number, number, number];
    readonly session_complete: (a: number, b: any) => [number, number, number];
    readonly session_dispose: (a: number) => [number, number, number];
    readonly session_new: (a: any) => [number, number, number];
    readonly session_snapshot: (a: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
