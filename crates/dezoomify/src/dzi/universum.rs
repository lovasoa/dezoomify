//! UDDragonView's IIP-shaped JSON uses Deep Zoom levels, not its IIP resolution
//! count. Standalone metadata requires the `meta/` and sibling `tiles/` layout.
//! Viewer links select `rep1`/`id1` from literal repository declarations; their
//! tile templates require page context, so those metadata reads are intermediate.

use std::{collections::BTreeMap, sync::LazyLock};

use regex::{Regex, bytes::Regex as BytesRegex};
use serde::Deserialize;
use url::Url;

use super::dzi_file::{DziFile, Size};
use crate::core::discovery::{Metadata, js_matches, json_metadata, viewer};
use crate::core::{
    DiscoveredEntry, DiscoveryCatalog, DiscoveryError, DiscoveryResource, DiscoveryRoute,
    ParsedResource, resolve_relative,
};
use crate::json_utils::number_or_string;

pub(super) const VIEWER_ROUTE: DiscoveryRoute =
    viewer(js_matches(&METADATA_TEMPLATE)).try_decode(viewer_metadata);
pub(super) const METADATA_ROUTE: DiscoveryRoute = json_metadata::<Image>();

static METADATA_TEMPLATE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"\bmeta["']?\s*:\s*["'][^"'<>]*\[(?:FILEID|FILENAME)\]"#)
        .expect("constant UDDragonView metadata template pattern")
});
static REPOSITORIES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:\b[\w$]+(?:\s*\.\s*[\w$]+)*\s*=|(?:\brep|["']rep["'])\s*:)\s*\{"#)
        .expect("constant UDDragonView repository declaration pattern")
});
static NUMERIC_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b([0-9]+)\s*:").expect("constant numeric repository key pattern")
});

#[derive(Deserialize)]
struct Repository {
    meta: String,
    dz: Option<String>,
}

