//! IIIF tile levels: `info.json` geometry to tile grids.
//!
//! Split from `iiif/mod.rs` (todo 4.1): this module owns level planning and
//! tile URL rendering, while `super` keeps discovery orchestration and
//! `manifest` keeps Presentation API parsing.

use std::sync::Arc;

use url::Url;

use crate::Vec2d;
use crate::core::{Grid, GridRequests, GridTile, LevelDescriptor, Request, StableId};
use crate::iiif::tile_info::{ImageInfo, TileSizeFormat};
use crate::iiif::{IIIFError, service_base_url_for_levels};
use crate::json_utils::all_json;

pub(crate) fn levels(url: &str, raw_info: &[u8]) -> Result<Vec<LevelDescriptor>, IIIFError> {
    match serde_json::from_slice(raw_info) {
        Ok(info) => levels_from_info(url, info),
        Err(e) => {
            // Due to the very fault-tolerant way we parse iiif manifests, a single javascript
            // object with a 'width' and a 'height' field is enough to be detected as an IIIF level
            // See https://github.com/lovasoa/dezoomify-rs/issues/80
            let levels: Vec<LevelDescriptor> = all_json::<ImageInfo>(raw_info)
                .filter(ImageInfo::has_distinctive_iiif_properties)
                .map(|info| levels_from_info(url, info))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect();
            if levels.is_empty() {
                Err(e.into())
            } else {
                Ok(levels)
            }
        }
    }
}

pub(crate) fn levels_from_info(
    url: &str,
    mut image_info: ImageInfo,
) -> Result<Vec<LevelDescriptor>, IIIFError> {
    let removed_test_id = image_info.remove_test_id();
    image_info.resolve_relative_urls(url);
    let mut warnings = image_info.warnings();
    if removed_test_id {
        warnings.push("Removed probably invalid IIIF image identifier".into());
    }
    let img = Arc::new(image_info);
    let image_size = img.size();
    let tiles = img.tiles();
    let base_url: Arc<str> = service_base_url_for_levels(url).into();

    let mut levels: Vec<_> = tiles
        .iter()
        .enumerate()
        .flat_map(|(tile_ordinal, tile_info)| {
            let tile_size = tile_info.size();
            let base_url = Arc::clone(&base_url);
            let quality = Arc::from(img.best_quality());
            let format = Arc::from(img.best_format());
            let size_format = img.preferred_size_format();
            let page_info = Arc::clone(&img);
            let warnings = warnings.clone();
            tile_info
                .scale_factors
                .iter()
                .enumerate()
                .map(move |(scale_ordinal, &scale_factor)| {
                    if scale_factor == 0 {
                        return Err(IIIFError::GeometryError {
                            description: "scale factor must be greater than zero".into(),
                        });
                    }
                    if tile_size.x == 0 || tile_size.y == 0 {
                        return Err(IIIFError::GeometryError {
                            description: "IIIF tile dimensions must be greater than zero".into(),
                        });
                    }
                    let scaled_tile_size = tile_size
                        .checked_mul(Vec2d::square(scale_factor))
                        .ok_or_else(|| IIIFError::GeometryError {
                            description: "scaled IIIF tile dimensions overflow u32".into(),
                        })?;
                    let level_size = image_size.ceil_div(scale_factor);
                    let shape = level_size.ceil_div(tile_size);
                    let last_coord = Vec2d {
                        x: shape.x.saturating_sub(1),
                        y: shape.y.saturating_sub(1),
                    };
                    if last_coord.checked_mul(scaled_tile_size).is_none() {
                        return Err(IIIFError::GeometryError {
                            description: "scaled IIIF tile positions overflow u32".into(),
                        });
                    }
                    let id = StableId::new(format!(
                        "iiif:level:{tile_ordinal}:{scale_factor}:{scale_ordinal}"
                    ));
                    let source = IIIFLevel {
                        scale_factor,
                        page_info: Arc::clone(&page_info),
                        base_url: Arc::clone(&base_url),
                        quality: Arc::clone(&quality),
                        format: Arc::clone(&format),
                        size_format,
                    };
                    let source = Grid::new(
                        id.clone(),
                        source.image_size(),
                        tile_size,
                        Vec2d::default(),
                        source,
                    )
                    .map_err(|error| IIIFError::GeometryError {
                        description: error.to_string(),
                    })?;
                    Ok(LevelDescriptor::new(source)
                        .with_title(Some(format!("IIIF level {tile_ordinal}")))
                        .with_scale_factor(Some(scale_factor))
                        .with_warnings(warnings.clone()))
                })
        })
        .collect::<Result<Vec<_>, IIIFError>>()?;
    levels.sort_by_key(|level| level.source.image_size().map_or(0, Vec2d::area));
    Ok(levels)
}

