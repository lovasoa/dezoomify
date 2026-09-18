//! Authoritative cross-language contract types. Every shared type is declared
//! here exactly once and `tsify` projects it into the WASM declaration.

use serde::{Deserialize, Serialize};
use std::num::{NonZeroU32, NonZeroU64, NonZeroUsize};

// ---------------------------------------------------------------------------
// Bounded integers (always safe across the JavaScript boundary)
// ---------------------------------------------------------------------------

/// Maximum coordinate/dimension/count (fits JavaScript safe integers).
pub const MAX_DIMENSION: u64 = 1 << 30;
/// Maximum tiles, probes, or retries.
pub const MAX_COUNT: u64 = 1 << 24;

// ---------------------------------------------------------------------------
// Runtime limits, format grid, transports (one generation source for TS)
// ---------------------------------------------------------------------------

/// Largest browser-tab canvas area in pixels (16384 x 16384).
pub const MAX_BROWSER_AREA: u64 = 268_435_456;
/// Metadata proxy response cap in bytes (2 MiB, mirrors the server limit).
pub const PROXY_MAX_BYTES: u64 = 2_097_152;
/// Direct-first metadata head-start window in milliseconds.
pub const METADATA_WINDOW_MS: u64 = 1_500;

/// Active-transport labels (mirrors browser-runtime types.ts, verified by tests).
pub const DIRECT_TRANSPORT_LABEL: &str = "Direct from your browser";
pub const PROXY_TRANSPORT_LABEL: &str = "Metadata proxy";

/// Format grid in registry precedence order: (id, display name).
/// This is a snapshot of the core registry (`Registry::snapshot` over every
/// built-in format); the engine test `format_grid_matches_registry` fails on
/// any drift, so the two lists cannot diverge silently.
pub const FORMAT_GRID: &[(&str, &str)] = &[
    ("custom", "Custom tiles"),
    ("google_arts_and_culture", "Arts & Culture"),
    ("zoomify", "Zoomify"),
    ("iiif", "IIIF"),
    ("deepzoom", "Seadragon (Deep Zoom Image)"),
    ("second_canvas", "Second Canvas"),
    ("generic", "Generic dezoomer"),
    ("krpano", "krpano"),
    ("iipimage", "IIPImage"),
    ("xlimage", "XLimage"),
    ("topviewer", "TopViewer"),
    ("fsi", "FSI"),
    ("lizardtech", "LizardTech ImageServer"),
    ("vls", "VLS"),
    ("hungaricana", "Hungaricana"),
    ("wmts", "WMTS"),
    ("arcgis", "ArcGIS MapServer"),
    ("pnav", "pnav"),
    ("bulk_text", "Bulk text"),
];

/// Power-user format ids (subset of FORMAT_GRID, hidden by default).
pub const POWER_USER_FORMATS: &[&str] = &["custom", "bulk_text"];

// ---------------------------------------------------------------------------
// Requests and byte-buffer ownership
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
pub struct RequestDto {
    pub id: u32,
    pub uri: String,
    #[serde(default)]
    pub headers: Vec<HeaderDto>,
    pub purpose: RequestPurpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct HeaderDto {
    pub name: String,
    pub value: String,
}

/// A position in the output image, in pixels from the top-left corner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct PointDto {
    pub x: u64,
    pub y: u64,
}

/// A pixel size (output canvas or planned tile extent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct SizeDto {
    pub width: u64,
    pub height: u64,
}

/// A closed byte transformation applied before image decoding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum OutputFormat {
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
pub struct TilePlacementDto {
    pub position: PointDto,
    pub expected_size: Option<SizeDto>,
    pub canvas: Option<SizeDto>,
    pub processing: ProcessingRecipe,
    /// Whether a successful probe is also part of the final output plan.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub probe_output: bool,
}

/// Typed reference to bytes owned by the WASM arena.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct BufferHandle {
    pub id: u32,
    pub generation: u32,
    pub length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}

// ---------------------------------------------------------------------------
// Catalog and selection
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct LevelDto {
    pub label: String,
    pub width: u64,
    pub height: u64,
    pub tile_width: u64,
    pub tile_height: u64,
}

/// A resolved image: declared geometry and selectable levels.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ImageDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub format: String,
    pub width: u64,
    pub height: u64,
    pub source_kind: String,
    pub levels: Vec<LevelDto>,
}

/// A still-deferred catalog entry: the resource to acquire before an image
/// can be planned. The host follows `uri` with a fresh bounded attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ImageRequestDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub uri: String,
}

