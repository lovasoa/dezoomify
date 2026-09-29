//! Format parsing and bounded asynchronous discovery.

use std::borrow::Cow;
use std::collections::HashSet;
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

    /// One rendering of this failure for discovery diagnostics. The request
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
    pub cause: FetchCause,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiscoveryLimits {
    pub max_parses: usize,
    pub resources: usize,
    pub retained_bytes: usize,
    pub concurrent: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            max_parses: 10_000,
            resources: 256,
            retained_bytes: 64 * 1024 * 1024,
            concurrent: 8,
        }
    }
}

pub enum ParsedResource {
    Follow(Request),
    Image(ImagePlan),
    Catalog(CatalogPlan),
    Complete(DiscoveryCatalog),
}
impl ParsedResource {
    pub(crate) fn compile(self, format: &'static str) -> Result<DiscoveryCatalog, DiscoveryError> {
        match self {
            Self::Image(plan) => plan.compile(format),
            Self::Catalog(plan) => plan.compile(format),
            Self::Complete(catalog) => Ok(catalog),
            Self::Follow(_) => Err(DiscoveryError::InvalidMetadata(
                "a metadata reference has no image plan".into(),
            )),
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
            context: DiscoveryContext { history: &[] },
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
    pub fn follow_relative(self, reference: &str) -> ParsedResource {
        ParsedResource::Follow(Request::new(resolve_relative(self.final_uri, reference)))
    }
}
#[derive(Clone, Copy, Debug)]
pub struct DiscoveryContext<'a> {
    history: &'a [ReadResource],
}
impl<'a> DiscoveryContext<'a> {
    pub fn resources(&self) -> impl DoubleEndedIterator<Item = DiscoveryResource<'a>> + '_ {
        self.history.iter().filter_map(ReadResource::resource)
    }
    pub fn has_visited(&self, uri: &str) -> bool {
        self.history.iter().any(|record| {
            record.request.uri == uri
                || record
                    .resource()
                    .is_some_and(|resource| resource.final_uri() == uri)
        })
    }
}
type Decoder = for<'a> fn(DiscoveryResource<'a>) -> Result<ParsedResource, DiscoveryError>;
type FailureHandler = for<'a> fn(
    &DiscoveryContext<'a>,
    &'a Request,
    &'a ResourceFailure,
) -> Result<ParsedResource, DiscoveryError>;
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
    pub const fn child_metadata(self, handler: Decoder) -> DiscoveryRoute {
        self.route(RouteAction::ChildMetadata(handler))
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
    ChildMetadata(Decoder),
    Decode(Decoder),
    MapUrl(UrlMapper),
    FollowCapture {
        capture: &'static str,
        html_entities: bool,
        prefix: &'static str,
        suffix: &'static str,
    },
}

fn parse_resource(
    routes: &[DiscoveryRoute],
    resource: DiscoveryResource<'_>,
    unmatched: &str,
) -> Result<ParsedResource, DiscoveryError> {
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
            RouteAction::Decode(decoder) | RouteAction::ChildMetadata(decoder) => decoder(resource),
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
                        DiscoveryError::InvalidMetadata("resource has no matching link".into())
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
    /// display name set it explicitly at their `SPEC` site.
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
                !matches!(route.handler, RouteAction::ChildMetadata(_))
                    && route.matcher.url_match(uri) == Some(true)
            })
            .map(|route| route.kind)
            .min()
    }

    fn follow(
        &self,
        request: Request,
        has_history: bool,
    ) -> Result<ParsedResource, DiscoveryError> {
        if !self.routes.iter().any(|route| {
            (has_history || !matches!(route.handler, RouteAction::ChildMetadata(_)))
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
                    return mapper(&request.uri).map(ParsedResource::Follow);
                }
                RouteAction::Plan(decode) => {
                    return decode(&request.uri).map(ParsedResource::Image);
                }
                _ => {}
            }
        }
        Ok(ParsedResource::Follow(request))
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
    /// The candidate stopped for another reason (resource or traversal
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
    Host(Box<crate::model::Error>),
    NoCandidateAccepted {
        diagnostics: Vec<CandidateDiagnostic>,
    },
    /// A candidate rejected the input or resource; `kind` classifies why.
    /// Fetch failures carry the typed cause; other rejections carry a
    /// free-text detail.
    Rejected {
        kind: RejectionKind,
        cause: Option<FetchCause>,
        detail: Option<String>,
    },
    /// A format handler or extractor failed without a typed rejection.
    InvalidMetadata(String),
    ParseLimitExceeded,
    ResourceLimitExceeded,
    MetadataSizeLimitExceeded,
}

