//! Expand declarative reference routes, preserving route and match order.
use super::*;
use crate::core::DiscoveredEntry;
use std::collections::BTreeSet;

pub(super) fn collect(
    routes: &[DiscoveryRoute],
    resource: DiscoveryResource<'_>,
    specificity: Option<Specificity>,
) -> Result<ParsedResource, DiscoveryError> {
    let base = crate::web_page::page_base(resource);
    let mut seen = BTreeSet::new();
    let mut urls = Vec::new();
    let mut failure = None;
    for route in routes
        .iter()
        .filter(|route| route.is_reference() && route.evidence() == specificity)
    {
        let Some(selected) = route.select_resource(resource) else {
            continue;
        };
        let (references, filename) = expand(*route, selected);
        for reference in references {
            let reference = match reference {
                Ok(reference) => reference,
                Err(error) => {
                    failure.get_or_insert(error);
                    continue;
                }
            };
            if reference.trim().is_empty() {
                continue;
            }
            let mut uri = resolve_relative(&base, reference.trim());
            if let Some(filename) = filename {
                uri = super::super::uri::append_path_component(&uri, filename);
            }
            if uri != resource.final_uri() && seen.insert(uri.clone()) {
                urls.push(uri);
            }
        }
    }
    match urls.len() {
        0 => Err(failure.unwrap_or_else(|| {
            DiscoveryError::InvalidMetadata("page declares no distinct metadata reference".into())
        })),
        1 => Ok(ParsedResource::Follow(Request::new(urls.remove(0)))),
        _ => Ok(ParsedResource::Complete(DiscoveryCatalog::new(
            urls.into_iter()
                .map(|uri| DiscoveredEntry::deferred(uri, None, Vec::new())),
        ))),
    }
}

fn expand(
    route: DiscoveryRoute,
    resource: DiscoveryResource<'_>,
) -> (Vec<Result<String, DiscoveryError>>, Option<&'static str>) {
    match route.handler {
        RouteAction::RegexLink(regex, template, filename) => {
            let mut references: Vec<_> = regex
                .captures_iter(resource.bytes())
                .map(|captures| {
                    let mut link = Vec::new();
                    captures.expand(template.as_bytes(), &mut link);
                    Ok(
                        html_escape::decode_html_entities(&String::from_utf8_lossy(&link))
                            .into_owned(),
                    )
                })
                .collect();
            if references.is_empty() {
                references.push(Err(DiscoveryError::InvalidMetadata(
                    "metadata path missing".into(),
                )));
            }
            (references, filename)
        }
        RouteAction::FollowAttribute {
            attribute,
            prefix,
            suffix,
        } => (
            elements(route, resource)
                .into_iter()
                .map(|element| {
                    element.and_then(|element| {
                        element
                            .required(attribute)
                            .map(|value| format!("{prefix}{}{suffix}", value.trim()))
                    })
                })
                .collect(),
            None,
        ),
        RouteAction::TextFile(filename) => (
            elements(route, resource)
                .into_iter()
                .map(|element| element.map(|element| element.text.clone()))
                .collect(),
            Some(filename),
        ),
        _ => unreachable!("only reference routes are expanded"),
    }
}

fn elements<'a>(
    route: DiscoveryRoute,
    resource: DiscoveryResource<'a>,
) -> Vec<Result<&'a HtmlElement, DiscoveryError>> {
    match route.matcher.pattern {
        MatchPattern::Css(selector, accept) => resource
            .select(selector)
            .filter(|element| accept(element))
            .map(Ok)
            .collect(),
        _ => vec![resource.element()],
    }
}
