/* tslint:disable */
/* eslint-disable */
/**
 * A closed byte transformation applied before image decoding.
 */
export type ProcessingRecipe = "none" | "google-arts-decrypt";

/**
 * A pixel size (output canvas or planned tile extent).
 */
export interface SizeDto {
    width: number;
    height: number;
}

/**
 * A position in the output image, in pixels from the top-left corner.
 */
export interface PointDto {
    x: number;
    y: number;
}

/**
 * Extension-to-native messages. Browser manifest enforcement authenticates
 * the sender; challenges and nonces provide session binding and replay defense.
 */
export type NativeHostRequest = { kind: "handshake"; protocol?: string | undefined; clientVersion?: number | undefined } | { kind: "negotiate"; clientVersion: number; jobId: string; extensionId?: string | undefined } | { kind: "consent"; challenge: string; nonce: string; jobId: string; origins: string[]; cookieNames?: string[]; confirmed: boolean } | { kind: "credential"; challenge: string; nonce: string; jobId: string; sourceUrl: string; origins: string[]; cookies?: NativeCookie[] } | { kind: "decline"; challenge: string };

/**
 * Host-neutral placement of one tile in the output image, projected from
 * the core tile plan. `position` is the top-left output corner;
 * `expected_size` is the planned extent when the plan declares it (absent
 * when only decoding reveals the extent); `canvas` is the declared output
 * size when the plan declares one; `processing` is the stable recipe id
 * the host must apply to the acquired bytes before decoding. Native
 * assembly and browser canvas hosts consume the same values.
 */
export interface TilePlacementDto {
    position: PointDto;
    expected_size: SizeDto | undefined;
    canvas: SizeDto | undefined;
    processing: ProcessingRecipe;
    /**
     * Whether a successful probe is also part of the final output plan.
     */
    probe_output?: boolean;
}

/**
 * One cookie transferred after explicit, origin-scoped consent.
 */
export interface NativeCookie {
    name: string;
    value: string;
    origin: string;
}

/**
 * One ordered discovery root. `contents` is omitted when the host only has
 * a reference and discovery should acquire it normally.
 */
export interface JobInputDto {
    url: string;
    contents?: string;
}

/**
 * One portable resource description. URI text is preserved exactly after
 * the core's approved normalization; secret headers are never carried here
 * (hosts attach scoped authorization out-of-band and redact logs).
 */
export interface RequestDto {
    id: number;
    uri: string;
    headers?: HeaderDto[];
    purpose: RequestPurpose;
}

/**
 * Opaque handle to one arena generation. Serialize-safe for JS transfer.
 */
export interface ArenaHandle {
    /**
     * Slot index. Never reused for a different live allocation without a
     * generation bump.
     */
    id: number;
    /**
     * Allocation generation of this slot. Mismatches are stale, never
     * use-after-free.
     */
    generation: number;
}

/**
 * Purpose of a resource request (metadata vs tile vs probe).
 */
export type RequestPurpose = "metadata" | "tile" | "probe";

/**
 * Stable ordered catalog projection (never exposes private core enums).
 */
export interface CatalogDto {
    images: ImageDto[];
}

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
 * Typed reference to bytes owned by the WASM arena.
 */
export interface BufferHandle {
    id: number;
    generation: number;
    length: number;
    checksum?: string;
}