/// One ordered catalog slot: a ready image or a request to resolve one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum CatalogEntryDto {
    Image(ImageDto),
    ImageRequest(ImageRequestDto),
}

/// Stable ordered catalog projection (never exposes private core enums).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct CatalogDto {
    pub entries: Vec<CatalogEntryDto>,
}

/// One ordered discovery root. `contents` is omitted when the host only has
/// a reference and discovery should acquire it normally.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct JobInputDto {
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

impl JobInputDto {
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            contents: None,
        }
    }
}

// Job commands (shared UI/CLI -> job)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum JobCommand {
    Start {
        inputs: Vec<JobInputDto>,
    },
    ProvideResource {
        request: u32,
        buffer: BufferHandle,
        /// Post-redirect URL observed by the host, when it has one. Relative
        /// tile URLs resolve against this instead of the request URI.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_uri: Option<String>,
    },
    ProvideFetchFailure {
        request: u32,
        error: FetchFailureDto,
    },
    SelectImage {
        image: u32,
    },
    SelectLevel {
        level: u32,
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
    /// image element and the adapter forwards a successful `TileOutcome`.
    ProvideDisplayOutcome {
        request: u32,
    },
    /// Elapsed retry wait for one outstanding `wait-retry-timer` host
    /// effect. The engine owns no clocks: the host waits `delay_ms` on its
    /// own clock, then answers with the same tile and attempt. While
    /// paused, the host parks the completion and answers on resume. Stale
    /// or duplicate completions are ignored.
    RetryTimerElapsed {
        tile: u32,
        attempt: u32,
    },
    RecoveryChoice {
        generation: u32,
        choice: RecoveryChoice,
    },
    FinalizationSucceeded,
    FinalizationFailed {
        error: ErrorDto,
    },
    Cancel,
    Pause,
    Resume,
}

