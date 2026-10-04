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

/// The requested output encoding.
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

impl OutputFormat {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Tiff => "tiff",
            Self::Zif => "zif",
            Self::Webp => "webp",
            Self::IiifDir => "iiif-dir",
        }
    }

    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Tiff => "tif",
            Self::IiifDir => "iiif",
            format => format.as_str(),
        }
    }

    #[must_use]
    pub const fn is_directory(self) -> bool {
        matches!(self, Self::IiifDir)
    }
}

/// How an acquired tile participates in probing and final output. `probe`
/// marks adaptive-probe acquisitions (a miss is an observation, never an
/// output failure); `output` marks acquisitions joining the final canvas.
/// Every planned tile sets at least one flag; `RequestPurpose` on a tile
/// request derives from `probe` and never disagrees with it.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct TileRole {
    pub probe: bool,
    pub output: bool,
}

impl TileRole {
    /// Fetched for the final output plan only.
    #[must_use]
    pub const fn output() -> Self {
        Self {
            probe: false,
            output: true,
        }
    }
    /// A probe which must not be added to the output canvas.
    #[must_use]
    pub const fn probe() -> Self {
        Self {
            probe: true,
            output: false,
        }
    }
    /// A successful probe is output; a missing probe is not an output failure.
    #[must_use]
    pub const fn probe_and_output() -> Self {
        Self {
            probe: true,
            output: true,
        }
    }
}

/// Host-neutral placement of one tile, projected from the core tile plan:
/// `position` is the top-left output corner, `expected_size` the planned
/// extent when declared, `canvas` the declared output size when declared,
/// and `processing` the recipe id the host applies before decoding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct TilePlacement {
    pub position: Point,
    pub expected_size: Option<Size>,
    pub canvas: Option<Size>,
    pub processing: ProcessingRecipe,
    /// Probe/output participation; see [`TileRole`].
    pub role: TileRole,
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
    pub levels: Vec<Level>,
}

/// A still-deferred catalog entry: the resource to acquire before an image
/// can be planned. The algorithm resolves `uri` within its deferred-follow limit.
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
// Errors: one closed enum. The serde tag `kind` (the kebab-case variant name)
// is the single stable machine identifier; `#[error(...)]` messages are plain
// sentences rendered from structured fields only, so identical causes read
// identically everywhere and no message text is stored or parsed. Both sides
// of the Rust/TypeScript boundary raise the same shapes: serde round-trips the
// tag. Match on variants; never on display text.
// ---------------------------------------------------------------------------

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

/// The host's active transport when it knows one (absent when unknown).
/// A named alias so the bindings' token-tree macros stay single-token.
pub type ActiveTransport = Option<ErrorTransport>;

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

/// Which output limit refused the job. Structured limit facts live in
/// [`LimitContext`]; `message` prose is presentation only and is never a
/// data channel between languages.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum LimitReason {
    /// Output assembly (canvas, tile retention, or spooling) exceeded a
    /// memory budget.
    Memory,
    /// A side exceeded the JPEG 65535 px bound.
    JpegSide,
    /// A side exceeded the WebP 16383 px bound.
    WebpSide,
}

/// Structured facts behind an output-limit refusal. Every field is optional
/// because only some limits know some facts; absent facts never fabricate
/// display text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct LimitContext {
    pub reason: LimitReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Size>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_required: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_available: Option<u64>,
}

/// The shared failure context, defined once instead of per variant:
/// `request` preserves the exact URI when known and `detail` carries the
/// bounded diagnostic text (usually the preserved cause chain).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct Failure {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Failure {
    /// Message suffix for `#[error]` templates: `": detail"` or empty.
    #[must_use]
    pub fn suffix(&self) -> String {
        self.detail
            .as_deref()
            .map_or_else(String::new, |text| format!(": {text}"))
    }
}

impl From<String> for Failure {
    fn from(detail: String) -> Self {
        Self {
            request: None,
            detail: Some(detail),
        }
    }
}

impl From<&str> for Failure {
    fn from(detail: &str) -> Self {
        Self::from(detail.to_string())
    }
}

