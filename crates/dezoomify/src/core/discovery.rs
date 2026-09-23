//! Pure, resumable discovery orchestration.
//!
//! A discovery program declares how acquired resources are matched and what
//! resource to follow next. The application owns acquisition and feeds each
//! outcome to [`DiscoveryOperation`].

use std::borrow::Cow;
use std::fmt;
use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;
use serde::{Deserialize, Serialize};

use super::model::{CatalogPlan, DiscoveryCatalog, ImagePlan, Request};
use super::tile_plan::TileSourceError;
use super::uri::resolve_relative;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RequestId(pub usize);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceNeed {
    pub id: RequestId,
    pub request: Request,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceResponse {
    pub id: RequestId,
    pub bytes: Vec<u8>,
    final_uri: Option<String>,
}
impl ResourceResponse {
    #[must_use]
    pub fn new(id: RequestId, bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            id,
            bytes: bytes.into(),
            final_uri: None,
        }
    }

    /// Set the URI reached after the host followed redirects. Empty values
    /// are ignored so relative tile URLs keep resolving against the request
    /// URI instead of collapsing to a page-relative path.
    #[must_use]
    pub fn with_final_uri(mut self, uri: impl Into<String>) -> Self {
        let uri = uri.into();
        if !uri.is_empty() {
            self.final_uri = Some(uri);
        }
        self
    }
}

/// Transport that attempted a fetch. A grouping-key component, never a
/// display string: hosts keep their own labels.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportKind {
    Direct,
    MetadataProxy,
    BrowserSession,
    Native,
    DisplayOnly,
}

/// Stable code of one fetch failure. Variant names mirror the codes the
/// hosts already emit, so the browser passes its strings through
/// unmapped; [`FetchCode::Unknown`] exists only to decode foreign codes
/// (another host's vocabulary) without falling back to rendered text.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum FetchCode {
    TransportHttpError,
    DiscoveryHttpError,
    UpstreamRateLimited,
    TransportPolicyDenied,
    ProxyBudgetExceeded,
    ProxyError,
    ProxyNetworkError,
    ProxyRateLimited,
    DiscoveryFailed,
    TransportTimeout,
    TransportNetworkError,
    TransportBadUrl,
    TransportBadRedirect,
    TransportRedirectLimit,
    TransportSizeLimit,
    Unknown(String),
}

impl FetchCode {
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::TransportHttpError => "TRANSPORT_HTTP_ERROR",
            Self::DiscoveryHttpError => "DISCOVERY_HTTP_ERROR",
            Self::UpstreamRateLimited => "UPSTREAM_RATE_LIMITED",
            Self::TransportPolicyDenied => "TRANSPORT_POLICY_DENIED",
            Self::ProxyBudgetExceeded => "PROXY_BUDGET_EXCEEDED",
            Self::ProxyError => "PROXY_ERROR",
            Self::ProxyNetworkError => "PROXY_NETWORK_ERROR",
            Self::ProxyRateLimited => "PROXY_RATE_LIMITED",
            Self::DiscoveryFailed => "DISCOVERY_FAILED",
            Self::TransportTimeout => "TRANSPORT_TIMEOUT",
            Self::TransportNetworkError => "TRANSPORT_NETWORK_ERROR",
            Self::TransportBadUrl => "TRANSPORT_BAD_URL",
            Self::TransportBadRedirect => "TRANSPORT_BAD_REDIRECT",
            Self::TransportRedirectLimit => "TRANSPORT_REDIRECT_LIMIT",
            Self::TransportSizeLimit => "TRANSPORT_SIZE_LIMIT",
            Self::Unknown(raw) => raw,
        }
    }

    /// Decode a host code string; anything unrecognized stays typed as
    /// [`FetchCode::Unknown`] so grouping keeps working on the raw code.
    #[must_use]
    pub fn from_string(value: impl Into<String>) -> Self {
        let value = value.into();
        match value.as_str() {
            "TRANSPORT_HTTP_ERROR" => Self::TransportHttpError,
            "DISCOVERY_HTTP_ERROR" => Self::DiscoveryHttpError,
            "UPSTREAM_RATE_LIMITED" => Self::UpstreamRateLimited,
            "TRANSPORT_POLICY_DENIED" => Self::TransportPolicyDenied,
            "PROXY_BUDGET_EXCEEDED" => Self::ProxyBudgetExceeded,
            "PROXY_ERROR" => Self::ProxyError,
            "PROXY_NETWORK_ERROR" => Self::ProxyNetworkError,
            "PROXY_RATE_LIMITED" => Self::ProxyRateLimited,
            "DISCOVERY_FAILED" => Self::DiscoveryFailed,
            "TRANSPORT_TIMEOUT" => Self::TransportTimeout,
            "TRANSPORT_NETWORK_ERROR" => Self::TransportNetworkError,
            "TRANSPORT_BAD_URL" => Self::TransportBadUrl,
            "TRANSPORT_BAD_REDIRECT" => Self::TransportBadRedirect,
            "TRANSPORT_REDIRECT_LIMIT" => Self::TransportRedirectLimit,
            "TRANSPORT_SIZE_LIMIT" => Self::TransportSizeLimit,
            _ => Self::Unknown(value),
        }
    }
}

impl fmt::Display for FetchCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for FetchCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for FetchCode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::from_string(String::deserialize(deserializer)?))
    }
}

/// Why the metadata proxy (or a host-side fetch policy) refused an
/// address. Kebab strings mirror the relay's closed reason vocabulary;
/// [`PolicyReason::Unknown`] decodes reasons added by a newer relay.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum PolicyReason {
    InvalidUrl,
    Scheme,
    Userinfo,
    SignedQuery,
    NonStandardPort,
    ProtocolVersion,
    MalformedBody,
    Method,
    LoopbackHost,
    PrivateHost,
    BlockedIpv4,
    BlockedIpv6,
    DnsRebinding,
    DnsRebindingV6,
    ContentType,
    RedirectLimit,
    RedirectTarget,
    Origin,
    Unknown(String),
}

impl PolicyReason {
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::InvalidUrl => "invalid-url",
            Self::Scheme => "scheme",
            Self::Userinfo => "userinfo",
            Self::SignedQuery => "signed-query",
            Self::NonStandardPort => "non-standard-port",
            Self::ProtocolVersion => "protocol-version",
            Self::MalformedBody => "malformed-body",
            Self::Method => "method",
            Self::LoopbackHost => "loopback-host",
            Self::PrivateHost => "private-host",
            Self::BlockedIpv4 => "blocked-ipv4",
            Self::BlockedIpv6 => "blocked-ipv6",
            Self::DnsRebinding => "dns-rebinding",
            Self::DnsRebindingV6 => "dns-rebinding-v6",
            Self::ContentType => "content-type",
            Self::RedirectLimit => "redirect-limit",
            Self::RedirectTarget => "redirect-target",
            Self::Origin => "origin",
            Self::Unknown(raw) => raw,
        }
    }

    /// Decode a relay reason string; unrecognized values stay typed.
    #[must_use]
    pub fn from_string(value: impl Into<String>) -> Self {
        let value = value.into();
        match value.as_str() {
            "invalid-url" => Self::InvalidUrl,
            "scheme" => Self::Scheme,
            "userinfo" => Self::Userinfo,
            "signed-query" => Self::SignedQuery,
            "non-standard-port" => Self::NonStandardPort,
            "protocol-version" => Self::ProtocolVersion,
            "malformed-body" => Self::MalformedBody,
            "method" => Self::Method,
            "loopback-host" => Self::LoopbackHost,
            "private-host" => Self::PrivateHost,
            "blocked-ipv4" => Self::BlockedIpv4,
            "blocked-ipv6" => Self::BlockedIpv6,
            "dns-rebinding" => Self::DnsRebinding,
            "dns-rebinding-v6" => Self::DnsRebindingV6,
            "content-type" => Self::ContentType,
            "redirect-limit" => Self::RedirectLimit,
            "redirect-target" => Self::RedirectTarget,
            "origin" => Self::Origin,
            _ => Self::Unknown(value),
        }
    }
}