struct IIIFLevel {
    scale_factor: u32,
    page_info: Arc<ImageInfo>,
    base_url: Arc<str>,
    quality: Arc<str>,
    format: Arc<str>,
    size_format: TileSizeFormat,
}

impl IIIFLevel {
    fn image_size(&self) -> Vec2d {
        self.page_info.size().ceil_div(self.scale_factor)
    }
}

impl GridRequests for IIIFLevel {
    fn request(&self, tile: GridTile) -> Request {
        // `levels_from_info` validates these multiplications up front for
        // every level, but tile requests must never panic on untrusted
        // `info.json` geometry: saturate to the image size on overflow so a
        // corrupt level degrades to a clamped tile URL.
        let col_and_row_pos: Vec2d = tile.coord.into();
        let scaled_tile_size = tile
            .cell_size
            .checked_mul(Vec2d::square(self.scale_factor))
            .unwrap_or_else(|| self.page_info.size());
        let xy_pos = col_and_row_pos
            .checked_mul(scaled_tile_size)
            .unwrap_or(Vec2d { x: 0, y: 0 });
        let scaled_tile_size = scaled_tile_size.min(self.page_info.size() - xy_pos);
        let tile_size = scaled_tile_size.ceil_div(self.scale_factor);
        let base = self
            .page_info
            .id
            .as_deref()
            .unwrap_or_else(|| self.base_url.as_ref());
        let path = format!(
            "{x},{y},{img_w},{img_h}/{tile_size}/{rotation}/{quality}.{format}",
            x = xy_pos.x,
            y = xy_pos.y,
            img_w = scaled_tile_size.x,
            img_h = scaled_tile_size.y,
            tile_size = TileSizeFormatter {
                w: tile_size.x,
                h: tile_size.y,
                format: self.size_format
            },
            rotation = 0,
            quality = self.quality,
            format = self.format,
        );
        Request::new(append_tile_path(base, &path))
    }
}

fn append_tile_path(uri: &str, suffix: &str) -> String {
    if let Some(uri) = append_to_iiif_query(uri, suffix) {
        return uri;
    }
    let Ok(mut parsed) = Url::parse(uri) else {
        return format!("{}/{}", uri.trim_end_matches('/'), suffix);
    };
    let path = parsed.path().trim_end_matches('/');
    parsed.set_path(&format!("{path}/{suffix}"));
    parsed.to_string()
}

fn append_to_iiif_query(uri: &str, suffix: &str) -> Option<String> {
    let query_start = uri.find('?')?;
    let fragment_start = uri[query_start..]
        .find('#')
        .map(|offset| query_start + offset);
    let query_end = fragment_start.unwrap_or(uri.len());
    let query = &uri[query_start + 1..query_end];
    let mut found = false;
    let query = query
        .split('&')
        .map(|part| {
            let Some((name, value)) = part.split_once('=') else {
                return Some(part.to_owned());
            };
            let decoded_name = url::form_urlencoded::parse(name.as_bytes())
                .next()
                .map(|(name, _)| name.into_owned())?;
            if !decoded_name.eq_ignore_ascii_case("IIIF") {
                return Some(part.to_owned());
            }
            found = true;
            let value = value
                .strip_suffix("/info.json")
                .unwrap_or(value)
                .trim_end_matches('/');
            Some(format!("{name}={value}/{suffix}"))
        })
        .collect::<Option<Vec<_>>>()?;
    found.then(|| {
        let fragment = fragment_start.map_or("", |start| &uri[start..]);
        format!("{}?{}{}", &uri[..query_start], query.join("&"), fragment)
    })
}

struct TileSizeFormatter {
    w: u32,
    h: u32,
    format: TileSizeFormat,
}

impl std::fmt::Display for TileSizeFormatter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.format {
            TileSizeFormat::WidthHeight => write!(f, "{},{}", self.w, self.h),
            TileSizeFormat::Width => write!(f, "{},", self.w),
        }
    }
}

impl std::fmt::Debug for IIIFLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let name = self
            .page_info
            .id
            .as_deref()
            .unwrap_or_else(|| self.base_url.as_ref())
            .split('/')
            .next_back()
            .and_then(|s: &str| {
                let s = s.trim();
                if s.is_empty() { None } else { Some(s) }
            })
            .unwrap_or("IIIF Image");
        write!(f, "{name}")
    }
}