/// One typed failure. Grouped by domain: transport and fetch, discovery,
/// job and planning, tiles, output, control, internals, and the composable
/// [`Error::Resource`] context wrapper that preserves the exact URI and
/// resource kind of any underlying failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum Error {
    // ---- Transport and fetch ----
    #[error(
        "request to {} returned HTTP {status}",
        .failure.request.as_deref().unwrap_or("<unknown address>")
    )]
    HttpError {
        status: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
        transport: ErrorTransport,
        #[serde(flatten)]
        failure: Failure,
    },
    #[error(
        "request to {} was rate limited",
        .failure.request.as_deref().unwrap_or("<unknown address>")
    )]
    RateLimited {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
        transport: ErrorTransport,
        #[serde(flatten)]
        failure: Failure,
    },
    #[error(
        "request to {} timed out",
        .failure.request.as_deref().unwrap_or("<unknown address>")
    )]
    Timeout {
        transport: ErrorTransport,
        #[serde(flatten)]
        failure: Failure,
    },
    #[error("the request failed{}", .failure.suffix())]
    NetworkFailure {
        transport: ErrorTransport,
        #[serde(flatten)]
        failure: Failure,
    },
    #[error("the request was blocked by policy: {}{}", .blocked_reason.as_str(), .failure.suffix())]
    PolicyDenied {
        blocked_reason: BlockedReason,
        transport: ErrorTransport,
        #[serde(flatten)]
        failure: Failure,
    },
    #[error("the request address is invalid{}", .0.suffix())]
    BadUrl(Failure),
    #[error("the redirect target is invalid{}", .0.suffix())]
    BadRedirect(Failure),
    #[error("redirect limit of {max} exceeded")]
    RedirectLimit { max: u32 },
    #[error("the response exceeds the {max_bytes}-byte limit")]
    SizeLimit { max_bytes: u64 },
    #[error("the job was cancelled")]
    Cancelled,
    #[error("the metadata proxy budget is exhausted")]
    ProxyBudgetExceeded,
    #[error("the metadata proxy could not fetch the address{}", .failure.suffix())]
    ProxyError {
        transport: ErrorTransport,
        #[serde(flatten)]
        failure: Failure,
    },

    // ---- Discovery ----
    #[error("no zoomable image was found{}", .0.suffix())]
    NoImageFound(Failure),
    #[error("the metadata could not be parsed{}", .0.suffix())]
    MalformedMetadata(Failure),
    #[error("unknown format: {format}")]
    UnknownFormat { format: String },
    #[error("the metadata resource is empty")]
    EmptyResource,
    #[error("a resource limit was reached{}", .0.suffix())]
    ResourceLimit(Failure),
    #[error("the deferred image follow limit of {max} was reached (or a loop)")]
    DeferredLimit { max: u32 },
    #[error("discovery failed{}", .failure.suffix())]
    DiscoveryFailed {
        #[serde(flatten)]
        failure: Failure,
        /// The representative fetch failure when every candidate failed on
        /// observed facts: its context and retry verdict stay authoritative.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[source]
        cause: Option<Box<Error>>,
    },

    // ---- Job and planning ----
    #[error("the input is not usable{}", .0.suffix())]
    InvalidInput(Failure),
    #[error("the options are not usable{}", .0.suffix())]
    InvalidOptions(Failure),
    #[error("the request does not match the job state{}", .0.suffix())]
    InvalidState(Failure),
    #[error("a job with this identity is already running")]
    Duplicate,
    #[error("the job result has been retired")]
    Stale,
    #[error("the selected level has no tiles")]
    PlanEmpty,
    #[error("the tile plan is invalid{}", .0.suffix())]
    PlanInvalid(Failure),
    /// The derived verdict and largest hint of the settled failure set;
    /// the evidence itself lives in `missing[]` and the diagnostics report.
    #[error("no usable tiles were acquired")]
    NoUsableTiles {
        transient: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },
    #[error("partial output was discarded")]
    PartialDiscarded {
        transient: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },

    // ---- Tiles ----
    #[error("a tile could not be decoded{}", .0.suffix())]
    DecodeFailed(Failure),
    #[error("a tile could not be processed{}", .0.suffix())]
    ProcessingFailed(Failure),

    // ---- Output ----
    #[error("the output exceeds a supported limit{}", limit_facts(.limit))]
    LimitExceeded { limit: LimitContext },
    #[error("the output could not be encoded{}", .0.suffix())]
    EncodeFailed(Failure),
    #[error("the output could not be written{}", .0.suffix())]
    WriteFailed(Failure),
    #[error("the output file already exists (refusing overwrite)")]
    OutputExists,
    #[error("the output destination is not writable{}", .0.suffix())]
    DestinationDenied(Failure),
    #[error("the output file extension is not supported{}", .0.suffix())]
    UnsupportedExtension(Failure),
    #[error("the saved image is unavailable{}", .0.suffix())]
    OutputUnavailable(Failure),
    #[error("the output path has no containing folder")]
    OutputNoParent,
    #[error("the system could not open the output{}", .0.suffix())]
    LaunchFailed(Failure),
    #[error("no output location was chosen")]
    OutputDenied,
    #[error("the output file is missing")]
    OutputNotFound,
    #[error("the output action failed")]
    InvokeFailed,

    // ---- Control ----
    #[error("the job could not be started{}", .0.suffix())]
    StartFailed(Failure),
    #[error("the image or level choice failed{}", .0.suffix())]
    ChoiceFailed(Failure),
    #[error("the address is not a usable web address")]
    InvalidUrl,
    #[error("the output settings are not usable{}", .0.suffix())]
    InvalidSettings(Failure),
    #[error("the app could not register the request{}", .0.suffix())]
    RegistrationFailed(Failure),

    // ---- Internal ----
    #[error("internal error{}", .0.suffix())]
    Internal(Failure),
    #[error("native resources are unavailable")]
    ShellLock,
    #[error("the host sent an invalid value{}", .0.suffix())]
    BindingInvalidValue(Failure),
    #[error("the question is no longer open")]
    InteractionExpired,
    #[error("cookie or authorization headers are forbidden in public requests")]
    AuthForbiddenHeader,

    // ---- Composition ----
    /// The exact request context for any underlying failure: URI and
    /// resource kind are preserved for diagnostics and the cause stays
    /// reachable through the error chain.
    #[error("{request}: {source}")]
    Resource {
        request: String,
        resource_kind: ResourceKind,
        #[source]
        source: Box<Error>,
    },
}

