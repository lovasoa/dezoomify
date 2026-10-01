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

/// How an acquired tile participates in probing and final output. The two
/// facts are orthogonal and consumed independently: `probe` marks
/// adaptive-probe acquisitions (fetched to observe dimensions, where a miss
/// is an observation and never an output failure), `output` marks
/// acquisitions whose success joins the final canvas. Every planned tile
/// sets at least one flag and is built through one of the three named
/// constructors; a wire value with both flags clear behaves as an
/// acquisition that is fetched and discarded. `RequestPurpose` on a tile
/// request is derived from `probe` and never disagrees with it.
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

/// Stable error code. Codes are a closed, type-checked API: each variant's
/// serde rename is the exact wire value, so structured codes never live in
/// free strings, every code is known to have user wording, and adding one
/// is a deliberate contract change. Match on variants; never on text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ErrorCode {
    // Fetch and transport observations (shared with [`FetchFailureCode`]).
    #[serde(rename = "TRANSPORT_HTTP_ERROR")]
    TransportHttpError,
    #[serde(rename = "DISCOVERY_HTTP_ERROR")]
    DiscoveryHttpError,
    #[serde(rename = "UPSTREAM_RATE_LIMITED")]
    UpstreamRateLimited,
    #[serde(rename = "TRANSPORT_POLICY_DENIED")]
    TransportPolicyDenied,
    #[serde(rename = "PROXY_BUDGET_EXCEEDED")]
    ProxyBudgetExceeded,
    #[serde(rename = "PROXY_ERROR")]
    ProxyError,
    #[serde(rename = "PROXY_NETWORK_ERROR")]
    ProxyNetworkError,
    #[serde(rename = "PROXY_RATE_LIMITED")]
    ProxyRateLimited,
    #[serde(rename = "PROXY_POLICY_DENIED")]
    ProxyPolicyDenied,
    #[serde(rename = "DISCOVERY_FAILED")]
    DiscoveryFailed,
    #[serde(rename = "TRANSPORT_TIMEOUT")]
    TransportTimeout,
    #[serde(rename = "TRANSPORT_NETWORK_ERROR")]
    TransportNetworkError,
    #[serde(rename = "TRANSPORT_CANCELLED")]
    TransportCancelled,
    #[serde(rename = "TRANSPORT_BAD_URL")]
    TransportBadUrl,
    #[serde(rename = "TRANSPORT_BAD_REDIRECT")]
    TransportBadRedirect,
    #[serde(rename = "TRANSPORT_REDIRECT_LIMIT")]
    TransportRedirectLimit,
    #[serde(rename = "TRANSPORT_SIZE_LIMIT")]
    TransportSizeLimit,

    // Job lifecycle.
    #[serde(rename = "job.cancelled")]
    JobCancelled,
    #[serde(rename = "job.invalid-input")]
    JobInvalidInput,
    #[serde(rename = "job.invalid-config")]
    JobInvalidConfig,
    #[serde(rename = "job.invalid-options")]
    JobInvalidOptions,
    #[serde(rename = "job.invalid-selection")]
    JobInvalidSelection,
    #[serde(rename = "job.invalid-state")]
    JobInvalidState,
    #[serde(rename = "job.duplicate")]
    JobDuplicate,
    #[serde(rename = "job.discovery-failed")]
    JobDiscoveryFailed,
    #[serde(rename = "job.empty-resource")]
    JobEmptyResource,
    #[serde(rename = "job.deferred-limit")]
    JobDeferredLimit,
    #[serde(rename = "job.plan-empty")]
    JobPlanEmpty,
    #[serde(rename = "job.plan-invalid")]
    JobPlanInvalid,
    #[serde(rename = "job.no-images")]
    JobNoImages,
    #[serde(rename = "job.no-usable-tiles")]
    JobNoUsableTiles,
    #[serde(rename = "job.partial-discarded")]
    JobPartialDiscarded,
    #[serde(rename = "job.resource-limit")]
    JobResourceLimit,
    #[serde(rename = "job.unknown")]
    JobUnknown,
    #[serde(rename = "job.stale")]
    JobStale,
    #[serde(rename = "job.unknown-format")]
    JobUnknownFormat,

    // Discovery and planning presentation codes.
    #[serde(rename = "discovery.no-image")]
    DiscoveryNoImage,
    #[serde(rename = "discovery.no-level")]
    DiscoveryNoLevel,

    // Tiles and processing.
    #[serde(rename = "TILE_DECODE_FAILED")]
    TileDecodeFailed,
    #[serde(rename = "tile.processing-failed")]
    TileProcessingFailed,

    // Native and desktop output.
    #[serde(rename = "output.canvas-limit")]
    OutputCanvasLimit,
    #[serde(rename = "output.encode-failed")]
    OutputEncodeFailed,
    #[serde(rename = "output.write-failed")]
    OutputWriteFailed,
    #[serde(rename = "output.exists")]
    OutputExists,
    #[serde(rename = "output.destination-denied")]
    OutputDestinationDenied,
    #[serde(rename = "output.unsupported-extension")]
    OutputUnsupportedExtension,
    #[serde(rename = "output.unavailable")]
    OutputUnavailable,
    #[serde(rename = "output.no-parent")]
    OutputNoParent,
    #[serde(rename = "output.launch-failed")]
    OutputLaunchFailed,
    #[serde(rename = "output.launch-task-failed")]
    OutputLaunchTaskFailed,
    #[serde(rename = "output.denied")]
    OutputDenied,
    #[serde(rename = "output.not-found")]
    OutputNotFound,
    #[serde(rename = "output.invoke-failed")]
    OutputInvokeFailed,

    // Browser canvas and display-only output family.
    #[serde(rename = "PLAN_INVALID")]
    CanvasPlanInvalid,
    #[serde(rename = "OUTPUT_ALLOCATION_FAILED")]
    CanvasAllocationFailed,
    #[serde(rename = "OUTPUT_SURFACE_UNAVAILABLE")]
    CanvasSurfaceUnavailable,
    #[serde(rename = "OUTPUT_ENCODE_FAILED")]
    CanvasEncodeFailed,
    #[serde(rename = "OUTPUT_FAILED")]
    CanvasFailed,
    #[serde(rename = "OUTPUT_DENIED")]
    DesktopOutputDenied,

    // Product control failures.
    #[serde(rename = "START_FAILED")]
    StartFailed,
    #[serde(rename = "CHOICE_FAILED")]
    ChoiceFailed,
    #[serde(rename = "INVALID_URL")]
    InvalidUrl,
    #[serde(rename = "INVALID_SETTINGS")]
    InvalidSettings,
    #[serde(rename = "NO_IMAGE_FOUND")]
    NoImageFound,
    #[serde(rename = "handoff.rejected")]
    HandoffRejected,
    #[serde(rename = "desktop.invalid-settings")]
    DesktopInvalidSettings,
    #[serde(rename = "desktop.invalid-source")]
    DesktopInvalidSource,
    #[serde(rename = "desktop.result-retired")]
    DesktopResultRetired,
    #[serde(rename = "desktop.registration-failed")]
    DesktopRegistrationFailed,

    // Host and binding internals.
    #[serde(rename = "native.internal")]
    HostInternal,
    #[serde(rename = "shell.lock")]
    ShellLock,
    #[serde(rename = "binding.invalid-value")]
    BindingInvalidValue,
    #[serde(rename = "interaction.expired")]
    InteractionExpired,
    #[serde(rename = "auth.forbidden-header")]
    AuthForbiddenHeader,
}

