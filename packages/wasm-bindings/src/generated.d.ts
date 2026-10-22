/* tslint:disable */
/* eslint-disable */

/** Discover and save one selected image from a batch of source/observation inputs.
 * Validates inputs and Options before I/O; awaits Host.settle on success or error.
 * Use a fresh Host and keep its dependencies alive until this promise settles.
 */
export function dezoomify(inputs: JobInput[], options: Options, host: Host): Promise<Output>;
export function applyProcessing(recipe: ProcessingRecipe, bytes: Uint8Array): Uint8Array;


/**
 * A closed byte transformation applied before image decoding.
 */
export type ProcessingRecipe = "none" | "google-arts-decrypt";

/**
 * A direct resource read, including its redirected base address. For a ranged
 * request, bytes cover exactly the requested interval; the Host validates this
 * contract before returning a successful response.
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
 * A probe's decoded pixel dimensions, or absence of a usable tile. Availability
 * also means output was retained when the requested `TileRole` includes output.
 */
export type ProbeOutcome = { status: "missing" } | { status: "available"; width: number; height: number };

/**
 * A resolved image: declared geometry and selectable levels.
 */
export interface Image {
    title?: string;
    sourceUrl?: string;
    /**
     * A complete, bounded single-tile level suitable for an optional preview.
     */
    preview?: Tile;
    format: string;
    size?: Size;
    levels: Level[];
}

/**
 * A resource read or a request for access the current policy could not provide.
 * Discovery may revisit `needs-access` with interaction allowed; it is not a
 * successful empty response or a transport failure.
 */
export type ResourceRead = { kind: "response"; response: ResourceResponse } | { kind: "needs-access"; origin: string };

/**
 * A still-deferred catalog entry: the resource to acquire before an image
 * can be planned. The algorithm resolves `uri` within its deferred-follow limit.
 */
export interface ImageRequest {
    title?: string;
    uri: string;
    size?: Size;
    /**
     * A bounded preview declared by this catalog, without resolving `uri`.
     */
    preview?: Tile;
}

/**
 * Batched CSS queries against inert, UTF-8 HTML. Parsing never fetches or executes.
 */
export interface HtmlQuery {
    source: string;
    selectors: string[];
}

/**
 * Checkpoints always check cancellation; `acquisition` also waits for pause or
 * retry approval. Neither gate stops in-flight work; cancellation still requires
 * awaiting job settlement.
 */
export type Gate = "cancellation" | "acquisition";

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
 * Core discovery/acquisition policy, validated by `dezoomify` before host I/O.
 * Hosts separately enforce transport, decode, and output resource limits.
 * Omitted serialized fields use core defaults; out-of-range limits fail the job.
 */