// ---------------------------------------------------------------------------
// Host effects (job -> host; every effect has correlation + one response)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum HostEffect {
    AcquireResource {
        request: RequestDto,
    },
    AcquireTile {
        request: RequestDto,
        /// Engine tile id correlating this acquisition with the tile outcome.
        tile: u32,
        /// Complete output placement for the acquired bytes (see
        /// [`TilePlacementDto`]). Hosts that assemble images read the
        /// placement here, at acquisition time, so acquisition failures and
        /// decode failures surface through the same tile outcome.
        placement: TilePlacementDto,
    },
    /// Awaited host-owned output operation. The host validates its destination,
    /// assembles/encodes when readable, and replies exactly once.
    FinalizeOutput {
        partial: bool,
        format: OutputFormat,
        canvas: Option<SizeDto>,
    },
    /// Explicit retry wait for one tile: the host waits `delay_ms` on its
    /// own clock and then answers with `RetryTimerElapsed` carrying the
    /// same tile and attempt. No new acquisition for this tile starts
    /// before that completion. While paused, the host parks the timer and
    /// issues the completion on resume.
    WaitRetryTimer {
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
// Events (job -> UI; absolute snapshots, terminal exactly once)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    Replayable,
    Transient,
    DecisionRequesting,
    Terminal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum JobState {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum JobEvent {
    JobState {
        state: JobState,
    },
    Catalog {
        catalog: CatalogDto,
    },
    Progress {
        acquired: u64,
        total: u64,
    },
    Warning {
        error: ErrorDto,
    },
    RecoveryRequest {
        generation: u32,
        actions: Vec<RecoveryAction>,
    },
    Completed,
    PartialCompleted,
    Failed {
        error: ErrorDto,
    },
    Cancelled,
    Paused,
    Resumed,
}

impl JobEvent {
    #[must_use]
    pub fn kind(&self) -> EventKind {
        match self {
            Self::JobState { .. }
            | Self::Catalog { .. }
            | Self::Progress { .. }
            | Self::Paused
            | Self::Resumed => EventKind::Replayable,
            Self::Warning { .. } => EventKind::Transient,
            Self::RecoveryRequest { .. } => EventKind::DecisionRequesting,
            Self::Completed | Self::PartialCompleted | Self::Failed { .. } | Self::Cancelled => {
                EventKind::Terminal
            }
        }
    }

    #[must_use]
    pub fn is_terminal(&self) -> bool {
        self.kind() == EventKind::Terminal
    }
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
// Native Messaging (extension <-> desktop host)
// ---------------------------------------------------------------------------

/// Native Messaging protocol version. Version 2 is the only accepted version.
pub const NATIVE_PROTOCOL_VERSION: u32 = 2;
/// Display form used by the independently installed native-host handshake.
pub const NATIVE_PROTOCOL_VERSION_TEXT: &str = "2.0";

/// One cookie transferred after explicit, origin-scoped consent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct NativeCookie {
    pub name: String,
    pub value: String,
    pub origin: String,
}

/// Extension-to-native messages. Browser manifest enforcement authenticates
/// the sender; challenges and nonces provide session binding and replay defense.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum NativeHostRequest {
    Handshake {
        #[serde(default)]
        protocol: Option<String>,
        #[serde(rename = "clientVersion")]
        #[serde(default)]
        client_version: Option<u32>,
    },
    Negotiate {
        #[serde(rename = "clientVersion")]
        client_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "extensionId")]
        #[serde(default)]
        extension_id: Option<String>,
    },
    Consent {
        challenge: String,
        nonce: String,
        #[serde(rename = "jobId")]
        job_id: String,
        origins: Vec<String>,
        #[serde(rename = "cookieNames")]
        #[serde(default)]
        cookie_names: Vec<String>,
        confirmed: bool,
    },
    Credential {
        challenge: String,
        nonce: String,
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "sourceUrl")]
        source_url: String,
        origins: Vec<String>,
        #[serde(default)]
        cookies: Vec<NativeCookie>,
    },
    Decline {
        challenge: String,
    },
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
    RedirectUnavailable,
    Scheme,
    SignedQuery,
    SourceDocumentLost,
    Throttled,
    Userinfo,
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
            Self::RedirectUnavailable => "redirect-unavailable",
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
pub struct FetchFailureDto {
    pub code: String,
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
pub struct ErrorDto {
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

impl ErrorDto {
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
    pub max_buffer_bytes: Option<NonZeroU64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_total_bytes: Option<NonZeroU64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_buffers: Option<NonZeroUsize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_concurrent_fetches: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_concurrent_decodes: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub max_tiles: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HostMessage {
    Effect(HostEffect),
    Event(JobEvent),
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
pub enum FailureCategoryDto {
    Permanent,
    Transient,
}

/// Structured facts for one failed tile attempt (bounded diagnostics).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct TileFailureDto {
    pub code: String,
    pub category: FailureCategoryDto,
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
pub struct SnapshotProgressDto {
    pub completed: u64,
    pub total: Option<u64>,
}

/// One still-deferred catalog entry: position plus follow-up URI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct SnapshotDeferredDto {
    pub position: u32,
    pub uri: String,
}

/// Current selection state (positions into the kept catalog).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct SnapshotSelectionDto {
    pub image: Option<u32>,
    pub level: Option<u32>,
    pub level_count: u32,
    pub deferred: Vec<SnapshotDeferredDto>,
}

/// One tile settled as missing, with its full structured detail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct MissingTileDto {
    pub tile: u32,
    pub failures: Vec<TileFailureDto>,
}

/// Outstanding partial decision payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct SnapshotDecisionDto {
    pub generation: u32,
    pub missing: Vec<MissingTileDto>,
}

/// Terminal outcome, set exactly once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum SnapshotTerminalDto {
    Completed,
    PartialCompleted { missing: Vec<u32> },
    Failed { error: ErrorDto },
    Cancelled,
}

/// Honest output disposition reported by the host that performed the save.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum OutputDispositionDto {
    NativePublication,
    BrowserSaveInitiated,
    BrowserSaveReady,
    DisplayOnly,
}

/// Output summary: geometry, completeness, and the honest disposition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct SnapshotOutputDto {
    pub canvas: Option<SizeDto>,
    pub format: OutputFormat,
    pub complete: bool,
    pub missing: Vec<u32>,
    pub disposition: Option<OutputDispositionDto>,
}

/// Authoritative per-job projection. Snapshots are absolute: UIs render
/// the latest snapshot and never reconstruct phases from event walks.
/// `revision` increases on every transition; observers drop stale ones.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct EngineSnapshotDto {
    pub revision: u32,
    pub lifecycle: JobState,
    pub paused: bool,
    pub progress: SnapshotProgressDto,
    pub selection: SnapshotSelectionDto,
    pub decision: Option<SnapshotDecisionDto>,
    pub terminal: Option<SnapshotTerminalDto>,
    pub output: Option<SnapshotOutputDto>,
}
