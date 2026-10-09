//! Format parsing and bounded asynchronous discovery.

use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet, HashSet},
    fmt,
    rc::Rc,
    sync::{Arc, LazyLock},
};

use regex::bytes::Regex as BytesRegex;

use super::model::{CatalogPlan, DiscoveryCatalog, ImagePlan, Request};
use super::tile_plan::TileSourceError;
use super::uri::resolve_relative;
use crate::model::{DiscoveryInputKind, Error, HtmlDocument, HtmlElement, HtmlQuery};
static SCRIPT_MARKUP: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)<(?:script|base|body)\b").expect("constant markup pattern")
});

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
    html: Option<&'a HtmlDocument>,
    selected: Option<&'a HtmlElement>,
}

impl<'a> DiscoveryResource<'a> {
    #[must_use]
    pub const fn new(uri: &'a str, bytes: &'a [u8]) -> Self {
        Self {
            uri,
            bytes,
            final_uri: uri,
            context: DiscoveryContext { history: &[] },
            html: None,
            selected: None,
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

    pub fn select(self, selector: &str) -> impl Iterator<Item = &'a HtmlElement> {
        self.html
            .into_iter()
            .flat_map(move |html| html.select(selector))
    }

    pub(crate) fn is_html(self) -> bool {
        let source = self.text_lossy();
        source
            .trim_start_matches(['\u{feff}', ' ', '\n', '\r', '\t'])
            .starts_with('<')
            || ((self.select("base[href], script").next().is_some()
                || self.select("body[onload]").next().is_some())
                && {
                    let visible =
                        crate::javascript::mask(&source.replace("<!--", "/*").replace("-->", "*/"));
                    crate::javascript::captures(&SCRIPT_MARKUP, &visible)
                        .next()
                        .is_some()
                })
    }

    pub fn element(self) -> Result<&'a HtmlElement, DiscoveryError> {
        self.selected.ok_or_else(|| {
            DiscoveryError::InvalidMetadata("route has no selected HTML element".into())
        })
    }

    pub fn with_html(mut self, html: &'a HtmlDocument) -> Self {
        self.html = Some(html);
        self
    }

    /// Decode resource bytes as UTF-8, replacing malformed sequences.
    #[must_use]
    pub fn text_lossy(self) -> Cow<'a, str> {
        String::from_utf8_lossy(self.bytes)
    }

    /// Follow a reference against the parsed document base or post-redirect URI.
    #[must_use]
    pub fn follow_relative(self, reference: &str) -> ParsedResource {
        ParsedResource::Follow(Request::new(resolve_relative(
            &crate::web_page::page_base(self),
            reference,
        )))
    }
    pub fn follow_file(self, reference: &str, filename: &str) -> ParsedResource {
        let uri = resolve_relative(&crate::web_page::page_base(self), reference);
        ParsedResource::Follow(Request::new(super::uri::append_path_component(
            &uri, filename,
        )))
    }
}
impl HtmlElement {
    pub fn required(&self, name: &str) -> Result<&str, DiscoveryError> {
        self.attribute(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DiscoveryError::InvalidMetadata(format!("{} has no {name}", self.name)))
    }
    pub fn positive_u32(&self, name: &str) -> Result<u32, DiscoveryError> {
        self.required(name)?
            .parse()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                DiscoveryError::InvalidMetadata(format!("{} has invalid {name}", self.name))
            })
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
    pub(crate) fn failures(&self) -> impl DoubleEndedIterator<Item = &Error> {
        self.history
            .iter()
            .filter_map(|record| record.response.as_ref().err())
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
    &'a Error,
) -> Result<ParsedResource, DiscoveryError>;
type UrlMapper = fn(&str) -> Result<Request, DiscoveryError>;
type UrlPredicate = fn(&str) -> bool;

