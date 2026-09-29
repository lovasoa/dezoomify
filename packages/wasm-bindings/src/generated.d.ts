/* tslint:disable */
/* eslint-disable */

export function dezoomify(inputs: JobInput[], options: Options, host: Host): Promise<Output>;
export function applyProcessing(recipe: ProcessingRecipe, bytes: Uint8Array): Uint8Array;


/**
 * A closed byte transformation applied before image decoding.
 */
export type ProcessingRecipe = "none" | "google-arts-decrypt";

/**
 * A direct resource read, including its redirected base address.
 */
export interface ResourceResponse {
    bytes: Uint8Array;
    final_uri: string | undefined;
}

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
    levels: Level[];
}

/**
 * A still-deferred catalog entry: the resource to acquire before an image
 * can be planned. The algorithm resolves `uri` within its deferred-follow limit.
 */
export interface ImageRequest {
    title?: string;
    uri: string;
}

/**
 * Final plan position and index of a tile already acquired during probing.
 */
export interface ReusedTile {
    index: number;
    position: Point;
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
 * Host-observed fetch facts. Retry and recovery policy belongs to the shared algorithm.
 */
export interface FetchFailure {
    code: FetchFailureCode;
    message: string;
    transport: ErrorTransport;
    blocked_reason?: BlockedReason;
    http?: number;
    /**
     * Host-observed `retry-after` in milliseconds, when the response
     * carried one. The shared algorithm waits at least this long before the retry.
     */
    retry_after_ms?: number;
    preview?: string;
    detail?: string;
}

/**
 * One discovery input. An omitted kind is a user-supplied source for
 * products that have no browser observations.
 */
export interface JobInput {
    url: string;
    contents?: string;
    kind?: DiscoveryInputKind;
}

/**
 * One ordered catalog slot: a ready image or a request to resolve one.
 */
export type CatalogEntry = ({ kind: "image" } & Image) | ({ kind: "image-request" } & ImageRequest);

/**
 * One portable resource description. URI text is preserved exactly after
 * the core's approved normalization; secret headers are never carried here
 * (hosts attach scoped authorization out-of-band).
 */
export interface ResourceRequest {
    uri: string;
    headers?: Header[];
    purpose: RequestPurpose;
}

/**
 * One tile settled as missing, with its full structured detail.
 */
export interface MissingTile {
    tile: number;
    failures: Error[];
}

/**
 * Output summary: geometry, completeness, and the honest disposition.
 */
export interface Output {
    canvas: Size | undefined;
    format: OutputFormat;
    complete: boolean;
    missing: number[];
    disposition: OutputDisposition;
}

/**
 * Purpose of a resource request (metadata vs tile vs probe).
 */
export type RequestPurpose = "metadata" | "tile" | "probe";

/**
 * Stable code for a host-observed fetch failure.
 *
 * Variant identifiers are the serialized values, so this enum
 * preserves stable error codes.
 */
export type FetchFailureCode = "TRANSPORT_HTTP_ERROR" | "DISCOVERY_HTTP_ERROR" | "UPSTREAM_RATE_LIMITED" | "TRANSPORT_POLICY_DENIED" | "PROXY_BUDGET_EXCEEDED" | "PROXY_ERROR" | "PROXY_NETWORK_ERROR" | "PROXY_RATE_LIMITED" | "DISCOVERY_FAILED" | "TRANSPORT_TIMEOUT" | "TRANSPORT_NETWORK_ERROR" | "TRANSPORT_CANCELLED" | "TRANSPORT_BAD_URL" | "TRANSPORT_BAD_REDIRECT" | "TRANSPORT_REDIRECT_LIMIT" | "TRANSPORT_SIZE_LIMIT";

/**
 * Stable ordered catalog projection (never exposes private core enums).
 */
export interface Catalog {
    entries: CatalogEntry[];
}

/**
 * The requested output encoding.
 */
export type OutputFormat = "png" | "jpeg" | "tiff" | "zif" | "webp" | "iiif-dir";

/**
 * The source of discovery evidence. Products report facts; core discovery
 * decides when a supplied document or observed resource is relevant.
 */
export type DiscoveryInputKind = "source" | "observed-document" | "observed-resource";

/**
 * Unit progress for the active phase (totals stay unknown until the plan
 * resolves).
 */
export interface Progress {
    phase: ProgressPhase;
    source_format: string | undefined;
    title: string | undefined;
    selected: Size | undefined;
    maximum: Size | undefined;
    completed: number;
    total: number | undefined;
}

/**
 * Versioned, local-only support report. Limits include protected evidence.
 */
export interface DiagnosticReport {
    schema_version: number;
    id: string;
    context: Record<string, DiagnosticValue>;
    counters: Record<string, number>;
    failures: DiagnosticFailureGroup[];
    records: DiagnosticRecord[];
    outcome: DiagnosticRecord | undefined;
    omitted_records: number;
    truncated_fields: number;
}

export interface DiagnosticFailureGroup {
    key: string;
    count: number;
    first: DiagnosticRecord;
    last: DiagnosticRecord;
}

export interface DiagnosticRecord {
    sequence: number;
    elapsed_ms: number;
    level: DiagnosticLevel;
    event: string;
    fields: Record<string, DiagnosticValue>;
}

export interface Error {
    retry_after_ms?: number;
    code: string;
    phase: ErrorPhase;
    retryable?: boolean;
    message: string;
    request?: string;
    transport?: ErrorTransport;
    blocked_reason?: BlockedReason;
    resource_kind?: ResourceKind;
    http?: number;
    preview?: string;
    detail?: string;
}

export interface FinishRequest {
    canvas: Size | undefined;
    format: OutputFormat;
    title: string | undefined;
    missing: number[];
    reused_tiles: ReusedTile[];
}

export interface Header {
    name: string;
    value: string;
}

export interface Host {
    fetch(request: ResourceRequest,interaction: Interaction,): Promise<ResourceRead>;
    probe(tile: Tile,): Promise<ProbeOutcome>;
    acquireTile(tile: Tile,): Promise<void>;
    finish(request: FinishRequest,): Promise<Output>;
    chooseImage(catalog: Catalog,): Promise<number>;
    chooseLevel(image: Image,): Promise<number>;
    choosePartial(missing: MissingTiles,): Promise<RecoveryChoice>;
    checkpoint(gate: Gate,): Promise<void>;
    sleep(delay_ms: number,): Promise<void>;
    report(progress: Progress): void;
    warn(message: string): void;
    settle(): Promise<void>;
}


export interface Level {
    label: string;
    size?: Size;
    tileSize?: Size;
}

export interface MissingTiles {
    missing: MissingTile[];
}

export interface Options {
    format?: string | undefined;
    selection?: SelectionPolicy;
    partial?: PartialPolicy;
    output?: OutputFormat;
    max_concurrent?: number;
    max_tiles?: number;
    max_retries?: number;
    max_bytes?: number;
    max_deferred_follows?: number;
    retry_base_delay_ms?: number;
}

export interface Tile {
    index: number;
    request: ResourceRequest;
    placement: TilePlacement;
}

export type BlockedReason = "access-required" | "blocked-ipv4" | "blocked-ipv6" | "cancelled" | "content-type" | "dns-rebinding" | "dns-rebinding-v6" | "forbidden" | "invalid-url" | "limit-exceeded" | "loopback-host" | "malformed" | "malformed-body" | "method" | "network" | "non-standard-port" | "origin" | "private-host" | "protocol-version" | "redirect-limit" | "redirect-target" | "scheme" | "signed-query" | "source-document-lost" | "throttled" | "userinfo";

export type DiagnosticLevel = "trace" | "debug" | "info" | "warn" | "error";

export type DiagnosticValue = string | number | boolean;

export type ErrorPhase = "validation" | "discovery" | "acquisition" | "decode" | "processing" | "output" | "publication" | "cleanup";

export type ErrorTransport = "direct" | "metadata-proxy" | "browser-session" | "native" | "display-only";

export type Gate = "cancellation" | "acquisition";

export type Interaction = "forbidden" | "allowed";

export type PartialPolicy = "prompt" | "keep" | "discard";

export type ProbeOutcome = { status: "missing" } | { status: "available"; width: number; height: number };

export type ProgressPhase = "discovery" | "planning" | "acquisition" | "output";

export type RecoveryChoice = "keep" | "retry" | "discard";

export type ResourceKind = "metadata" | "tile" | "probe" | "output";

export type ResourceRead = { kind: "response"; response: ResourceResponse } | { kind: "needs-access"; origin: string };

export type SelectionPolicy = { kind: "interactive" } | { kind: "fitting"; max_width: number; max_height: number; max_area: number } | { kind: "automatic"; image_index: number; largest: boolean; max_width: number | undefined; max_height: number | undefined; zoom_level: number | undefined };


export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly applyProcessing: (a: any, b: number, c: number) => [number, number, number, number];
    readonly dezoomify: (a: any, b: any, c: any) => any;
    readonly wasm_bindgen_2a67c6f173b08fad___convert__closures_____invoke___js_sys_c1f2febeb42441dd___Function_fn_wasm_bindgen_2a67c6f173b08fad___JsValue_____wasm_bindgen_2a67c6f173b08fad___sys__Undefined___js_sys_c1f2febeb42441dd___Function_fn_wasm_bindgen_2a67c6f173b08fad___JsValue_____wasm_bindgen_2a67c6f173b08fad___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_2a67c6f173b08fad___convert__closures_____invoke___wasm_bindgen_2a67c6f173b08fad___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_2a67c6f173b08fad___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
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
