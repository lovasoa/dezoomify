//! Pure, resumable discovery orchestration.
//!
//! A discovery program declares how acquired resources are matched and what
//! resource to follow next. The application owns acquisition and feeds each
//! outcome to [`DiscoveryOperation`].

use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;
use serde::{Deserialize, Serialize};

use super::model::{CatalogPlan, DiscoveryCatalog, ImagePlan, Request};
use super::tile_plan::TileSourceError;
use super::uri::resolve_relative;
use crate::model::DiscoveryInputKind;

/// User source or host observation supplied to the shared discovery search.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryInput {
    pub url: String,
    pub contents: Option<Vec<u8>>,
    pub kind: DiscoveryInputKind,
}

impl DiscoveryInput {
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            contents: None,
            kind: DiscoveryInputKind::Source,
        }
    }

    #[must_use]
    pub fn with_contents(url: impl Into<String>, contents: impl Into<Vec<u8>>) -> Self {
        Self {
            url: url.into(),
            contents: Some(contents.into()),
            kind: DiscoveryInputKind::Source,
        }
    }

    #[must_use]
    pub const fn with_kind(mut self, kind: DiscoveryInputKind) -> Self {
        self.kind = kind;
        self
    }
}

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
    Blocked(ResourceFailure),
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
    Image(ImagePlan),
    Catalog(CatalogPlan),
    Complete(DiscoveryCatalog),
}
impl DiscoveryStep {
    pub(crate) fn compile(self, format: &'static str) -> Result<DiscoveryCatalog, DiscoveryError> {
        match self {
            Self::Image(plan) => plan.compile(format),
            Self::Catalog(plan) => plan.compile(format),
            Self::Complete(catalog) => Ok(catalog),
            Self::Follow(_) => Err(DiscoveryError::NotComplete),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct DiscoveryResource<'a> {
    uri: &'a str,
    bytes: &'a [u8],
    final_uri: &'a str,
    context: DiscoveryContext<'a>,
}

impl<'a> DiscoveryResource<'a> {
    #[must_use]
    pub const fn new(uri: &'a str, bytes: &'a [u8]) -> Self {
        Self {
            uri,
            bytes,
            final_uri: uri,
            context: DiscoveryContext {
                history_ids: &[],
                requests: &[],
            },
        }
    }
    #[must_use]
    pub const fn context(&self) -> &DiscoveryContext<'a> {
        &self.context
    }
    #[must_use]
    pub const fn uri(self) -> &'a str {
        self.uri
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
#[derive(Clone, Copy, Debug)]
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
            .filter_map(ResourceRecord::resource)
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
type Decoder = for<'a> fn(DiscoveryResource<'a>) -> Result<DiscoveryStep, DiscoveryError>;
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