#[cfg(test)]
pub(crate) fn level_with_scale(levels: &[LevelDescriptor], scale_factor: u32) -> &LevelDescriptor {
    levels
        .iter()
        .find(|level| level.scale_factor == Some(scale_factor))
        .expect("expected IIIF scale factor")
}

#[cfg(test)]
pub(crate) fn tile_urls(level: &LevelDescriptor) -> Vec<String> {
    let crate::core::TileSource::Grid(plan) = &level.source else {
        panic!("IIIF levels are grids");
    };
    plan.tiles_row_major()
        .map(Result::unwrap)
        .map(|tile| tile.request.uri)
        .collect()
}

#[test]
fn test_tiles() {
    let data = br#"{
      "@context" : "http://iiif.io/api/image/2/context.json",
      "@id" : "http://www.asmilano.it/fast/iipsrv.fcgi?IIIF=/opt/divenire/files/./tifs/05/36/536765.tif",
      "protocol" : "http://iiif.io/api/image",
      "width" : 15001,
      "height" : 48002,
      "tiles" : [
         { "width" : 512, "height" : 512, "scaleFactors" : [ 1, 2, 4, 8, 16, 32, 64, 128 ] }
      ],
      "profile" : [
         "http://iiif.io/api/image/2/level1.json",
         { "formats" : [ "jpg" ],
           "qualities" : [ "native","color","gray" ],
           "supports" : ["regionByPct","sizeByForcedWh","sizeByWh","sizeAboveFull","rotationBy90s","mirroring","gray"] }
      ]
    }"#;
    let levels = levels("test.com", data).unwrap();
    let tiles = tile_urls(level_with_scale(&levels, 64));
    assert_eq!(
        tiles,
        vec![
            "http://www.asmilano.it/fast/iipsrv.fcgi?IIIF=/opt/divenire/files/./tifs/05/36/536765.tif/0,0,15001,32768/235,512/0/default.jpg",
            "http://www.asmilano.it/fast/iipsrv.fcgi?IIIF=/opt/divenire/files/./tifs/05/36/536765.tif/0,32768,15001,15234/235,239/0/default.jpg",
        ]
    );
}

#[test]
fn test_tiles_max_area_filter() {
    // Predefined tile size (1024x1024) is over maxArea (262144 = 512x512).
    // See https://github.com/lovasoa/dezoomify-rs/issues/107#issuecomment-862225501
    let data = br#"{
      "width" : 1024,
      "height" : 1024,
      "tiles" : [{ "width" : 1024, "scaleFactors" : [ 1 ] }],
      "profile" :  [ { "maxArea": 262144 } ]
    }"#;
    let levels = levels("http://ophir.dev/info.json", data).unwrap();
    let tiles = tile_urls(level_with_scale(&levels, 1));
    assert_eq!(
        tiles,
        vec![
            "http://ophir.dev/0,0,512,512/512,512/0/default.jpg",
            "http://ophir.dev/512,0,512,512/512,512/0/default.jpg",
            "http://ophir.dev/0,512,512,512/512,512/0/default.jpg",
            "http://ophir.dev/512,512,512,512/512,512/0/default.jpg",
        ]
    );
}

#[test]
fn test_missing_id() {
    let data = br#"{
      "width" : 600,
      "height" : 350
    }"#;
    let levels = levels("http://test.com/info.json", data).unwrap();
    let tiles = tile_urls(level_with_scale(&levels, 1));
    assert_eq!(
        tiles,
        vec![
            "http://test.com/0,0,512,350/512,350/0/default.jpg",
            "http://test.com/512,0,88,350/88,350/0/default.jpg"
        ]
    );
}

#[test]
fn ordinary_query_parameters_follow_the_iiif_tile_path() {
    let data = br#"{
      "type": "ImageService3",
      "width": 512,
      "height": 512,
      "tiles": [{ "width": 512, "scaleFactors": [1] }]
    }"#;
    let levels = levels("https://example.com/image/info.json?token=secret", data).unwrap();
    assert_eq!(
        tile_urls(level_with_scale(&levels, 1)),
        vec!["https://example.com/image/0,0,512,512/512,512/0/default.jpg?token=secret"]
    );
}