/// Bounded diagnostic suffix for plain message templates.
/// Bounded request text for error fields: server-controlled addresses are
/// capped at 2048 bytes with an ellipsis marker on a UTF-8 char boundary.
#[must_use]
pub fn bounded_uri(uri: impl Into<String>) -> String {
    let mut uri = uri.into();
    if uri.len() > 2_048 {
        let mut cut = 2_048;
        while cut > 0 && !uri.is_char_boundary(cut) {
            cut -= 1;
        }
        uri.truncate(cut);
        uri.push_str("...");
    }
    uri
}

/// Structured limit facts for message templates; the localized copy layer
/// reads the same fields and never parses this text.
fn limit_facts(limit: &LimitContext) -> String {
    let reason = match limit.reason {
        LimitReason::Memory => "memory",
        LimitReason::JpegSide => "jpeg per-side",
        LimitReason::WebpSide => "webp per-side",
    };
    let mut facts = vec![reason.to_string()];
    if let Some(dimensions) = &limit.dimensions {
        facts.push(format!("{}x{}", dimensions.width, dimensions.height));
    }
    if let Some(bytes_required) = limit.bytes_required {
        facts.push(format!("{bytes_required} bytes required"));
    }
    if let Some(bytes_available) = limit.bytes_available {
        facts.push(format!("{bytes_available} bytes available"));
    }
    format!(" ({})", facts.join(", "))
}

impl Error {
    /// Attach the exact request context to any failure. This replaces
    /// ad-hoc request decoration: the URI and resource kind ride along with
    /// the underlying failure instead of being flattened into fields.
    #[must_use]
    pub fn resource(self, request: impl Into<String>, kind: ResourceKind) -> Self {
        Self::Resource {
            request: bounded_uri(request),
            resource_kind: kind,
            source: Box::new(self),
        }
    }

    /// The underlying failure, seen through the composition wrappers:
    /// [`Self::Resource`] request context and [`Self::DiscoveryFailed`]'s
    /// retained cause.
    #[must_use]
    pub fn cause(&self) -> &Self {
        match self {
            Self::Resource { source, .. } => source.cause(),
            Self::DiscoveryFailed {
                cause: Some(cause), ..
            } => cause.cause(),
            other => other,
        }
    }