impl ErrorCode {
    /// The exact stable wire value of this code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TransportHttpError => "TRANSPORT_HTTP_ERROR",
            Self::DiscoveryHttpError => "DISCOVERY_HTTP_ERROR",
            Self::UpstreamRateLimited => "UPSTREAM_RATE_LIMITED",
            Self::TransportPolicyDenied => "TRANSPORT_POLICY_DENIED",
            Self::ProxyBudgetExceeded => "PROXY_BUDGET_EXCEEDED",
            Self::ProxyError => "PROXY_ERROR",
            Self::ProxyNetworkError => "PROXY_NETWORK_ERROR",
            Self::ProxyRateLimited => "PROXY_RATE_LIMITED",
            Self::ProxyPolicyDenied => "PROXY_POLICY_DENIED",
            Self::DiscoveryFailed => "DISCOVERY_FAILED",
            Self::TransportTimeout => "TRANSPORT_TIMEOUT",
            Self::TransportNetworkError => "TRANSPORT_NETWORK_ERROR",
            Self::TransportCancelled => "TRANSPORT_CANCELLED",
            Self::TransportBadUrl => "TRANSPORT_BAD_URL",
            Self::TransportBadRedirect => "TRANSPORT_BAD_REDIRECT",
            Self::TransportRedirectLimit => "TRANSPORT_REDIRECT_LIMIT",
            Self::TransportSizeLimit => "TRANSPORT_SIZE_LIMIT",
            Self::JobCancelled => "job.cancelled",
            Self::JobInvalidInput => "job.invalid-input",
            Self::JobInvalidConfig => "job.invalid-config",
            Self::JobInvalidOptions => "job.invalid-options",
            Self::JobInvalidSelection => "job.invalid-selection",
            Self::JobInvalidState => "job.invalid-state",
            Self::JobDuplicate => "job.duplicate",
            Self::JobDiscoveryFailed => "job.discovery-failed",
            Self::JobEmptyResource => "job.empty-resource",
            Self::JobDeferredLimit => "job.deferred-limit",
            Self::JobPlanEmpty => "job.plan-empty",
            Self::JobPlanInvalid => "job.plan-invalid",
            Self::JobNoImages => "job.no-images",
            Self::JobNoUsableTiles => "job.no-usable-tiles",
            Self::JobPartialDiscarded => "job.partial-discarded",
            Self::JobResourceLimit => "job.resource-limit",
            Self::JobUnknown => "job.unknown",
            Self::JobStale => "job.stale",
            Self::JobUnknownFormat => "job.unknown-format",
            Self::DiscoveryNoImage => "discovery.no-image",
            Self::DiscoveryNoLevel => "discovery.no-level",
            Self::TileDecodeFailed => "TILE_DECODE_FAILED",
            Self::TileProcessingFailed => "tile.processing-failed",
            Self::OutputCanvasLimit => "output.canvas-limit",
            Self::OutputEncodeFailed => "output.encode-failed",
            Self::OutputWriteFailed => "output.write-failed",
            Self::OutputExists => "output.exists",
            Self::OutputDestinationDenied => "output.destination-denied",
            Self::OutputUnsupportedExtension => "output.unsupported-extension",
            Self::OutputUnavailable => "output.unavailable",
            Self::OutputNoParent => "output.no-parent",
            Self::OutputLaunchFailed => "output.launch-failed",
            Self::OutputLaunchTaskFailed => "output.launch-task-failed",
            Self::OutputDenied => "output.denied",
            Self::OutputNotFound => "output.not-found",
            Self::OutputInvokeFailed => "output.invoke-failed",
            Self::CanvasPlanInvalid => "PLAN_INVALID",
            Self::CanvasAllocationFailed => "OUTPUT_ALLOCATION_FAILED",
            Self::CanvasSurfaceUnavailable => "OUTPUT_SURFACE_UNAVAILABLE",
            Self::CanvasEncodeFailed => "OUTPUT_ENCODE_FAILED",
            Self::CanvasFailed => "OUTPUT_FAILED",
            Self::DesktopOutputDenied => "OUTPUT_DENIED",
            Self::StartFailed => "START_FAILED",
            Self::ChoiceFailed => "CHOICE_FAILED",
            Self::InvalidUrl => "INVALID_URL",
            Self::InvalidSettings => "INVALID_SETTINGS",
            Self::NoImageFound => "NO_IMAGE_FOUND",
            Self::HandoffRejected => "handoff.rejected",
            Self::DesktopInvalidSettings => "desktop.invalid-settings",
            Self::DesktopInvalidSource => "desktop.invalid-source",
            Self::DesktopResultRetired => "desktop.result-retired",
            Self::DesktopRegistrationFailed => "desktop.registration-failed",
            Self::HostInternal => "native.internal",
            Self::ShellLock => "shell.lock",
            Self::BindingInvalidValue => "binding.invalid-value",
            Self::InteractionExpired => "interaction.expired",
            Self::AuthForbiddenHeader => "auth.forbidden-header",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<FetchFailureCode> for ErrorCode {
    fn from(code: FetchFailureCode) -> Self {
        match code {
            FetchFailureCode::TRANSPORT_HTTP_ERROR => Self::TransportHttpError,
            FetchFailureCode::DISCOVERY_HTTP_ERROR => Self::DiscoveryHttpError,
            FetchFailureCode::UPSTREAM_RATE_LIMITED => Self::UpstreamRateLimited,
            FetchFailureCode::TRANSPORT_POLICY_DENIED => Self::TransportPolicyDenied,
            FetchFailureCode::PROXY_BUDGET_EXCEEDED => Self::ProxyBudgetExceeded,
            FetchFailureCode::PROXY_ERROR => Self::ProxyError,
            FetchFailureCode::PROXY_NETWORK_ERROR => Self::ProxyNetworkError,
            FetchFailureCode::PROXY_RATE_LIMITED => Self::ProxyRateLimited,
            FetchFailureCode::DISCOVERY_FAILED => Self::DiscoveryFailed,
            FetchFailureCode::TRANSPORT_TIMEOUT => Self::TransportTimeout,
            FetchFailureCode::TRANSPORT_NETWORK_ERROR => Self::TransportNetworkError,
            FetchFailureCode::TRANSPORT_CANCELLED => Self::TransportCancelled,
            FetchFailureCode::TRANSPORT_BAD_URL => Self::TransportBadUrl,
            FetchFailureCode::TRANSPORT_BAD_REDIRECT => Self::TransportBadRedirect,
            FetchFailureCode::TRANSPORT_REDIRECT_LIMIT => Self::TransportRedirectLimit,
            FetchFailureCode::TRANSPORT_SIZE_LIMIT => Self::TransportSizeLimit,
        }
    }
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
    /// Stable error code. Rewrite through [`Error::with_code`] so the
    /// derived `retryable` verdict never disagrees with it.
    pub code: ErrorCode,
    pub phase: ErrorPhase,
    /// Derived from `code` and `http` by [`crate::retry::is_retryable`]
    /// (job-level aggregates derive it from their retained failure set via
    /// [`crate::retry::aggregate_retryable`]); every construction and
    /// rewrite recomputes it so it never contradicts its facts.
    #[serde(default)]
    pub retryable: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<LimitContext>,
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
    pub fn new(code: ErrorCode, phase: ErrorPhase, message: impl Into<String>) -> Self {
        let retryable = crate::retry::is_retryable(code, None);
        Self {
            retry_after_ms: None,
            code,
            phase,
            retryable,
            message: message.into(),
            limit: None,
            request: None,
            transport: None,
            blocked_reason: None,
            resource_kind: None,
            http: None,
            preview: None,
            detail: None,
        }
    }

    /// Rewrite the code (and therefore the retry verdict) while keeping the
    /// structured failure context.
    #[must_use]
    pub fn with_code(mut self, code: ErrorCode) -> Self {
        self.code = code;
        self.retryable = crate::retry::is_retryable(self.code, self.http);
        self
    }

    /// Attach the bounded diagnostic detail (for example the preserved
    /// error-chain text of the underlying cause).
    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
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

    #[must_use]
    pub fn with_limit(mut self, limit: LimitContext) -> Self {
        self.limit = Some(limit);
        self
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

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}

/// Bounded error-chain text for [`Error::detail`]: the cause chain is
/// preserved as diagnostic detail instead of being pasted into `message`
/// or thrown away. Truncated with an ellipsis marker past 512 bytes.
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
// Credential vocabulary (cross-language constants)
// ---------------------------------------------------------------------------

/// Canonical secret/credential query-key vocabulary. These keys must never
/// travel in a handoff deep link (they are rejected before use) and never
/// enter diagnostics. Matching is case-insensitive exact, never substring, so
/// `/cookie-recipe/` stays valid while `?token=secret` is rejected. Sorted and
/// unique.
///
/// This constant is the single source of truth on the Rust side. The
/// TypeScript mirror is `DEEP_LINK_SECRET_QUERY_KEYS` in
/// [`packages/shared-ui/src/source-url.ts`](../../../../packages/shared-ui/src/source-url.ts);
/// the two lists are pinned together by twin membership lock tests
/// (`sensitive_query_key_membership_is_locked` in
/// `apps/desktop/src-tauri/src/deep_link.rs` and "secret query vocabulary
/// mirrors the Rust contract" in `apps/desktop/tests/policy-vectors.test.mjs`).
/// The deliberately narrower metadata-proxy policy is `SIGNED_QUERY_KEYS` in
/// the same TypeScript module (a strict subset of this vocabulary).
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
