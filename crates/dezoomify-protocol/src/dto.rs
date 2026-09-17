//! Authoritative cross-language contract types. Every shared type is declared
//! here exactly once and `tsify` projects it into the WASM declaration.

use serde::{Deserialize, Serialize};

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
/// Mirrors `dezoomify-core/src/core/registry.rs` BUILTINS snapshot (18 entries).
pub const FORMAT_GRID: &[(&str, &str)] = &[
    ("custom", "Custom tiles"),
    ("google_arts_and_culture", "Arts & Culture"),
    ("zoomify", "Zoomify"),
    ("iiif", "IIIF"),
    ("deepzoom", "Seadragon (Deep Zoom Image)"),
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
    pub processing: String,
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
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum Readiness {
    Ready,
    Deferred,
}

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ImageDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub format: String,
    pub width: u64,
    pub height: u64,
    pub readiness: Readiness,
    pub source_kind: String,
    pub levels: Vec<LevelDto>,
}

/// Stable ordered catalog projection (never exposes private core enums).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct CatalogDto {
    pub images: Vec<ImageDto>,
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
        error: ErrorDto,
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
        ok: bool,
        width: u64,
        height: u64,
    },
    /// Display-only observation for one outstanding `acquire-tile` in
    /// `AcquiringTiles`. The host holds an ordinary image element (no
    /// readable bytes, canvas taints on draw) and the adapter forwards a
    /// successful `TileOutcome`; the tainted output completes as
    /// display-only downstream. Width/height are the observed image
    /// dimensions and must be positive.
    ProvideDisplayOutcome {
        request: u32,
        width: u64,
        height: u64,
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
        format: String,
        canvas: Option<SizeDto>,
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
    pub max_buffer_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_buffers: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_fetches: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_decodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tiles: Option<u32>,
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