impl fmt::Display for PolicyReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for PolicyReason {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PolicyReason {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::from_string(String::deserialize(deserializer)?))
    }
}

/// Typed cause of one failed host fetch: the discovery grouping key.
/// Free text (server signals, host sentences) never enters it, so
/// identical causes always compare equal.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct FetchCause {
    pub code: FetchCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<u16>,
    pub transport: TransportKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PolicyReason>,
}

impl FetchCause {
    /// Cause with no HTTP status and no policy reason.
    #[must_use]
    pub fn new(code: FetchCode, transport: TransportKind) -> Self {
        Self {
            code,
            http: None,
            transport,
            reason: None,
        }
    }

    /// Attach an HTTP status.
    #[must_use]
    pub fn with_http(mut self, status: u16) -> Self {
        self.http = Some(status);
        self
    }

    /// One rendering of this failure for engine diagnostics. The request
    /// URL is deliberately absent: callers place it once, outside the
    /// per-format bullets.
    #[must_use]
    pub fn describe(&self) -> String {
        let status = match self.http {
            Some(status) => format!("HTTP {status}"),
            None => self.code.to_string(),
        };
        match &self.reason {
            Some(reason) => format!("{status} fetching this address, reason={reason}"),
            None => format!("{status} fetching this address"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceFailure {
    pub id: RequestId,
    pub cause: FetchCause,
}
#[derive(Clone, Debug, Eq, PartialEq)]
enum ResourceOutcome {
    Response(ResourceResponse),
    Failure(ResourceFailure),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiscoveryLimits {
    pub transitions: usize,
    pub resources: usize,
    pub retained_bytes: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            transitions: 10_000,
            resources: 256,
            retained_bytes: 64 * 1024 * 1024,
        }
    }
}

pub enum DiscoveryStep {
    Follow(Request),
    Complete(DiscoveryCatalog),
}
#[derive(Clone, Copy, Debug)]
pub struct DiscoveryResource<'a> {
    request: &'a Request,
    bytes: &'a [u8],
    final_uri: &'a str,
}

impl<'a> DiscoveryResource<'a> {
    #[must_use]
    pub const fn uri(self) -> &'a str {
        self.request.uri.as_str()
    }
    /// The URI after host-level redirects, or [`Self::uri`] when unavailable.
    #[must_use]
    pub const fn final_uri(self) -> &'a str {
        self.final_uri
    }
    #[must_use]
    pub fn bytes(self) -> &'a [u8] {
        self.bytes
    }

    /// Decode resource bytes as UTF-8, replacing malformed sequences.
    #[must_use]
    pub fn text_lossy(self) -> Cow<'a, str> {
        String::from_utf8_lossy(self.bytes)
    }

    /// Follow a resource reference against this response's post-redirect URI.
    #[must_use]
    pub fn follow_relative(self, reference: &str) -> DiscoveryStep {
        DiscoveryStep::Follow(Request::new(resolve_relative(self.final_uri, reference)))
    }
}
pub struct DiscoveryContext<'a> {
    history_ids: &'a [RequestId],
    requests: &'a [ResourceRecord],
}

impl<'a> DiscoveryContext<'a> {
    #[must_use]
    pub fn resources(&self) -> impl DoubleEndedIterator<Item = DiscoveryResource<'a>> + '_ {
        self.history_ids
            .iter()
            .filter_map(|id| self.requests.get(id.0))
            .filter_map(|record| match record.outcome.as_ref()? {
                ResourceOutcome::Response(response) => Some(DiscoveryResource {
                    request: &record.request,
                    bytes: &response.bytes,
                    final_uri: response
                        .final_uri
                        .as_deref()
                        .filter(|uri| !uri.is_empty())
                        .unwrap_or(&record.request.uri),
                }),
                ResourceOutcome::Failure(_) => None,
            })
    }
    #[must_use]
    pub fn has_visited(&self, uri: &str) -> bool {
        self.history_ids.iter().any(|id| {
            self.requests.get(id.0).is_some_and(|record| {
                record.request.uri == uri
                    || matches!(
                        record.outcome.as_ref(),
                        Some(ResourceOutcome::Response(response))
                            if response.final_uri.as_deref() == Some(uri)
                    )
            })
        })
    }
}
type RouteHandler = for<'a> fn(
    &DiscoveryContext<'a>,
    DiscoveryResource<'a>,
) -> Result<DiscoveryStep, DiscoveryError>;
type CatalogExtractor = fn(&str, &[u8]) -> Result<DiscoveryCatalog, DiscoveryError>;
type CatalogDecoder = fn(&str, &[u8]) -> Result<CatalogPlan, DiscoveryError>;
type PlanDecoder = fn(&str, &[u8]) -> Result<ImagePlan, DiscoveryError>;
type FailureHandler = for<'a> fn(
    &DiscoveryContext<'a>,
    &'a Request,
    &'a ResourceFailure,
) -> Result<DiscoveryStep, DiscoveryError>;
type UrlMapper = fn(&str) -> Result<Request, DiscoveryError>;
type UrlPredicate = fn(&str) -> bool;
type ContentPredicate = fn(&[u8]) -> bool;

