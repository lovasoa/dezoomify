//! eMuseum embeds IIIF geometry in Tapestry's MediaZoom initializer rather than
//! serving info.json. Keep the viewer canonical: the tile service alone cannot
//! reconstruct its dimensions. URLs resolve against the document's HTML base.

use std::sync::LazyLock;

use regex::bytes::Regex;

use crate::core::discovery::{js_matches, viewer};
use crate::core::{DiscoveryError, DiscoveryResource, DiscoveryRoute, ParsedResource};
use crate::web_page::{page_base, script_bodies};

use super::tile_info::{ImageInfo, Profile, TileInfo};

pub(super) const ROUTE: DiscoveryRoute = viewer(js_matches(&INITIALIZER)).decode(decode);

static INITIALIZER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\[\s*["']emuseum/MediaZoom:init["']\s*,\s*\d+\s*,\s*\d+\s*,\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*\d+\s*,\s*\d+\s*\]"#,
    )
    .expect("constant eMuseum MediaZoom initializer pattern")
});

/// Read the literal IIIF 2 initializer (width, height, service URL, tile size,
/// version). Reuse MediaZoom's four scale factors and width-only JPEG requests;
/// malformed geometry is rejected by the shared IIIF planner without fetching.
fn decode(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let initializer = script_bodies(resource)
        .find_map(|body| INITIALIZER.find(body))
        .ok_or_else(|| DiscoveryError::InvalidMetadata("missing eMuseum initializer".into()))?;
    let text = std::str::from_utf8(initializer.as_bytes())
        .map_err(|error| DiscoveryError::InvalidMetadata(error.to_string()))?;
    let (_, width, height, service, tile_size, version): (String, u32, u32, String, u32, u32) =
        json5::from_str(text)
            .map_err(|error| DiscoveryError::InvalidMetadata(error.to_string()))?;
    if version != 2 || service.trim().is_empty() {
        return Err(DiscoveryError::InvalidMetadata(
            "eMuseum requires an IIIF 2 service URL".into(),
        ));
    }
    let info = ImageInfo {
        id: Some(crate::core::resolve_relative(
            &page_base(resource),
            &service,
        )),
        width,
        height,
        profile: Some(Profile::Reference(
            "http://iiif.io/api/image/2/level1.json".into(),
        )),
        tiles: Some(vec![TileInfo {
            width: tile_size,
            height: None,
            scale_factors: vec![8, 4, 2, 1],
        }]),
        ..Default::default()
    };
    super::catalog_from_levels(super::levels_from_info(resource.final_uri(), info)?)
        .map(ParsedResource::Complete)
}

#[cfg(test)]
mod tests {
    #[test]
    fn malformed_geometry_and_inert_initializers_do_not_produce_images() {
        for initializer in [
            r#"["emuseum/MediaZoom:init",0,512,"/image",256,2]"#,
            r#"["emuseum/MediaZoom:init",512,512,"/image",0,2]"#,
            r#"["emuseum/MediaZoom:init",512,512,"",256,2]"#,
            r#"["emuseum/MediaZoom:init",512,512,"/image",256,3]"#,
        ] {
            let page = format!("<script>{initializer}</script>");
            let (result, _) = crate::test_support::discover(
                super::super::SPEC,
                "https://museum.test/viewer",
                &[(page.as_bytes(), None)],
            );
            assert!(result.is_err(), "{initializer}");
        }
        let page = br#"<template><script>["emuseum/MediaZoom:init",512,512,"/image",256,2]</script></template>"#;
        let (result, _) = crate::test_support::discover(
            super::super::SPEC,
            "https://museum.test/viewer",
            &[(page, None)],
        );
        assert!(result.is_err());
    }
}
