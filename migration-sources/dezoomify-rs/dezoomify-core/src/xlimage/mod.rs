//! Pure discovery for `XLimage` `*.img?cmd=info` documents.

use std::sync::Arc;

use serde::Deserialize;
use url::Url;

use crate::Vec2d;
use crate::core::{
    CatalogEntry, DezoomerSpec, DiscoveryError, DiscoveryMatch, DiscoveryRoute, Grid, ImageCatalog,
    ImageDescriptor, LevelDescriptor, Request, StableId, resolve_relative,
};

const INFO_QUERY: &str = "cmd=info";

const ROUTES: &[DiscoveryRoute] = &[
    DiscoveryMatch::UrlPredicate(is_kbr_viewer).map_url(kbr_info_url),
    DiscoveryMatch::Any.extract(catalog),
];

pub const SPEC: DezoomerSpec = DezoomerSpec::new("xlimage", ROUTES)
    .recognizing(is_xlimage_url, "not an XLimage URL")
    .preferring(is_info_url);

fn is_xlimage_url(uri: &str) -> bool {
    let path = uri.split_once(['?', '#']).map_or(uri, |(path, _)| path);
    path.to_ascii_lowercase().contains(".img")
        && (path.to_ascii_lowercase().ends_with(".imgf")
            || path.to_ascii_lowercase().ends_with(".imgi")
            || path.to_ascii_lowercase().ends_with(".imgg"))
        || uri.to_ascii_lowercase().contains("kbr.be/multi/")
}

fn is_info_url(uri: &str) -> bool {
    uri.to_ascii_lowercase().contains(INFO_QUERY)
}

fn is_kbr_viewer(uri: &str) -> bool {
    kbr_viewer_id(uri).is_some()
}

fn kbr_viewer_id(uri: &str) -> Option<String> {
    let parsed = Url::parse(uri).ok()?;
    let path = parsed.path();
    let path = path.strip_prefix("/multi/")?;
    let (id, _) = path.split_once("Viewer")?;
    (!id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then_some(id.to_owned())
}

fn kbr_info_url(input: &str) -> Result<Request, DiscoveryError> {
    let id = kbr_viewer_id(input)
        .ok_or_else(|| DiscoveryError::Session("invalid KBR XLimage viewer URL".into()))?;
    let mut viewer = Url::parse(input)
        .map_err(|_| DiscoveryError::Session("invalid KBR XLimage viewer URL".into()))?;
    viewer.set_path(&format!("/multi/{id}Viewer/xml.php"));
    viewer.set_query(None);
    viewer.set_fragment(None);
    Ok(Request::new(format!(
        "{viewer}?/multi/{id}/001.imgi?cmd=info"
    )))
}

fn image_origin(url: &str) -> String {
    let (path, query) = url.split_once('?').map_or((url, None), |(path, query)| {
        (
            path,
            Some(query.split_once('#').map_or(query, |(query, _)| query)),
        )
    });
    if path.to_ascii_lowercase().contains(".img") {
        return path.to_owned();
    }
    query
        .and_then(|query| query.split_once('?').map(|(path, _)| path))
        .filter(|path| path.to_ascii_lowercase().contains(".img"))
        .map_or_else(|| path.to_owned(), |path| resolve_relative(url, path))
}

fn catalog(url: &str, bytes: &[u8]) -> Result<ImageCatalog, DiscoveryError> {
    let metadata: Metadata = serde_xml_rs::from_reader(bytes).map_err(|error| {
        DiscoveryError::Session(format!("unable to parse XLimage metadata: {error}"))
    })?;
    if metadata.width == 0
        || metadata.height == 0
        || metadata.tileside == 0
        || metadata.maxzoom == 0
    {
        return Err(DiscoveryError::Session(
            "XLimage metadata must declare positive width, height, tileside, and maxzoom".into(),
        ));
    }
    let origin: Arc<str> = image_origin(url).into();
    let levels = build_levels(&metadata, &origin)?;

    Ok(ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
        id: StableId::new("xlimage:image"),
        title: Some("XLimage".into()),
        format: StableId::new("xlimage"),
        levels,
        ..Default::default()
    })]))
}

fn build_levels(
    metadata: &Metadata,
    origin: &Arc<str>,
) -> Result<Vec<LevelDescriptor>, DiscoveryError> {
    let mut levels = Vec::new();
    let mut zoom = 1;
    loop {
        let width = metadata.width.div_ceil(zoom);
        let height = metadata.height.div_ceil(zoom);
        let origin = Arc::clone(origin);
        let source = Grid::with_requests(
            StableId::new(format!("xlimage:{zoom}")),
            Vec2d {
                x: width,
                y: height,
            },
            Vec2d::square(metadata.tileside),
            Vec2d::default(),
            move |tile| {
                let coord: Vec2d = tile.coord.into();
                Request::new(format!(
                    "{origin}?cmd=tile&x={}&y={}&z={zoom}",
                    coord.x, coord.y
                ))
            },
        )
        .map_err(|error| DiscoveryError::Session(format!("invalid XLimage grid: {error}")))?;
        levels.push(LevelDescriptor::new(source).with_scale_factor(Some(zoom)));

        if zoom >= metadata.maxzoom {
            break;
        }
        zoom = zoom
            .checked_mul(2)
            .map_or(metadata.maxzoom, |next| next.min(metadata.maxzoom));
    }
    Ok(levels)
}

#[derive(Debug, Deserialize)]
struct Metadata {
    width: u32,
    height: u32,
    tileside: u32,
    #[serde(default = "default_maxzoom")]
    maxzoom: u32,
}

fn default_maxzoom() -> u32 {
    1
}