#[derive(Clone, Copy, Debug)]
pub enum DiscoveryMatch {
    Any,
    UrlSuffix(&'static str),
    UrlPredicate(UrlPredicate),
    ContentPredicate(ContentPredicate),
    ContentRegex(&'static LazyLock<BytesRegex>),
}

impl DiscoveryMatch {
    #[must_use]
    pub const fn then(self, handler: RouteHandler) -> DiscoveryRoute {
        self.route(RouteAction::Then(handler))
    }
    #[must_use]
    pub const fn extract(self, extractor: CatalogExtractor) -> DiscoveryRoute {
        self.route(RouteAction::Extract(extractor))
    }
    #[must_use]
    pub const fn catalog(self, decoder: CatalogDecoder) -> DiscoveryRoute {
        self.route(RouteAction::Catalog(decoder))
    }
    #[must_use]
    pub const fn decode(self, decoder: PlanDecoder) -> DiscoveryRoute {
        self.route(RouteAction::Decode(decoder))
    }
    #[must_use]
    pub const fn map_url(self, mapper: UrlMapper) -> DiscoveryRoute {
        self.route(RouteAction::MapUrl(mapper))
    }
    const fn route(self, handler: RouteAction) -> DiscoveryRoute {
        DiscoveryRoute {
            matcher: self,
            handler,
        }
    }

    fn matches(self, uri: &str, bytes: Option<&[u8]>) -> bool {
        match self {
            Self::Any => true,
            Self::UrlSuffix(suffix) => uri
                .split(['?', '#'])
                .next()
                .unwrap_or(uri)
                .ends_with(suffix),
            Self::UrlPredicate(predicate) => predicate(uri),
            Self::ContentPredicate(predicate) => bytes.is_some_and(predicate),
            Self::ContentRegex(regex) => bytes.is_some_and(|bytes| regex.is_match(bytes)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DiscoveryRoute {
    matcher: DiscoveryMatch,
    handler: RouteAction,
}

impl DiscoveryRoute {
    /// Follow a named regex capture against the resource's final URI.
    #[must_use]
    pub const fn relative_capture(
        regex: &'static LazyLock<BytesRegex>,
        capture: &'static str,
    ) -> Self {
        Self {
            matcher: DiscoveryMatch::ContentRegex(regex),
            handler: RouteAction::FollowCapture {
                capture,
                html_entities: false,
                prefix: "",
                suffix: "",
            },
        }
    }

    /// Decode HTML entities before resolving an embedded link.
    #[must_use]
    pub const fn html_relative_capture(
        regex: &'static LazyLock<BytesRegex>,
        capture: &'static str,
    ) -> Self {
        Self {
            matcher: DiscoveryMatch::ContentRegex(regex),
            handler: RouteAction::FollowCapture {
                capture,
                html_entities: true,
                prefix: "",
                suffix: "",
            },
        }
    }

    /// Insert a named regex capture into a resource URL.
    #[must_use]
    pub const fn capture_url(
        regex: &'static LazyLock<BytesRegex>,
        capture: &'static str,
        prefix: &'static str,
        suffix: &'static str,
    ) -> Self {
        Self {
            matcher: DiscoveryMatch::ContentRegex(regex),
            handler: RouteAction::FollowCapture {
                capture,
                html_entities: false,
                prefix,
                suffix,
            },
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum RouteAction {
    Then(RouteHandler),
    Extract(CatalogExtractor),
    Catalog(CatalogDecoder),
    Decode(PlanDecoder),
    MapUrl(UrlMapper),
    FollowCapture {
        capture: &'static str,
        html_entities: bool,
        prefix: &'static str,
        suffix: &'static str,
    },
}

fn dispatch_resource(
    format: &'static str,
    routes: &[DiscoveryRoute],
    context: &DiscoveryContext<'_>,
    resource: DiscoveryResource<'_>,
    unmatched: &str,
) -> Result<DiscoveryStep, DiscoveryError> {
    for route in routes {
        let matches_final = route
            .matcher
            .matches(resource.final_uri(), Some(resource.bytes()));
        let matches_requested = route
            .matcher
            .matches(resource.uri(), Some(resource.bytes()));
        if !matches_final && !matches_requested {
            continue;
        }
        return match route.handler {
            RouteAction::Then(handler) => handler(context, resource),
            RouteAction::Extract(extractor) => {
                extractor(resource.final_uri(), resource.bytes()).map(DiscoveryStep::Complete)
            }
            RouteAction::Catalog(decoder) => decoder(resource.final_uri(), resource.bytes())
                .and_then(|plan| plan.compile(format))
                .map(DiscoveryStep::Complete),
            RouteAction::Decode(decoder) => decoder(resource.final_uri(), resource.bytes())
                .and_then(|plan| plan.compile(format))
                .map(DiscoveryStep::Complete),
            RouteAction::FollowCapture {
                capture,
                html_entities,
                prefix,
                suffix,
            } => {
                let DiscoveryMatch::ContentRegex(regex) = route.matcher else {
                    unreachable!("capture routes require a regex matcher")
                };
                let link = regex
                    .captures(resource.bytes())
                    .and_then(|captures| captures.name(capture))
                    .ok_or_else(|| {
                        DiscoveryError::Session("resource has no matching link".into())
                    })?;
                let link = String::from_utf8_lossy(link.as_bytes());
                let link = if html_entities {
                    html_escape::decode_html_entities(&link)
                } else {
                    link
                };
                Ok(resource.follow_relative(&format!("{prefix}{}{suffix}", link.trim())))
            }
            RouteAction::MapUrl(_) => continue,
        };
    }
    Err(DiscoveryError::rejected(
        RejectionKind::DidNotMatchContent,
        unmatched,
    ))
}

fn map_url(routes: &[DiscoveryRoute], request: Request) -> Result<Request, DiscoveryError> {
    for route in routes {
        if let RouteAction::MapUrl(mapper) = route.handler
            && route.matcher.matches(&request.uri, None)
        {
            return mapper(&request.uri);
        }
    }
    Ok(request)
}

#[derive(Clone, Copy, Debug)]
enum DiscoveryProgram {
    ImmediatePlan(fn(&str) -> Result<ImagePlan, DiscoveryError>),
    Rules(&'static [DiscoveryRoute], Option<FailureHandler>),
}

#[derive(Clone, Copy, Debug)]
pub struct FormatSpec {
    name: &'static str,
    display_name: &'static str,
    recognize: fn(&str) -> bool,
    rejection: &'static str,
    prefer: fn(&str) -> bool,
    program: DiscoveryProgram,
}

impl FormatSpec {
    #[must_use]
    pub const fn new(name: &'static str, routes: &'static [DiscoveryRoute]) -> Self {
        Self::from_program(name, DiscoveryProgram::Rules(routes, None))
    }
    #[must_use]
    pub const fn immediate_plan(
        name: &'static str,
        decode: fn(&str) -> Result<ImagePlan, DiscoveryError>,
    ) -> Self {
        Self::from_program(name, DiscoveryProgram::ImmediatePlan(decode))
    }
    #[must_use]
    pub const fn on_failure(mut self, handler: FailureHandler) -> Self {
        let DiscoveryProgram::Rules(routes, ..) = self.program else {
            panic!("an immediate format cannot handle resource failures");
        };
        self.program = DiscoveryProgram::Rules(routes, Some(handler));
        self
    }
    const fn from_program(name: &'static str, program: DiscoveryProgram) -> Self {
        Self {
            name,
            display_name: name,
            recognize: |_| true,
            rejection: "input not recognized",
            prefer: |_| false,
            program,
        }
    }
    /// User-visible format name. Defaults to the stable id; formats with a
    /// legacy display name set it explicitly at their `SPEC` site.
    #[must_use]
    pub const fn with_display_name(mut self, display_name: &'static str) -> Self {
        self.display_name = display_name;
        self
    }
    #[must_use]
    pub const fn recognizing(
        mut self,
        recognize: fn(&str) -> bool,
        rejection: &'static str,
    ) -> Self {
        self.recognize = recognize;
        self.rejection = rejection;
        self
    }
    #[must_use]
    pub const fn preferring(mut self, prefer: fn(&str) -> bool) -> Self {
        self.prefer = prefer;
        self
    }
    #[must_use]
    pub const fn name(&self) -> &'static str {
        self.name
    }

    #[must_use]
    pub const fn display_name(&self) -> &'static str {
        self.display_name
    }

    #[must_use]
    pub fn prefers(&self, uri: &str) -> bool {
        (self.prefer)(uri)
    }
}

impl PartialEq for FormatSpec {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

/// Why one discovery candidate rejected an input or a resource. Typed so
/// callers never branch on display text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RejectionKind {
    /// The candidate's URL-shape check declined this address. Nothing was
    /// fetched, so the rejection carries no page-content information.
    DidNotMatchUrl,
    /// Fetched bytes matched none of the candidate's routes.
    DidNotMatchContent,
    /// The candidate recognized the resource but its metadata was invalid
    /// or unparseable.
    InvalidMetadata,
    /// A resource the candidate needed could not be fetched.
    FetchFailed,
    /// The candidate stopped for another reason (resource or transition
    /// limits, or an internal invariant).
    Failed,
}

/// One rejected candidate's diagnostic. Fetch failures carry a typed
/// [`FetchCause`]; other rejections carry a minimized free-text detail.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateDiagnostic {
    pub format: String,
    pub kind: RejectionKind,
    pub cause: Option<FetchCause>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiscoveryError {
    UnknownRequest(RequestId),
    RequestAlreadyProvided(RequestId),
    NoCandidateAccepted {
        diagnostics: Vec<CandidateDiagnostic>,
    },
    NotComplete,
    /// A candidate rejected the input or resource; `kind` classifies why.
    /// Fetch failures carry the typed cause; other rejections carry a
    /// free-text detail.
    Rejected {
        kind: RejectionKind,
        cause: Option<FetchCause>,
        detail: Option<String>,
    },
    /// A format handler or extractor failed without a typed rejection.
    Session(String),
    TransitionLimitExceeded,
    MetadataSizeLimitExceeded,
}

impl From<TileSourceError> for DiscoveryError {
    fn from(error: TileSourceError) -> Self {
        Self::Session(format!("invalid tile grid: {error}"))
    }
}

impl DiscoveryError {
    /// A candidate rejected the input or resource with a typed kind.
    pub(crate) fn rejected(kind: RejectionKind, detail: impl Into<String>) -> Self {
        Self::Rejected {
            kind,
            cause: None,
            detail: Some(detail.into()),
        }
    }

    /// A resource a candidate needed could not be fetched.
    pub(crate) fn fetch_failed(cause: FetchCause) -> Self {
        Self::Rejected {
            kind: RejectionKind::FetchFailed,
            cause: Some(cause),
            detail: None,
        }
    }
}

/// Grouping key of one rejection: the typed kind plus whichever payload
/// the kind carries (fetch causes group on the cause, other rejections
/// on their minimized free-text detail).
type RejectionKey<'a> = (RejectionKind, Option<&'a FetchCause>, Option<&'a str>);

/// Per-format diagnostic bullets: fetch rejections group by their typed
/// `(kind, cause)` key, other rejections by `(kind, detail)`, and
/// URL-shape misses collapse to one count line. Identical causes read
/// identically regardless of which format reported them. ASCII only.
#[must_use]
pub fn diagnostic_bullets(diagnostics: &[CandidateDiagnostic]) -> Vec<String> {
    let mut url_misses = 0_usize;
    let mut grouped: Vec<(RejectionKey<'_>, Vec<&str>)> = Vec::new();
    for diagnostic in diagnostics {
        if diagnostic.kind == RejectionKind::DidNotMatchUrl {
            url_misses += 1;
            continue;
        }
        let key = (
            diagnostic.kind,
            diagnostic.cause.as_ref(),
            diagnostic.detail.as_deref(),
        );
        match grouped.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, names)) => names.push(diagnostic.format.as_str()),
            None => grouped.push((key, vec![diagnostic.format.as_str()])),
        }
    }
    let mut lines = Vec::new();
    for ((_, cause, detail), names) in &grouped {
        let text = if let Some(cause) = cause {
            cause.describe()
        } else if let Some(detail) = detail {
            (*detail).to_string()
        } else {
            "rejected".to_string()
        };
        lines.push(format!(" - {}: {}", names.join(", "), text));
    }
    if url_misses > 0 {
        lines.push(format!(
            " - {url_misses} other format(s) did not match this page address"
        ));
    }
    lines
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownRequest(id) => write!(f, "unknown discovery request {}", id.0),
            Self::RequestAlreadyProvided(id) => write!(f, "request {} was already supplied", id.0),
            Self::NoCandidateAccepted { diagnostics } => {
                f.write_str("no discovery candidate accepted the input")?;
                for line in diagnostic_bullets(diagnostics) {
                    write!(f, "\n{line}")?;
                }
                Ok(())
            }
            Self::NotComplete => f.write_str("discovery is not complete"),
            Self::Rejected {
                cause: Some(cause), ..
            } => f.write_str(&cause.describe()),
            Self::Rejected {
                detail: Some(detail),
                ..
            } => f.write_str(detail),
            Self::Rejected { .. } => f.write_str("candidate rejected the input"),
            Self::Session(message) => f.write_str(message),
            Self::TransitionLimitExceeded => f.write_str("discovery transition limit exceeded"),
            Self::MetadataSizeLimitExceeded => {
                f.write_str("discovery metadata size limit exceeded")
            }
        }
    }
}

impl DiscoveryError {
    /// Engine diagnostics for wire errors: the headline-free per-format
    /// bullet block for a rejected aggregate, or the plain error text
    /// otherwise. The headline stays out: callers render their own
    /// prominent message and never repeat it inside the details.
    #[must_use]
    pub fn engine_detail(&self) -> String {
        match self {
            Self::NoCandidateAccepted { diagnostics } => {
                let block = diagnostic_bullets(diagnostics).join("\n");
                if block.is_empty() {
                    Self::NoCandidateAccepted {
                        diagnostics: Vec::new(),
                    }
                    .to_string()
                } else {
                    block
                }
            }
            other => other.to_string(),
        }
    }
}

impl std::error::Error for DiscoveryError {}

#[derive(Clone, Copy)]
enum CandidateState {
    New,
    Waiting(RequestId),
    Rejected,
}

struct Candidate {
    spec: FormatSpec,
    state: CandidateState,
    history: Vec<RequestId>,
}

struct ResourceRecord {
    request: Request,
    outcome: Option<ResourceOutcome>,
}

pub struct DiscoveryOperation {
    input: String,
    candidates: Vec<Candidate>,
    requests: Vec<ResourceRecord>,
    diagnostics: Vec<CandidateDiagnostic>,
    catalog: Option<DiscoveryCatalog>,
    transitions: usize,
    retained_bytes: usize,
    limits: DiscoveryLimits,
}

impl DiscoveryOperation {
    pub(crate) fn new(input: String, specs: &[FormatSpec], limits: DiscoveryLimits) -> Self {
        let candidates = specs
            .iter()
            .map(|&spec| Candidate {
                spec,
                state: CandidateState::New,
                history: Vec::new(),
            })
            .collect();
        Self {
            input,
            candidates,
            requests: Vec::new(),
            diagnostics: Vec::new(),
            catalog: None,
            transitions: 0,
            retained_bytes: 0,
            limits,
        }
    }
    fn resource(&self, id: RequestId) -> Option<&ResourceRecord> {
        self.requests.get(id.0)
    }
    fn ready(&self, state: CandidateState) -> bool {
        matches!(state, CandidateState::New)
            || matches!(state, CandidateState::Waiting(id) if self
                .resource(id)
                .is_some_and(|resource| resource.outcome.is_some()))
    }
    pub fn missing_resources(&mut self) -> Result<Vec<ResourceNeed>, DiscoveryError> {
        self.drive()?;
        Ok(if self.catalog.is_none() {
            self.outstanding_needs().collect()
        } else {
            Vec::new()
        })
    }
    pub fn next_priority_need(&mut self) -> Result<Option<ResourceNeed>, DiscoveryError> {
        self.drive()?;
        if self.catalog.is_some() {
            return Ok(None);
        }
        for candidate in &self.candidates {
            if let CandidateState::Waiting(id) = candidate.state
                && let Some(resource) = self.resource(id)
                && resource.outcome.is_none()
            {
                return Ok(Some(ResourceNeed {
                    id,
                    request: resource.request.clone(),
                }));
            }
        }
        Ok(self.outstanding_needs().next())
    }
    fn outstanding_needs(&self) -> impl Iterator<Item = ResourceNeed> + '_ {
        self.requests
            .iter()
            .enumerate()
            .filter(|(_, resource)| resource.outcome.is_none())
            .map(|(index, resource)| ResourceNeed {
                id: RequestId(index),
                request: resource.request.clone(),
            })
    }
    pub fn provide(&mut self, response: ResourceResponse) -> Result<(), DiscoveryError> {
        self.provide_outcome(response.id, ResourceOutcome::Response(response))
    }
    pub fn provide_failure(&mut self, failure: ResourceFailure) -> Result<(), DiscoveryError> {
        self.provide_outcome(failure.id, ResourceOutcome::Failure(failure))
    }
    fn provide_outcome(
        &mut self,
        id: RequestId,
        outcome: ResourceOutcome,
    ) -> Result<(), DiscoveryError> {
        let Some(resource) = self.requests.get(id.0) else {
            return Err(DiscoveryError::UnknownRequest(id));
        };
        if resource.outcome.is_some() {
            return Err(DiscoveryError::RequestAlreadyProvided(id));
        }
        if let ResourceOutcome::Response(response) = &outcome {
            self.retained_bytes = self
                .retained_bytes
                .checked_add(response.bytes.len())
                .filter(|total| *total <= self.limits.retained_bytes)
                .ok_or(DiscoveryError::MetadataSizeLimitExceeded)?;
        }
        self.requests[id.0].outcome = Some(outcome);
        self.drive()
    }

    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.catalog.is_some()
    }

    /// Request URI for a core request id, for fetch-failure diagnostics.
    #[must_use]
    pub fn request_uri(&self, id: RequestId) -> Option<&str> {
        self.requests
            .get(id.0)
            .map(|record| record.request.uri.as_str())
    }

    pub fn finish(mut self) -> Result<DiscoveryCatalog, DiscoveryError> {
        self.drive()?;
        self.catalog.take().ok_or(DiscoveryError::NotComplete)
    }
    fn drive(&mut self) -> Result<(), DiscoveryError> {
        while self.catalog.is_none() {
            let Some(index) = self
                .candidates
                .iter()
                .position(|candidate| self.ready(candidate.state))
            else {
                let pending = self.requests.iter().any(|r| r.outcome.is_none())
                    || self
                        .candidates
                        .iter()
                        .any(|c| !matches!(c.state, CandidateState::Rejected));
                if pending {
                    return Ok(());
                }
                return Err(DiscoveryError::NoCandidateAccepted {
                    diagnostics: self.diagnostics.clone(),
                });
            };
            self.transitions += 1;
            if self.transitions > self.limits.transitions {
                return Err(DiscoveryError::TransitionLimitExceeded);
            }
            // URL-shape check: `recognize` runs before any fetch, so a
            // rejection here is typed `DidNotMatchUrl` (no content read).
            if matches!(self.candidates[index].state, CandidateState::New)
                && !(self.candidates[index].spec.recognize)(&self.input)
            {
                let detail = self.candidates[index].spec.rejection.to_string();
                self.reject_candidate(index, RejectionKind::DidNotMatchUrl, None, Some(detail));
                continue;
            }
            let result = self
                .advance_candidate(index)
                .and_then(|step| self.apply_step(index, step));
            match result {
                Err(DiscoveryError::Rejected {
                    kind,
                    cause,
                    detail,
                }) => {
                    self.reject_candidate(index, kind, cause, detail);
                }
                // A bare session failure comes from a format handler or
                // extractor: the fetched bytes were unusable.
                Err(DiscoveryError::Session(message)) => {
                    self.reject_candidate(
                        index,
                        RejectionKind::InvalidMetadata,
                        None,
                        Some(message),
                    );
                }
                result => result?,
            }
        }
        Ok(())
    }

    fn advance_candidate(&mut self, index: usize) -> Result<DiscoveryStep, DiscoveryError> {
        let candidate = &self.candidates[index];
        if matches!(candidate.state, CandidateState::New) {
            // `drive` already applied the URL-shape check before here.
            debug_assert!((candidate.spec.recognize)(&self.input));
            return match candidate.spec.program {
                DiscoveryProgram::ImmediatePlan(decode) => decode(&self.input)?
                    .compile(candidate.spec.name)
                    .map(DiscoveryStep::Complete),
                DiscoveryProgram::Rules(..) => {
                    Ok(DiscoveryStep::Follow(Request::new(self.input.clone())))
                }
            };
        }

        let CandidateState::Waiting(id) = candidate.state else {
            return Err(DiscoveryError::rejected(
                RejectionKind::Failed,
                "internal: rejected candidate driven",
            ));
        };
        let DiscoveryProgram::Rules(routes, on_failure) = candidate.spec.program else {
            return Err(DiscoveryError::rejected(
                RejectionKind::Failed,
                "internal: immediate format follows resources",
            ));
        };
        let Some(resource) = self.resource(id) else {
            return Err(DiscoveryError::rejected(
                RejectionKind::Failed,
                "internal: ready request missing",
            ));
        };
        let request = &resource.request;
        let previous_history = &candidate.history[..candidate.history.len() - 1];
        let context = DiscoveryContext {
            history_ids: previous_history,
            requests: &self.requests,
        };
        let Some(outcome) = resource.outcome.as_ref() else {
            return Err(DiscoveryError::rejected(
                RejectionKind::Failed,
                "internal: ready candidate lacks outcome",
            ));
        };
        match outcome {
            ResourceOutcome::Response(response) => dispatch_resource(
                candidate.spec.name,
                routes,
                &context,
                DiscoveryResource {
                    request,
                    bytes: &response.bytes,
                    final_uri: response
                        .final_uri
                        .as_deref()
                        .filter(|uri| !uri.is_empty())
                        .unwrap_or(&request.uri),
                },
                "resource did not match any discovery route",
            ),
            // The resource could not be fetched: handlers may still
            // recover (krpano tries the next viewer script); otherwise the
            // failure is reported with its typed cause.
            ResourceOutcome::Failure(failure) => match on_failure {
                Some(handler) => handler(&context, request, failure),
                None => Err(DiscoveryError::fetch_failed(failure.cause.clone())),
            },
        }
    }

    fn apply_step(&mut self, index: usize, step: DiscoveryStep) -> Result<(), DiscoveryError> {
        match step {
            DiscoveryStep::Follow(request) => {
                let request = match self.candidates[index].spec.program {
                    DiscoveryProgram::Rules(routes, ..) => map_url(routes, request)?,
                    DiscoveryProgram::ImmediatePlan(_) => request,
                };
                let Some(id) = self.register_request(request) else {
                    self.reject_candidate(
                        index,
                        RejectionKind::Failed,
                        None,
                        Some("discovery resource limit exceeded".into()),
                    );
                    return Ok(());
                };
                if self.candidates[index].history.contains(&id) {
                    self.reject_candidate(
                        index,
                        RejectionKind::Failed,
                        None,
                        Some("discovery followed the same resource twice".into()),
                    );
                } else {
                    self.candidates[index].history.push(id);
                    self.candidates[index].state = CandidateState::Waiting(id);
                }
            }
            DiscoveryStep::Complete(catalog) => {
                self.catalog = Some(catalog);
            }
        }
        Ok(())
    }

    fn reject_candidate(
        &mut self,
        index: usize,
        kind: RejectionKind,
        cause: Option<FetchCause>,
        detail: Option<String>,
    ) {
        let format = self.candidates[index].spec.name.to_owned();
        self.diagnostics.push(CandidateDiagnostic {
            format,
            kind,
            cause,
            detail,
        });
        self.candidates[index].state = CandidateState::Rejected;
    }

    fn register_request(&mut self, request: Request) -> Option<RequestId> {
        if let Some(index) = self
            .requests
            .iter()
            .position(|resource| resource.request == request)
        {
            return Some(RequestId(index));
        }
        if self.requests.len() >= self.limits.resources {
            return None;
        }
        let id = RequestId(self.requests.len());
        self.requests.push(ResourceRecord {
            request,
            outcome: None,
        });
        Some(id)
    }
}

#[cfg(test)]
#[allow(clippy::unnecessary_wraps)]
mod tests {
    use super::*;
    use crate::core::model::{DiscoveredEntry, ResolvedImage};
    use crate::core::registry::Registry;

    fn catalog(_: &str, _: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
        Ok(DiscoveryCatalog::default())
    }

    fn final_uri_catalog(uri: &str, _: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
        Ok(DiscoveryCatalog::new([DiscoveredEntry::Ready(
            ResolvedImage {
                title: Some(uri.into()),
                ..Default::default()
            },
        )]))
    }

    const FINAL_URI: &[DiscoveryRoute] =
        &[DiscoveryMatch::UrlSuffix("/redirect").extract(final_uri_catalog)];

    fn reject(
        _: &DiscoveryContext<'_>,
        _: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        Err(DiscoveryError::Session("wrong format".into()))
    }

    const COMPLETE: &[DiscoveryRoute] = &[DiscoveryMatch::Any.extract(catalog)];
    const REJECT: &[DiscoveryRoute] = &[DiscoveryMatch::Any.then(reject)];
    static LINK_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
        BytesRegex::new(r#"href="(?P<link>[^"]+)""#).expect("constant test link pattern")
    });
    const FOLLOW_CAPTURE: &[DiscoveryRoute] = &[
        DiscoveryRoute::html_relative_capture(&LINK_RE, "link"),
        DiscoveryMatch::Any.extract(catalog),
    ];
    static ID_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
        BytesRegex::new(r#"id="(?P<id>[A-Za-z0-9]+)""#).expect("constant test ID pattern")
    });
    const FOLLOW_ID: &[DiscoveryRoute] = &[
        DiscoveryRoute::capture_url(&ID_RE, "id", "https://tiles.test/", "/info.json"),
        DiscoveryMatch::Any.extract(catalog),
    ];