impl From<TileSourceError> for DiscoveryError {
    fn from(error: TileSourceError) -> Self {
        Self::InvalidMetadata(format!("invalid tile grid: {error}"))
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
            Self::Host(error) => error.fmt(f),
            Self::NoCandidateAccepted { diagnostics } => {
                f.write_str("no discovery candidate accepted the input")?;
                for line in diagnostic_bullets(diagnostics) {
                    write!(f, "\n{line}")?;
                }
                Ok(())
            }
            Self::Rejected {
                cause: Some(cause), ..
            } => f.write_str(&cause.describe()),
            Self::Rejected {
                detail: Some(detail),
                ..
            } => f.write_str(detail),
            Self::Rejected { .. } => f.write_str("candidate rejected the input"),
            Self::InvalidMetadata(message) => f.write_str(message),
            Self::ParseLimitExceeded => f.write_str("discovery parse limit exceeded"),
            Self::ResourceLimitExceeded => f.write_str("discovery resource limit exceeded"),
            Self::MetadataSizeLimitExceeded => {
                f.write_str("discovery metadata size limit exceeded")
            }
        }
    }
}

impl DiscoveryError {
    /// Discovery diagnostics: the headline-free per-format
    /// bullet block for a rejected aggregate, or the plain error text
    /// otherwise. The headline stays out: callers render their own
    /// prominent message and never repeat it inside the details.
    #[must_use]
    pub fn detail(&self) -> String {
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

#[derive(Clone, Debug)]
struct ReadResource {
    request: Request,
    response: Option<std::sync::Arc<crate::model::ResourceResponse>>,
}
impl ReadResource {
    fn resource(&self) -> Option<DiscoveryResource<'_>> {
        let response = self.response.as_ref()?;
        Some(DiscoveryResource {
            final_uri: response
                .final_uri
                .as_deref()
                .filter(|uri| !uri.is_empty())
                .unwrap_or(&self.request.uri),
            ..DiscoveryResource::new(&self.request.uri, &response.bytes)
        })
    }
}

#[derive(Clone)]
enum Read {
    Response(std::sync::Arc<crate::model::ResourceResponse>),
    NeedsAccess,
}
type SharedRead<'a> = futures_util::future::Shared<
    futures_util::future::LocalBoxFuture<'a, Result<Read, crate::model::Error>>,
>;

type Priority = (u8, usize, usize, usize);

struct Resources<'a, F> {
    fetch: &'a F,
    reads: std::cell::RefCell<Vec<(Request, bool, SharedRead<'a>)>>,
    responses: std::rc::Rc<std::cell::RefCell<Vec<ReadResource>>>,
    retained: std::rc::Rc<std::cell::Cell<usize>>,
    parsed: std::cell::Cell<usize>,
    depths: std::cell::RefCell<std::collections::BTreeMap<Request, usize>>,
    limits: DiscoveryLimits,
}

impl<'a, F, Fut> Resources<'a, F>
where
    F: Fn(Request, crate::model::Interaction) -> Fut,
    Fut: std::future::Future<Output = Result<crate::model::ResourceRead, crate::model::Error>> + 'a,
{
    fn supplied(&self, input: &DiscoveryInput) -> Result<(), DiscoveryError> {
        use futures_util::FutureExt;
        if let Some(bytes) = &input.contents {
            let retained = self
                .retained
                .get()
                .checked_add(bytes.len())
                .ok_or(DiscoveryError::MetadataSizeLimitExceeded)?;
            if retained > self.limits.retained_bytes {
                return Err(DiscoveryError::MetadataSizeLimitExceeded);
            }
            self.retained.set(retained);
            let request = Request::new(&input.url);
            let response = std::sync::Arc::new(crate::model::ResourceResponse {
                bytes: bytes.clone(),
                final_uri: None,
            });
            self.responses.borrow_mut().push(ReadResource {
                request: request.clone(),
                response: Some(response.clone()),
            });
            self.reads.borrow_mut().push((
                request,
                false,
                async move { Ok(Read::Response(response)) }
                    .boxed_local()
                    .shared(),
            ));
        }
        Ok(())
    }

    async fn read(&self, request: Request, interactive: bool) -> Result<Read, DiscoveryError> {
        use futures_util::FutureExt;
        let cached = self
            .reads
            .borrow()
            .iter()
            .find(|(key, allowed, _)| *key == request && *allowed == interactive)
            .map(|(_, _, future)| future.clone());
        let future = if let Some(cached) = cached {
            cached
        } else {
            if self.reads.borrow().len() >= self.limits.resources {
                return Err(DiscoveryError::rejected(
                    RejectionKind::Failed,
                    "discovery resource limit exceeded",
                ));
            }
            let future = (self.fetch)(
                request.clone(),
                if interactive {
                    crate::model::Interaction::Allowed
                } else {
                    crate::model::Interaction::Forbidden
                },
            );
            let responses = self.responses.clone();
            let retained = self.retained.clone();
            let limit = self.limits.retained_bytes;
            let key = request.clone();
            let future = async move {
                match future.await? {
                    crate::model::ResourceRead::NeedsAccess { .. } => Ok(Read::NeedsAccess),
                    crate::model::ResourceRead::Response { response } => {
                        let total = retained
                            .get()
                            .checked_add(response.bytes.len())
                            .filter(|total| *total <= limit)
                            .ok_or_else(|| {
                                crate::model::Error::new(
                                    "job.resource-limit",
                                    crate::model::ErrorPhase::Discovery,
                                    "discovery metadata size limit exceeded",
                                )
                            })?;
                        retained.set(total);
                        let response = std::sync::Arc::new(response);
                        responses.borrow_mut().push(ReadResource {
                            request: key,
                            response: Some(response.clone()),
                        });
                        Ok(Read::Response(response))
                    }
                }
            }
            .boxed_local()
            .shared();
            self.reads
                .borrow_mut()
                .push((request.clone(), interactive, future.clone()));
            future
        };
        future
            .await
            .map_err(|error| DiscoveryError::Host(Box::new(error)))
    }

    async fn resolve(
        &self,
        spec: FormatSpec,
        uri: &str,
        interactive: bool,
        priority: &std::cell::Cell<Priority>,
        base: Priority,
    ) -> Result<Option<(usize, DiscoveryCatalog)>, DiscoveryError> {
        let mut history = Vec::new();
        let mut parsed = ParsedResource::Follow(Request::new(uri));
        loop {
            let ParsedResource::Follow(request) = parsed else {
                return parsed
                    .compile(spec.name)
                    .map(|catalog| Some((history.len(), catalog)));
            };
            parsed = spec.follow(request, !history.is_empty())?;
            let ParsedResource::Follow(request) = parsed else {
                continue;
            };
            priority.set((
                base.0.min(if history.is_empty() { base.0 } else { 2 }),
                base.1 + history.len() + 1,
                base.2,
                base.3,
            ));
            self.depths
                .borrow_mut()
                .entry(request.clone())
                .and_modify(|depth| *depth = (*depth).min(base.1 + history.len()))
                .or_insert(base.1 + history.len());
            let context = DiscoveryContext { history: &history };
            if history
                .iter()
                .any(|previous: &ReadResource| previous.request == request)
            {
                return Err(DiscoveryError::rejected(
                    RejectionKind::Failed,
                    "discovery followed the same resource twice",
                ));
            }
            self.parsed.set(self.parsed.get() + 1);
            if self.parsed.get() > self.limits.max_parses {
                return Err(DiscoveryError::ParseLimitExceeded);
            }
            let response = match self.read(request.clone(), false).await {
                Ok(Read::NeedsAccess) if interactive => self.read(request.clone(), true).await,
                result => result,
            };
            let record = match response {
                Ok(Read::NeedsAccess) => return Ok(None),
                Ok(Read::Response(response)) => ReadResource {
                    request: request.clone(),
                    response: Some(response),
                },
                Err(DiscoveryError::Host(error))
                    if error.code == "job.cancelled"
                        || error.code == "TRANSPORT_CANCELLED"
                        || error.code == "job.resource-limit"
                        || error.code.starts_with("binding.") =>
                {
                    return Err(DiscoveryError::Host(error));
                }
                Err(DiscoveryError::Host(error)) => {
                    let failure = ResourceFailure {
                        cause: FetchCause {
                            code: FetchCode::from_string(error.code),
                            http: error.http,
                            transport: match error.transport {
                                Some(crate::model::ErrorTransport::MetadataProxy) => {
                                    TransportKind::MetadataProxy
                                }
                                Some(crate::model::ErrorTransport::BrowserSession) => {
                                    TransportKind::BrowserSession
                                }
                                _ => TransportKind::Direct,
                            },
                            reason: error
                                .blocked_reason
                                .map(|r| PolicyReason::from_string(r.as_str())),
                        },
                    };
                    parsed = match spec.on_failure {
                        Some(handler) => handler(&context, &request, &failure)?,
                        None => return Err(DiscoveryError::fetch_failed(failure.cause)),
                    };
                    history.push(ReadResource {
                        request,
                        response: None,
                    });
                    continue;
                }
                Err(error) => return Err(error),
            };
            parsed = parse_resource(
                spec.routes,
                DiscoveryResource {
                    context,
                    ..record.resource().expect("read response")
                },
                "resource did not match any discovery route",
            )?;
            history.push(record);
        }
    }
}

/// Resolve formats through shared, bounded asynchronous resource reads.
pub async fn discover<F, Fut>(
    inputs: Vec<DiscoveryInput>,
    specs: &[FormatSpec],
    limits: DiscoveryLimits,
    fetch: F,
) -> Result<DiscoveryCatalog, DiscoveryError>
where
    F: Fn(Request, crate::model::Interaction) -> Fut,
    Fut: std::future::Future<Output = Result<crate::model::ResourceRead, crate::model::Error>>,
{
    use futures_util::{StreamExt, stream};
    if inputs.len() > limits.resources {
        return Err(DiscoveryError::ResourceLimitExceeded);
    }
    let resources = Resources {
        fetch: &fetch,
        reads: Default::default(),
        responses: Default::default(),
        retained: Default::default(),
        parsed: Default::default(),
        depths: Default::default(),
        limits,
    };
    let mut roots: Vec<_> = inputs
        .into_iter()
        .enumerate()
        .map(|(order, input)| {
            let evidence = match input.kind {
                DiscoveryInputKind::Source => 0,
                DiscoveryInputKind::ObservedDocument if input.contents.is_some() => 1,
                _ => match specs
                    .iter()
                    .filter_map(|spec| spec.url_kind(&input.url))
                    .min()
                {
                    Some(RouteKind::Metadata | RouteKind::Image) => 2,
                    Some(RouteKind::Viewer) => 3,
                    None => 4,
                },
            };
            (evidence, 0usize, order, input)
        })
        .collect();
    for (_, _, _, input) in &roots {
        resources.supplied(input)?;
    }
    let mut visited: HashSet<String> = roots
        .iter()
        .map(|(_, _, _, input)| input.url.clone())
        .collect();
    let mut diagnostics = Vec::new();
    let mut blocked = Vec::new();
    let mut branch = roots.len();
    loop {
        roots.sort_by_key(|(evidence, depth, order, _)| (*evidence, *depth, *order));
        let mut candidates = Vec::new();
        let tier = roots
            .first()
            .map(|(evidence, depth, _, _)| (*evidence, *depth));
        let ready = roots
            .iter()
            .take_while(|(evidence, depth, _, _)| Some((*evidence, *depth)) == tier)
            .count();
        for (evidence, depth, order, input) in roots.drain(..ready) {
            let mut formats = specs.to_vec();
            formats.sort_by_key(|spec| {
                let kind = spec.url_kind(&input.url);
                (kind.is_none(), kind)
            });
            candidates.extend(
                formats
                    .into_iter()
                    .enumerate()
                    .map(|(rank, spec)| ((evidence, depth, order, rank), spec, input.url.clone())),
            );
        }
        let priorities: Vec<_> = candidates
            .iter()
            .map(|(rank, spec, uri)| {
                let direct = spec.url_kind(uri) == Some(RouteKind::Image);
                std::cell::Cell::new((rank.0, rank.1 + usize::from(!direct), rank.2, rank.3))
            })
            .collect();
        let mut finished = vec![false; candidates.len()];
        let mut results = stream::iter(candidates.iter().enumerate().map(
            |(index, (rank, spec, uri))| {
                let priority = &priorities[index];
                let resources = &resources;
                async move {
                    (
                        index,
                        *rank,
                        *spec,
                        uri.clone(),
                        resources.resolve(*spec, uri, false, priority, *rank).await,
                    )
                }
            },
        ))
        .buffer_unordered(limits.concurrent.max(1));
        let mut winner: Option<(Priority, DiscoveryCatalog)> = None;
        loop {
            let next = futures_util::future::poll_fn(|cx| {
                use futures_util::Stream;
                use std::task::Poll;
                // Ordinary earlier reads keep their precedence. A branch that has
                // followed a deeper link no longer delays a shallower result.
                if winner.as_ref().is_some_and(|(best, _)| {
                    priorities
                        .iter()
                        .enumerate()
                        .all(|(i, rank)| finished[i] || rank.get() >= *best)
                }) {
                    return Poll::Ready(None);
                }
                let result = std::pin::Pin::new(&mut results).poll_next(cx);
                if result.is_pending()
                    && winner.as_ref().is_some_and(|(best, _)| {
                        priorities
                            .iter()
                            .enumerate()
                            .all(|(i, rank)| finished[i] || rank.get() >= *best)
                    })
                {
                    return Poll::Ready(None);
                }
                result
            })
            .await;
            let Some((index, rank, spec, uri, result)) = next else {
                break;
            };
            finished[index] = true;
            match result {
                Ok(Some((distance, catalog))) => {
                    let rank = (
                        rank.0.min(if distance > 1 { 2 } else { rank.0 }),
                        rank.1 + distance,
                        rank.2,
                        rank.3,
                    );
                    if winner.as_ref().is_none_or(|(best, _)| rank < *best) {
                        winner = Some((rank, catalog));
                    }
                }
                Ok(None) => blocked.push((rank, spec, uri)),
                Err(error) => record_diagnostic(&mut diagnostics, spec, error)?,
            }
        }
        drop(results);
        if let Some((_, catalog)) = winner {
            return Ok(catalog);
        }
        let reads = resources.reads.borrow();
        let responses = resources.responses.borrow();
        for (request, _, _) in reads.iter() {
            let Some(resource) = responses
                .iter()
                .find(|resource| resource.request == *request)
            else {
                continue;
            };
            let Some(response) = &resource.response else {
                continue;
            };
            let base = response
                .final_uri
                .as_deref()
                .filter(|uri| !uri.is_empty())
                .unwrap_or(&resource.request.uri);
            visited.insert(resource.request.uri.clone());
            visited.insert(base.to_owned());
            for source in crate::web_page::iframe_sources(&response.bytes) {
                let uri = resolve_relative(base, &source);
                let supported = match url::Url::parse(&uri) {
                    Ok(url) => matches!(url.scheme(), "http" | "https" | "file"),
                    Err(url::ParseError::RelativeUrlWithoutBase) => url::Url::parse(base).is_err(),
                    Err(_) => false,
                };
                if supported && visited.insert(uri.clone()) && roots.len() < limits.resources {
                    let depth = resources.depths.borrow().get(request).copied().unwrap_or(0) + 1;
                    roots.push((3, depth, branch, DiscoveryInput::new(uri)));
                    branch += 1;
                }
            }
        }
        if roots.is_empty() {
            break;
        }
    }
    blocked.sort_by_key(|(rank, _, _)| *rank);
    for (rank, spec, uri) in blocked {
        match resources
            .resolve(spec, &uri, true, &std::cell::Cell::new(rank), rank)
            .await
        {
            Ok(Some((_, catalog))) => return Ok(catalog),
            Ok(None) => {}
            Err(error) => record_diagnostic(&mut diagnostics, spec, error)?,
        }
    }
    Err(DiscoveryError::NoCandidateAccepted { diagnostics })
}

fn record_diagnostic(
    diagnostics: &mut Vec<CandidateDiagnostic>,
    spec: FormatSpec,
    error: DiscoveryError,
) -> Result<(), DiscoveryError> {
    let (kind, cause, detail) = match error {
        DiscoveryError::Rejected {
            kind,
            cause,
            detail,
        } => (kind, cause, detail),
        DiscoveryError::InvalidMetadata(message) => {
            (RejectionKind::InvalidMetadata, None, Some(message))
        }
        other => return Err(other),
    };
    diagnostics.push(CandidateDiagnostic {
        format: spec.name.into(),
        kind,
        cause,
        detail,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        // Detailed diagnostics carry no headline.
        assert_eq!(
            error.detail(),
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
