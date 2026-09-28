//! Authoritative cross-language contract types. Every shared type is declared
//! here exactly once and `tsify` projects it into the WASM declaration.

use serde::{Deserialize, Serialize};
use std::num::NonZeroU64;

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
/// (hosts attach scoped authorization out-of-band).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ResourceRequest {
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

/// The requested browser output representation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum OutputFormat {
    #[default]
    Png,
    Jpeg,
    Tiff,
    Zif,
    Webp,
    IiifDir,
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

/// The source of discovery evidence. Products report facts; core discovery
/// decides when a supplied document or observed resource is relevant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum DiscoveryInputKind {
    #[default]
    Source,
    ObservedDocument,
    ObservedResource,
}

/// One discovery input. An omitted kind is a user-supplied source for
/// products that have no browser observations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct JobInput {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contents: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<DiscoveryInputKind>,
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
            kind: None,
        }
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
// Errors (stable codes + safe structured context for specific UI guidance)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ErrorPhase {
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
/// Variant identifiers are the serialized values, so this enum
/// preserves stable error codes.
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

/// Host-observed fetch facts. Retry and recovery policy belongs to the shared algorithm.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct FetchFailure {
    pub code: FetchFailureCode,
    pub message: String,
    pub transport: ErrorTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<BlockedReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<u16>,
    /// Host-observed `retry-after` in milliseconds, when the response
    /// carried one. The shared algorithm waits at least this long before the retry.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
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
            retry_after_ms: None,
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
    /// Original host-observed fetch facts, retained without reformatting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<FetchFailure>,
}

/// Unit progress for the active phase (totals stay unknown until the plan
/// resolves).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Progress {
    pub phase: ProgressPhase,
    pub source_format: Option<String>,
    pub title: Option<String>,
    pub selected: Option<Size>,
    pub maximum: Option<Size>,
    pub completed: u64,
    pub total: Option<u64>,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            phase: ProgressPhase::Discovery,
            source_format: None,
            title: None,
            selected: None,
            maximum: None,
            completed: 0,
            total: Some(0),
        }
    }
}

/// One tile settled as missing, with its full structured detail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct MissingTile {
    pub tile: u32,
    pub failures: Vec<TileFailure>,
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
pub struct Output {
    pub canvas: Option<Size>,
    pub format: OutputFormat,
    pub complete: bool,
    pub missing: Vec<u32>,
    pub disposition: OutputDisposition,
}

// Bounded diagnostic observations.
// Hosts supply clocks and identity. Fields are bounded scalar facts: bodies,
// buffers, and arbitrary object graphs cannot enter a report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum DiagnosticValue {
    Text(String),
    Number(f64),
    Bool(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum DiagnosticLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct DiagnosticRecord {
    pub sequence: u32,
    pub elapsed_ms: f64,
    pub level: DiagnosticLevel,
    pub event: String,
    #[cfg_attr(
        feature = "typescript",
        tsify(type = "Record<string, DiagnosticValue>")
    )]
    pub fields: std::collections::BTreeMap<String, DiagnosticValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct DiagnosticFailureGroup {
    pub key: String,
    pub count: u32,
    pub first: DiagnosticRecord,
    pub last: DiagnosticRecord,
}

/// Versioned, local-only support report. Limits include protected evidence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct DiagnosticReport {
    pub schema_version: u32,
    pub id: String,
    #[cfg_attr(
        feature = "typescript",
        tsify(type = "Record<string, DiagnosticValue>")
    )]
    pub context: std::collections::BTreeMap<String, DiagnosticValue>,
    #[cfg_attr(feature = "typescript", tsify(type = "Record<string, number>"))]
    pub counters: std::collections::BTreeMap<String, f64>,
    pub failures: Vec<DiagnosticFailureGroup>,
    pub records: Vec<DiagnosticRecord>,
    pub outcome: Option<DiagnosticRecord>,
    pub omitted_records: u32,
    pub truncated_fields: u32,
}

/// A direct resource read, including its redirected base address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ResourceResponse {
    #[serde(with = "serde_bytes")]
    #[cfg_attr(feature = "typescript", tsify(type = "Uint8Array"))]
    pub bytes: Vec<u8>,
    pub final_uri: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ResourceRead {
    Response { response: ResourceResponse },
    NeedsAccess { origin: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum Interaction {
    Forbidden,
    Allowed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum Gate {
    Cancellation,
    Acquisition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ProgressPhase {
    Discovery,
    Planning,
    Acquisition,
    Output,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Tile {
    pub index: u32,
    pub request: ResourceRequest,
    pub placement: TilePlacement,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct TileReceipt {
    pub display_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct FinishRequest {
    pub canvas: Option<Size>,
    pub format: OutputFormat,
    pub title: Option<String>,
    pub missing: Vec<u32>,
    pub display_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct MissingTiles {
    pub missing: Vec<MissingTile>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum SelectionPolicy {
    #[default]
    Interactive,
    Fitting {
        max_width: u32,
        max_height: u32,
        max_area: u64,
    },
    Automatic {
        image_index: usize,
        largest: bool,
        max_width: Option<u32>,
        max_height: Option<u32>,
        zoom_level: Option<usize>,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum PartialPolicy {
    #[default]
    Prompt,
    Keep,
    Discard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Options {
    pub format: Option<String>,
    pub selection: SelectionPolicy,
    pub partial: PartialPolicy,
    pub output: OutputFormat,
    pub max_concurrent: u32,
    pub max_tiles: u32,
    pub max_retries: u32,
    pub max_bytes: u64,
    pub max_deferred_follows: u32,
    pub retry_base_delay_ms: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            format: None,
            selection: SelectionPolicy::default(),
            partial: PartialPolicy::default(),
            output: OutputFormat::Png,
            max_concurrent: 4,
            max_tiles: 4096,
            max_retries: 3,
            max_bytes: 67_108_864,
            max_deferred_follows: 8,
            retry_base_delay_ms: 1000,
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
