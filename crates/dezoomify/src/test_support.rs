//! Deterministic resource acquisition and plan helpers shared by in-crate
//! format tests (`crate::test_support`) and integration tests (`tests/support`
//! includes this file via `#[path]`). Paths go through `super::` so the same
//! bodies resolve against either crate root.
#![allow(dead_code)]
use super::core::discovery::{DiscoveryError, DiscoveryInput, DiscoveryLimits};
use super::core::{
    DiscoveredEntry, DiscoveryCatalog, FormatSpec, Grid, Registry, Request, ResolvedImage,
    ResolvedLevel, TileSource,
};
use super::model::{Error, ResourceRead, ResourceResponse};
use std::cell::RefCell;

#[path = "../../dezoomify-native/src/html.rs"]
pub mod html;
pub use html::parse_html;

pub fn resource<R>(
    uri: &str,
    bytes: &[u8],
    decode: impl FnOnce(super::core::DiscoveryResource<'_>) -> R,
) -> R {
    let html = futures::executor::block_on(parse_html(super::model::HtmlQuery {
        source: String::from_utf8_lossy(bytes).into_owned(),
        selectors: super::model::HtmlDocument::PAGE_QUERIES
            .iter()
            .map(|selector| (*selector).into())
            .collect(),
    }))
    .unwrap();
    decode(super::core::DiscoveryResource::new(uri, bytes).with_html(&html))
}

/// Discovery over an injected byte lookup: the one fetch stub. Misses fail
/// `discovery-failed` naming the URI; every request is logged in order.
pub fn discover_with_responses(
    registry: Registry,
    input: &str,
    lookup: impl FnMut(&str) -> Option<Result<(Vec<u8>, Option<String>), Error>>,
) -> (Result<DiscoveryCatalog, DiscoveryError>, Vec<Request>) {
    discover_inputs(
        registry,
        vec![DiscoveryInput::new(input)],
        DiscoveryLimits::default(),
        lookup,
    )
}

pub fn discover_inputs(
    registry: Registry,
    inputs: Vec<DiscoveryInput>,
    limits: DiscoveryLimits,
    lookup: impl FnMut(&str) -> Option<Result<(Vec<u8>, Option<String>), Error>>,
) -> (Result<DiscoveryCatalog, DiscoveryError>, Vec<Request>) {
    let lookup = RefCell::new(lookup);
    let requests = RefCell::new(Vec::new());
    let result = futures::executor::block_on(registry.discover(
        inputs,
        limits,
        |request, _| {
            let (uri, reply) = {
                let uri = request.uri.clone();
                let reply = lookup.borrow_mut()(&uri);
                requests.borrow_mut().push(request);
                (uri, reply)
            };
            async move {
                match reply {
                    Some(Ok((bytes, final_uri))) => Ok(ResourceRead::Response {
                        response: ResourceResponse { bytes, final_uri },
                    }),
                    Some(Err(error)) => Err(error),
                    None => Err(Error::DiscoveryFailed {
                        failure: format!("no fixture: {uri}").into(),
                        cause: None,
                    }),
                }
            }
        },
        parse_html,
        |_| async { Ok(Vec::new()) },
    ));
    (result, requests.into_inner())
}

/// Discovery keyed by request URI.
pub fn discover_with(
    registry: Registry,
    input: &str,
    lookup: impl Fn(&str) -> Option<Vec<u8>>,
) -> Result<DiscoveryCatalog, DiscoveryError> {
    discover_with_responses(registry, input, |uri| {
        lookup(uri).map(|bytes| Ok((bytes, None)))
    })
    .0
}

/// Fixed responses keyed by URI. Unexpected reads fail immediately; use
/// `discover_with_responses` when missing resources are part of the scenario.
#[track_caller]
pub fn discover_resources(
    registry: Registry,
    input: &str,
    responses: &[(&str, &[u8])],
) -> (Result<DiscoveryCatalog, DiscoveryError>, Vec<Request>) {
    discover_with_responses(registry, input, |uri| {
        let (_, bytes) = responses
            .iter()
            .find(|(expected, _)| *expected == uri)
            .unwrap_or_else(|| panic!("unexpected resource read: {uri}"));
        Some(Ok((bytes.to_vec(), None)))
    })
}

/// Discovery with positional replies (by request order) and final URIs.
pub fn discover(
    spec: FormatSpec,
    uri: &str,
    replies: &[(&[u8], Option<&str>)],
) -> (Result<DiscoveryCatalog, DiscoveryError>, Vec<Request>) {
    let mut registry = Registry::new();
    registry.register(spec);
    let index = std::cell::Cell::new(0);
    discover_with_responses(registry, uri, |_| {
        let reply = replies
            .get(index.get())
            .map(|(bytes, final_uri)| Ok((bytes.to_vec(), final_uri.map(str::to_owned))));
        index.set(index.get() + 1);
        reply
    })
}

/// The catalog must contain exactly one ready image.
#[track_caller]
pub fn ready_image(catalog: DiscoveryCatalog) -> ResolvedImage {
    let mut entries = catalog.into_entries();
    assert_eq!(entries.len(), 1, "expected exactly one image: {entries:?}");
    match entries.pop().expect("one entry") {
        DiscoveredEntry::Ready(image) => image,
        DiscoveredEntry::Deferred(image) => {
            panic!("expected a ready image, got deferred URI {}", image.uri)
        }
    }
}

/// The level's grid, or an adaptive source's declared grid.
#[track_caller]
pub fn grid(level: &ResolvedLevel) -> &Grid {
    match &level.source {
        TileSource::Grid(grid) => grid,
        TileSource::Adaptive(source) => source
            .declared_grid()
            .expect("adaptive source must have a declared grid"),
        source => panic!("expected a grid source, got {source:?}"),
    }
}

/// Require a resource source, retaining unexpected variants in the failure.
#[track_caller]
pub fn resource_uri(source: &super::model::TileSource) -> &str {
    &source
        .resource()
        .unwrap_or_else(|| panic!("expected a resource source, got {source:?}"))
        .uri
}

/// One tile in row-major order; only the selected tile's request is inspected.
#[track_caller]
pub fn grid_tile(grid: &Grid, ordinal: u64) -> super::core::TileSpec {
    grid.tiles_row_major()
        .nth(usize::try_from(ordinal).expect("tile ordinal must fit usize"))
        .unwrap_or_else(|| panic!("tile {ordinal} outside grid of {} tiles", grid.count()))
        .unwrap_or_else(|error| panic!("tile {ordinal}: {error}"))
}

#[track_caller]
pub fn grid_tile_uri(grid: &Grid, ordinal: u64) -> String {
    resource_uri(&grid_tile(grid, ordinal).source).to_owned()
}

/// Every planned tile URI of the level's grid, row-major.
#[track_caller]
pub fn tile_urls(level: &ResolvedLevel) -> Vec<String> {
    grid(level)
        .tiles_row_major()
        .enumerate()
        .map(|(ordinal, tile)| {
            let tile = tile.unwrap_or_else(|error| panic!("tile {ordinal}: {error}"));
            resource_uri(&tile.source).to_owned()
        })
        .collect()
}