    fn url_match(self, uri: &str) -> Option<bool> {
        matches!(self, Self::UrlSuffix(_) | Self::UrlPredicate(_)).then(|| self.matches(uri, None))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum RouteKind {
    Metadata,
    Image,
    Viewer,
}

pub const fn metadata(matcher: DiscoveryMatch) -> RoutePattern {
    RoutePattern {
        matcher,
        kind: RouteKind::Metadata,
    }
}
pub const fn viewer(matcher: DiscoveryMatch) -> RoutePattern {
    RoutePattern {
        matcher,
        kind: RouteKind::Viewer,
    }
}
pub const fn image_url(predicate: UrlPredicate) -> RoutePattern {
    RoutePattern {
        matcher: url_matches(predicate),
        kind: RouteKind::Image,
    }
}
pub const fn any() -> DiscoveryMatch {
    DiscoveryMatch::Any
}
pub const fn url_suffix(suffix: &'static str) -> DiscoveryMatch {
    DiscoveryMatch::UrlSuffix(suffix)
}
pub const fn url_matches(predicate: UrlPredicate) -> DiscoveryMatch {
    DiscoveryMatch::UrlPredicate(predicate)
}
pub const fn html_matches(predicate: ContentPredicate) -> DiscoveryMatch {
    DiscoveryMatch::ContentPredicate(predicate)
}

/// Semantic input pattern paired with a decoding or reference-resolution action.
pub struct RoutePattern {
    matcher: DiscoveryMatch,
    kind: RouteKind,
}

impl RoutePattern {
    /// Compile a URL-only image plan without acquiring a document.
    #[must_use]
    pub const fn plan(
        self,
        decoder: fn(&str) -> Result<ImagePlan, DiscoveryError>,
    ) -> DiscoveryRoute {
        self.route(RouteAction::Plan(decoder))
    }
    #[must_use]
    pub const fn decode(self, decoder: Decoder) -> DiscoveryRoute {
        self.route(RouteAction::Decode(decoder))
    }
    #[must_use]
    pub const fn extract_metadata(self, handler: Decoder) -> DiscoveryRoute {
        self.decode(handler)
    }
    /// Metadata that is meaningful only after this format has read its parent.
    #[must_use]
    pub const fn continue_with(self, handler: Decoder) -> DiscoveryRoute {
        self.route(RouteAction::Continuation(handler))
    }
    #[must_use]
    pub const fn resolve_metadata(self, mapper: UrlMapper) -> DiscoveryRoute {
        self.route(RouteAction::MapUrl(mapper))
    }
    const fn route(self, handler: RouteAction) -> DiscoveryRoute {
        DiscoveryRoute {
            matcher: self.matcher,
            handler,
            kind: self.kind,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DiscoveryRoute {
    matcher: DiscoveryMatch,
    handler: RouteAction,
    kind: RouteKind,
}

impl DiscoveryRoute {
    /// Follow a named regex capture against the resource's final URI.
    #[must_use]
    pub const fn relative_capture(
        regex: &'static LazyLock<BytesRegex>,
        capture: &'static str,
    ) -> Self {
        Self::capture_url(regex, capture, "", "")
    }

    /// Decode HTML entities before resolving an embedded link.
    #[must_use]
    pub const fn html_relative_capture(
        regex: &'static LazyLock<BytesRegex>,
        capture: &'static str,
    ) -> Self {
        let mut route = Self::relative_capture(regex, capture);
        if let RouteAction::FollowCapture { html_entities, .. } = &mut route.handler {
            *html_entities = true;
        }
        route
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
            kind: RouteKind::Viewer,
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
    Plan(fn(&str) -> Result<ImagePlan, DiscoveryError>),
    Continuation(Decoder),
    Decode(Decoder),
    MapUrl(UrlMapper),
    FollowCapture {
        capture: &'static str,
        html_entities: bool,
        prefix: &'static str,
        suffix: &'static str,
    },
}

fn dispatch_resource(
    routes: &[DiscoveryRoute],
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
            RouteAction::Decode(decoder) | RouteAction::Continuation(decoder) => decoder(resource),
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
            RouteAction::MapUrl(_) | RouteAction::Plan(_) => continue,
        };
    }
    Err(DiscoveryError::rejected(
        RejectionKind::DidNotMatchContent,
        unmatched,
    ))
}

#[derive(Clone, Copy, Debug)]
pub struct FormatSpec {
    name: &'static str,
    display_name: &'static str,
    routes: &'static [DiscoveryRoute],
    on_failure: Option<FailureHandler>,
}

impl FormatSpec {
    #[must_use]
    pub const fn new(name: &'static str, routes: &'static [DiscoveryRoute]) -> Self {
        Self {
            name,
            display_name: name,
            routes,
            on_failure: None,
        }
    }
    #[must_use]
    pub const fn on_failure(mut self, handler: FailureHandler) -> Self {
        self.on_failure = Some(handler);
        self
    }
    /// User-visible format name. Defaults to the stable id; formats with a
    /// legacy display name set it explicitly at their `SPEC` site.
    #[must_use]
    pub const fn with_display_name(mut self, display_name: &'static str) -> Self {
        self.display_name = display_name;
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

    fn url_kind(&self, uri: &str) -> Option<RouteKind> {
        self.routes
            .iter()
            .filter(|route| {
                !matches!(route.handler, RouteAction::Continuation(_))
                    && route.matcher.url_match(uri) == Some(true)
            })
            .map(|route| route.kind)
            .min()
    }

    fn follow(&self, request: Request, has_history: bool) -> Result<DiscoveryStep, DiscoveryError> {
        if !self.routes.iter().any(|route| {
            (has_history || !matches!(route.handler, RouteAction::Continuation(_)))
                && route.matcher.url_match(&request.uri) != Some(false)
        }) {
            return Err(DiscoveryError::rejected(
                RejectionKind::DidNotMatchUrl,
                "no matching URL route",
            ));
        }
        for route in self.routes {
            if !route.matcher.matches(&request.uri, None) {
                continue;
            }
            match route.handler {
                RouteAction::MapUrl(mapper) => {
                    return mapper(&request.uri).map(DiscoveryStep::Follow);
                }
                RouteAction::Plan(decode) => return decode(&request.uri).map(DiscoveryStep::Image),
                _ => {}
            }
        }
        Ok(DiscoveryStep::Follow(request))
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
    ResourceLimitExceeded,
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
            Self::ResourceLimitExceeded => f.write_str("discovery resource limit exceeded"),
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

struct Interpretation {
    spec: FormatSpec,
    history: Vec<RequestId>,
}

#[derive(Debug)]
struct ResourceRecord {
    request: Request,
    outcome: Option<ResourceOutcome>,
    navigation_expanded: bool,
    access_attempted: bool,
}
impl ResourceRecord {
    fn resource(&self) -> Option<DiscoveryResource<'_>> {
        let ResourceOutcome::Response(response) = self.outcome.as_ref()? else {
            return None;
        };
        Some(DiscoveryResource {
            final_uri: response.final_uri.as_deref().unwrap_or(&self.request.uri),
            ..DiscoveryResource::new(&self.request.uri, &response.bytes)
        })
    }
}

/// Product provenance sets precedence; distance breaks ties breadth first.
#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
enum Evidence {
    Source,
    Document,
    Resource,
    Navigation,
    Fallback,
}

type Position = (Evidence, usize, usize, usize);

enum Work {
    Root(DiscoveryInput),
    Parse(Interpretation),
}

pub struct DiscoveryOperation {
    specs: Vec<FormatSpec>,
    frontier: BTreeMap<Position, Work>,
    next_branch: usize,
    navigated: HashSet<String>,
    requests: Vec<ResourceRecord>,
    diagnostics: Vec<CandidateDiagnostic>,
    catalog: Option<DiscoveryCatalog>,
    transitions: usize,
    retained_bytes: usize,
    initial_error: Option<DiscoveryError>,
    limits: DiscoveryLimits,
}

impl DiscoveryOperation {
    pub(crate) fn from_inputs(
        inputs: Vec<DiscoveryInput>,
        specs: &[FormatSpec],
        limits: DiscoveryLimits,
    ) -> Self {
        let mut operation = Self {
            specs: specs.to_vec(),
            frontier: BTreeMap::new(),
            next_branch: 0,
            navigated: HashSet::new(),
            requests: Vec::new(),
            diagnostics: Vec::new(),
            catalog: None,
            transitions: 0,
            retained_bytes: 0,
            initial_error: None,
            limits,
        };
        if inputs.len() > limits.resources {
            operation.initial_error = Some(DiscoveryError::ResourceLimitExceeded);
            return operation;
        }
        let supplied_bytes = inputs.iter().try_fold(0usize, |total, input| {
            total.checked_add(input.contents.as_ref().map_or(0, Vec::len))
        });
        let Some(supplied_bytes) = supplied_bytes.filter(|total| *total <= limits.retained_bytes)
        else {
            operation.initial_error = Some(DiscoveryError::MetadataSizeLimitExceeded);
            return operation;
        };
        operation.retained_bytes = supplied_bytes;
        for input in inputs {
            let evidence = match input.kind {
                DiscoveryInputKind::Source => Evidence::Source,
                DiscoveryInputKind::ObservedDocument if input.contents.is_some() => {
                    Evidence::Document
                }
                _ => match specs
                    .iter()
                    .filter_map(|spec| spec.url_kind(&input.url))
                    .min()
                {
                    Some(RouteKind::Metadata | RouteKind::Image) => Evidence::Resource,
                    Some(RouteKind::Viewer) => Evidence::Navigation,
                    None => Evidence::Fallback,
                },
            };
            operation.enqueue(input, evidence, 0);
        }
        operation
    }
    fn enqueue(&mut self, input: DiscoveryInput, evidence: Evidence, depth: usize) {
        let position = (evidence, depth, self.next_branch, 0);
        self.next_branch += 1;
        self.frontier.insert(position, Work::Root(input));
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
        Ok(self.missing_resources()?.into_iter().next())
    }
    fn outstanding_needs(&self) -> impl Iterator<Item = ResourceNeed> + '_ {
        let mut seen = HashSet::new();
        self.frontier.values().filter_map(move |work| {
            let Work::Parse(interpretation) = work else {
                return None;
            };
            let id = *interpretation.history.last()?;
            let resource = &self.requests[id.0];
            (resource.outcome.is_none() && seen.insert(id)).then(|| ResourceNeed {
                id,
                request: resource.request.clone(),
            })
        })
    }
    pub fn provide(&mut self, response: ResourceResponse) -> Result<(), DiscoveryError> {
        self.provide_outcome(response.id, ResourceOutcome::Response(response))
    }
    pub fn provide_failure(&mut self, failure: ResourceFailure) -> Result<(), DiscoveryError> {
        self.provide_outcome(failure.id, ResourceOutcome::Failure(failure))
    }

    /// Leave blocked interpretations on the frontier while accessible work proceeds.
    pub fn provide_blocked(&mut self, failure: ResourceFailure) -> Result<(), DiscoveryError> {
        if self
            .requests
            .get(failure.id.0)
            .is_some_and(|record| record.access_attempted)
        {
            return self.provide_failure(failure);
        }
        self.provide_outcome(failure.id, ResourceOutcome::Blocked(failure))
    }

    /// Access is requested only after all accessible branches have settled.
    pub fn access_needed(&mut self) -> Result<Option<ResourceNeed>, DiscoveryError> {
        self.drive()?;
        if self.is_complete() || self.outstanding_needs().next().is_some() {
            return Ok(None);
        }
        Ok(self
            .requests
            .iter()
            .enumerate()
            .find_map(|(index, record)| {
                matches!(record.outcome, Some(ResourceOutcome::Blocked(_))).then(|| ResourceNeed {
                    id: RequestId(index),
                    request: record.request.clone(),
                })
            }))
    }

    /// The same frontier entries resume; only the resource's acquisition state changes.
    pub fn resolve_access(&mut self, id: RequestId, granted: bool) -> Result<(), DiscoveryError> {
        let record = self
            .requests
            .get_mut(id.0)
            .ok_or(DiscoveryError::UnknownRequest(id))?;
        let Some(ResourceOutcome::Blocked(failure)) = &record.outcome else {
            return Err(DiscoveryError::RequestAlreadyProvided(id));
        };
        record.outcome = if granted {
            None
        } else {
            Some(ResourceOutcome::Failure(failure.clone()))
        };
        record.access_attempted = true;
        self.drive()
    }
    fn provide_outcome(
        &mut self,
        id: RequestId,
        outcome: ResourceOutcome,
    ) -> Result<(), DiscoveryError> {
        self.record_outcome(id, outcome)?;
        self.drive()
    }

    fn record_outcome(
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
        Ok(())
    }

    /// Expand references once, in traversal order rather than fetch-reply order.
    fn expand_navigation(&mut self, id: RequestId, depth: usize) {
        let resource = &mut self.requests[id.0];
        if resource.navigation_expanded {
            return;
        }
        let Some(ResourceOutcome::Response(response)) = &resource.outcome else {
            return;
        };
        resource.navigation_expanded = true;
        let base = response
            .final_uri
            .as_deref()
            .filter(|uri| !uri.is_empty())
            .unwrap_or(&resource.request.uri);
        self.navigated.insert(resource.request.uri.clone());
        self.navigated.insert(base.to_owned());
        let roots = self
            .frontier
            .values()
            .filter(|work| matches!(work, Work::Root(_)))
            .count();
        let references: Vec<_> = crate::web_page::iframe_sources(&response.bytes)
            .take(self.limits.resources.saturating_sub(roots))
            .map(|source| resolve_relative(base, &source))
            .filter(|uri| {
                let supported = match url::Url::parse(uri) {
                    Ok(parsed) => matches!(parsed.scheme(), "http" | "https" | "file"),
                    Err(url::ParseError::RelativeUrlWithoutBase) => url::Url::parse(base).is_err(),
                    Err(_) => false,
                };
                supported && !self.navigated.contains(uri)
            })
            .collect();
        for uri in references {
            self.enqueue(DiscoveryInput::new(uri), Evidence::Navigation, depth + 1);
        }
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
        if let Some(error) = &self.initial_error {
            return Err(error.clone());
        }
        while self.catalog.is_none() {
            let position = self.frontier.iter().find_map(|(position, work)| {
                let blocked = match work {
                    Work::Root(_) => false,
                    Work::Parse(interpretation) => {
                        let id = interpretation.history.last().expect("parser resource");
                        matches!(
                            self.requests[id.0].outcome,
                            Some(ResourceOutcome::Blocked(_))
                        )
                    }
                };
                (!blocked).then_some(*position)
            });
            let Some(position) = position else {
                if !self.frontier.is_empty() {
                    return Ok(());
                }
                return Err(DiscoveryError::NoCandidateAccepted {
                    diagnostics: self.diagnostics.clone(),
                });
            };
            let work = self.frontier.remove(&position).expect("frontier work");
            match work {
                Work::Root(input) => self.expand(position, input)?,
                Work::Parse(interpretation) => {
                    let id = *interpretation
                        .history
                        .last()
                        .expect("parser owns a resource");
                    if self.requests[id.0].outcome.is_none() {
                        // Keep acceptance deterministic even when fetch replies arrive out of order.
                        self.frontier.insert(position, Work::Parse(interpretation));
                        return Ok(());
                    }
                    self.tick()?;
                    self.expand_navigation(id, position.1);
                    let result = self.parse(&interpretation);
                    self.apply(position, interpretation, result)?;
                }
            }
        }
        Ok(())
    }

    fn tick(&mut self) -> Result<(), DiscoveryError> {
        self.transitions += 1;
        if self.transitions > self.limits.transitions {
            return Err(DiscoveryError::TransitionLimitExceeded);
        }
        Ok(())
    }

    fn parse(&self, interpretation: &Interpretation) -> Result<DiscoveryStep, DiscoveryError> {
        let (&id, previous_history) = interpretation
            .history
            .split_last()
            .expect("parser resource");
        let resource = &self.requests[id.0];
        let context = DiscoveryContext {
            history_ids: previous_history,
            requests: &self.requests,
        };
        match resource.outcome.as_ref().expect("ready parser") {
            ResourceOutcome::Response(_) => dispatch_resource(
                interpretation.spec.routes,
                DiscoveryResource {
                    context,
                    ..resource.resource().expect("response")
                },
                "resource did not match any discovery route",
            ),
            // The resource could not be fetched: handlers may still
            // recover (krpano tries the next viewer script); otherwise the
            // failure is reported with its typed cause.
            ResourceOutcome::Failure(failure) => match interpretation.spec.on_failure {
                Some(handler) => handler(&context, &resource.request, failure),
                None => Err(DiscoveryError::fetch_failed(failure.cause.clone())),
            },
            ResourceOutcome::Blocked(_) => unreachable!("blocked work stays on the frontier"),
        }
    }

    fn expand(&mut self, position: Position, input: DiscoveryInput) -> Result<(), DiscoveryError> {
        if position.0 == Evidence::Navigation && self.navigated.contains(&input.url) {
            return Ok(());
        }
        self.navigated.insert(input.url.clone());
        if let Some(contents) = input.contents {
            self.retained_bytes -= contents.len();
            let id = self
                .register_request(Request::new(input.url.clone()))
                .ok_or(DiscoveryError::ResourceLimitExceeded)?;
            if self.requests[id.0].outcome.is_none() {
                self.record_outcome(
                    id,
                    ResourceOutcome::Response(ResourceResponse::new(id, contents)),
                )?;
            }
            self.expand_navigation(id, position.1);
        }
        let mut specs = self.specs.clone();
        // Unknown URL shapes still get content detection. A suffix miss is not a rejection.
        // Explicit matches precede unknowns; registry order breaks ties.
        specs.sort_by_key(|spec| {
            let kind = spec.url_kind(&input.url);
            (kind.is_none(), kind)
        });
        for (rank, spec) in specs.into_iter().enumerate() {
            self.tick()?;
            // Initial acquisition stays at the root's depth; following a reference advances it.
            self.apply(
                (position.0, position.1, position.2, rank),
                Interpretation {
                    spec,
                    history: Vec::new(),
                },
                Ok(DiscoveryStep::Follow(Request::new(&input.url))),
            )?;
            if self.catalog.is_some() {
                break;
            }
        }
        Ok(())
    }

    fn apply(
        &mut self,
        mut position: Position,
        mut interpretation: Interpretation,
        result: Result<DiscoveryStep, DiscoveryError>,
    ) -> Result<(), DiscoveryError> {
        let format = interpretation.spec.name;
        let result = result
            .and_then(|step| match step {
                DiscoveryStep::Follow(request) => interpretation
                    .spec
                    .follow(request, !interpretation.history.is_empty()),
                step => Ok(step),
            })
            .and_then(|step| match step {
                DiscoveryStep::Follow(request) => {
                    if !interpretation.history.is_empty() {
                        position.1 += 1;
                        // A format-derived link is image-specific evidence, even
                        // when its parent was reached through generic navigation.
                        position.0 = position.0.min(Evidence::Resource);
                    }
                    let id = self.register_request(request).ok_or_else(|| {
                        DiscoveryError::rejected(
                            RejectionKind::Failed,
                            "discovery resource limit exceeded",
                        )
                    })?;
                    if interpretation.history.contains(&id) {
                        return Err(DiscoveryError::rejected(
                            RejectionKind::Failed,
                            "discovery followed the same resource twice",
                        ));
                    }
                    interpretation.history.push(id);
                    Ok(Some(interpretation))
                }
                step => {
                    self.catalog = Some(step.compile(format)?);
                    Ok(None)
                }
            });
        match result {
            Ok(Some(interpretation)) => {
                self.frontier.insert(position, Work::Parse(interpretation));
            }
            Ok(None) => {}
            Err(error) => {
                let (kind, cause, detail) = match error {
                    DiscoveryError::Rejected {
                        kind,
                        cause,
                        detail,
                    } => (kind, cause, detail),
                    DiscoveryError::Session(message) => {
                        (RejectionKind::InvalidMetadata, None, Some(message))
                    }
                    other => return Err(other),
                };
                self.diagnostics.push(CandidateDiagnostic {
                    format: format.to_owned(),
                    kind,
                    cause,
                    detail,
                });
            }
        }
        Ok(())
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
            navigation_expanded: false,
            access_attempted: false,
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

    fn catalog(_: DiscoveryResource<'_>) -> Result<DiscoveryStep, DiscoveryError> {
        Ok(DiscoveryStep::Complete(DiscoveryCatalog::default()))
    }

    fn final_uri_catalog(resource: DiscoveryResource<'_>) -> Result<DiscoveryStep, DiscoveryError> {
        Ok(DiscoveryStep::Complete(DiscoveryCatalog::new([
            DiscoveredEntry::Ready(ResolvedImage {
                title: Some(resource.final_uri().into()),
                ..Default::default()
            }),
        ])))
    }

    const FINAL_URI: &[DiscoveryRoute] =
        &[metadata(url_suffix("/redirect")).decode(final_uri_catalog)];

    fn reject(_: DiscoveryResource<'_>) -> Result<DiscoveryStep, DiscoveryError> {
        Err(DiscoveryError::Session("wrong format".into()))
    }

    const COMPLETE: &[DiscoveryRoute] = &[metadata(any()).decode(catalog)];
    static LINK_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
        BytesRegex::new(r#"href="(?P<link>[^"]+)""#).expect("constant test link pattern")
    });
    const FOLLOW_CAPTURE: &[DiscoveryRoute] = &[
        DiscoveryRoute::html_relative_capture(&LINK_RE, "link"),
        metadata(any()).decode(catalog),
    ];
    static ID_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
        BytesRegex::new(r#"id="(?P<id>[A-Za-z0-9]+)""#).expect("constant test ID pattern")
    });
    const FOLLOW_ID: &[DiscoveryRoute] = &[
        DiscoveryRoute::capture_url(&ID_RE, "id", "https://tiles.test/", "/info.json"),
        metadata(any()).decode(catalog),
    ];

    fn provide(operation: &mut DiscoveryOperation, bytes: &[u8]) {
        let need = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide(ResourceResponse::new(need.id, bytes))
            .unwrap();
    }

    fn operation(routes: &'static [DiscoveryRoute], uri: &str) -> DiscoveryOperation {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("test", routes));
        registry.start(uri)
    }

    #[test]
    fn decoders_use_redirect_targets_and_ignore_empty_final_uris() {
        let requested = "https://example.test/redirect";
        for target in [None, Some(""), Some("https://cdn.example.test/info.xml")] {
            let mut operation = operation(FINAL_URI, requested);
            let need = operation.next_priority_need().unwrap().unwrap();
            let mut response = ResourceResponse::new(need.id, b"metadata");
            if let Some(target) = target {
                response = response.with_final_uri(target);
            }
            operation.provide(response).unwrap();
            let catalog = operation.finish().unwrap();
            let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
                panic!("expected one image")
            };
            assert_eq!(
                image.title.as_deref(),
                Some(target.filter(|uri| !uri.is_empty()).unwrap_or(requested))
            );
        }
    }

    #[test]
    fn captured_links_resolve_after_redirects_and_decode_html_entities() {
        let mut operation = operation(FOLLOW_CAPTURE, "https://example.test/old/page");
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
        let mut operation = operation(FOLLOW_ID, "https://example.test/viewer");
        provide(&mut operation, br#"<viewer id="Ab12">"#);
        let next = operation.missing_resources().unwrap().pop().unwrap();
        assert_eq!(next.request.uri, "https://tiles.test/Ab12/info.json");
    }

    fn branch(
        resource: DiscoveryResource<'_>,
        target: &str,
    ) -> Result<DiscoveryStep, DiscoveryError> {
        let context = resource.context();
        if context.resources().next().is_none() {
            return Ok(DiscoveryStep::Follow(
                Request::new(target).with_header("X-Test", "preserved"),
            ));
        }
        assert_eq!(
            context.resources().map(|r| r.uri()).collect::<Vec<_>>(),
            ["memory://shared"]
        );
        assert!(context.has_visited("memory://redirected"));
        match resource.bytes() {
            b"deeper" => Ok(resource.follow_relative("/deeper")),
            b"ok" => catalog(resource),
            _ => Err(DiscoveryError::Session("not an image".into())),
        }
    }

    const HISTORY_A: &[DiscoveryRoute] =
        &[viewer(any()).extract_metadata(|r| branch(r, "memory://a"))];
    const HISTORY_B: &[DiscoveryRoute] =
        &[viewer(any()).extract_metadata(|r| branch(r, "memory://b"))];

    #[test]
    fn access_recovery_preserves_followed_request_headers_and_branch_history() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("a", HISTORY_A));
        let mut operation = registry.start_inputs(vec![
            DiscoveryInput::new("memory://shared"),
            DiscoveryInput::with_contents("memory://unrelated", b"invalid"),
        ]);
        let root = operation.next_priority_need().unwrap().unwrap();
        operation
            .provide(
                ResourceResponse::new(root.id, b"shared").with_final_uri("memory://redirected"),
            )
            .unwrap();
        let need = operation.next_priority_need().unwrap().unwrap();
        operation
            .provide_blocked(ResourceFailure {
                id: need.id,
                cause: FetchCause::new(FetchCode::TransportPolicyDenied, TransportKind::Direct),
            })
            .unwrap();
        let access = operation.access_needed().unwrap().unwrap();
        assert_eq!(access, need);
        operation.resolve_access(access.id, true).unwrap();
        let resumed = operation.next_priority_need().unwrap().unwrap();
        assert_eq!(resumed.request.header("X-Test"), Some("preserved"));
        // The shared branch decoder verifies the original requested/redirected history.
        operation
            .provide(ResourceResponse::new(resumed.id, b"ok"))
            .unwrap();
        assert!(operation.is_complete());
    }

    #[test]
    fn shared_requests_preserve_history_headers_and_breadth_first_precedence() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("a", HISTORY_A));
        registry.register(FormatSpec::new("b", HISTORY_B));
        for (reversed, resources) in [(false, 3), (true, 3), (false, 4), (true, 4)] {
            for first_reply in [b"reject".as_slice(), b"deeper"] {
                let mut operation = registry.start_with_limits(
                    "memory://shared",
                    DiscoveryLimits {
                        resources,
                        ..Default::default()
                    },
                );
                let needs = operation.missing_resources().unwrap();
                assert_eq!(needs.len(), 1);
                operation
                    .provide(
                        ResourceResponse::new(needs[0].id, b"shared")
                            .with_final_uri("memory://redirected"),
                    )
                    .unwrap();
                let needs = operation.missing_resources().unwrap();
                assert_eq!(
                    needs
                        .iter()
                        .map(|n| n.request.uri.as_str())
                        .collect::<Vec<_>>(),
                    ["memory://a", "memory://b"]
                );
                assert!(
                    needs
                        .iter()
                        .all(|n| n.request.header("X-Test") == Some("preserved"))
                );
                let mut replies = [
                    ResourceResponse::new(needs[0].id, first_reply),
                    ResourceResponse::new(needs[1].id, b"ok"),
                ];
                if reversed {
                    replies.reverse();
                }
                let [first, second] = replies;
                operation.provide(first).unwrap();
                assert!(!operation.is_complete());
                operation.provide(second).unwrap();
                assert!(operation.is_complete());
                assert!(operation.missing_resources().unwrap().is_empty());
            }
        }
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

    #[test]
    fn failure_handlers_choose_the_next_action() {
        let mut registry = Registry::new();
        registry.register(FormatSpec::new("failure", COMPLETE).on_failure(recover));
        let mut operation = registry.start("memory://failure");
        let need = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide_failure(ResourceFailure {
                id: need.id,
                cause: FetchCause::new(FetchCode::DiscoveryFailed, TransportKind::Direct),
            })
            .unwrap();
        assert!(operation.finish().unwrap().is_empty());
    }

    fn repeat(resource: DiscoveryResource<'_>) -> Result<DiscoveryStep, DiscoveryError> {
        Ok(DiscoveryStep::Follow(Request::new(resource.uri())))
    }

    const REPEAT: &[DiscoveryRoute] = &[viewer(any()).extract_metadata(repeat)];

    #[test]
    fn following_the_same_uri_is_rejected() {
        let mut operation = operation(REPEAT, "memory://repeat");
        let need = operation.missing_resources().unwrap().pop().unwrap();
        let error = operation
            .provide(ResourceResponse::new(need.id, b"again"))
            .unwrap_err();
        assert!(error.to_string().contains("same resource twice"));
    }

    fn follow_again(resource: DiscoveryResource<'_>) -> Result<DiscoveryStep, DiscoveryError> {
        Ok(DiscoveryStep::Follow(Request::new(format!(
            "memory://{}",
            resource.context().resources().count()
        ))))
    }

    const LOOP: &[DiscoveryRoute] = &[viewer(any()).extract_metadata(follow_again)];

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
    }

