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
 * Batched CSS queries against inert, UTF-8 HTML. Parsing never fetches or executes.
 */
export interface HtmlQuery {
    source: string;
    selectors: string[];
}

/**
 * Compact coverage for a regular, row-major tile plan. Requests remain lazy.
 */
export interface OutputGrid {
    /**
     * Cell dimensions before overlap and edge clipping.
     */
    tile_size: Size;
    /**
     * Additional pixels on each side, clipped to the canvas.
     */
    overlap: Size;
}

/**
 * Current filesystem availability, queried separately from job completion.
 */
export type SavedOutputState = "available" | "deleted";

/**
 * Desktop completion plus its independently owned saved-file reference.
 */
export interface DesktopOutput {
    output: Output;
    saved_output: SavedOutput | undefined;
}

/**
 * Durable native reference to a published output; filesystem paths stay in the shell.
 */
export interface SavedOutput {
    id: string;
    filename: string;
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
 * Host-neutral placement of one tile, projected from the core tile plan:
 * `position` is the top-left output corner, `expected_size` the planned
 * extent when declared, `canvas` the declared output size when declared,
 * and `processing` the recipe id the host applies before decoding.
 */
export interface TilePlacement {
    position: Point;
    expected_size: Size | undefined;
    canvas: Size | undefined;
    processing: ProcessingRecipe;
    /**
     * Probe/output participation; see [`TileRole`].
     */
    role: TileRole;
}

/**
 * How an acquired tile participates in probing and final output. `probe`
 * marks adaptive-probe acquisitions (a miss is an observation, never an
 * output failure); `output` marks acquisitions joining the final canvas.
 * Every planned tile sets at least one flag; `RequestPurpose` on a tile
 * request derives from `probe` and never disagrees with it.
 */
export interface TileRole {
    probe: boolean;
    output: boolean;
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
 * One typed failure. Grouped by domain: transport and fetch, discovery,
 * job and planning, tiles, output, control, internals, and the composable
 * [`Error::Resource`] context wrapper that preserves the exact URI and
 * resource kind of any underlying failure.
 */
export type Error = ({ kind: "http-error" } & { status: number; retry_after_ms?: number; preview?: string; transport: ErrorTransport } & Failure) | ({ kind: "rate-limited" } & { retry_after_ms?: number; transport: ErrorTransport } & Failure) | ({ kind: "timeout" } & { transport: ErrorTransport } & Failure) | ({ kind: "network-failure" } & { transport: ErrorTransport } & Failure) | ({ kind: "policy-denied" } & { blocked_reason: BlockedReason; transport: ErrorTransport } & Failure) | ({ kind: "bad-url" } & Failure) | ({ kind: "bad-redirect" } & Failure) | { kind: "redirect-limit"; max: number } | { kind: "size-limit"; max_bytes: number } | { kind: "cancelled" } | { kind: "proxy-budget-exceeded" } | ({ kind: "proxy-error" } & { transport: ErrorTransport } & Failure) | ({ kind: "no-image-found" } & Failure) | ({ kind: "malformed-metadata" } & Failure) | { kind: "unknown-format"; format: string } | { kind: "empty-resource" } | ({ kind: "resource-limit" } & Failure) | { kind: "deferred-limit"; max: number } | ({ kind: "discovery-failed" } & { cause?: Error } & Failure) | ({ kind: "invalid-input" } & Failure) | ({ kind: "invalid-options" } & Failure) | ({ kind: "invalid-state" } & Failure) | { kind: "duplicate" } | { kind: "stale" } | { kind: "plan-empty" } | ({ kind: "plan-invalid" } & Failure) | { kind: "no-usable-tiles"; transient: boolean; retry_after_ms?: number } | { kind: "partial-discarded"; transient: boolean; retry_after_ms?: number } | ({ kind: "decode-failed" } & Failure) | ({ kind: "processing-failed" } & Failure) | { kind: "limit-exceeded"; limit: LimitContext } | ({ kind: "encode-failed" } & Failure) | ({ kind: "write-failed" } & Failure) | { kind: "output-exists" } | ({ kind: "destination-denied" } & Failure) | ({ kind: "unsupported-extension" } & Failure) | ({ kind: "output-unavailable" } & Failure) | { kind: "output-no-parent" } | ({ kind: "launch-failed" } & Failure) | { kind: "output-denied" } | { kind: "output-not-found" } | { kind: "invoke-failed" } | ({ kind: "start-failed" } & Failure) | ({ kind: "choice-failed" } & Failure) | { kind: "invalid-url" } | ({ kind: "invalid-settings" } & Failure) | ({ kind: "registration-failed" } & Failure) | ({ kind: "internal" } & Failure) | { kind: "shell-lock" } | ({ kind: "binding-invalid-value" } & Failure) | { kind: "interaction-expired" } | { kind: "auth-forbidden-header" } | { kind: "resource"; request: string; resource_kind: ResourceKind; source: Error };

/**
 * Output preflight after geometry probes and before ordinary acquisitions.
 * Positioned or unresolved coverage has no grid and must finalize safely.
 */
export interface OutputPlan {
    canvas: Size | undefined;
    grid: OutputGrid | undefined;
    tile_count: number;
    format: OutputFormat;
    title: string | undefined;
}

/**
 * Output summary: geometry, completeness, and the honest disposition.
 */
export interface Output {
    canvas: Size | undefined;
    format: OutputFormat;
    missing: number[];
    disposition: OutputDisposition;
}

/**
 * Purpose of a resource request (metadata vs tile vs probe).
 */
export type RequestPurpose = "metadata" | "tile" | "probe";

/**
 * Selected elements in document order, with decoded attributes and textContent.
 */
export type HtmlDocument = Record<string, HtmlElement[]>;

/**
 * Stable ordered catalog projection (never exposes private core enums).
 */
export interface Catalog {
    entries: CatalogEntry[];
}

/**
 * Structured facts behind an output-limit refusal. Every field is optional
 * because only some limits know some facts; absent facts never fabricate
 * display text.
 */
export interface LimitContext {
    reason: LimitReason;
    dimensions?: Size;
    bytes_required?: number;
    bytes_available?: number;
}

/**
 * The requested output encoding.
 */
export type OutputFormat = "png" | "jpeg" | "tiff" | "zif" | "webp" | "iiif-dir";

/**
 * The shared failure context, defined once instead of per variant:
 * `request` preserves the exact URI when known and `detail` carries the
 * bounded diagnostic text (usually the preserved cause chain).
 */
export interface Failure {
    request?: string;
    detail?: string;
}

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

/**
 * Which output limit refused the job. Structured limit facts live in
 * [`LimitContext`]; `message` prose is presentation only and is never a
 * data channel between languages.
 */
export type LimitReason = "memory" | "jpeg-side" | "webp-side";

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
    parseHtml(query: HtmlQuery,): Promise<HtmlDocument>;
    probe(tile: Tile,): Promise<ProbeOutcome>;
    beginOutput(plan: OutputPlan,): Promise<void>;
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


export interface HtmlElement {
    name: string;
    attributes: Record<string, string>;
    text: string;
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


/**
 * Whether a source URL carries secret-bearing query or fragment keys.
 */
export function hasSecretParams(url: string): boolean;

/**
 * The retry policy of `Error::retryable()`, exposed at the boundary:
 * one policy in Rust; the shared UI reads the boundary-stamped
 * `retryable` hint as plain data.
 */
export function isRetryable(error: any): boolean;

/**
 * The secret/credential query-key policy of `SENSITIVE_QUERY_KEYS`,
 * exposed at the boundary: one vocabulary in Rust. The TypeScript list
 * exists only for pure callers that load no runtime.
 */
export function isSecretKey(key: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly applyProcessing: (a: any, b: number, c: number) => [number, number, number, number];
    readonly dezoomify: (a: any, b: any, c: any) => any;
    readonly hasSecretParams: (a: number, b: number) => number;
    readonly isRetryable: (a: any) => [number, number, number];
    readonly isSecretKey: (a: number, b: number) => number;
    readonly wasm_bindgen_aa50da02252d0a0c___convert__closures_____invoke___js_sys_28922c544317ab39___Function_fn_wasm_bindgen_aa50da02252d0a0c___JsValue_____wasm_bindgen_aa50da02252d0a0c___sys__Undefined___js_sys_28922c544317ab39___Function_fn_wasm_bindgen_aa50da02252d0a0c___JsValue_____wasm_bindgen_aa50da02252d0a0c___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_aa50da02252d0a0c___convert__closures_____invoke___wasm_bindgen_aa50da02252d0a0c___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_aa50da02252d0a0c___JsError___true_: (a: number, b: number, c: any) => [number, number];
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