    /// The stable machine identifier: exactly the serialized `kind` tag.
    /// The arm text equals the kebab-case variant name; no variant renames
    /// itself with `#[serde(rename)]`.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::HttpError { .. } => "http-error",
            Self::RateLimited { .. } => "rate-limited",
            Self::Timeout { .. } => "timeout",
            Self::NetworkFailure { .. } => "network-failure",
            Self::PolicyDenied { .. } => "policy-denied",
            Self::BadUrl { .. } => "bad-url",
            Self::BadRedirect { .. } => "bad-redirect",
            Self::RedirectLimit { .. } => "redirect-limit",
            Self::SizeLimit { .. } => "size-limit",
            Self::Cancelled => "cancelled",
            Self::ProxyBudgetExceeded => "proxy-budget-exceeded",
            Self::ProxyError { .. } => "proxy-error",
            Self::NoImageFound { .. } => "no-image-found",
            Self::MalformedMetadata { .. } => "malformed-metadata",
            Self::UnknownFormat { .. } => "unknown-format",
            Self::EmptyResource => "empty-resource",
            Self::ResourceLimit { .. } => "resource-limit",
            Self::DeferredLimit { .. } => "deferred-limit",
            Self::DiscoveryFailed { .. } => "discovery-failed",
            Self::InvalidInput { .. } => "invalid-input",
            Self::InvalidOptions { .. } => "invalid-options",
            Self::InvalidState { .. } => "invalid-state",
            Self::Duplicate => "duplicate",
            Self::Stale => "stale",
            Self::PlanEmpty => "plan-empty",
            Self::PlanInvalid { .. } => "plan-invalid",
            Self::NoUsableTiles { .. } => "no-usable-tiles",
            Self::PartialDiscarded { .. } => "partial-discarded",
            Self::DecodeFailed { .. } => "decode-failed",
            Self::ProcessingFailed { .. } => "processing-failed",
            Self::LimitExceeded { .. } => "limit-exceeded",
            Self::EncodeFailed { .. } => "encode-failed",
            Self::WriteFailed { .. } => "write-failed",
            Self::OutputExists => "output-exists",
            Self::DestinationDenied { .. } => "destination-denied",
            Self::UnsupportedExtension { .. } => "unsupported-extension",
            Self::OutputUnavailable { .. } => "output-unavailable",
            Self::OutputNoParent => "output-no-parent",
            Self::LaunchFailed { .. } => "launch-failed",
            Self::OutputDenied => "output-denied",
            Self::OutputNotFound => "output-not-found",
            Self::InvokeFailed => "invoke-failed",
            Self::StartFailed { .. } => "start-failed",
            Self::ChoiceFailed { .. } => "choice-failed",
            Self::InvalidUrl => "invalid-url",
            Self::InvalidSettings { .. } => "invalid-settings",
            Self::RegistrationFailed { .. } => "registration-failed",
            Self::Internal { .. } => "internal",
            Self::ShellLock => "shell-lock",
            Self::BindingInvalidValue { .. } => "binding-invalid-value",
            Self::InteractionExpired => "interaction-expired",
            Self::AuthForbiddenHeader => "auth-forbidden-header",
            Self::Resource { .. } => "resource",
        }
    }

    /// Whether the same request may be retried. Transient HTTP statuses
    /// (408/425/429 and 5xx) and transient transport/service failures retry;
    /// everything else is permanent so novel failures fail closed instead of
    /// burning the retry budget. Aggregates retry when any retained
    /// constituent is transient; [`Self::Resource`] delegates to its source.
    /// Pure function of the variant and status: there is no stored verdict
    /// that could contradict its facts.
    #[must_use]
    pub fn retryable(&self) -> bool {
        match self {
            Self::HttpError { status, .. } => matches!(*status, 408 | 425 | 429 | 500..=599),
            Self::RateLimited { .. }
            | Self::Timeout { .. }
            | Self::NetworkFailure { .. }
            | Self::ProxyError { .. } => true,
            Self::Resource { source, .. } => source.retryable(),
            Self::DiscoveryFailed {
                cause: Some(cause), ..
            } => cause.retryable(),
            Self::NoUsableTiles { transient, .. } | Self::PartialDiscarded { transient, .. } => {
                *transient
            }
            _ => false,
        }
    }

    /// Host-observed `retry-after` hint in milliseconds, when the response
    /// carried one; the retrying loop waits at least this long. Aggregates
    /// report the largest retained hint.
    #[must_use]
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::HttpError {
                retry_after_ms: Some(hint),
                ..
            }
            | Self::RateLimited {
                retry_after_ms: Some(hint),
                ..
            }
            | Self::NoUsableTiles {
                retry_after_ms: Some(hint),
                ..
            }
            | Self::PartialDiscarded {
                retry_after_ms: Some(hint),
                ..
            } => Some(*hint),
            Self::Resource { source, .. } => source.retry_after_ms(),
            Self::DiscoveryFailed {
                cause: Some(cause), ..
            } => cause.retry_after_ms(),
            _ => None,
        }
    }

    /// Failures that end the whole job instead of settling one resource:
    /// cancellation and binding-layer refusals.
    #[must_use]
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.cause(),
            Self::Cancelled | Self::BindingInvalidValue { .. }
        )
    }

    /// Output/save failures settle the job typed at once and are never one
    /// tile's failure. The browser's canvas refusals (`plan-invalid`, the
    /// declared canvas exceeding the browser limits) are raised while
    /// outputting and settle the same way.
    #[must_use]
    pub fn is_output(&self) -> bool {
        matches!(
            self.cause(),
            Self::PlanInvalid { .. }
                | Self::LimitExceeded { .. }
                | Self::EncodeFailed { .. }
                | Self::WriteFailed { .. }
                | Self::OutputExists
                | Self::DestinationDenied { .. }
                | Self::UnsupportedExtension { .. }
                | Self::OutputUnavailable { .. }
                | Self::OutputNoParent
                | Self::LaunchFailed { .. }
                | Self::OutputDenied
                | Self::OutputNotFound
                | Self::InvokeFailed
        )
    }
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
    pub failures: Vec<Error>,
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
    pub missing: Vec<u32>,
    pub disposition: OutputDisposition,
}

