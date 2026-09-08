//! Pure discovery for Gigapan panorama pages and KML metadata.

use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;
use serde::Deserialize;
use url::Url;

use crate::Vec2d;
use crate::core::{
    CatalogEntry, DezoomerSpec, DiscoveryError, DiscoveryMatch, Grid, ImageCatalog,
    ImageDescriptor, LevelDescriptor, Request, StableId,
};

const TILE_SIZE: u32 = 256;

static PAGE_METADATA: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"(?s)\bvar\s+gigapan\s*=\s*(?P<json>\{.*?\})\s*;")
        .expect("constant Gigapan page metadata pattern")
});

const ROUTES: &[crate::core::DiscoveryRoute] =
    &[DiscoveryMatch::ContentPredicate(contains_metadata).extract(catalog)];

pub const SPEC: DezoomerSpec = DezoomerSpec::new("gigapan", ROUTES)
    .with_display_name("Gigapan")
    .recognizing(is_gigapan_url, "not a Gigapan URL")
    .preferring(is_gigapan_url);

fn is_gigapan_url(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if !host.eq_ignore_ascii_case("gigapan.com") && !host.eq_ignore_ascii_case("www.gigapan.com") {
        return false;
    }
    let path = url.path().trim_end_matches('/');
    let Some(id) = path.strip_prefix("/gigapans/") else {
        return false;
    };
    let id = id.strip_suffix(".kml").unwrap_or(id);
    !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
}

fn contains_metadata(bytes: &[u8]) -> bool {
    PAGE_METADATA.is_match(bytes)
        || bytes
            .windows(b"<ImagePyramid".len())
            .any(|window| window.eq_ignore_ascii_case(b"<ImagePyramid"))
}

#[derive(Clone, Debug, Deserialize)]
struct GigapanMetadata {
    id: u32,
    width: u32,
    height: u32,
    #[serde(default)]
    levels: Option<u32>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    tile_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct PageEnvelope {
    gigapan: GigapanMetadata,
}

#[derive(Debug, Deserialize)]
struct KmlRoot {
    #[serde(rename = "Document")]
    document: KmlDocument,
}

#[derive(Debug, Deserialize)]
struct KmlDocument {
    #[serde(rename = "PhotoOverlay")]
    photo_overlay: KmlPhotoOverlay,
}

#[derive(Debug, Deserialize)]
struct KmlPhotoOverlay {
    name: Option<String>,
    #[serde(rename = "ImagePyramid")]
    image_pyramid: KmlImagePyramid,
    #[serde(rename = "@id", default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KmlImagePyramid {
    #[serde(rename = "tileSize")]
    tile_size: u32,
    #[serde(rename = "maxWidth")]
    max_width: u32,
    #[serde(rename = "maxHeight")]
    max_height: u32,
}

fn catalog(uri: &str, bytes: &[u8]) -> Result<ImageCatalog, DiscoveryError> {
    let metadata = parse_metadata(bytes)?;
    if metadata.id == 0 {
        return Err(DiscoveryError::Session(
            "Gigapan id must be positive".into(),
        ));
    }
    if metadata.width == 0 || metadata.height == 0 {
        return Err(DiscoveryError::Session(
            "Gigapan image dimensions must be positive".into(),
        ));
    }
    let tile_size = metadata.tile_size.unwrap_or(TILE_SIZE);
    if tile_size == 0 {
        return Err(DiscoveryError::Session(
            "Gigapan tile size must be positive".into(),
        ));
    }
    let levels = metadata
        .levels
        .unwrap_or_else(|| level_count(metadata.width, metadata.height, tile_size).unwrap_or(1));
    if levels == 0 || levels > 32 {
        return Err(DiscoveryError::Session(
            "Gigapan level count is out of range".into(),
        ));
    }
    let origin = Url::parse(uri)
        .map_err(|_| DiscoveryError::Session("invalid Gigapan metadata URL".into()))?
        .origin()
        .ascii_serialization();
    let levels = build_levels(
        metadata.id,
        metadata.width,
        metadata.height,
        tile_size,
        levels,
        &origin,
    )?;
    Ok(ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
        id: StableId::new(format!("gigapan:{}", metadata.id)),
        title: metadata
            .name
            .filter(|name| !name.trim().is_empty())
            .map(|name| name.trim().to_owned()),
        format: StableId::new("gigapan"),
        levels,
        ..Default::default()
    })]))
}

