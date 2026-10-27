//! Mirador's literal configuration identifies the catalog, including canvases
//! that the currently loaded OpenSeadragon source does not expose.

use std::sync::LazyLock;

use crate::core::discovery::{js_matches, viewer};
use crate::core::{DiscoveryError, DiscoveryResource, DiscoveryRoute, ParsedResource};

pub(super) const ROUTE: DiscoveryRoute = viewer(js_matches(&INITIALIZER)).try_decode(manifest);

static INITIALIZER: LazyLock<regex::bytes::Regex> = LazyLock::new(|| {
    regex::bytes::Regex::new(r"\bMirador\s*\(\s*\{").expect("constant Mirador initializer pattern")
});
static CALL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"\bMirador\s*\(\s*\{").expect("constant Mirador call pattern")
});

#[derive(serde::Deserialize)]
struct Configuration {
    #[serde(default, rename = "windowObjects")]
    windows: Vec<Manifest>,
    #[serde(default)]
    data: Vec<Manifest>,
}

#[derive(serde::Deserialize)]
struct Manifest {
    #[serde(default, rename = "loadedManifest", alias = "manifestUri")]
    uri: String,
}

fn manifest(resource: DiscoveryResource<'_>) -> Option<Result<ParsedResource, DiscoveryError>> {
    let uri = crate::web_page::script_bodies(resource).find_map(|body| {
        let text = crate::javascript::mask(std::str::from_utf8(body).ok()?);
        crate::javascript::captures(&CALL, &text).find_map(|call| {
            let config = crate::javascript::body_at(&text, call.get(0)?.end())?;
            let config: Configuration = json5::from_str(&format!("{{{config}}}")).ok()?;
            config
                .windows
                .into_iter()
                .chain(config.data)
                .map(|manifest| manifest.uri)
                .find(|uri| !uri.trim().is_empty())
        })
    })?;
    Some(Ok(resource.follow_relative(&uri)))
}
