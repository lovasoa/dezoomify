//! Authoritative cross-language contract types. Every shared type is declared
//! here exactly once and `tsify` projects it into the WASM declaration.

use serde::{Deserialize, Serialize};
use std::num::{NonZeroU32, NonZeroU64};

// ---------------------------------------------------------------------------
// Requests and direct byte ownership
// ---------------------------------------------------------------------------

/// Purpose of a resource request (metadata vs tile vs probe).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum RequestPurpose {
    Metadata,
    Tile,
    Probe,
}

/// One portable resource description. URI text is preserved exactly after
/// the core's approved normalization; secret headers are never carried here
/// (hosts attach scoped authorization out-of-band and redact logs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ResourceRequest {
    pub id: u32,
    pub uri: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    pub purpose: RequestPurpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Header {
    pub name: String,
    pub value: String,
}

/// A position in the output image, in pixels from the top-left corner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Point {
    pub x: u32,
    pub y: u32,
}

/// A pixel size (output canvas or planned tile extent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

/// A closed byte transformation applied before image decoding.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ProcessingRecipe {
    #[default]
    None,
    GoogleArtsDecrypt,
}

/// Typed argument for the pure WASM tile-processing operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ProcessingRequest {
    pub recipe: ProcessingRecipe,
}

/// The browser output representation requested by the job engine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum OutputFormat {
    #[default]
    Png,
}

/// Host-neutral placement of one tile in the output image, projected from
/// the core tile plan. `position` is the top-left output corner;
/// `expected_size` is the planned extent when the plan declares it (absent
/// when only decoding reveals the extent); `canvas` is the declared output
/// size when the plan declares one; `processing` is the stable recipe id
/// the host must apply to the acquired bytes before decoding. Native
/// assembly and browser canvas hosts consume the same values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct TilePlacement {
    pub position: Point,
    pub expected_size: Option<Size>,
    pub canvas: Option<Size>,
    pub processing: ProcessingRecipe,
    /// Whether a successful probe is also part of the final output plan.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub probe_output: bool,
}

// ---------------------------------------------------------------------------
// Catalog and selection
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Level {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_size: Option<Size>,
}

/// A resolved image: declared geometry and selectable levels.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Image {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    pub source_kind: String,
    pub levels: Vec<Level>,
}

/// A still-deferred catalog entry: the resource to acquire before an image
/// can be planned. The host follows `uri` with a fresh bounded attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ImageRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub uri: String,
}

/// One ordered catalog slot: a ready image or a request to resolve one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum CatalogEntry {
    Image(Image),
    ImageRequest(ImageRequest),
}

/// Stable ordered catalog projection (never exposes private core enums).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
}

/// One ordered discovery root. `contents` is omitted when the host only has
/// a reference and discovery should acquire it normally.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct JobInput {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contents: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ProbeOutcome {
    Missing,
    Available {
        #[cfg_attr(feature = "typescript", tsify(type = "number"))]
        width: NonZeroU64,
        #[cfg_attr(feature = "typescript", tsify(type = "number"))]
        height: NonZeroU64,
    },
}

impl JobInput {
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            contents: None,
        }
    }
}

// User commands (UI -> job): intent that can never supply bytes, complete
// an effect, or claim publication. Host completions travel separately as
// [`HostCompletion`]; the split is structural, not documentary.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum JobCommand {
    Start {
        inputs: Vec<JobInput>,
    },
    SelectImage {
        image: u32,
    },
    /// Follow one still-deferred catalog entry within the same job
    /// (zero-based position). Bounded and cycle-guarded; the catalog is
    /// replaced on success with no new job ID.
    FollowDeferred {
        image: u32,
    },
    SelectLevel {
        level: u32,
    },
    /// Answer the outstanding partial decision. Same generation + decision
    /// vocabulary as the engine `AnswerPartial`; stale generations are
    /// rejected, never consumed in order.
    AnswerPartial {
        generation: u32,
        decision: RecoveryChoice,
    },
    Cancel,
    Pause,
    Resume,
}