    #[test]
    fn concurrent_page_replies_keep_navigation_in_frontier_order() {
        const FIRST: &[DiscoveryRoute] = &[
            viewer(url_suffix("/root"))
                .resolve_metadata(|_| Ok(Request::new("https://viewer.test/first"))),
            viewer(any()).extract_metadata(reject),
        ];
        const SECOND: &[DiscoveryRoute] = &[
            viewer(url_suffix("/root"))
                .resolve_metadata(|_| Ok(Request::new("https://viewer.test/second"))),
            viewer(any()).extract_metadata(reject),
        ];
        for reversed in [false, true] {
            let mut registry = Registry::new();
            registry.register(FormatSpec::new("first", FIRST));
            registry.register(FormatSpec::new("second", SECOND));
            let mut operation = registry.start("https://viewer.test/root");
            let needs = operation.missing_resources().unwrap();
            assert_eq!(needs.len(), 2);
            let mut replies = [
                ResourceResponse::new(
                    needs[0].id,
                    br#"<iframe src="/first-child"></iframe>"#.as_slice(),
                ),
                ResourceResponse::new(
                    needs[1].id,
                    br#"<iframe src="/second-child"></iframe>"#.as_slice(),
                ),
            ];
            if reversed {
                replies.reverse();
            }
            for reply in replies {
                operation.provide(reply).unwrap();
            }
            assert_eq!(
                operation.next_priority_need().unwrap().unwrap().request.uri,
                "https://viewer.test/first-child"
            );
        }
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
