//! Format parsing and bounded asynchronous discovery.

use std::{
    borrow::Cow,
    fmt,
    sync::{Arc, LazyLock},
};

use regex::bytes::Regex as BytesRegex;

use super::model::{CatalogPlan, DiscoveryCatalog, ImagePlan, Request};
use super::tile_plan::TileSourceError;
use super::uri::resolve_relative;
use crate::model::{
    DiscoveryInputKind, Error, HtmlDocument, HtmlElement, HtmlQuery, Interaction, JobInput,
};
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

impl From<JobInput> for DiscoveryInput {
    fn from(input: JobInput) -> Self {
        Self {
            url: input.url,
            contents: input.contents.map(String::into_bytes),
            kind: input.kind.unwrap_or_default(),
        }
    }
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
    /// Resource attempts across the entire search, including supplied documents,
    /// failures and interactive retries. Cache hits and URL evidence are free;
    /// replacing supplied contents does not replenish the allowance.
    pub resources: usize,
    /// Concurrent distinct remote reads. Supplied bodies and decoder work do
    /// not occupy network slots.
    pub concurrent: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            resources: 256,
            concurrent: 8,
        }
    }
}

pub enum ParsedResource {
    Follow(Request),
    /// A reference whose decoder is known by the resource that produced it.
    FollowWith(Request, Decoder),
    /// Decode an auxiliary resource which needs earlier discovery context.
    FollowIntermediate(Request, Decoder),
    Image(ImagePlan),
    Catalog(CatalogPlan),
    Complete(DiscoveryCatalog),
    /// A format route designated this entry point as reusable.
    #[doc(hidden)]
    CanonicalSource {
        uri: String,
        parsed: Box<Self>,
    },
}
impl ParsedResource {
    /// Attach a decoder to an unresolved reference; preserve other results.
    pub fn decode_with(self, decoder: Decoder) -> Self {
        match self {
            Self::Follow(request) => Self::FollowWith(request, decoder),
            Self::CanonicalSource { uri, parsed } => Self::CanonicalSource {
                uri,
                parsed: Box::new(parsed.decode_with(decoder)),
            },
            parsed => parsed,
        }
    }

    /// Attach a context-dependent decoder without making its resource canonical.
    pub fn decode_intermediate_with(self, decoder: Decoder) -> Self {
        match self {
            Self::Follow(request) => Self::FollowIntermediate(request, decoder),
            Self::CanonicalSource { uri, parsed } => Self::CanonicalSource {
                uri,
                parsed: Box::new(parsed.decode_intermediate_with(decoder)),
            },
            parsed => parsed,
        }
    }

