//! Pure discovery for Semantics Visual Library Server viewers.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use url::Url;

use crate::Vec2d;
use crate::core::discovery::{css, metadata, url_matches, viewer};
use crate::core::{DiscoveryError, FormatSpec, ImagePlan, ParsedResource, Request, ResolvedLevel};
use crate::web_page::page_title;

static VIEW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/(?:thumbview|pageview|zoom)/\d+(?:[?#].*)?$")
        .expect("constant VLS URL pattern")
});
static VIEW_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/(?:thumbview|pageview|zoom)/").expect("constant VLS view path pattern")
});
pub const SPEC: FormatSpec = FormatSpec::new(
    "vls",
    &[
        viewer(url_matches(is_view_url)).resolve_metadata(normalize_url),
        metadata(css("map[id=map i], div[id=map i]")).decode(decode),
    ],
)
.with_display_name("VLS")
.html_queries(&["var[id=zoomTileSize i]"]);

fn is_view_url(uri: &str) -> bool {
    VIEW_RE.is_match(uri)
}

#[allow(clippy::unnecessary_wraps)]
fn normalize_url(uri: &str) -> Result<Request, DiscoveryError> {
    Ok(Request::new(
        VIEW_PATH_RE.replace(uri, "/zoom/").into_owned(),
    ))
}

fn decode(resource: crate::core::DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let url = resource.final_uri();
    let map = resource.element()?;
    let id = map
        .attribute("vls:ot_id")
        .or_else(|| map.attribute("ot_id"))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| DiscoveryError::InvalidMetadata("VLS map has no image ID".into()))?;
    let width = map
        .positive_u32("vls:width")
        .or_else(|_| map.positive_u32("width"))?;
    let height = map
        .positive_u32("vls:height")
        .or_else(|_| map.positive_u32("height"))?;
    let zoom_tile_size = resource
        .select("var[id=zoomTileSize i]")
        .find_map(|tag| tag.positive_u32("value").ok())
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("VLS page has no valid zoom tile size".into())
        })?;
    let height = height
        .div_ceil(zoom_tile_size)
        .checked_mul(zoom_tile_size)
        .ok_or_else(|| DiscoveryError::InvalidMetadata("VLS image height exceeds u32".into()))?;
    let parsed = Url::parse(url)
        .map_err(|_| DiscoveryError::InvalidMetadata("invalid VLS viewer URL".into()))?;
    let mut base = parsed;
    base.set_path(&format!("/image/tiler/square/{id}/0"));
    base.set_query(None);
    base.set_fragment(None);
    let base: Arc<str> = base.to_string().trim_end_matches('/').into();
    let level = ResolvedLevel::grid(
        Vec2d {
            x: width,
            y: height,
        },
        Vec2d::square(1024),
        move |tile| Request::new(format!("{base}/{}/{}", tile.coord.column, tile.coord.row)),
    )?;
    Ok(ParsedResource::Image(ImagePlan::new(
        page_title(resource),
        vec![level],
    )))
}

#[cfg(test)]
mod tests {
    use super::{SPEC, normalize_url};

    #[test]
    fn viewer_path_normalization_is_case_insensitive() {
        let uri = normalize_url("https://example.test/ThumbView/12")
            .unwrap()
            .uri;
        assert_eq!(uri, "https://example.test/zoom/12");
    }

    #[test]
    fn rounded_height_overflow_is_rejected() {
        let page = format!(
            r#"<div id="map" vls:ot_id="1" vls:width="1" vls:height="{}"></div>
                <var id="zoomTileSize" value="1024">"#,
            u32::MAX
        );
        assert!(
            crate::test_support::discover(
                SPEC,
                "https://example.test/pageview/1",
                &[(page.as_bytes(), None)]
            )
            .0
            .is_err()
        );
    }
}