#[derive(Clone, Copy, Debug)]
pub enum DiscoveryMatch {
    Any,
    UrlSuffix(&'static str),
    UrlPredicate(UrlPredicate),
    Css(&'static str, fn(&HtmlElement) -> bool),
    ResourcePredicate(for<'a> fn(DiscoveryResource<'a>) -> bool),
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
            Self::Css(..) | Self::ResourcePredicate(_) => false,
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
    RoutePattern::new(matcher, RouteKind::Metadata)
}
pub const fn viewer(matcher: DiscoveryMatch) -> RoutePattern {
    RoutePattern::new(matcher, RouteKind::Viewer)
}
pub const fn image_url(predicate: UrlPredicate) -> RoutePattern {
    RoutePattern::new(url_matches(predicate), RouteKind::Image)
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
/// Match a CSS selector and pass its first selected element to the decoder.
pub const fn css(selector: &'static str) -> DiscoveryMatch {
    css_when(selector, |_| true)
}
pub const fn css_when(selector: &'static str, accept: fn(&HtmlElement) -> bool) -> DiscoveryMatch {
    DiscoveryMatch::Css(selector, accept)
}

pub const fn resource_matches(
    predicate: for<'a> fn(DiscoveryResource<'a>) -> bool,
) -> DiscoveryMatch {
    DiscoveryMatch::ResourcePredicate(predicate)
}

pub const fn content_matches(regex: &'static LazyLock<BytesRegex>) -> DiscoveryMatch {
    DiscoveryMatch::ContentRegex(regex)
}

/// Semantic input pattern paired with a decoding or reference-resolution action.
pub struct RoutePattern {
    matcher: DiscoveryMatch,
    kind: RouteKind,
}

impl RoutePattern {
    const fn new(matcher: DiscoveryMatch, kind: RouteKind) -> Self {
        Self { matcher, kind }
    }

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
    /// Metadata that is meaningful only after this format has read its parent.
    #[must_use]
    pub const fn child_metadata(self, handler: Decoder) -> DiscoveryRoute {
        self.route(RouteAction::ChildMetadata(handler))
    }
    #[must_use]
    pub const fn resolve_metadata(self, mapper: UrlMapper) -> DiscoveryRoute {
        self.route(RouteAction::MapUrl(mapper))
    }
    /// Follow a decoded attribute against the document's base URI.
    pub const fn follow_attribute(self, attribute: &'static str) -> DiscoveryRoute {
        self.attribute_url(attribute, "", "")
    }
    /// Follow a metadata file beneath the selected element's text URL.
    pub const fn text_file(self, filename: &'static str) -> DiscoveryRoute {
        self.route(RouteAction::TextFile(filename))
    }
    /// Follow a metadata file beneath the first regex capture's URL.
    pub const fn regex_file(
        self,
        regex: &'static LazyLock<BytesRegex>,
        filename: &'static str,
    ) -> DiscoveryRoute {
        self.route(RouteAction::RegexLink(regex, "$1", Some(filename)))
    }
    /// Insert a decoded attribute into a metadata reference.
    pub const fn attribute_url(
        self,
        attribute: &'static str,
        prefix: &'static str,
        suffix: &'static str,
    ) -> DiscoveryRoute {
        self.route(RouteAction::FollowAttribute {
            attribute,
            prefix,
            suffix,
        })
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
    /// Expand named regex captures into a metadata reference (`$name`).
    pub const fn regex_link(regex: &'static LazyLock<BytesRegex>, template: &'static str) -> Self {
        Self {
            matcher: DiscoveryMatch::ContentRegex(regex),
            kind: RouteKind::Viewer,
            handler: RouteAction::RegexLink(regex, template, None),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum RouteAction {
    Plan(fn(&str) -> Result<ImagePlan, DiscoveryError>),
    ChildMetadata(Decoder),
    Decode(Decoder),
    MapUrl(UrlMapper),
    FollowAttribute {
        attribute: &'static str,
        prefix: &'static str,
        suffix: &'static str,
    },
    RegexLink(
        &'static LazyLock<BytesRegex>,
        &'static str,
        Option<&'static str>,
    ),
    TextFile(&'static str),
}

fn parse_resource(
    routes: &[DiscoveryRoute],
    resource: DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    for route in routes {
        if matches!(route.handler, RouteAction::ChildMetadata(_))
            && resource.context.history.is_empty()
        {
            continue;
        }
        let selected = match route.matcher {
            DiscoveryMatch::Css(selector, accept) => {
                resource.select(selector).find(|tag| accept(tag))
            }
            _ => None,
        };
        let matched = match route.matcher {
            DiscoveryMatch::Css(..) => selected.is_some(),
            DiscoveryMatch::ResourcePredicate(predicate) => predicate(resource),
            DiscoveryMatch::ContentRegex(regex) => regex.is_match(resource.bytes()),
            matcher => {
                matcher.matches(resource.final_uri(), Some(resource.bytes()))
                    || (resource.uri() != resource.final_uri()
                        && matcher.matches(resource.uri(), Some(resource.bytes())))
            }
        };
        if !matched {
            continue;
        }
        let resource = DiscoveryResource {
            selected,
            ..resource
        };
        return match route.handler {
            RouteAction::Decode(decoder) | RouteAction::ChildMetadata(decoder) => decoder(resource),
            RouteAction::FollowAttribute {
                attribute,
                prefix,
                suffix,
            } => {
                let reference = resource.element()?.required(attribute)?;
                Ok(resource.follow_relative(&format!("{prefix}{}{suffix}", reference.trim())))
            }
            RouteAction::TextFile(filename) => {
                Ok(resource.follow_file(resource.element()?.text.trim(), filename))
            }
            RouteAction::RegexLink(regex, template, filename) => {
                let captures = regex.captures(resource.bytes()).ok_or_else(|| {
                    DiscoveryError::InvalidMetadata("metadata path missing".into())
                })?;
                let mut link = Vec::new();
                captures.expand(template.as_bytes(), &mut link);
                let text = String::from_utf8_lossy(&link);
                let reference = html_escape::decode_html_entities(text.trim());
                Ok(match filename {
                    Some(filename) => resource.follow_file(&reference, filename),
                    None => resource.follow_relative(&reference),
                })
            }
            RouteAction::MapUrl(_) | RouteAction::Plan(_) => continue,
        };
    }
    Err(DiscoveryError::rejected(
        RejectionKind::DidNotMatchContent,
        "resource did not match any discovery route",
    ))
}

#[derive(Clone, Copy, Debug)]
pub struct FormatSpec {
    name: &'static str,
    display_name: &'static str,
    routes: &'static [DiscoveryRoute],
    on_failure: Option<FailureHandler>,
    html_queries: &'static [&'static str],
}

impl FormatSpec {
    #[must_use]
    pub const fn new(name: &'static str, routes: &'static [DiscoveryRoute]) -> Self {
        Self {
            name,
            display_name: name,
            routes,
            on_failure: None,
            html_queries: &[],
        }
    }
    #[must_use]
    pub const fn on_failure(mut self, handler: FailureHandler) -> Self {
        self.on_failure = Some(handler);
        self
    }
    /// Additional CSS projections needed by this format's pure decoders.
    pub const fn html_queries(mut self, selectors: &'static [&'static str]) -> Self {
        self.html_queries = selectors;
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
    /// The candidate parsed the metadata successfully, but the document
    /// declares no image (for example a zero-sized DZI). Distinct from
    /// [`Self::InvalidMetadata`]: the document is readable, it is empty.
    NoImage,
    /// A resource the candidate needed could not be fetched.
    FetchFailed,
    /// The candidate stopped for another reason (resource or traversal
    /// limits, or an internal invariant).
    Failed,
}

/// One rejected candidate's diagnostic, retaining the original host error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateDiagnostic {
    pub format: String,
    pub kind: RejectionKind,
    pub cause: Option<Box<Error>>,
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
        cause: Option<Box<Error>>,
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
    pub(crate) fn fetch_failed(cause: Error) -> Self {
        Self::Rejected {
            kind: RejectionKind::FetchFailed,
            cause: Some(Box::new(cause)),
            detail: None,
        }
    }
}

/// The observed fetch facts that define one diagnostic group: variant
/// identity plus HTTP status, transport, and policy reason. Bounded detail
/// and previews are diagnostics, never grouping facts.
fn observed_cause(
    cause: &Error,
) -> (
    &'static str,
    Option<u16>,
    Option<crate::model::ErrorTransport>,
    Option<crate::model::BlockedReason>,
) {
    let cause = cause.cause();
    match cause {
        Error::HttpError {
            status, transport, ..
        } => (cause.kind(), Some(*status), Some(*transport), None),
        Error::PolicyDenied {
            blocked_reason,
            transport,
            ..
        } => (cause.kind(), None, Some(*transport), Some(*blocked_reason)),
        Error::RateLimited { transport, .. }
        | Error::Timeout { transport, .. }
        | Error::NetworkFailure { transport, .. }
        | Error::ProxyError { transport, .. } => (cause.kind(), None, Some(*transport), None),
        other => (other.kind(), None, None, None),
    }
}

/// Fetch rejections group by their observed facts (variant, HTTP status,
/// transport, and policy reason); other rejections group by detail.
/// URL and content misses collapse to one count.
#[must_use]
pub fn diagnostic_bullets(diagnostics: &[CandidateDiagnostic]) -> Vec<String> {
    let mut misses: Vec<&str> = Vec::new();
    let mut grouped: Vec<(&CandidateDiagnostic, Vec<&str>)> = Vec::new();
    for diagnostic in diagnostics {
        if matches!(
            diagnostic.kind,
            RejectionKind::DidNotMatchUrl | RejectionKind::DidNotMatchContent
        ) {
            let name = diagnostic.format.as_str();
            if !misses.contains(&name) {
                misses.push(name);
            }
            continue;
        }
        let group = grouped.iter_mut().find(|(existing, _)| {
            existing.kind == diagnostic.kind
                && match (&existing.cause, &diagnostic.cause) {
                    (Some(a), Some(b)) => observed_cause(a) == observed_cause(b),
                    (None, None) => existing.detail == diagnostic.detail,
                    _ => false,
                }
        });
        match group {
            Some((_, names)) => {
                let name = diagnostic.format.as_str();
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            None => grouped.push((diagnostic, vec![diagnostic.format.as_str()])),
        }
    }
    let mut lines = Vec::new();
    for (diagnostic, names) in grouped {
        let text = if let Some(cause) = &diagnostic.cause {
            describe_fetch(cause)
        } else {
            diagnostic
                .detail
                .clone()
                .unwrap_or_else(|| "rejected".into())
        };
        lines.push(format!(" - {}: {}", names.join(", "), text));
    }
    if !misses.is_empty() {
        lines.push(format!(
            " - {} other format(s) did not match this resource",
            misses.len()
        ));
    }
    lines
}

fn describe_fetch(error: &Error) -> String {
    let error = error.cause();
    let status = match error {
        Error::HttpError { status, .. } => format!("HTTP {status}"),
        other => other.kind().to_string(),
    };
    match error {
        Error::PolicyDenied { blocked_reason, .. } => {
            format!(
                "{status} fetching this address, reason={}",
                blocked_reason.as_str()
            )
        }
        _ => format!("{status} fetching this address"),
    }
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
            } => f.write_str(&describe_fetch(cause)),
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
                } else if block.len() > 4000 {
                    // Typed error detail must fit the 4096-char bound checked downstream.
                    format!("{}...", &block[..block.floor_char_boundary(4000)])
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
    response: Result<Arc<ParsedResponse>, Error>,
}
impl ReadResource {
    fn resource(&self) -> Option<DiscoveryResource<'_>> {
        let response = self.response.as_ref().ok()?;
        Some(DiscoveryResource {
            html: Some(&response.html),
            final_uri: response
                .final_uri
                .as_deref()
                .filter(|uri| !uri.is_empty())
                .unwrap_or(&self.request.uri),
            ..DiscoveryResource::new(&self.request.uri, &response.bytes)
        })
    }
}

#[derive(Clone, Debug)]
struct ParsedResponse {
    bytes: Vec<u8>,
    final_uri: Option<String>,
    html: HtmlDocument,
}

#[derive(Clone)]
enum Read {
    Response(Arc<ParsedResponse>),
    NeedsAccess,
}
type SharedRead<'a> = futures_util::future::Shared<
    futures_util::future::LocalBoxFuture<'a, Result<Read, crate::model::Error>>,
>;

type Priority = (u8, usize, usize, usize);

struct Resources<'a, F, P> {
    fetch: &'a F,
    parse_html: &'a P,
    selectors: Vec<String>,
    supplied: BTreeMap<Request, Vec<u8>>,
    reads: RefCell<Vec<(Request, bool, SharedRead<'a>)>>,
    responses: Rc<RefCell<Vec<ReadResource>>>,
    retained: Rc<Cell<usize>>,
    parsed: Cell<usize>,
    depths: RefCell<BTreeMap<Request, usize>>,
    limits: DiscoveryLimits,
}

impl<'a, F, Fut, P, PFut> Resources<'a, F, P>
where
    F: Fn(Request, crate::model::Interaction) -> Fut,
    Fut: std::future::Future<Output = Result<crate::model::ResourceRead, crate::model::Error>> + 'a,
    P: Fn(HtmlQuery) -> PFut,
    PFut: std::future::Future<Output = Result<HtmlDocument, Error>> + 'a,
{
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
            let supplied = self.supplied.get(&request).cloned();
            let supplied_bytes = supplied.is_some();
            let parse_html = self.parse_html;
            let fetch = self.fetch;
            let selectors = self.selectors.clone();
            let responses = self.responses.clone();
            let retained = self.retained.clone();
            let limit = self.limits.retained_bytes;
            let key = request.clone();
            let future = async move {
                let response = if let Some(bytes) = supplied {
                    crate::model::ResourceResponse {
                        bytes,
                        final_uri: None,
                    }
                } else {
                    let interaction = if interactive {
                        crate::model::Interaction::Allowed
                    } else {
                        crate::model::Interaction::Forbidden
                    };
                    match (fetch)(key.clone(), interaction).await? {
                        crate::model::ResourceRead::NeedsAccess { .. } => {
                            return Ok(Read::NeedsAccess);
                        }
                        crate::model::ResourceRead::Response { response } => response,
                    }
                };
                let added = if supplied_bytes {
                    0
                } else {
                    response.bytes.len()
                };
                let total = retained
                    .get()
                    .checked_add(added)
                    .filter(|total| *total <= limit)
                    .ok_or_else(|| {
                        Error::ResourceLimit("discovery metadata size limit exceeded".into())
                    })?;
                retained.set(total);
                let html = parse_html(HtmlQuery {
                    source: String::from_utf8_lossy(&response.bytes).into_owned(),
                    selectors,
                })
                .await?;
                let total = retained
                    .get()
                    .checked_add(html.byte_len())
                    .filter(|total| *total <= limit)
                    .ok_or_else(|| {
                        Error::ResourceLimit("discovery HTML projection size limit exceeded".into())
                    })?;
                retained.set(total);
                let response = Arc::new(ParsedResponse {
                    bytes: response.bytes,
                    final_uri: response.final_uri,
                    html,
                });
                responses.borrow_mut().push(ReadResource {
                    request: key,
                    response: Ok(response.clone()),
                });
                Ok(Read::Response(response))
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
        priority: &Cell<Priority>,
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
                    response: Ok(response),
                },
                Err(DiscoveryError::Host(error))
                    if error.is_terminal()
                        || matches!(error.cause(), Error::ResourceLimit { .. }) =>
                {
                    return Err(DiscoveryError::Host(error));
                }
                Err(DiscoveryError::Host(error)) => {
                    parsed = match spec.on_failure {
                        Some(handler) => handler(&context, &request, &error)?,
                        None => return Err(DiscoveryError::fetch_failed(*error)),
                    };
                    history.push(ReadResource {
                        request,
                        response: Err(*error),
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
            )?;
            history.push(record);
        }
    }
}

/// Resolve formats through shared, bounded asynchronous resource reads.
pub async fn discover<F, Fut, P, PFut>(
    inputs: Vec<DiscoveryInput>,
    specs: &[FormatSpec],
    limits: DiscoveryLimits,
    fetch: F,
    parse_html: P,
) -> Result<DiscoveryCatalog, DiscoveryError>
where
    F: Fn(Request, crate::model::Interaction) -> Fut,
    Fut: std::future::Future<Output = Result<crate::model::ResourceRead, crate::model::Error>>,
    P: Fn(HtmlQuery) -> PFut,
    PFut: std::future::Future<Output = Result<HtmlDocument, Error>>,
{
    use futures_util::{StreamExt, stream};
    if inputs.len() > limits.resources {
        return Err(DiscoveryError::ResourceLimitExceeded);
    }
    let supplied_bytes = inputs
        .iter()
        .filter_map(|input| input.contents.as_ref())
        .try_fold(0usize, |total, bytes| {
            total
                .checked_add(bytes.len())
                .filter(|total| *total <= limits.retained_bytes)
        })
        .ok_or(DiscoveryError::MetadataSizeLimitExceeded)?;
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
    roots.sort_by_key(|(evidence, depth, order, _)| (*evidence, *depth, *order));
    let resources = Resources {
        fetch: &fetch,
        parse_html: &parse_html,
        selectors: HtmlDocument::PAGE_QUERIES
            .iter()
            .copied()
            .chain(
                specs
                    .iter()
                    .flat_map(|spec| spec.html_queries.iter().copied()),
            )
            .chain(specs.iter().flat_map(|spec| {
                spec.routes.iter().filter_map(|route| match route.matcher {
                    DiscoveryMatch::Css(selector, _) => Some(selector),
                    _ => None,
                })
            }))
            .map(str::to_owned)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        supplied: roots
            .iter()
            .rev()
            .filter_map(|(_, _, _, input)| {
                input
                    .contents
                    .as_ref()
                    .map(|bytes| (Request::new(&input.url), bytes.clone()))
            })
            .collect(),
        reads: Default::default(),
        responses: Default::default(),
        retained: Rc::new(Cell::new(supplied_bytes)),
        parsed: Default::default(),
        depths: Default::default(),
        limits,
    };
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
                Cell::new((rank.0, rank.1 + usize::from(!direct), rank.2, rank.3))
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
                let settled = || {
                    winner.as_ref().is_some_and(|(best, _)| {
                        priorities
                            .iter()
                            .zip(&finished)
                            .all(|(rank, done)| *done || rank.get() >= *best)
                    })
                };
                if settled() {
                    return Poll::Ready(None);
                }
                let result = std::pin::Pin::new(&mut results).poll_next(cx);
                if result.is_pending() && settled() {
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
            let Some(page) = resource.resource() else {
                continue;
            };
            let base = page.final_uri();
            visited.insert(resource.request.uri.clone());
            visited.insert(base.to_owned());
            let document_base = crate::web_page::page_base(page);
            for source in crate::web_page::iframe_sources(page) {
                let uri = resolve_relative(&document_base, source);
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
            .resolve(spec, &uri, true, &Cell::new(rank), rank)
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
    use crate::model::{BlockedReason, ErrorTransport, Failure};

    fn http_cause(status: u16, transport: ErrorTransport) -> Box<Error> {
        Box::new(Error::HttpError {
            status,
            retry_after_ms: None,
            preview: None,
            transport,
            failure: Failure {
                request: Some("https://example.test/metadata".into()),
                detail: None,
            },
        })
    }

    #[test]
    fn repeated_formats_list_once() {
        let diagnostics = (0..30)
            .flat_map(|_| {
                ["zoomify", "krpano", "topviewer", "vls"].map(|format| CandidateDiagnostic {
                    format: format.into(),
                    kind: RejectionKind::InvalidMetadata,
                    cause: None,
                    detail: Some("unreadable metadata".into()),
                })
            })
            .collect::<Vec<_>>();
        let bullets = diagnostic_bullets(&diagnostics);
        assert_eq!(bullets.len(), 1);
        assert!(bullets[0].starts_with(" - zoomify, krpano, topviewer, vls: "));
        assert!(!bullets[0].contains("zoomify, krpano, topviewer, vls, zoomify"));
    }

    #[test]
    fn diagnostics_group_by_typed_cause_and_collapse_route_misses() {
        let diagnostic = |format: &str, kind, cause: Option<Box<Error>>, detail: Option<&str>| {
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
                    Some(http_cause(403, ErrorTransport::Direct)),
                    None,
                ),
                diagnostic(
                    "zoomify",
                    RejectionKind::FetchFailed,
                    Some(http_cause(403, ErrorTransport::Direct)),
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
                // URL and content misses from another scanned input count once.
                diagnostic(
                    "generic",
                    RejectionKind::DidNotMatchContent,
                    None,
                    Some("resource did not match any discovery route"),
                ),
            ],
        };
        assert_eq!(
            error.to_string(),
            "no discovery candidate accepted the input\
             \n - iiif, zoomify: HTTP 403 fetching this address\
             \n - deepzoom: unable to parse DZI metadata\
             \n - 2 other format(s) did not match this resource"
        );
        // Detailed diagnostics carry no headline.
        assert_eq!(
            error.detail(),
            " - iiif, zoomify: HTTP 403 fetching this address\
             \n - deepzoom: unable to parse DZI metadata\
             \n - 2 other format(s) did not match this resource"
        );
    }

    #[test]
    fn distinct_causes_never_merge_and_detail_never_splits() {
        let causes = [
            http_cause(403, ErrorTransport::Direct),
            http_cause(404, ErrorTransport::Direct),
            http_cause(403, ErrorTransport::MetadataProxy),
            http_cause(403, ErrorTransport::Native),
            http_cause(403, ErrorTransport::DisplayOnly),
            Box::new(Error::PolicyDenied {
                blocked_reason: BlockedReason::SignedQuery,
                transport: ErrorTransport::MetadataProxy,
                failure: Failure::default(),
            }),
            Box::new(Error::PolicyDenied {
                blocked_reason: BlockedReason::PrivateHost,
                transport: ErrorTransport::MetadataProxy,
                failure: Failure::default(),
            }),
            Box::new(Error::NetworkFailure {
                transport: ErrorTransport::BrowserSession,
                failure: Failure::default(),
            }),
        ];
        let diagnostics: Vec<_> = causes
            .iter()
            .map(|cause| CandidateDiagnostic {
                format: "iiif".into(),
                kind: RejectionKind::FetchFailed,
                cause: Some(cause.clone()),
                detail: None,
            })
            .collect();
        let rendered = diagnostic_bullets(&diagnostics);
        assert_eq!(rendered.len(), causes.len());
        assert!(
            rendered
                .iter()
                .any(|line| line.contains("reason=signed-query"))
        );
        assert!(
            rendered
                .iter()
                .any(|line| line.contains("network-failure fetching this address"))
        );
        // Bounded detail is a diagnostic, never a grouping fact.
        let mut different_text = diagnostics[0].clone();
        if let Some(cause) = &mut different_text.cause
            && let Error::HttpError { failure, .. } = cause.as_mut()
        {
            failure.detail = Some("another format's explanation".into());
        }
        assert_eq!(
            diagnostic_bullets(&[diagnostics[0].clone(), different_text]).len(),
            1
        );
    }
}