// Host completions (host -> job): answers to outstanding [`HostEffect`]s.
// Only these carry bytes, failures, observations, and publication claims.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum HostCompletion {
    ProvideResource {
        request: u32,
        /// Resource body, carried directly in the completion. Nothing is
        /// retained adapter-side; tile success is body-free
        /// (`ProvideDisplayOutcome`) and never carries bytes.
        bytes: Vec<u8>,
        /// Post-redirect URL observed by the host, when it has one. Relative
        /// tile URLs resolve against this instead of the request URI.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_uri: Option<String>,
    },
    ProvideFetchFailure {
        request: u32,
        error: FetchFailure,
    },
    /// Probe observation for one outstanding `acquire-tile` with
    /// `purpose: probe`. Correlated by the adapter-minted request id (like
    /// `ProvideResource`); the adapter maps it to the engine tile ordinal
    /// and forwards `ProbeOutcome`. `ok=false` (or zero width/height)
    /// reports a missing probe.
    ProvideProbeOutcome {
        request: u32,
        outcome: ProbeOutcome,
    },
    /// Display-only observation for one outstanding `acquire-tile` in
    /// `AcquiringTiles`. The host has already retained a valid ordinary
    /// image element and the adapter forwards a typed `TileDisplayed`.
    ProvideDisplayOutcome {
        request: u32,
    },
    /// Successful acquisition of one outstanding `acquire-tile` in
    /// `AcquiringTiles`. The host has already fetched, decoded, and placed
    /// the tile; the body is NOT carried (it never re-enters the adapter).
    /// The adapter forwards a typed `TileAcquired`.
    TileAcquired {
        request: u32,
    },
    /// Elapsed retry wait for one outstanding `wait-retry-timer` host
    /// effect. The engine owns no clocks: the host waits `delay_ms` on its
    /// own clock, then answers with the exact effect id it received. The
    /// engine parks elapsed retries while paused; stale or duplicate
    /// completions are rejected as stale effects.
    RetryTimerElapsed {
        effect: u32,
    },
    FinalizationSucceeded {
        /// Correlation of the outstanding `finalize-output` effect.
        effect: u32,
        /// Honest disposition from the host that performed the save:
        /// tainted (display-only) canvases report DisplayOnly so every
        /// product presents preview instead of claiming a saved file.
        disposition: OutputDisposition,
    },
    FinalizationFailed {
        /// Correlation of the outstanding `finalize-output` effect.
        effect: u32,
        error: Error,
    },
}

// ---------------------------------------------------------------------------
// Host effects (job -> host; every effect has correlation + one response)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum HostEffect {
    AcquireResource {
        request: ResourceRequest,
    },
    AcquireTile {
        request: ResourceRequest,
        /// Engine tile id correlating this acquisition with the tile outcome.
        tile: u32,
        /// Complete output placement for the acquired bytes (see
        /// [`TilePlacement`]). Hosts that assemble images read the
        /// placement here, at acquisition time, so acquisition failures and
        /// decode failures surface through the same tile outcome.
        placement: TilePlacement,
    },
    /// Awaited host-owned output operation. The host validates its destination,
    /// assembles/encodes when readable, and replies exactly once.
    FinalizeOutput {
        /// Engine-minted effect correlation echoed by finalization completion.
        effect: u32,
        partial: bool,
        format: OutputFormat,
        canvas: Option<Size>,
    },
    /// Explicit retry wait for one tile: the host waits `delay_ms` on its
    /// own clock and then answers with `RetryTimerElapsed` carrying this
    /// exact effect id. No new acquisition for this tile starts before that
    /// completion. The engine parks elapsed retries while paused and
    /// re-drives them on resume.
    WaitRetryTimer {
        /// Engine-minted effect correlation echoed by timer completion.
        effect: u32,
        tile: u32,
        attempt: u32,
        delay_ms: u64,
    },
    CancelWork,
    RequestDecision {
        generation: u32,
    },
}

// ---------------------------------------------------------------------------
// Job lifecycle (engine -> hosts; absolute snapshots, terminal exactly once)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum JobState {
    #[default]
    Created,
    Discovering,
    AwaitingImageSelection,
    AwaitingLevelSelection,
    Planning,
    AcquiringTiles,
    AwaitingPartialDecision,
    Finalizing,
    Cancelling,
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum RecoveryChoice {
    Keep,
    Retry,
    Discard,
}

// ---------------------------------------------------------------------------
// Recovery (typed actions, never message parsing)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum RecoveryKind {
    Retry,
    EditInput,
    ChooseOutput,
    GrantPermission,
    ChangeTransport,
    KeepPartial,
    DiscardPartial,
    HandoffToNative,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct RecoveryAction {
    pub id: String,
    pub kind: RecoveryKind,
    pub scope: String,
    pub rationale: String,
}