fn selected_repository(resource: DiscoveryResource<'_>) -> Option<Repository> {
    let url = Url::parse(resource.uri()).ok()?;
    let hash = url.fragment()?;
    let hash = hash
        .split_once('/')
        .map_or(hash, |(_, parameters)| parameters);
    let parameter = |name: &str| {
        url::form_urlencoded::parse(hash.as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let repository = parameter("rep1")?;
    let id = parameter("id1").filter(|id| !id.is_empty())?;
    crate::web_page::scripts(resource)
        .into_iter()
        .filter(|script| script.source.is_none())
        .find_map(|script| {
            let text = crate::javascript::mask(&script.body);
            crate::javascript::captures(&REPOSITORIES, &text).find_map(|declaration| {
                let body = crate::javascript::body_at(&text, declaration.get(0)?.end())?;
                let mut repositories = repositories(body)?;
                let mut selected = repositories.remove(&repository)?;
                selected.meta = resolve_relative(
                    &script.base,
                    &selected
                        .meta
                        .replace("[FILEID]", &id)
                        .replace("[FILENAME]", &id),
                );
                selected.dz = selected.dz.map(|url| resolve_relative(&script.base, &url));
                Some(selected)
            })
        })
}

fn repositories(body: &str) -> Option<BTreeMap<String, Repository>> {
    // JavaScript allows numeric property names, but JSON5 requires them quoted.
    let mut literal = format!("{{{body}}}");
    for key in crate::javascript::captures(&NUMERIC_KEY, body)
        .filter_map(|capture| capture.get(1))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        literal.insert(key.end() + 1, '"');
        literal.insert(key.start() + 1, '"');
    }
    json5::from_str(&literal).ok()
}

fn viewer_metadata(
    resource: DiscoveryResource<'_>,
) -> Option<Result<ParsedResource, DiscoveryError>> {
    let repository = selected_repository(resource)?;
    Some(Ok(if repository.dz.is_some() {
        resource
            .follow_relative(&repository.meta)
            .decode_intermediate_with(configured_image)
    } else {
        ParsedResource::Complete(DiscoveryCatalog::new([DiscoveredEntry::deferred(
            repository.meta,
            None,
            Vec::new(),
        )]))
    }))
}

fn configured_image(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let repository = resource
        .context()
        .resources()
        .rev()
        .filter_map(selected_repository)
        .find(|repository| repository.meta == resource.uri())
        .ok_or_else(|| invalid("missing UDDragonView repository context"))?;
    let template = repository
        .dz
        .as_deref()
        .and_then(|url| url.strip_suffix("/[LEVEL]/[X]_[Y].jpg"))
        .ok_or_else(|| invalid("unsupported UDDragonView Deep Zoom tile template"))?;
    let image: Image = serde_json::from_slice(resource.bytes()).map_err(invalid)?;
    image.into_dzi(template)?.decode(resource)
}

#[derive(Deserialize)]
struct Dimensions(
    #[serde(deserialize_with = "number_or_string")] u32,
    #[serde(deserialize_with = "number_or_string")] u32,
);

#[derive(Deserialize)]
struct Image {
    fid: String,
    #[serde(rename = "Max-size")]
    size: Dimensions,
    #[serde(rename = "Tile-size")]
    tile_size: Dimensions,
}

impl Metadata for Image {
    fn decode(self, resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        let path = Url::parse(resource.final_uri())
            .map(|url| url.path().to_owned())
            .unwrap_or_else(|_| resource.final_uri().to_owned());
        if path.rsplit(['/', '\\']).nth(1) != Some("meta") {
            return Err(invalid(
                "UDDragonView metadata outside meta/ requires its viewer configuration",
            ));
        }
        self.into_dzi("../tiles/[FILENAME]/")?.decode(resource)
    }
}

impl Image {
    fn into_dzi(self, template: &str) -> Result<DziFile, DiscoveryError> {
        let filename = self
            .fid
            .strip_suffix(".dzi")
            .or_else(|| self.fid.strip_suffix(".jp2"))
            .unwrap_or(&self.fid);
        if filename.is_empty()
            || matches!(filename, "." | "..")
            || filename.contains(['/', '\\', '?', '#'])
        {
            return Err(invalid("invalid UDDragonView image filename"));
        }
        if self.tile_size.0 != self.tile_size.1 {
            return Err(invalid("UDDragonView requires square Deep Zoom tiles"));
        }
        Ok(DziFile {
            overlap: 0,
            tile_size: self.tile_size.0,
            format: "jpg".into(),
            size: Size {
                width: self.size.0,
                height: self.size.1,
            },
            base_url: Some(template.replace("[FILENAME]", filename)),
        })
    }
}

fn invalid(detail: impl std::fmt::Display) -> DiscoveryError {
    DiscoveryError::InvalidMetadata(detail.to_string())
}

#[cfg(test)]
mod tests {
    use crate::Vec2d;
    use crate::core::discovery::DiscoveryInput;
    use crate::core::{DiscoveredEntry, default_registry, registry_for};
    use crate::test_support::{
        discover_inputs, discover_resources, grid, grid_tile, grid_tile_uri, ready_image,
        resource_uri,
    };

    #[test]
    fn metadata_uses_deep_zoom_levels_and_exact_edges() {
        let metadata = "https://images.test/collection/meta/image.json";
        let json = br#"{"fid":"painting","Max-size":["104000","64000"],"Tile-size":[256,256],"Resolution-number":10}"#;
        let (catalog, _) = discover_resources(default_registry(), metadata, &[(metadata, json)]);
        let image = ready_image(catalog.unwrap());
        assert_eq!(image.source_url.as_deref(), Some(metadata));
        assert_eq!(image.levels.len(), 18);
        let full = grid(image.levels.last().unwrap());
        assert_eq!(
            full.image_size(),
            Vec2d {
                x: 104_000,
                y: 64_000
            }
        );
        assert_eq!(full.count(), 101_750);
        let last = grid_tile(full, full.count() - 1);
        assert_eq!(last.expected_size, Some(Vec2d { x: 64, y: 256 }));
        assert_eq!(
            resource_uri(&last.source),
            "https://images.test/collection/tiles/painting/17/406_249.jpg"
        );
    }

    #[test]
    fn viewer_uses_declared_repositories_and_tile_hosts() {
        let metadata = "https://images.test/lookup/panel-name.json?edition=2";
        for (repository, declaration, expected_tile) in [
            (
                "17",
                r#"const anything = {17:{meta:'https://images.test/lookup/[FILEID].json?edition=2',dz:'https://proxy.test/image?url=https://cdn.test/scans/[FILENAME]/[LEVEL]/[X]_[Y].jpg'}};"#,
                "https://proxy.test/image?url=https://cdn.test/scans/painting/9/1_1.jpg",
            ),
            (
                "archive",
                r#"initialize({rep:{archive:{meta:'https://images.test/lookup/[FILENAME].json?edition=2',dz:'https://cdn.test/scans/[FILENAME]/[LEVEL]/[X]_[Y].jpg'}}});"#,
                "https://cdn.test/scans/painting/9/1_1.jpg",
            ),
        ] {
            let page = format!("https://museum.test/work/#viewer/rep1={repository}&id1=panel-name");
            let html = format!("<script>{declaration}</script>");
            let json = include_bytes!(
                "../../../../fixtures/deepzoom/approximate-universum/meta/image.json"
            );
            let (catalog, _) = discover_resources(
                default_registry(),
                &page,
                &[(&page, html.as_bytes()), (metadata, json)],
            );
            let image = ready_image(catalog.unwrap());
            assert_eq!(image.source_url.as_deref(), Some(page.as_str()));
            assert_eq!(
                grid_tile_uri(grid(image.levels.last().unwrap()), 3),
                expected_tile
            );
        }
    }

    #[test]
    fn repositories_can_use_existing_iiif_discovery() {
        let page = "https://museum.test/work/#viewer/rep1=archive&id1=panel-name";
        let html = br#"<base href="https://images.test/catalog/"><script>initialize({rep:{archive:{meta:'[FILENAME]/info.json',iiif:'[FILENAME]/[PIXELX],[PIXELY],[WI],[HI]/[OFFSET]/0/default.jpg'}}});</script>"#;
        let metadata = "https://images.test/catalog/panel-name/info.json";
        let info = include_str!("../../../../fixtures/iiif/v2/info.json")
            .replace("{{origin}}", "https://images.test");
        let (catalog, _) = discover_resources(default_registry(), page, &[(page, html)]);
        let catalog = catalog.unwrap();
        let [DiscoveredEntry::Deferred(request)] = catalog.entries() else {
            panic!("other protocols use normal deferred discovery")
        };
        assert_eq!(request.uri, metadata);
        let (catalog, _) = discover_resources(
            default_registry(),
            &request.uri,
            &[(metadata, info.as_bytes())],
        );
        let image = ready_image(catalog.unwrap());
        assert_eq!(image.format, "iiif");
        assert_eq!(image.source_url.as_deref(), Some(metadata));
    }

    #[test]
    fn inactive_or_computed_configuration_does_not_fetch_metadata() {
        for html in [
            r#"<script>// const rep = {archive:{meta:'/meta/[FILEID].json',dz:'/tiles/[FILENAME]/[LEVEL]/[X]_[Y].jpg'}}</script>"#,
            r#"<script>const example = "const rep = {archive:{meta:'/meta/[FILEID].json'}}";</script>"#,
            r#"<template><script>const rep = {archive:{meta:'/meta/[FILEID].json'}};</script></template>"#,
            r#"<script type="text/plain">const rep = {archive:{meta:'/meta/[FILEID].json'}};</script>"#,
            r#"<script>const rep = {archive:{meta:computed}};</script>"#,
        ] {
            let (catalog, requests) = discover_inputs(
                registry_for("deepzoom").unwrap(),
                vec![DiscoveryInput::with_contents(
                    "https://museum.test/#viewer/rep1=archive&id1=panel-name",
                    html,
                )],
                Default::default(),
                |_| panic!("no active literal repository"),
            );
            assert!(catalog.is_err());
            assert!(requests.is_empty());
        }
    }
}