export interface ErrorDto {
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

export interface FetchFailureDto {
    code: string;
    retryable: boolean;
    message: string;
    recovery?: RecoveryAction[];
    transport: ErrorTransport;
    blocked_reason?: BlockedReason;
    http?: number;
    preview?: string;
    detail?: string;
}

export interface HeaderDto {
    name: string;
    value: string;
}

export interface ImageDto {
    title?: string;
    format: string;
    width: number;
    height: number;
    readiness: Readiness;
    sourceKind: string;
    levels: LevelDto[];
}

export interface LevelDto {
    label: string;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
}

export interface RecoveryAction {
    id: string;
    kind: RecoveryKind;
    scope: string;
    rationale: string;
}

export interface SessionConfig {
    max_buffer_bytes?: number;
    max_total_bytes?: number;
    max_buffers?: number;
    max_concurrent_fetches?: number;
    max_concurrent_decodes?: number;
    max_tiles?: number;
    max_retries?: number;
}

export type BlockedReason = "access-required" | "blocked-ipv4" | "blocked-ipv6" | "cancelled" | "content-type" | "dns-rebinding" | "dns-rebinding-v6" | "forbidden" | "invalid-url" | "limit-exceeded" | "loopback-host" | "malformed" | "malformed-body" | "method" | "network" | "non-standard-port" | "origin" | "private-host" | "protocol-version" | "redirect-limit" | "redirect-target" | "redirect-unavailable" | "scheme" | "signed-query" | "source-document-lost" | "throttled" | "userinfo";

export type DispatchResult = { status: "ok"; messages: HostMessage[] } | { status: "error"; error: ErrorDto };

export type ErrorPhase = "handshake" | "validation" | "discovery" | "acquisition" | "decode" | "processing" | "output" | "publication" | "cleanup";

export type ErrorTransport = "direct" | "metadata-proxy" | "browser-session" | "native" | "display-only";

export type HostEffect = { type: "acquire-resource"; request: RequestDto } | { type: "acquire-tile"; request: RequestDto; tile: number; placement: TilePlacementDto } | { type: "finalize-output"; partial: boolean; format: OutputFormat; canvas: SizeDto | undefined } | { type: "cancel-work" } | { type: "request-decision"; generation: number };

export type HostMessage = ({ kind: "effect" } & HostEffect) | ({ kind: "event" } & JobEvent);

export type JobCommand = { type: "start"; inputs: JobInputDto[] } | { type: "provide-resource"; request: number; buffer: BufferHandle; final_uri?: string } | { type: "provide-fetch-failure"; request: number; error: FetchFailureDto } | { type: "select-image"; image: number } | { type: "select-level"; level: number } | { type: "provide-probe-outcome"; request: number; outcome: ProbeOutcome } | { type: "provide-display-outcome"; request: number } | { type: "recovery-choice"; generation: number; choice: RecoveryChoice } | { type: "finalization-succeeded" } | { type: "finalization-failed"; error: ErrorDto } | { type: "cancel" } | { type: "pause" } | { type: "resume" };

export type JobEvent = { type: "job-state"; state: JobState } | { type: "catalog"; catalog: CatalogDto } | { type: "progress"; acquired: number; total: number } | { type: "warning"; error: ErrorDto } | { type: "recovery-request"; generation: number; actions: RecoveryAction[] } | { type: "completed" } | { type: "partial-completed" } | { type: "failed"; error: ErrorDto } | { type: "cancelled" } | { type: "paused" } | { type: "resumed" };

export type JobState = "Created" | "Discovering" | "AwaitingImageSelection" | "AwaitingLevelSelection" | "Planning" | "AcquiringTiles" | "AwaitingPartialDecision" | "Finalizing" | "Cancelling" | "Completed" | "PartiallyCompleted" | "Failed" | "Cancelled";

export type ProbeOutcome = { status: "missing" } | { status: "available"; width: number; height: number };

export type Readiness = "ready" | "deferred";

export type RecoveryChoice = "keep" | "retry" | "discard";

export type RecoveryKind = "retry" | "edit-input" | "choose-output" | "grant-permission" | "change-transport" | "keep-partial" | "discard-partial" | "handoff-to-native";

export type ResourceKind = "metadata" | "tile" | "probe" | "output";


/**
 * The `Session` export: owns one job and one byte arena.
 */
export class Session {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Reserve `length` bytes for host-supplied data (`buffers`).
     */
    allocateBuffer(length: number): ArenaHandle;
    /**
     * Apply one core processing recipe to tile bytes (pure: no job
     * state, same recipes as the discovery adapter).
     */
    applyProcessing(request: ProcessingRequest, bytes: Uint8Array): Uint8Array;
    /**
     * Project an arena handle onto its canonical protocol reference
     * (`buffers`): typed `provide-resource` commands carry a
     * `BufferHandle`, distinct from the
     * arena form `allocateBuffer` returns.
     */
    bufferHandle(handle: ArenaHandle): BufferHandle;
    /**
     * Seal one buffer for a subsequent correlated command (`buffers`).
     */
    commitBuffer(handle: ArenaHandle, actual: number): void;
    /**
     * Run one typed command and return its ordered host messages.
     */
    dispatch(command: JobCommand): DispatchResult;
    /**
     * Cancel/release session resources; repeat-safe (`dispose`).
     */
    dispose(): DispatchResult;
    /**
     * Release a buffer handle; idempotent (`buffers`).
     */
    freeBuffer(handle: ArenaHandle): void;
    /**
     * Validate typed configuration and own exactly one job session.
     */
    constructor(config: SessionConfig);
    /**
     * Move adapter-held bytes out exactly once (`buffers`).
     */
    takeBuffer(handle: ArenaHandle): Uint8Array;
    /**
     * Copy host bytes into an uncommitted allocation (`buffers`).
     */
    writeBuffer(handle: ArenaHandle, offset: number, data: Uint8Array): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_session_free: (a: number, b: number) => void;
    readonly session_allocateBuffer: (a: number, b: number) => [number, number, number];
    readonly session_applyProcessing: (a: number, b: any, c: number, d: number) => [number, number, number, number];
    readonly session_bufferHandle: (a: number, b: any) => [number, number, number];
    readonly session_commitBuffer: (a: number, b: any, c: number) => [number, number];
    readonly session_dispatch: (a: number, b: any) => [number, number, number];
    readonly session_dispose: (a: number) => [number, number, number];
    readonly session_freeBuffer: (a: number, b: any) => [number, number];
    readonly session_new: (a: any) => [number, number, number];
    readonly session_takeBuffer: (a: number, b: any) => [number, number, number, number];
    readonly session_writeBuffer: (a: number, b: any, c: number, d: number, e: number) => [number, number];
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