#[test]
fn iiif_query_parameters_keep_the_image_path_inside_the_iiif_value() {
    let data = br#"{
      "type": "ImageService3",
      "id": "https://images.example.test/iipsrv.fcgi?IIIF=/images/item.tif&download",
      "width": 512,
      "height": 512,
      "tiles": [{ "width": 512, "scaleFactors": [1] }]
    }"#;
    let levels = levels("https://example.com/info.json", data).unwrap();
    assert_eq!(
        tile_urls(level_with_scale(&levels, 1)),
        vec![
            "https://images.example.test/iipsrv.fcgi?IIIF=/images/item.tif/0,0,512,512/512,512/0/default.jpg&download"
        ]
    );
}

#[test]
fn nested_info_urls_do_not_repeat_info_json_in_tile_paths() {
    let data = br#"{
      "type": "ImageService3",
      "width": 512,
      "height": 512,
      "tiles": [{ "width": 512, "scaleFactors": [1] }]
    }"#;
    let levels = levels(
        "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json",
        data,
    )
    .unwrap();
    assert_eq!(
        tile_urls(level_with_scale(&levels, 1)),
        vec![
            "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/0,0,512,512/512,512/0/default.jpg"
        ]
    );
}

#[test]
fn overflowing_scaled_tile_geometry_is_rejected() {
    let data = format!(
        r#"{{
          "type": "ImageService3",
          "width": {},
          "height": {},
          "tiles": [{{ "width": {}, "scaleFactors": [{}] }}]
        }}"#,
        u32::MAX,
        u32::MAX,
        u32::MAX,
        u32::MAX
    );
    assert!(levels("https://example.com/info.json", data.as_bytes()).is_err());
}

#[test]
fn test_false_positive() {
    let data = br#"
    var mainImage={
        type:       "zoomifytileservice",
        width:      62596,
        height:     38467,
        tilesUrl:   "./ORIONFINAL/"
    };
    "#;
    let res = levels("https://orion2020v5b.spaceforeverybody.com/", data);
    assert!(
        res.is_err(),
        "openseadragon zoomify image should not be misdetected"
    );
}

#[test]
fn test_qualities() {
    let data = br#"{
        "@context": "http://library.stanford.edu/iiif/image-api/1.1/context.json",
        "@id": "https://images.britishart.yale.edu/iiif/fd470c3e-ead0-4878-ac97-d63295753f82",
        "tile_height": 1024,
        "tile_width": 1024,
        "width": 5156,
        "height": 3816,
        "profile": "http://library.stanford.edu/iiif/image-api/1.1/compliance.html#level0",
        "qualities": [ "native", "color", "bitonal", "gray", "zorglub" ],
        "formats" : [ "png", "zorglub" ],
        "scale_factors": [ 10 ]
    }"#;
    let levels = levels("test.com", data).unwrap();
    let level = level_with_scale(&levels, 10);
    assert_eq!(level.source.image_size(), Some(Vec2d { x: 516, y: 382 }));
    let tiles = tile_urls(level);
    assert_eq!(
        tiles,
        vec![
            "https://images.britishart.yale.edu/iiif/fd470c3e-ead0-4878-ac97-d63295753f82/0,0,5156,3816/516,382/0/native.png",
        ]
    );
}

#[test]
fn discovery_requests_metadata_then_returns_normalized_replayable_levels() {
    let mut registry = crate::core::Registry::new();
    registry.register(crate::iiif::SPEC);
    let mut operation = registry.start("https://example.com/image/info.json");
    let need = operation.missing_resources().unwrap().pop().unwrap();
    assert_eq!(need.request.uri, "https://example.com/image/info.json");
    operation
        .provide(crate::core::ResourceResponse::new(
            need.id,
            br#"{
          "type":"ImageService3", "id":"https://images.example/item",
          "width":1000, "height":1500,
          "tiles":[{"width":512,"height":512,"scaleFactors":[1,2,4]}]
        }"#
            .as_slice(),
        ))
        .unwrap();
    let catalog = operation.finish().unwrap();
    let [crate::core::CatalogEntry::Ready(image)] = catalog.entries() else {
        panic!("info.json must be ready, not deferred");
    };
    assert!(
        image
            .levels
            .windows(2)
            .all(|pair| pair[0].source.image_size().unwrap().area()
                <= pair[1].source.image_size().unwrap().area())
    );
    let level = level_with_scale(&image.levels, 1);
    let crate::core::TileSource::Grid(plan) = &level.source else {
        panic!("IIIF tile geometry is a grid");
    };
    let first = plan.tiles_row_major().next().unwrap().unwrap();
    assert_eq!(&first.id.level, level.id());
    assert_eq!(
        first.request.headers.get("Referer").map(String::as_str),
        Some("https://images.example/item/0,0,512,512/512,512/0/default.jpg")
    );
}