// ---------------------------------------------------------------------------
// Errors (stable codes + safe structured context for specific UI guidance)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ErrorPhase {
    Handshake,
    Validation,
    Discovery,
    Acquisition,
    Decode,
    Processing,
    Output,
    Publication,
    Cleanup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ErrorTransport {
    Direct,
    MetadataProxy,
    BrowserSession,
    Native,
    DisplayOnly,
}

impl ErrorTransport {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::MetadataProxy => "metadata-proxy",
            Self::BrowserSession => "browser-session",
            Self::Native => "native",
            Self::DisplayOnly => "display-only",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum BlockedReason {
    AccessRequired,
    BlockedIpv4,
    BlockedIpv6,
    Cancelled,
    ContentType,
    DnsRebinding,
    DnsRebindingV6,
    Forbidden,
    InvalidUrl,
    LimitExceeded,
    LoopbackHost,
    Malformed,
    MalformedBody,
    Method,
    Network,
    NonStandardPort,
    Origin,
    PrivateHost,
    ProtocolVersion,
    RedirectLimit,
    RedirectTarget,
    Scheme,
    SignedQuery,
    SourceDocumentLost,
    Throttled,
    Userinfo,
}

/// Stable code for a host-observed fetch failure.
///
/// Variant identifiers are the protocol's serialized values, so this enum
/// preserves the pre-existing wire vocabulary without rename tables.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[allow(non_camel_case_types)]
pub enum FetchFailureCode {
    TRANSPORT_HTTP_ERROR,
    DISCOVERY_HTTP_ERROR,
    UPSTREAM_RATE_LIMITED,
    TRANSPORT_POLICY_DENIED,
    PROXY_BUDGET_EXCEEDED,
    PROXY_ERROR,
    PROXY_NETWORK_ERROR,
    PROXY_RATE_LIMITED,
    DISCOVERY_FAILED,
    TRANSPORT_TIMEOUT,
    TRANSPORT_NETWORK_ERROR,
    TRANSPORT_CANCELLED,
    TRANSPORT_BAD_URL,
    TRANSPORT_BAD_REDIRECT,
    TRANSPORT_REDIRECT_LIMIT,
    TRANSPORT_SIZE_LIMIT,
}

impl BlockedReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AccessRequired => "access-required",
            Self::BlockedIpv4 => "blocked-ipv4",
            Self::BlockedIpv6 => "blocked-ipv6",
            Self::Cancelled => "cancelled",
            Self::ContentType => "content-type",
            Self::DnsRebinding => "dns-rebinding",
            Self::DnsRebindingV6 => "dns-rebinding-v6",
            Self::Forbidden => "forbidden",
            Self::InvalidUrl => "invalid-url",
            Self::LimitExceeded => "limit-exceeded",
            Self::LoopbackHost => "loopback-host",
            Self::Malformed => "malformed",
            Self::MalformedBody => "malformed-body",
            Self::Method => "method",
            Self::Network => "network",
            Self::NonStandardPort => "non-standard-port",
            Self::Origin => "origin",
            Self::PrivateHost => "private-host",
            Self::ProtocolVersion => "protocol-version",
            Self::RedirectLimit => "redirect-limit",
            Self::RedirectTarget => "redirect-target",
            Self::Scheme => "scheme",
            Self::SignedQuery => "signed-query",
            Self::SourceDocumentLost => "source-document-lost",
            Self::Throttled => "throttled",
            Self::Userinfo => "userinfo",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ResourceKind {
    Metadata,
    Tile,
    Probe,
    Output,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct FetchFailure {
    pub code: FetchFailureCode,
    pub retryable: bool,
    pub message: String,
    #[serde(default)]
    pub recovery: Vec<RecoveryAction>,
    pub transport: ErrorTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<BlockedReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<u16>,
    /// Host-observed `retry-after` in milliseconds, when the response
    /// carried one. The engine waits at least this long before the retry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Error {
    pub code: String,
    pub phase: ErrorPhase,
    pub retryable: bool,
    pub message: String,
    #[serde(default)]
    pub recovery: Vec<RecoveryAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<ErrorTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<BlockedReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_kind: Option<ResourceKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Error {
    #[must_use]
    pub fn new(code: impl Into<String>, phase: ErrorPhase, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            phase,
            retryable: false,
            message: message.into(),
            recovery: Vec::new(),
            request: None,
            transport: None,
            blocked_reason: None,
            resource_kind: None,
            http: None,
            preview: None,
            detail: None,
        }
    }

    #[must_use]
    pub fn with_transport(mut self, transport: ErrorTransport) -> Self {
        self.transport = Some(transport);
        self
    }

    #[must_use]
    pub fn with_resource(mut self, kind: ResourceKind) -> Self {
        self.resource_kind = Some(kind);
        self
    }
}

/// Redact credential-bearing text from error display strings
/// (case-insensitive key match).
#[must_use]
pub fn redact_error_text(input: &str) -> String {
    let mut out = input.to_string();
    for needle in [
        "apikey=",
        "api-key=",
        "api_key=",
        "x-api-key",
        "access_token=",
        "access-token=",
        "token=",
        "bearer",
        "session=",
        "cookie=",
        "set-cookie",
        "authorization:",
        "auth=",
        "secret=",
        "password=",
    ] {
        let mut search_from = 0;
        loop {
            let window = out[search_from..].to_ascii_lowercase();
            let Some(rel) = window.find(needle) else {
                break;
            };
            let pos = search_from + rel;
            let end = out[pos..]
                .find(['&', ' ', '"', '\''])
                .map_or(out.len(), |e| pos + e);
            out.replace_range(pos + needle.len()..end, "REDACTED");
            search_from = pos + needle.len() + "REDACTED".len();
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Typed WASM session boundary
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct SessionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_concurrent_fetches: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_tiles: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
    /// Opt in to browser selection using the largest ready image and the
    /// largest level that fits these declared canvas limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_selection: Option<BrowserSelectionLimits>,
}

/// Positive declared-canvas limits used by browser automatic selection.
/// Non-zero integer types reject invalid limits at the typed boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct BrowserSelectionLimits {
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_width: NonZeroU32,
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_height: NonZeroU32,
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_area: NonZeroU64,
}

// ---------------------------------------------------------------------------
// Engine snapshots (authoritative per-job projections for UI rendering)
// ---------------------------------------------------------------------------
//
// The engine projects one absolute snapshot per transition: lifecycle,
// pause flag, progress, selection/decision payload, terminal result, and
// output summary. Snapshots carry no secrets, pixels, paths, or handles,
// and no routing identifiers (job IDs stay host-side).

/// Closed retry category for one classified tile failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum FailureCategory {
    Permanent,
    Transient,
}

/// Structured facts for one failed tile attempt (bounded diagnostics).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct TileFailure {
    pub code: String,
    pub category: FailureCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Unit progress for the active phase (totals stay unknown until the plan
/// resolves).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Progress {
    pub completed: u64,
    pub total: Option<u64>,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            completed: 0,
            total: Some(0),
        }
    }
}