fn parse_metadata(bytes: &[u8]) -> Result<GigapanMetadata, DiscoveryError> {
    if let Some(captures) = PAGE_METADATA.captures(bytes) {
        let json = captures.name("json").expect("Gigapan JSON capture");
        let envelope: PageEnvelope = serde_json::from_slice(json.as_bytes()).map_err(|error| {
            DiscoveryError::Session(format!("unable to parse Gigapan page metadata: {error}"))
        })?;
        return Ok(envelope.gigapan);
    }
    let kml: KmlRoot = serde_xml_rs::from_reader(bytes).map_err(|error| {
        DiscoveryError::Session(format!("unable to parse Gigapan KML metadata: {error}"))
    })?;
    let overlay = kml.document.photo_overlay;
    let id = overlay
        .id
        .as_deref()
        .and_then(|id| id.strip_prefix("gigapan_"))
        .and_then(|id| id.parse().ok())
        .ok_or_else(|| DiscoveryError::Session("Gigapan KML has no numeric id".into()))?;
    Ok(GigapanMetadata {
        id,
        width: overlay.image_pyramid.max_width,
        height: overlay.image_pyramid.max_height,
        levels: None,
        name: overlay.name,
        tile_size: Some(overlay.image_pyramid.tile_size),
    })
}

fn level_count(width: u32, height: u32, tile_size: u32) -> Option<u32> {
    let tiles = width.div_ceil(tile_size).max(height.div_ceil(tile_size));
    Some(tiles.checked_next_power_of_two()?.ilog2() + 1)
}

fn build_levels(
    id: u32,
    width: u32,
    height: u32,
    tile_size: u32,
    level_count: u32,
    origin: &str,
) -> Result<Vec<LevelDescriptor>, DiscoveryError> {
    (0..level_count)
        .map(|level| {
            let shift = level_count - level - 1;
            let scale = 1_u32.checked_shl(shift).ok_or_else(|| {
                DiscoveryError::Session("Gigapan level scale is out of range".into())
            })?;
            let size = Vec2d {
                x: width.div_ceil(scale),
                y: height.div_ceil(scale),
            };
            let base = origin.to_owned();
            let source = Grid::with_requests(
                StableId::new(format!("gigapan:{id}:{level}")),
                size,
                Vec2d::square(tile_size),
                Vec2d::default(),
                move |tile| {
                    Request::new(format!(
                        "{base}/get_ge_tile/{id}/{level}/{}/{}",
                        tile.coord.row, tile.coord.column
                    ))
                },
            )
            .map_err(|error| DiscoveryError::Session(format!("invalid Gigapan grid: {error}")))?;
            Ok(LevelDescriptor::new(source).with_title(Some(format!("Gigapan level {level}"))))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{CatalogEntry, ResourceResponse, TileSource};

    const PAGE: &[u8] = br#"
        <script>
        var gigapan = {"gigapan":{"id":116906,"name":"Machu Picchu","width":206996,"height":77069,"levels":11}};
        </script>
    "#;

    const KML: &[u8] = br#"<?xml version="1.0"?>
        <kml xmlns="http://www.opengis.net/kml/2.2"><Document><PhotoOverlay id="gigapan_116906"><name>Machu Picchu</name>
        <ImagePyramid><tileSize>256</tileSize><maxWidth>206996</maxWidth><maxHeight>77069</maxHeight></ImagePyramid>
        </PhotoOverlay></Document></kml>"#;

    fn discover(uri: &str, bytes: &[u8]) -> ImageDescriptor {
        let mut operation = crate::core::Registry::new();
        operation.register(SPEC);
        let mut operation = operation.start(uri);
        let need = operation.missing_resources().unwrap().pop().unwrap();
        operation
            .provide(ResourceResponse::new(need.id, bytes))
            .unwrap();
        let catalog = operation.finish().unwrap();
        let CatalogEntry::Ready(image) = catalog.entries().first().unwrap() else {
            panic!("Gigapan metadata must produce a ready image")
        };
        image.clone()
    }

    #[test]
    fn page_metadata_builds_full_resolution_tiles() {
        let image = discover("https://gigapan.com/gigapans/116906/", PAGE);
        assert_eq!(image.format.as_str(), "gigapan");
        assert_eq!(image.title.as_deref(), Some("Machu Picchu"));
        assert_eq!(image.levels.len(), 11);
        let level = image.levels.last().unwrap();
        let TileSource::Grid(grid) = &level.source else {
            panic!("Gigapan levels must be grids")
        };
        assert_eq!(
            grid.image_size(),
            Vec2d {
                x: 206_996,
                y: 77_069
            }
        );
        assert_eq!(grid.shape(), Vec2d { x: 809, y: 302 });
        let tiles: Vec<_> = grid.tiles_row_major().collect::<Result<_, _>>().unwrap();
        assert_eq!(
            tiles.first().unwrap().request.uri,
            "https://gigapan.com/get_ge_tile/116906/10/0/0"
        );
        assert_eq!(
            tiles.last().unwrap().request.uri,
            "https://gigapan.com/get_ge_tile/116906/10/301/808"
        );
    }

    #[test]
    fn kml_metadata_computes_levels_and_accepts_kml_urls() {
        let image = discover("https://gigapan.com/gigapans/116906.kml", KML);
        assert_eq!(image.levels.len(), 11);
        assert!(is_gigapan_url("https://www.gigapan.com/gigapans/116906/"));
        assert!(!is_gigapan_url("https://example.test/gigapans/116906/"));
    }
}
