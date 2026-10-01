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

/// Discovery over an injected byte lookup: the one fetch stub. `lookup` maps
/// request URIs to `Ok((bytes, final_uri))` replies or an explicit error; a
/// miss fails `discovery-failed` naming the URI it could not find. Every
/// request is logged in order alongside the result.
pub fn discover_with_responses(
    registry: Registry,
    input: &str,
    lookup: impl FnMut(&str) -> Option<Result<(Vec<u8>, Option<String>), Error>>,
) -> (Result<DiscoveryCatalog, DiscoveryError>, Vec<Request>) {
    let lookup = RefCell::new(lookup);
    let requests = RefCell::new(Vec::new());
    let result = futures::executor::block_on(registry.discover(
        vec![DiscoveryInput::new(input)],
        DiscoveryLimits::default(),
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

/// Discovery with positional replies (by request order) and optional final
/// URIs, for single-format unit tests.
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

/// The catalog's single ready image: a deferred entry or an empty catalog
/// is a stub-level bug, not a case outcome.
pub fn ready_image(catalog: DiscoveryCatalog) -> ResolvedImage {
    match catalog.into_entries().into_iter().next() {
        Some(DiscoveredEntry::Ready(image)) => image,
        Some(DiscoveredEntry::Deferred(image)) => {
            panic!("expected a ready image, got deferred URI {}", image.uri)
        }
        None => panic!("expected one image"),
    }
}

/// The level's grid: a plain grid source or an adaptive source's declared
/// grid. Fallible so callers can skip probe-only levels.
pub fn grid(level: &ResolvedLevel) -> Result<&Grid, String> {
    match &level.source {
        TileSource::Grid(grid) => Ok(grid),
        TileSource::Adaptive(source) => source
            .declared_grid()
            .ok_or_else(|| "adaptive source has no declared grid".to_string()),
        source => Err(format!("expected a grid source, got {source:?}")),
    }
}

/// Every planned tile URI of the level's grid, row-major.
pub fn tile_urls(level: &ResolvedLevel) -> Result<Vec<String>, String> {
    Ok(grid(level)?
        .tiles_row_major()
        .map(|tile| tile.expect("grid tile").request.uri)
        .collect())
}