/// One still-deferred catalog entry: position plus follow-up URI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct DeferredEntry {
    pub position: u32,
    pub uri: String,
}

/// Current selection state (positions into the kept catalog).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Selection {
    pub image: Option<u32>,
    pub level: Option<u32>,
    pub level_count: u32,
    /// The kept catalog with full geometry, once discovered. Replaced when
    /// a deferred catalog entry is followed within the same job.
    pub catalog: Option<Catalog>,
    pub deferred: Vec<DeferredEntry>,
}

/// One tile settled as missing, with its full structured detail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct MissingTile {
    pub tile: u32,
    pub failures: Vec<TileFailure>,
}

/// Outstanding partial decision payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Decision {
    pub generation: u32,
    pub missing: Vec<MissingTile>,
}

/// Terminal outcome, set exactly once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum Terminal {
    Completed,
    PartialCompleted { missing: Vec<u32> },
    Failed { error: Error },
    Cancelled,
}

/// Honest output disposition reported by the host that performed the save.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum OutputDisposition {
    NativePublication,
    BrowserSaveInitiated,
    BrowserSaveReady,
    DisplayOnly,
}

/// Output summary: geometry, completeness, and the honest disposition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct OutputSummary {
    pub canvas: Option<Size>,
    pub format: OutputFormat,
    pub complete: bool,
    pub missing: Vec<u32>,
    pub disposition: Option<OutputDisposition>,
}

/// Authoritative per-job projection. Snapshots are absolute: UIs render
/// the latest snapshot and never reconstruct phases from event walks.
/// `revision` increases on every transition; observers drop stale ones.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Snapshot {
    pub revision: u32,
    pub lifecycle: JobState,
    pub paused: bool,
    pub progress: Progress,
    pub selection: Selection,
    pub decision: Option<Decision>,
    pub terminal: Option<Terminal>,
    pub output: Option<OutputSummary>,
}