    pub(crate) fn compile(self, format: &'static str) -> Result<DiscoveryCatalog, DiscoveryError> {
        match self {
            Self::Image(plan) => plan.compile(format),
            Self::Catalog(plan) => plan.compile(format),
            Self::Complete(catalog) => Ok(catalog),
            Self::CanonicalSource { uri, parsed } => parsed
                .compile(format)
                .map(|catalog| catalog.with_source_url(&uri)),
            Self::Follow(_) | Self::FollowWith(..) | Self::FollowIntermediate(..) => Err(
                DiscoveryError::InvalidMetadata("a metadata reference has no image plan".into()),
            ),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct DiscoveryResource<'a> {
    request: Option<&'a Request>,
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
            request: None,
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
    /// The request that supplied these bytes, including any byte range.
    #[must_use]
    pub const fn request(self) -> Option<&'a Request> {
        self.request
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
pub type Decoder = for<'a> fn(DiscoveryResource<'a>) -> Result<ParsedResource, DiscoveryError>;
type FailureHandler = for<'a> fn(
    &DiscoveryContext<'a>,
    &'a Request,
    &'a Error,
) -> Result<ParsedResource, DiscoveryError>;
type UrlMapper = fn(&str) -> Result<Request, DiscoveryError>;
type UrlPredicate = fn(&str) -> bool;

/// Strength of evidence for discovery work. Content matchers contribute only
/// after matching available bytes; they never justify speculative reads.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
pub enum Specificity {
    High,
    #[default]
    Medium,
    Low,
}

/// A matcher with a constructor-specific default strength. Override broad
/// exceptions explicitly rather than inferring strength from selector syntax.
/// URL evidence defaults to High for metadata/images and Medium for viewers.
/// CSS/content regexes default to High and custom content predicates to Medium.
/// Wildcards add no evidence; successful schema decoders retain caller evidence.
#[derive(Clone, Copy, Debug)]
pub struct DiscoveryMatch {
    pattern: MatchPattern,
    specificity: Option<Specificity>,
}

#[derive(Clone, Copy, Debug)]
enum MatchPattern {
    Any,
    UrlSuffix(&'static str),
    UrlPredicate(UrlPredicate),
    Css(&'static str, fn(&HtmlElement) -> bool),
    ResourcePredicate(for<'a> fn(DiscoveryResource<'a>) -> bool),
    ContentRegex(&'static LazyLock<BytesRegex>),
    MarkupRegex(&'static LazyLock<BytesRegex>),
    ScriptRegex(&'static LazyLock<BytesRegex>),
}

impl DiscoveryMatch {
    const fn new(pattern: MatchPattern) -> Self {
        Self {
            pattern,
            specificity: None,
        }
    }

    #[must_use]
    pub const fn specificity(mut self, specificity: Specificity) -> Self {
        self.specificity = Some(specificity);
        self
    }

    fn matches_url(self, uri: &str) -> bool {
        match self.pattern {
            MatchPattern::Any => true,
            MatchPattern::UrlSuffix(suffix) => uri
                .split(['?', '#'])
                .next()
                .unwrap_or(uri)
                .ends_with(suffix),
            MatchPattern::UrlPredicate(predicate) => predicate(uri),
            _ => false,
        }
    }

    fn url_match(self, uri: &str) -> Option<bool> {
        matches!(
            self.pattern,
            MatchPattern::UrlSuffix(_) | MatchPattern::UrlPredicate(_)
        )
        .then(|| self.matches_url(uri))
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
    DiscoveryMatch::new(MatchPattern::Any)
}
pub const fn url_suffix(suffix: &'static str) -> DiscoveryMatch {
    DiscoveryMatch::new(MatchPattern::UrlSuffix(suffix))
}
pub const fn url_matches(predicate: UrlPredicate) -> DiscoveryMatch {
    DiscoveryMatch::new(MatchPattern::UrlPredicate(predicate))
}
/// Match a CSS selector and pass its first selected element to the decoder.
pub const fn css(selector: &'static str) -> DiscoveryMatch {
    css_when(selector, |_| true)
}
pub const fn css_when(selector: &'static str, accept: fn(&HtmlElement) -> bool) -> DiscoveryMatch {
    DiscoveryMatch::new(MatchPattern::Css(selector, accept))
}

pub const fn resource_matches(
    predicate: for<'a> fn(DiscoveryResource<'a>) -> bool,
) -> DiscoveryMatch {
    DiscoveryMatch::new(MatchPattern::ResourcePredicate(predicate))
}

/// A permissive markup guard: XML and HTML need not be distinguished here.
pub const fn html_matches(regex: &'static LazyLock<BytesRegex>) -> DiscoveryMatch {
    DiscoveryMatch::new(MatchPattern::MarkupRegex(regex))
}

pub const fn js_matches(regex: &'static LazyLock<BytesRegex>) -> DiscoveryMatch {
    DiscoveryMatch::new(MatchPattern::ScriptRegex(regex))
}

/// Parsed wire metadata converts directly into a format result.
pub trait Metadata: serde::de::DeserializeOwned {
    fn decode(self, resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError>;
}

/// Schema failures are route misses; conversion errors retain their cause.
pub const fn json_metadata<T: Metadata>() -> DiscoveryRoute {
    metadata(any()).try_decode(|resource| {
        serde_json::from_slice::<T>(resource.bytes())
            .ok()
            .map(|metadata| metadata.decode(resource))
    })
}

pub const fn xml_metadata<T: Metadata>() -> DiscoveryRoute {
    metadata(any()).try_decode(|resource| {
        quick_xml::de::from_reader::<_, T>(resource.bytes())
            .ok()
            .map(|metadata| metadata.decode(resource))
    })
}

/// Semantic input pattern paired with a decoding or reference-resolution action.
/// Decoding designates the matched resource as canonical unless opted out.
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
    pub const fn try_decode(
        self,
        decoder: for<'a> fn(
            DiscoveryResource<'a>,
        ) -> Option<Result<ParsedResource, DiscoveryError>>,
    ) -> DiscoveryRoute {
        self.route(RouteAction::TryDecode(decoder))
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
            followed_decoder: None,
            followed_intermediate: false,
            canonical: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DiscoveryRoute {
    matcher: DiscoveryMatch,
    handler: RouteAction,
    kind: RouteKind,
    followed_decoder: Option<Decoder>,
    followed_intermediate: bool,
    canonical: bool,
}

impl DiscoveryRoute {
    fn evidence(self) -> Option<Specificity> {
        self.matcher.specificity.or(match self.matcher.pattern {
            MatchPattern::Any => None,
            MatchPattern::UrlSuffix(_) | MatchPattern::UrlPredicate(_) => Some(match self.kind {
                RouteKind::Metadata | RouteKind::Image => Specificity::High,
                RouteKind::Viewer => Specificity::Medium,
            }),
            MatchPattern::ResourcePredicate(_) => Some(Specificity::Medium),
            _ => Some(Specificity::High),
        })
    }

    /// Expand named regex captures into a metadata reference (`$name`).
    pub const fn regex_link(regex: &'static LazyLock<BytesRegex>, template: &'static str) -> Self {
        Self {
            matcher: DiscoveryMatch::new(MatchPattern::ContentRegex(regex)),
            kind: RouteKind::Viewer,
            handler: RouteAction::RegexLink(regex, template, None),
            followed_decoder: None,
            followed_intermediate: false,
            canonical: true,
        }
    }

    /// Override the evidence strength of this route's matcher.
    #[must_use]
    pub const fn specificity(mut self, specificity: Specificity) -> Self {
        self.matcher.specificity = Some(specificity);
        self
    }

    /// Decode references produced by this route without running discovery again.
    #[must_use]
    pub const fn then_decode(mut self, decoder: Decoder) -> Self {
        self.followed_decoder = Some(decoder);
        self.followed_intermediate = false;
        self
    }

    /// Decode an auxiliary target while retaining the preceding canonical source.
    #[must_use]
    pub const fn then_decode_intermediate(mut self, decoder: Decoder) -> Self {
        self.followed_decoder = Some(decoder);
        self.followed_intermediate = true;
        self
    }

    /// Preserve the preceding canonical URL rather than designating this route's
    /// resource. Use for intermediate resources which cannot
    /// independently reconstruct the image or catalog.
    #[must_use]
    pub const fn non_canonical(mut self) -> Self {
        self.canonical = false;
        self
    }

    fn followed(self, parsed: ParsedResource, current_uri: &str) -> ParsedResource {
        let parsed = match self.followed_decoder {
            Some(decoder) if self.followed_intermediate => parsed.decode_intermediate_with(decoder),
            Some(decoder) => parsed.decode_with(decoder),
            None => parsed,
        };
        if self.canonical {
            ParsedResource::CanonicalSource {
                uri: current_uri.to_owned(),
                parsed: Box::new(parsed),
            }
        } else {
            parsed
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum RouteAction {
    Plan(fn(&str) -> Result<ImagePlan, DiscoveryError>),
    Decode(Decoder),
    TryDecode(for<'a> fn(DiscoveryResource<'a>) -> Option<Result<ParsedResource, DiscoveryError>>),
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

/// Return the matched evidence alongside its action. A wildcard contributes no
/// new evidence; its decoder may still recognize complete metadata.
fn parse_resource(
    routes: &[DiscoveryRoute],
    resource: DiscoveryResource<'_>,
) -> Result<(ParsedResource, Option<Specificity>), DiscoveryError> {
    for route in routes {
        let selected = match route.matcher.pattern {
            MatchPattern::Css(selector, accept) => {
                resource.select(selector).find(|tag| accept(tag))
            }
            _ => None,
        };
        let matched = match route.matcher.pattern {
            MatchPattern::Css(..) => selected.is_some(),
            MatchPattern::ResourcePredicate(predicate) => predicate(resource),
            MatchPattern::ContentRegex(regex) => regex.is_match(resource.bytes()),
            MatchPattern::MarkupRegex(regex) => {
                resource.is_html() && regex.is_match(resource.bytes())
            }
            MatchPattern::ScriptRegex(regex) => {
                crate::web_page::script_bodies(resource).any(|bytes| regex.is_match(bytes))
            }
            _ => {
                route.matcher.matches_url(resource.final_uri())
                    || (resource.uri() != resource.final_uri()
                        && route.matcher.matches_url(resource.uri()))
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
            RouteAction::Decode(decoder) => decoder(resource),
            RouteAction::TryDecode(decoder) => match decoder(resource) {
                Some(result) => result,
                None => continue,
            },
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
        }
        .map(|parsed| {
            (
                route.followed(parsed, resource.final_uri()),
                route.evidence(),
            )
        });
    }
    Err(DiscoveryError::rejected(
        RejectionKind::DidNotMatchContent,
        "resource did not match any discovery route",
    ))
}

/// Routes are tried in declaration order. Specificity schedules discovery work;
/// it does not reorder parser fallback within a format. A `try_decode` miss
/// continues to the next route; matched decoder errors retain their cause.
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

    fn url_specificity(&self, uri: &str) -> Option<Specificity> {
        self.routes
            .iter()
            .filter(|route| route.matcher.url_match(uri) == Some(true))
            .filter_map(|route| route.evidence())
            .min()
    }

    fn follow(&self, request: Request) -> Result<ParsedResource, DiscoveryError> {
        if !self
            .routes
            .iter()
            .any(|route| route.matcher.url_match(&request.uri) != Some(false))
        {
            return Err(DiscoveryError::rejected(
                RejectionKind::DidNotMatchUrl,
                "no matching URL route",
            ));
        }
        for route in self.routes {
            if !route.matcher.matches_url(&request.uri) {
                continue;
            }
            match route.handler {
                RouteAction::MapUrl(mapper) => {
                    return mapper(&request.uri).map(|target| {
                        route.followed(ParsedResource::Follow(target), &request.uri)
                    });
                }
                RouteAction::Plan(decode) => {
                    return decode(&request.uri)
                        .map(|image| route.followed(ParsedResource::Image(image), &request.uri));
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
    ResourceLimitExceeded,
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
            Self::ResourceLimitExceeded => f.write_str("discovery resource limit exceeded"),
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
            request: Some(&self.request),
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
    bytes: Arc<Vec<u8>>,
    final_uri: Option<String>,
    html: HtmlDocument,
    /// Reconstructed viewer data stays below declared source catalogs, even
    /// when another branch consumes it through a recognized metadata URL.
    snapshot: bool,
}

mod search;
pub use search::discover;

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

    #[test]
    fn metadata_routes_convert_the_value_deserialized_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static PARSES: AtomicUsize = AtomicUsize::new(0);

        fn width<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<u32, D::Error> {
            PARSES.fetch_add(1, Ordering::Relaxed);
            serde::Deserialize::deserialize(decoder)
        }
        #[derive(serde::Deserialize)]
        struct Document {
            #[serde(rename = "@width", alias = "width", deserialize_with = "width")]
            width: u32,
        }
        impl Metadata for Document {
            fn decode(self, _: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
                Ok(ParsedResource::Image(ImagePlan::new(
                    None,
                    vec![super::super::model::ResolvedLevel::grid(
                        crate::Vec2d::square(self.width),
                        crate::Vec2d::square(2),
                        |_| Request::new("memory://tile"),
                    )?],
                )))
            }
        }

        for (route, bytes) in [
            (json_metadata::<Document>(), br#"{"width":4}"#.as_slice()),
            (xml_metadata::<Document>(), br#"<Image width="4"/>"#),
        ] {
            PARSES.store(0, Ordering::Relaxed);
            let catalog =
                parse_resource(&[route], DiscoveryResource::new("memory://metadata", bytes))
                    .unwrap()
                    .0
                    .compile("test")
                    .unwrap();
            let super::super::model::DiscoveredEntry::Ready(image) = &catalog.entries()[0] else {
                panic!("expected an image")
            };
            assert_eq!(image.source_url.as_deref(), Some("memory://metadata"));
            assert_eq!(
                image.levels[0].source.image_size(),
                Some(crate::Vec2d::square(4))
            );
            assert_eq!(PARSES.load(Ordering::Relaxed), 1);
        }
    }

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