impl Output {
    /// Complete output has no missing tiles; the two cannot disagree.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.missing.is_empty()
    }
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

/// Final plan position and index of a tile already acquired during probing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct ReusedTile {
    pub index: u32,
    pub position: Point,
}

/// Compact coverage for a regular, row-major tile plan. Requests remain lazy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct OutputGrid {
    /// Cell dimensions before overlap and edge clipping.
    pub tile_size: Size,
    /// Additional pixels on each side, clipped to the canvas.
    pub overlap: Size,
}

/// Output preflight after geometry probes and before ordinary acquisitions.
/// Positioned or unresolved coverage has no grid and must finalize safely.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct OutputPlan {
    pub canvas: Option<Size>,
    pub grid: Option<OutputGrid>,
    pub tile_count: u32,
    pub format: OutputFormat,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub struct FinishRequest {
    pub canvas: Option<Size>,
    pub format: OutputFormat,
    pub title: Option<String>,
    pub missing: Vec<u32>,
    pub reused_tiles: Vec<ReusedTile>,
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

/// Bounded error-chain text for error `detail` fields: the cause chain is
/// preserved as diagnostic detail instead of being pasted into display
/// messages or thrown away. Truncated with an ellipsis marker past 512 bytes.
#[must_use]
pub fn chain_text(error: &(dyn std::error::Error + 'static)) -> String {
    const LIMIT: usize = 512;
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = std::error::Error::source(cause);
    }
    if text.len() > LIMIT {
        let mut cut = LIMIT;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("...");
    }
    text
}

// ---------------------------------------------------------------------------
// Credential vocabulary
// ---------------------------------------------------------------------------

/// Canonical secret/credential query-key vocabulary, the single owner of the
/// policy. These keys must never travel in a source URL (they are rejected
/// before use) and never enter diagnostics. Matching is case-insensitive
/// exact, never substring, so `/cookie-recipe/` stays valid while
/// `?token=secret` is rejected. Sorted and unique. Membership is deliberately
/// unpinned: adding or removing a key is a reviewed policy edit.
///
/// The wasm boundary exposes the policy as `isSecretKey`/`hasSecretParams`;
/// TypeScript callers with a runtime ask there. The one TypeScript list in
/// [`packages/shared-ui/src/source-url.ts`](../../../../packages/shared-ui/src/source-url.ts)
/// is the wire-format counterpart of `isSecretKey`, kept only for pure
/// callers that load no runtime. The deliberately narrower metadata-proxy
/// policy is `SIGNED_QUERY_KEYS` in that module (a strict subset of this
/// vocabulary).
pub const SENSITIVE_QUERY_KEYS: &[&str] = &[
    "access-token",
    "access_token",
    "api-key",
    "api_key",
    "apikey",
    "auth",
    "authorization",
    "bearer",
    "code",
    "cookie",
    "cookies",
    "credential",
    "key",
    "passwd",
    "password",
    "proxy-authorization",
    "secret",
    "session",
    "sessionid",
    "sessiontoken",
    "set-cookie",
    "sid",
    "sig",
    "signature",
    "state",
    "ticket",
    "token",
    "x-api-key",
];

/// Case-insensitive exact membership in [`SENSITIVE_QUERY_KEYS`].
pub fn is_secret_key(key: &str) -> bool {
    SENSITIVE_QUERY_KEYS.contains(&key.to_ascii_lowercase().as_str())
}

/// Whether a URL carries a secret-bearing query or fragment key. A pair's key
/// is the text before its first `=`, so bare keys (`?token`) and
/// percent-encoded spellings are caught like `?token=secret`. Unparseable
/// URLs count as secret-bearing.
pub fn has_secret_params(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return true;
    };
    if parsed.query_pairs().any(|(key, _)| is_secret_key(&key)) {
        return true;
    }
    let Some(fragment) = parsed.fragment() else {
        return false;
    };
    fragment.split('&').any(|pair| {
        if pair.is_empty() {
            return false;
        }
        let raw_key = pair.split_once('=').map_or(pair, |(key, _)| key);
        let raw_key = raw_key.trim_start_matches(['?', '#']);
        if raw_key.is_empty() {
            return false;
        }
        if is_secret_key(raw_key) {
            return true;
        }
        url::form_urlencoded::parse(pair.as_bytes())
            .next()
            .is_some_and(|(key, _)| is_secret_key(&key))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_render_from_structured_facts_only() {
        let refused = Error::HttpError {
            status: 403,
            retry_after_ms: None,
            preview: None,
            transport: ErrorTransport::Native,
            failure: Failure {
                request: Some("https://example.test/tile".into()),
                detail: None,
            },
        };
        assert_eq!(
            refused.to_string(),
            "request to https://example.test/tile returned HTTP 403"
        );
        let unknown = Error::HttpError {
            status: 503,
            retry_after_ms: None,
            preview: None,
            transport: ErrorTransport::Direct,
            failure: "connection reset".to_string().into(),
        };
        assert_eq!(
            unknown.to_string(),
            "request to <unknown address> returned HTTP 503"
        );
        // Bounded diagnostic detail rides along in the rendered sentence.
        assert_eq!(
            Error::MalformedMetadata("expected value at line 1".to_string().into()).to_string(),
            "the metadata could not be parsed: expected value at line 1"
        );
    }

    #[test]
    fn verdicts_derive_from_the_variant_and_its_facts() {
        assert!(Error::Cancelled.retry_after_ms().is_none());
        assert!(!Error::Cancelled.retryable());
        assert!(Error::Cancelled.is_terminal());
        assert!(!Error::Cancelled.is_output());
        assert!(Error::WriteFailed(Failure::default()).is_output());
        assert!(!Error::WriteFailed(Failure::default()).is_terminal());
        // The browser's canvas refusal settles the job typed at once; it is
        // never one tile's failure.
        assert!(Error::PlanInvalid(Failure::default()).is_output());
        let throttled = Error::RateLimited {
            retry_after_ms: Some(9_000),
            transport: ErrorTransport::MetadataProxy,
            failure: Failure::default(),
        }
        .resource("https://example.test/info.json", ResourceKind::Metadata);
        assert!(throttled.retryable());
        assert_eq!(throttled.retry_after_ms(), Some(9_000));
        assert_eq!(throttled.cause().kind(), "rate-limited");
        // Aggregates report the largest retained hint.
        let aggregate = Error::NoUsableTiles {
            transient: true,
            retry_after_ms: Some(9_000),
        };
        assert_eq!(aggregate.retry_after_ms(), Some(9_000));
    }
}
