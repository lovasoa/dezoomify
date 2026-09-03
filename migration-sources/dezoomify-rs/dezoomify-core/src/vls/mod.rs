//! Pure discovery for Semantics Visual Library Server viewers.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use url::Url;

use crate::Vec2d;
use crate::core::{
    CatalogEntry, DezoomerSpec, DiscoveryError, DiscoveryMatch, Grid, ImageCatalog,
    ImageDescriptor, LevelDescriptor, Request, StableId,
};

static VIEW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/(?:thumbview|pageview|zoom)/\d+(?:[?#].*)?$")
        .expect("constant VLS URL pattern")
});
static VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)<var\b[^>]*\bid\s*=\s*[\"']zoomTileSize[\"'][^>]*\bvalue\s*=\s*[\"'](\d+)[\"']"#,
    )
    .expect("constant VLS tile-size pattern")
});
static MAP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<(?:map|div)\b([^>]*\bid\s*=\s*[\"']map[\"'][^>]*)>"#)
        .expect("constant VLS map pattern")
});
static ATTRIBUTE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*[\"']([^\"']*)[\"']"#)
        .expect("constant VLS attribute pattern")
});

pub const SPEC: DezoomerSpec = DezoomerSpec::new(
    "vls",
    &[
        DiscoveryMatch::UrlPredicate(is_view_url).map_url(normalize_url),
        DiscoveryMatch::Any.extract(catalog),
    ],
)
.recognizing(is_view_url, "not a VLS viewer URL")
.preferring(is_view_url);

fn is_view_url(uri: &str) -> bool {
    VIEW_RE.is_match(uri)
}

#[allow(clippy::unnecessary_wraps)]
fn normalize_url(uri: &str) -> Result<Request, DiscoveryError> {
    let marker = uri
        .find("/thumbview/")
        .or_else(|| uri.find("/pageview/"))
        .unwrap_or(uri.len());
    Ok(Request::new(format!(
        "{}{}",
        &uri[..marker],
        uri[marker..]
            .replace("/thumbview/", "/zoom/")
            .replace("/pageview/", "/zoom/")
    )))
}

fn catalog(url: &str, bytes: &[u8]) -> Result<ImageCatalog, DiscoveryError> {
    let page = String::from_utf8_lossy(bytes);
    let map = MAP_RE
        .captures(&page)
        .and_then(|captures| captures.get(1))
        .ok_or_else(|| DiscoveryError::Session("VLS page has no map element".into()))?;
    let id = attribute(map.as_str(), "vls:ot_id")
        .or_else(|| attribute(map.as_str(), "ot_id"))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| DiscoveryError::Session("VLS map has no image ID".into()))?;
    let width = positive_attribute(map.as_str(), "vls:width")
        .or_else(|| positive_attribute(map.as_str(), "width"))
        .ok_or_else(|| DiscoveryError::Session("VLS map has invalid width".into()))?;
    let height = positive_attribute(map.as_str(), "vls:height")
        .or_else(|| positive_attribute(map.as_str(), "height"))
        .ok_or_else(|| DiscoveryError::Session("VLS map has invalid height".into()))?;
    let zoom_tile_size = VAR_RE
        .captures(&page)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<u32>().ok())
        .filter(|size| *size > 0)
        .ok_or_else(|| DiscoveryError::Session("VLS page has no valid zoom tile size".into()))?;
    let height = height.div_ceil(zoom_tile_size) * zoom_tile_size;
    let parsed =
        Url::parse(url).map_err(|_| DiscoveryError::Session("invalid VLS viewer URL".into()))?;
    let mut base = parsed;
    base.set_path(&format!("/image/tiler/square/{id}/0"));
    base.set_query(None);
    base.set_fragment(None);
    let base: Arc<str> = base.to_string().trim_end_matches('/').into();
    let source = Grid::with_requests(
        StableId::new("vls:level"),
        Vec2d {
            x: width,
            y: height,
        },
        Vec2d::square(1024),
        Vec2d::default(),
        move |tile| Request::new(format!("{base}/{}/{}", tile.coord.column, tile.coord.row)),
    )
    .map_err(|error| DiscoveryError::Session(format!("invalid VLS grid: {error}")))?;
    Ok(ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
        id: StableId::new("vls:image"),
        title: Some(format!("VLS image {id}")),
        format: StableId::new("vls"),
        levels: vec![LevelDescriptor::new(source)],
        ..Default::default()
    })]))
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    ATTRIBUTE_RE.captures_iter(tag).find_map(|captures| {
        (captures.get(1)?.as_str().eq_ignore_ascii_case(name))
            .then(|| captures.get(2).expect("attribute value capture").as_str())
    })
}

fn positive_attribute(tag: &str, name: &str) -> Option<u32> {
    attribute(tag, name)
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
}