    fn provide(operation: &mut DiscoveryOperation, bytes: &[u8]) {
        let need = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide(ResourceResponse::new(need.id, bytes))
            .unwrap();
    }

    #[test]
    fn input_acquisition_is_implicit_and_extractors_receive_it() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("test", COMPLETE));
        let mut operation = registry.start("memory://metadata");
        let need = operation.missing_resources().unwrap().pop().unwrap();
        assert_eq!(need.request.uri, "memory://metadata");
        operation
            .provide(ResourceResponse::new(need.id, b"metadata"))
            .unwrap();
        assert!(operation.finish().unwrap().is_empty());
    }

    #[test]
    fn extractors_receive_the_redirect_target_uri() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("final-uri", FINAL_URI));
        let mut operation = registry.start("https://example.test/redirect");
        let need = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide(
                ResourceResponse::new(need.id, b"metadata")
                    .with_final_uri("https://cdn.example.test/info.xml"),
            )
            .unwrap();
        let catalog = operation.finish().unwrap();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("expected one ready image")
        };
        assert_eq!(
            image.title.as_deref(),
            Some("https://cdn.example.test/info.xml")
        );
    }

    #[test]
    fn captured_links_resolve_after_redirects_and_decode_html_entities() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("capture", FOLLOW_CAPTURE));
        let mut operation = registry.start("https://example.test/old/page");
        let first = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide(
                ResourceResponse::new(first.id, br#"<a href="tiles/one.xml?x=1&amp;y=2">"#)
                    .with_final_uri("https://cdn.example.test/new/page"),
            )
            .unwrap();
        let second = operation.missing_resources().unwrap().pop().unwrap();
        assert_eq!(
            second.request.uri,
            "https://cdn.example.test/new/tiles/one.xml?x=1&y=2"
        );
        operation
            .provide(ResourceResponse::new(second.id, b"metadata"))
            .unwrap();
        assert!(operation.finish().unwrap().is_empty());
    }

    #[test]
    fn captured_id_fills_a_resource_url() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("capture-id", FOLLOW_ID));
        let mut operation = registry.start("https://example.test/viewer");
        provide(&mut operation, br#"<viewer id="Ab12">"#);
        let next = operation.missing_resources().unwrap().pop().unwrap();
        assert_eq!(next.request.uri, "https://tiles.test/Ab12/info.json");
    }

    #[test]
    fn empty_final_uri_falls_back_to_the_request_uri() {
        // Regression: proxied metadata once arrived with an empty final URI,
        // so relative tile URLs (krpano galleria_04.tiles/*) resolved against
        // the app page (/beta/) and every tile 404'd. Empty values must
        // collapse to the request URI at every layer.
        for with_empty in [false, true] {
            let mut registry = Registry::new();
            registry.register(FormatSpec::new("final-uri", FINAL_URI));
            let mut operation = registry.start("https://example.test/redirect");
            let need = operation.missing_resources().unwrap().pop().unwrap();
            let mut response = ResourceResponse::new(need.id, b"metadata");
            if with_empty {
                response = response.with_final_uri("");
            }
            operation.provide(response).unwrap();
            let catalog = operation.finish().unwrap();
            let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
                panic!("expected one ready image")
            };
            assert_eq!(
                image.title.as_deref(),
                Some("https://example.test/redirect"),
                "empty final URIs must fall back to the request URI"
            );
        }
    }

    fn text_catalog(
        _: &DiscoveryContext<'_>,
        resource: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        assert_eq!(resource.text_lossy(), "metadata\u{fffd}");
        Ok(DiscoveryStep::Complete(DiscoveryCatalog::default()))
    }

    const TEXT: &[DiscoveryRoute] = &[DiscoveryMatch::Any.then(text_catalog)];

    #[test]
    fn resources_expose_lossy_text() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("text", TEXT));
        let mut operation = registry.start("memory://metadata");
        provide(&mut operation, b"metadata\xff");
        assert!(operation.finish().unwrap().is_empty());
    }

    fn is_tile(uri: &str) -> bool {
        uri.ends_with("/tile.jpg")
    }

    fn tile_metadata(uri: &str) -> Result<Request, DiscoveryError> {
        Ok(Request::new(uri.replace("/tile.jpg", "/metadata")))
    }

    const MAPPED: &[DiscoveryRoute] = &[
        DiscoveryMatch::UrlPredicate(is_tile).map_url(tile_metadata),
        DiscoveryMatch::UrlSuffix("/metadata").extract(catalog),
    ];

    #[test]
    fn url_mapping_happens_before_acquisition() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("mapped", MAPPED));
        let mut operation = registry.start("memory://image/tile.jpg");
        assert_eq!(
            operation.next_priority_need().unwrap().unwrap().request.uri,
            "memory://image/metadata"
        );
    }

    fn follow_tiles(
        context: &DiscoveryContext<'_>,
        resource: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        assert!(context.resources().next().is_none());
        Ok(DiscoveryStep::Follow(
            Request::new(format!("{}/tiles", resource.uri())).with_header("X-Test", "preserved"),
        ))
    }

    fn finish_chain(
        context: &DiscoveryContext<'_>,
        resource: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        assert!(resource.uri().ends_with("/tiles"));
        assert_eq!(context.resources().count(), 1);
        Ok(DiscoveryStep::Complete(DiscoveryCatalog::default()))
    }

    const CHAIN: &[DiscoveryRoute] = &[
        DiscoveryMatch::UrlSuffix("/metadata").then(follow_tiles),
        DiscoveryMatch::UrlSuffix("/tiles").then(finish_chain),
    ];

    #[test]
    fn followed_resources_are_redispatched_with_history() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("chain", CHAIN));
        let mut operation = registry.start("memory://image/metadata");
        provide(&mut operation, b"metadata");
        let need = operation.next_priority_need().unwrap().unwrap();
        assert_eq!(need.request.uri, "memory://image/metadata/tiles");
        assert_eq!(need.request.header("X-Test"), Some("preserved"));
        provide(&mut operation, b"tiles");
        assert!(operation.finish().unwrap().is_empty());
    }

    #[test]
    fn identical_requests_are_fanned_out_and_parser_errors_try_the_next_candidate() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("reject", REJECT));
        registry.register(FormatSpec::new("accept", COMPLETE));
        let mut operation = registry.start("memory://shared");
        assert_eq!(operation.missing_resources().unwrap().len(), 1);
        provide(&mut operation, b"metadata");
        assert!(operation.is_complete());
        assert!(operation.finish().unwrap().is_empty());
    }

    fn follow_a(
        context: &DiscoveryContext<'_>,
        _: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        assert!(context.resources().next().is_none());
        Ok(DiscoveryStep::Follow(Request::new("memory://a")))
    }

    fn follow_b(
        context: &DiscoveryContext<'_>,
        _: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        assert!(context.resources().next().is_none());
        Ok(DiscoveryStep::Follow(Request::new("memory://b")))
    }

    const HISTORY_A: &[DiscoveryRoute] = &[DiscoveryMatch::Any.then(follow_a)];
    const HISTORY_B: &[DiscoveryRoute] = &[DiscoveryMatch::Any.then(follow_b)];

    #[test]
    fn history_is_candidate_local_when_requests_are_shared() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("a", HISTORY_A));
        registry.register(FormatSpec::new("b", HISTORY_B));
        let mut operation = registry.start("memory://shared");
        let shared = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide(ResourceResponse::new(shared.id, b"shared"))
            .unwrap();
        assert_eq!(operation.candidates[0].history[0], shared.id);
        assert_eq!(operation.candidates[1].history[0], shared.id);
        assert_ne!(
            operation.candidates[0].history[1],
            operation.candidates[1].history[1]
        );
    }

    fn recover(
        _: &DiscoveryContext<'_>,
        request: &Request,
        failure: &ResourceFailure,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        assert_eq!(request.uri, "memory://failure");
        assert_eq!(failure.cause.code, FetchCode::DiscoveryFailed);
        assert_eq!(failure.cause.transport, TransportKind::Direct);
        Ok(DiscoveryStep::Complete(DiscoveryCatalog::default()))
    }

    fn test_cause(code: FetchCode) -> FetchCause {
        FetchCause {
            code,
            http: None,
            transport: TransportKind::Direct,
            reason: None,
        }
    }

    #[test]
    fn failure_handlers_choose_the_next_action() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("failure", COMPLETE).on_failure(recover));
        let mut operation = registry.start("memory://failure");
        let need = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide_failure(ResourceFailure {
                id: need.id,
                cause: test_cause(FetchCode::DiscoveryFailed),
            })
            .unwrap();
        assert!(operation.finish().unwrap().is_empty());
    }

    fn repeat(
        _: &DiscoveryContext<'_>,
        resource: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        Ok(DiscoveryStep::Follow(Request::new(resource.uri())))
    }

    const REPEAT: &[DiscoveryRoute] = &[DiscoveryMatch::Any.then(repeat)];

    #[test]
    fn following_the_same_uri_is_rejected() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("repeat", REPEAT));
        let mut operation = registry.start("memory://repeat");
        let need = operation.missing_resources().unwrap().pop().unwrap();
        let error = operation
            .provide(ResourceResponse::new(need.id, b"again"))
            .unwrap_err();
        assert!(error.to_string().contains("same resource twice"));
    }

    fn follow_again(
        context: &DiscoveryContext<'_>,
        _: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        Ok(DiscoveryStep::Follow(Request::new(format!(
            "memory://{}",
            context.resources().count()
        ))))
    }

    const LOOP: &[DiscoveryRoute] = &[DiscoveryMatch::Any.then(follow_again)];

    #[test]
    fn operation_limits_are_enforced() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("loop", LOOP));
        let mut transitions = registry.start_with_limits(
            "memory://start",
            DiscoveryLimits {
                transitions: 2,
                ..Default::default()
            },
        );
        let need = transitions.missing_resources().unwrap().pop().unwrap();
        transitions
            .provide(ResourceResponse::new(need.id, []))
            .unwrap();
        let need = transitions.missing_resources().unwrap().pop().unwrap();
        let error = transitions
            .provide(ResourceResponse::new(need.id, []))
            .unwrap_err();
        assert_eq!(error, DiscoveryError::TransitionLimitExceeded);

        let mut limited = Registry::new();
        limited.register(FormatSpec::new("high", HIGH));
        limited.register(FormatSpec::new("low", LOW));
        let mut resources = limited.start_with_limits(
            "memory://root",
            DiscoveryLimits {
                resources: 2,
                ..Default::default()
            },
        );
        let high = resources
            .missing_resources()
            .unwrap()
            .into_iter()
            .find(|need| need.request.uri == "memory://high-1")
            .unwrap();
        assert_eq!(
            resources.provide(ResourceResponse::new(high.id, [])),
            Ok(())
        );
        let low = resources
            .missing_resources()
            .unwrap()
            .into_iter()
            .find(|need| need.request.uri == "memory://low")
            .unwrap();
        resources
            .provide(ResourceResponse::new(low.id, []))
            .unwrap();
        assert!(resources.is_complete());
        assert!(resources.finish().unwrap().is_empty());

        let mut bytes = Registry::new();
        bytes.register(FormatSpec::new("bytes", COMPLETE));
        let mut bytes = bytes.start_with_limits(
            "memory://metadata",
            DiscoveryLimits {
                retained_bytes: 1,
                ..Default::default()
            },
        );
        let need = bytes.missing_resources().unwrap().pop().unwrap();
        assert_eq!(
            bytes.provide(ResourceResponse::new(need.id, [0, 1])),
            Err(DiscoveryError::MetadataSizeLimitExceeded)
        );
    }

    fn high_start(_: &str) -> Result<Request, DiscoveryError> {
        Ok(Request::new("memory://high-1"))
    }

    fn low_start(_: &str) -> Result<Request, DiscoveryError> {
        Ok(Request::new("memory://low"))
    }

    fn is_root(uri: &str) -> bool {
        uri == "memory://root"
    }

    fn high_next(
        _: &DiscoveryContext<'_>,
        _: DiscoveryResource<'_>,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        Ok(DiscoveryStep::Follow(Request::new("memory://high-2")))
    }

    const HIGH: &[DiscoveryRoute] = &[
        DiscoveryMatch::UrlPredicate(is_root).map_url(high_start),
        DiscoveryMatch::UrlSuffix("high-1").then(high_next),
        DiscoveryMatch::UrlSuffix("high-2").extract(catalog),
    ];
    const LOW: &[DiscoveryRoute] = &[
        DiscoveryMatch::UrlPredicate(is_root).map_url(low_start),
        DiscoveryMatch::Any.extract(catalog),
    ];

    #[test]
    fn priority_stays_depth_first_across_followed_resources() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("high", HIGH));
        registry.register(FormatSpec::new("low", LOW));
        let mut operation = registry.start("memory://root");
        assert_eq!(operation.missing_resources().unwrap().len(), 2);
        let high = operation.next_priority_need().unwrap().unwrap();
        assert_eq!(high.request.uri, "memory://high-1");
        operation
            .provide(ResourceResponse::new(high.id, []))
            .unwrap();
        assert_eq!(
            operation.next_priority_need().unwrap().unwrap().request.uri,
            "memory://high-2"
        );
    }

    #[test]
    fn diagnostics_group_by_typed_cause_and_collapse_url_misses() {
        let http_cause = |status: u16| FetchCause {
            code: FetchCode::TransportHttpError,
            http: Some(status),
            transport: TransportKind::Direct,
            reason: None,
        };
        let diagnostic = |format: &str, kind, cause: Option<FetchCause>, detail: Option<&str>| {
            CandidateDiagnostic {
                format: format.into(),
                kind,
                cause,
                detail: detail.map(str::to_string),
            }
        };
        let error = DiscoveryError::NoCandidateAccepted {
            diagnostics: vec![
                diagnostic(
                    "custom",
                    RejectionKind::DidNotMatchUrl,
                    None,
                    Some("not a tiles.yaml file"),
                ),
                diagnostic(
                    "iiif",
                    RejectionKind::FetchFailed,
                    Some(http_cause(403)),
                    None,
                ),
                diagnostic(
                    "zoomify",
                    RejectionKind::FetchFailed,
                    Some(http_cause(403)),
                    None,
                ),
                diagnostic(
                    "deepzoom",
                    RejectionKind::InvalidMetadata,
                    None,
                    Some("unable to parse DZI metadata"),
                ),
                diagnostic(
                    "generic",
                    RejectionKind::DidNotMatchUrl,
                    None,
                    Some("not a generic X/Y tile template"),
                ),
            ],
        };
        assert_eq!(
            error.to_string(),
            "no discovery candidate accepted the input\
             \n - iiif, zoomify: HTTP 403 fetching this address\
             \n - deepzoom: unable to parse DZI metadata\
             \n - 2 other format(s) did not match this page address"
        );
        // The engine block for wire diagnostics carries no headline.
        assert_eq!(
            error.engine_detail(),
            " - iiif, zoomify: HTTP 403 fetching this address\
             \n - deepzoom: unable to parse DZI metadata\
             \n - 2 other format(s) did not match this page address"
        );
    }

    #[test]
    fn different_causes_never_merge() {
        let fetch = |cause: FetchCause| CandidateDiagnostic {
            format: "iiif".into(),
            kind: RejectionKind::FetchFailed,
            cause: Some(cause),
            detail: None,
        };
        let causes = [
            FetchCause {
                code: FetchCode::TransportHttpError,
                http: Some(403),
                transport: TransportKind::Direct,
                reason: None,
            },
            FetchCause {
                code: FetchCode::TransportHttpError,
                http: Some(404),
                transport: TransportKind::Direct,
                reason: None,
            },
            FetchCause {
                code: FetchCode::TransportHttpError,
                http: Some(403),
                transport: TransportKind::MetadataProxy,
                reason: None,
            },
            FetchCause {
                code: FetchCode::TransportPolicyDenied,
                http: None,
                transport: TransportKind::MetadataProxy,
                reason: Some(PolicyReason::SignedQuery),
            },
            FetchCause {
                code: FetchCode::TransportPolicyDenied,
                http: None,
                transport: TransportKind::MetadataProxy,
                reason: Some(PolicyReason::PrivateHost),
            },
            FetchCause {
                code: FetchCode::from_string("extension.network"),
                http: None,
                transport: TransportKind::BrowserSession,
                reason: None,
            },
        ];
        let error = DiscoveryError::NoCandidateAccepted {
            diagnostics: causes.iter().map(|cause| fetch(cause.clone())).collect(),
        };
        let rendered = error.to_string();
        let bullets = rendered.lines().skip(1).count();
        assert_eq!(
            bullets,
            causes.len(),
            "every distinct typed cause keeps its own bullet"
        );
        assert!(rendered.contains("reason=signed-query"));
        assert!(rendered.contains("TRANSPORT_POLICY_DENIED fetching this address"));
        assert!(rendered.contains("extension.network fetching this address"));
    }

    #[test]
    fn fetch_causes_round_trip_through_json() {
        let cause = FetchCause {
            code: FetchCode::TransportHttpError,
            http: Some(503),
            transport: TransportKind::MetadataProxy,
            reason: Some(PolicyReason::from_string("future-reason")),
        };
        let json = serde_json::to_string(&cause).unwrap();
        assert_eq!(
            json,
            "{\"code\":\"TRANSPORT_HTTP_ERROR\",\"http\":503,\
             \"transport\":\"metadata-proxy\",\"reason\":\"future-reason\"}"
        );
        let decoded: FetchCause = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, cause);
        // Foreign host codes and unknown transports decode, never fail.
        let lenient: FetchCause =
            serde_json::from_str("{\"code\":\"extension.throttled\",\"transport\":\"direct\"}")
                .unwrap();
        assert_eq!(
            lenient.code,
            FetchCode::Unknown("extension.throttled".into())
        );
        assert_eq!(lenient.transport, TransportKind::Direct);
        assert_eq!(lenient.http, None);
        assert_eq!(lenient.reason, None);
    }
}