export interface Options {
    /**
     * Restrict discovery to a registered format id; absent or `auto` searches all.
     */
    format?: string | undefined;
    /**
     * Issue approval-required attempts after the automatic retry allowance.
     */
    interactive_retries?: boolean;
    output?: OutputFormat;
    /**
     * Maximum overlapping metadata reads or tile attempts; positive and no
     * greater than `max_tiles`.
     */
    max_concurrent?: number;
    /**
     * Positive limit applied separately to geometry probe calls and the final
     * tile plan (including reused probes and any reusable lower source levels).
     */
    max_tiles?: number;
    /**
     * Automatic retries per tile after attempt zero, including origin recovery.
     */
    max_retries?: number;
    /**
     * Byte limit for each fetched metadata body and initial supplied document.
     * Discovery also has an aggregate budget; hosts own tile/output limits.
     */
    max_bytes?: number;
    /**
     * Maximum selected deferred catalog entries followed before a ready image.
     */
    max_deferred_follows?: number;
    /**
     * First retry's backoff in milliseconds; see `retry_delay_ms` for clamping.
     */
    retry_base_delay_ms?: number;
    /**
     * Initial per-origin tile spacing. Zero leaves admission unpaced until
     * throttling is observed; a positive value enables adaptive pacing.
     */
    initial_tile_interval_ms?: number;
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
 * Desktop image-choice updates contain display thumbnails, never source pixels.
 */
export type ImageChoiceEvent = { kind: "catalog"; catalog: Catalog } | { kind: "preview"; index: number; thumbnail: string };

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
 * Finalization after successful preflight and all required acquisitions.
 * Probe output is already retained; `reused_tiles` assigns its final plan indices
 * by output position. A host may infer undeclared canvas dimensions from tiles.
 */
export interface FinishRequest {
    canvas: Size | undefined;
    format: OutputFormat;
    title: string | undefined;
    reused_tiles: ReusedTile[];
}

/**
 * Honest output disposition reported by the host that performed the save.
 */
export type OutputDisposition = "native-publication" | "browser-save-initiated" | "browser-save-ready" | "display-only";

/**
 * Host-neutral placement of one tile, projected from the core tile plan:
 * `position` is the top-left output corner, `expected_size` the planned
 * extent when declared, `canvas` the declared level size when declared
 * (the selected image, or a source level listed in `OutputPlan::source_levels`),
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
 * How an output owns its encoded image or pyramid.
 */
export type OutputLayout = "streaming" | "buffered" | "pyramid" | "directory";

/**
 * Native output capabilities, also exported as generated data for presentation.
 */
export interface OutputCodec {
    format: OutputFormat;
    name: string;
    extensions: string[];
    max_side?: number;
    control: OutputControl;
    layout: OutputLayout;
    hint: string;
    /**
     * Quality samples and estimated bytes/pixel, interpolated between samples.
     */
    size_coefficients: [number, number][];
}

/**
 * One acquisition attempt. The core owns retries; Hosts await approval for
 * optional attempts before performing I/O. Attempt zero is the initial request.
 * The core handles retry delays and origin pacing before calling the host.
 */
export interface TileAcquisition {
    tile: Tile;
    attempt: number;
    /**
     * This attempt exceeds the automatic allowance; acquire approval or return
     * a typed error (user cancellation is `cancelled`) before acquiring the tile.
     */
    requires_approval: boolean;
    /**
     * The preceding attempt's error, absent only on the initial attempt.
     */
    previous_failure: Error | undefined;
}

/**
 * One discovery input. An omitted kind is a user-supplied source for
 * products that have no browser observations.
 * A batch supplies evidence for one image selection, not independent jobs.
 */
export interface JobInput {
    /**
     * Source address and base for relative references; native hosts may accept paths.
     */
    url: string;
    /**
     * Supplied UTF-8 document instead of fetching `url`. Initial inputs must be
     * nonempty and within `Options.max_bytes`; observed metadata never follows links.
     */
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
 * A finite single `Range: bytes=start-end` asks the Host for exactly that
 * inclusive interval. Hosts validate partial response headers and body length
 * before returning bytes, and include the range in any resource cache key.
 */
export interface ResourceRequest {
    uri: string;
    headers?: Header[];
    purpose: RequestPurpose;
}

/**
 * One request with placement and an index scoped to its probe sequence or final
 * plan. Probe indices need not match final indices; `FinishRequest.reused_tiles`
 * maps retained output by position. The index is not a source zoom identifier.
 */
export interface Tile {
    index: number;
    request: ResourceRequest;
    placement: TilePlacement;
}

/**
 * One typed failure. Grouped by domain: transport and fetch, discovery,
 * job and planning, tiles, output, control, internals, and the composable
 * [`Error::Resource`] context wrapper that preserves the exact URI and
 * resource kind of any underlying failure.
 */
export type Error = ({ kind: "http-error" } & { status: number; retry_after_ms?: number; preview?: string; transport: ErrorTransport } & Failure) | ({ kind: "rate-limited" } & { retry_after_ms?: number; transport: ErrorTransport } & Failure) | ({ kind: "timeout" } & { transport: ErrorTransport } & Failure) | ({ kind: "network-failure" } & { transport: ErrorTransport } & Failure) | ({ kind: "policy-denied" } & { blocked_reason: BlockedReason; transport: ErrorTransport } & Failure) | ({ kind: "bad-url" } & Failure) | ({ kind: "bad-redirect" } & Failure) | { kind: "redirect-limit"; max: number } | { kind: "size-limit"; max_bytes: number } | { kind: "cancelled" } | { kind: "proxy-budget-exceeded" } | ({ kind: "proxy-error" } & { transport: ErrorTransport } & Failure) | ({ kind: "no-image-found" } & Failure) | ({ kind: "malformed-metadata" } & Failure) | { kind: "unknown-format"; format: string } | { kind: "empty-resource" } | ({ kind: "resource-limit" } & Failure) | { kind: "deferred-limit"; max: number } | ({ kind: "discovery-failed" } & { cause?: Error } & Failure) | ({ kind: "invalid-input" } & Failure) | ({ kind: "invalid-options" } & Failure) | ({ kind: "invalid-state" } & Failure) | { kind: "duplicate" } | { kind: "stale" } | { kind: "plan-empty" } | ({ kind: "plan-invalid" } & Failure) | { kind: "tile-failed"; tile: number; attempts: number; cause: Error } | ({ kind: "decode-failed" } & Failure) | ({ kind: "processing-failed" } & Failure) | { kind: "limit-exceeded"; limit: LimitContext } | ({ kind: "encode-failed" } & Failure) | ({ kind: "write-failed" } & Failure) | { kind: "output-exists" } | ({ kind: "destination-denied" } & Failure) | ({ kind: "unsupported-extension" } & Failure) | ({ kind: "output-unavailable" } & Failure) | { kind: "output-no-parent" } | ({ kind: "launch-failed" } & Failure) | { kind: "output-denied" } | { kind: "output-not-found" } | { kind: "invoke-failed" } | ({ kind: "start-failed" } & Failure) | ({ kind: "choice-failed" } & Failure) | { kind: "invalid-url" } | ({ kind: "invalid-settings" } & Failure) | ({ kind: "registration-failed" } & Failure) | ({ kind: "internal" } & Failure) | { kind: "shell-lock" } | ({ kind: "binding-invalid-value" } & Failure) | { kind: "interaction-expired" } | { kind: "auth-forbidden-header" } | { kind: "resource"; request: string; resource_kind: ResourceKind; source: Error };

/**
 * Output preflight after geometry probes and before ordinary acquisitions.
 * Retain output from successful probes. Without a grid, use individual tile
 * placements rather than assuming complete regular coverage.
 */
export interface OutputPlan {
    /**
     * Selected image dimensions in pixels; absent when geometry is undeclared.
     */
    canvas: Size | undefined;
    grid: OutputGrid | undefined;
    /**
     * Compatible lower source levels, in decreasing size, sharing `grid`.
     * Their tiles use level-local coordinates and `TilePlacement::canvas`.
     */
    source_levels?: Size[];
    /**
     * Final tile count across the selected and source levels, including reused
     * output probes but excluding missing and probe-only observations.
     */
    tile_count: number;
    format: OutputFormat;
    title: string | undefined;
}

/**
 * Output summary after every required tile has been acquired.
 */
export interface Output {
    canvas: Size | undefined;
    format: OutputFormat;
    disposition: OutputDisposition;
}

/**
 * Platform resources and interactions for one `dezoomify` invocation.
 *
 * Discovery and selection precede geometry probes, then output preflight,
 * ordinary tile acquisitions, and finalization. Probes may already retain
 * output. Acquisitions and metadata reads can overlap; completion order
 * is unspecified. The core owns retries, pacing, and backoff; hosts perform
 * individual attempts and own I/O, decoding, and output resources.
 *
 * On success or error, the core awaits `settle` after its other calls
 * have returned or their futures have been dropped. Hosts must track
 * work that outlives those futures. Signal cancellation through the host
 * and await the job; dropping a Rust job future skips this cleanup.
 * Keep the host and its dependencies alive until settlement completes;
 * use a fresh host for each job. Fallible methods return typed `Error`
 * values (TypeScript promises reject with the same serialized shapes).
 */
export interface Host {
    /**
     * Supply more discovery evidence under the interaction policy.
     * Return new or improved evidence; an empty batch exhausts the current
     * policy. The core may ask again, including with interaction allowed.
     */
    observe(interaction: Interaction,): Promise<JobInput[]>;
    /**
     * Read one resource, preserving its redirected base URI. Honor the
     * interaction policy and `ResourceRequest` range/credential rules.
     * Return the `needs-access` outcome when permission is unavailable.
     */
    fetch(request: ResourceRequest,interaction: Interaction,): Promise<ResourceRead>;
    /**
     * Query supplied HTML without executing scripts or loading resources.
     * Return selector-keyed matches in document order, excluding
     * template/noscript subtrees. Leave URLs for the core to resolve.
     */
    parseHtml(query: HtmlQuery,): Promise<HtmlDocument>;
    /**
     * Measure one geometry probe before output preflight. `missing` is a
     * search observation, not a failed output tile. Propagate cancellation
     * and output errors. On availability, retain the tile at its placement
     * for reuse if its role includes output.
     */
    probe(tile: Tile,): Promise<ProbeOutcome>;
    /**
     * Announce the resolved plan once, before ordinary acquisitions.
     * Preserve probe output. Hosts may preflight destinations and resource
     * requirements here; acceptance does not guarantee later allocation
     * or publication will succeed.
     */
    beginOutput(plan: OutputPlan,): Promise<void>;
    /**
     * Perform one tile attempt, awaiting any required approval before I/O.
     * Success means the tile has joined output; retain resources as needed
     * until finish/settlement. Calls for different tiles can overlap;
     * retries of the same tile are sequential and must not duplicate output.
     */
    acquireTile(request: TileAcquisition,): Promise<void>;
    /**
     * Finalize after all required tiles succeeded, including reused probes.
     * Called at most once; report the actual save disposition, which need
     * not mean a browser download has finished. Failure still leads to settle.
     */
    finish(request: FinishRequest,): Promise<Output>;
    /**
     * Return a zero-based index into `catalog.entries`, even for a single
     * entry. Selecting a deferred entry can lead to another catalog choice.
     * The core rejects out-of-range indices with `invalid-state`.
     */
    chooseImage(catalog: Catalog,): Promise<number>;
    /**
     * Return a zero-based index into `image.levels` in its supplied order,
     * not a source format's zoom identifier. The core checks the range.
     */
    chooseLevel(image: Image,): Promise<number>;
    /**
     * Check cancellation at either gate; the acquisition gate also waits
     * for pause/retry approval to clear. Pausing does not cancel work that
     * is already running. Return `cancelled` when cancellation is signalled.
     * Sample `HostTiming` after the gate opens, on the invocation's shared scale.
     */
    checkpoint(gate: Gate,): Promise<HostTiming>;
    /**
     * Wait at least `delay_ms` milliseconds for core-owned pacing or backoff,
     * or return `cancelled`. Return completion timing on the `HostTiming` scale.
     * Calls may overlap; leave scheduling and retries to the core.
     */
    sleep(delay_ms: number,): Promise<HostTiming>;
    /**
     * Deliver a progress snapshot synchronously. Totals may be unknown
     * during discovery/planning; completion is the job result, not a count.
     */
    report(progress: Progress): void;
    /**
     * Deliver a nonfatal discovery warning synchronously. Diagnostic
     * prose is for presentation, never a machine-readable failure kind.
     */
    warn(message: string): void;
    /**
     * Stop and drain remaining host work and release invocation resources,
     * including on validation failure before any other capability was called.
     * Preserve independently owned saved output. Cleanup must not fail or
     * replace the job result; after it completes, no job work may use resources.
     */
    settle(): Promise<void>;
}


/**
 * Presentation data derived from the codec registry, including automatic output.
 */
export interface OutputOption {
    format: OutputPreference;
    name: string;
    label_key?: string;
    hint: string;
    max_side?: number;
    description_max_side?: number;
    compression_supported: boolean;
    compression_warning_above?: number;
    /**
     * Estimated bytes/pixel for each integer compression value from 0 to 100.
     */
    compression_estimates: number[];
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
 * The meaning of the existing compression setting for a codec.
 */
export type OutputControl = { kind: "quality"; minimum: number; warning_below: number } | { kind: "effort" } | { kind: "none" };

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
export type DiscoveryInputKind = "source" | "observed-document" | "observed-resource" | "observed-metadata";

/**
 * Timing observed when a Host operation completes. Readings must be
 * nondecreasing with time and share a stable origin within one invocation.
 * Differences represent elapsed milliseconds; equal readings are allowed at
 * the clock's resolution. Timestamps are allowed, but dates are not required.
 */
export interface HostTiming {
    /**
     * Completion reading in milliseconds from the invocation's shared origin.
     */
    time_ms: number;
}

/**
 * Unit progress for the active phase (totals stay unknown until the plan
 * resolves).
 */
export interface Progress {
    phase: ProgressPhase;
    source_format: string | undefined;
    /**
     * Format-designated reusable URL for the selected image's catalog, if known.
     */
    source_url?: string;
    title: string | undefined;
    selected: Size | undefined;
    maximum: Size | undefined;
    completed: number;
    total: number | undefined;
    /**
     * Native pixel preparation, separate from acquired tile counts.
     */
    preparation?: OutputPreparation;
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
 * Whether a capability may ask for access: `forbidden` uses only existing access;
 * `allowed` may prompt but does not itself grant permission.
 */
export type Interaction = "forbidden" | "allowed";

/**
 * Which output limit refused the job. Structured limit facts live in
 * [`LimitContext`]; `message` prose is presentation only and is never a
 * data channel between languages.
 */
export type LimitReason = "memory" | { "codec-side": OutputFormat };

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

export interface Header {
    name: string;
    value: string;
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

export interface OutputPreparation {
    completed_pixels: number;
    total_pixels: number;
}

export type BlockedReason = "access-required" | "blocked-ipv4" | "blocked-ipv6" | "cancelled" | "content-type" | "dns-rebinding" | "dns-rebinding-v6" | "forbidden" | "invalid-url" | "limit-exceeded" | "loopback-host" | "malformed" | "malformed-body" | "method" | "network" | "non-standard-port" | "origin" | "private-host" | "protocol-version" | "redirect-limit" | "redirect-target" | "scheme" | "signed-query" | "source-document-lost" | "throttled" | "userinfo";

export type DiagnosticLevel = "trace" | "debug" | "info" | "warn" | "error";

export type DiagnosticValue = string | number | boolean;

export type ErrorTransport = "direct" | "metadata-proxy" | "browser-session" | "native" | "display-only";

export type OutputFormat = "png" | "jpeg" | "tiff" | "webp" | "avif" | "zif" | "iiif-dir";

export type OutputPreference = "auto" | "png" | "jpeg" | "tiff" | "webp" | "avif" | "zif" | "iiif-dir";

export type ProgressPhase = "discovery" | "planning" | "acquisition" | "output";

export type ResourceKind = "metadata" | "tile" | "probe" | "output";

export type RetryChoice = "retry" | "cancel";


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
