//! Pure discovery for Second Canvas (Madpixel) `gigapixel` JSON metadata.

use std::sync::{Arc, LazyLock};

use regex::bytes::Regex as BytesRegex;
use serde::{Deserialize, de::IntoDeserializer};
use url::Url;

use crate::Vec2d;
use crate::core::discovery::{any, css, html_matches, json_metadata, metadata, viewer};
use crate::core::{
    CatalogPlan, DiscoveryError, DiscoveryResource, DiscoveryRoute, FormatSpec, Grid, ImagePlan,
    ParsedResource, Positioned, Request, ResolvedLevel,
};

#[derive(Deserialize)]
struct MetadataMatch {
    #[serde(rename = "gigapixel")]
    _gigapixel: serde::de::IgnoredAny,
}
static VIEWER_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"(?i-u)sc[wv]\.min\.js").expect("constant Second Canvas viewer pattern")
});

const ROUTES: &[DiscoveryRoute] = &[
    json_metadata::<MetadataMatch>().decode(decode_catalog),
    viewer(html_matches(&VIEWER_RE)).decode(follow_viewer_config),
    viewer(css(
        "iframe[src*=\".s3.amazonaws.com/web/\" i][src*=\".html\" i]",
    ))
    .follow_attribute("src"),
    metadata(any()).child_metadata(decode_catalog),
];

pub const SPEC: FormatSpec =
    FormatSpec::new("second_canvas", ROUTES).with_display_name("Second Canvas");

static EMBEDDED_CONFIG_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)\bsc[wv]\s*\.\s*load\s*\(\s*\{\s*[\"']hash[\"']\s*:\s*[\"'](?P<config>[^\"']+\.json)[\"']"#,
    )
    .expect("constant Second Canvas embedded configuration pattern")
});

fn follow_viewer_config(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    Ok(ParsedResource::Follow(Request::new(viewer_config_uri(
        resource.final_uri(),
        resource.bytes(),
    )?)))
}

fn viewer_config_uri(viewer_uri: &str, viewer_bytes: &[u8]) -> Result<String, DiscoveryError> {
    let viewer = Url::parse(viewer_uri).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("invalid Second Canvas viewer URL: {error}"))
    })?;
    let config = viewer
        .query_pairs()
        .find_map(|(name, value)| (name == "js").then(|| value.into_owned()))
        .or_else(|| {
            EMBEDDED_CONFIG_RE
                .captures(viewer_bytes)
                .and_then(|captures| captures.name("config"))
                .map(|config| String::from_utf8_lossy(config.as_bytes()).into_owned())
        })
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Second Canvas viewer has no JSON configuration".into())
        })?;
    let config = viewer.join(&config).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("invalid Second Canvas configuration URL: {error}"))
    })?;
    if !config.path().to_ascii_lowercase().ends_with(".json") {
        return Err(DiscoveryError::InvalidMetadata(
            "Second Canvas viewer js configuration is not JSON".into(),
        ));
    }
    Ok(config.into())
}

fn decode_catalog(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let bytes = resource.bytes();
    let document: Document = serde_json::from_slice(bytes).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("unable to parse Second Canvas metadata: {error}"))
    })?;
    let gigapixel = document.gigapixel;
    if gigapixel.url.is_empty()
        || gigapixel.size.w == 0
        || gigapixel.size.h == 0
        || gigapixel.tile == 0
    {
        return Err(DiscoveryError::InvalidMetadata(
            "Second Canvas metadata must declare a URL and positive size and tile values".into(),
        ));
    }
    let layers = gigapixel.layers()?;
    let normal_level = layers
        .iter()
        .find(|layer| layer.is_normal())
        .or_else(|| layers.first())
        .map(|layer| layer.level)
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Second Canvas metadata has no image layers".into())
        })?;

    let images = layers
        .into_iter()
        .map(|layer| {
            let image_size = layer_size(gigapixel.size, normal_level, layer.level)?;
            let levels = build_levels(&gigapixel, &layer, image_size)?;
            let layer_title = layer.title();
            Ok(ImagePlan::new(
                document.title.clone().map(|title| {
                    if layer.is_normal() {
                        title
                    } else {
                        layer_title.map_or(title.clone(), |layer_title| {
                            format!("{title} ({layer_title})")
                        })
                    }
                }),
                levels,
            ))
        })
        .collect::<Result<Vec<_>, DiscoveryError>>()?;
    Ok(ParsedResource::Catalog(CatalogPlan::images(images)))
}

#[cfg(test)]
fn catalog(uri: &str, bytes: &[u8]) -> Result<crate::core::DiscoveryCatalog, DiscoveryError> {
    decode_catalog(DiscoveryResource::new(uri, bytes))?.compile("second_canvas")
}

fn layer_size(size: Size, normal_level: u32, layer_level: u32) -> Result<Vec2d, DiscoveryError> {
    let divisor = 1_u32
        .checked_shl(normal_level.saturating_sub(layer_level))
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Second Canvas level is too large".into())
        })?;
    Ok(Vec2d {
        x: size.w.div_ceil(divisor),
        y: size.h.div_ceil(divisor),
    })
}

fn build_levels(
    gigapixel: &Gigapixel,
    layer: &Layer,
    image_size: Vec2d,
) -> Result<Vec<ResolvedLevel>, DiscoveryError> {
    let origin: Arc<str> = gigapixel.url.clone().into();
    let pattern: Arc<str> = layer.pattern.clone().into();
    (0..=layer.level)
        .map(|level| {
            let downscale = 1_u32.checked_shl(layer.level - level).ok_or_else(|| {
                DiscoveryError::InvalidMetadata("Second Canvas level is too large".into())
            })?;
            let level_size = Vec2d {
                x: image_size.x.div_ceil(downscale),
                y: image_size.y.div_ceil(downscale),
            };
            let tile_origin = Arc::clone(&origin);
            let tile_pattern = Arc::clone(&pattern);
            let grid = Grid::with_requests(
                level_size,
                Vec2d::square(gigapixel.tile),
                Vec2d::default(),
                move |tile| {
                    Request::new(format!(
                        "{tile_origin}{tile_pattern}{level}_{}_{}.jpg",
                        tile.coord.column, tile.coord.row
                    ))
                },
            )?;
            // Second Canvas serves full-sized padded JPEGs for edge cells.
            // Keep their decoded size and let the declared canvas crop padding
            // instead of scaling edge pixels down in browser runtimes.
            let source = Positioned::from_padded_grid(grid);
            Ok(ResolvedLevel::new(source)
                .with_scale_factor(Some(downscale))
                .with_title(Some(format!("Second Canvas level {level}"))))
        })
        .collect()
}

#[derive(Deserialize)]
struct Document {
    title: Option<String>,
    gigapixel: Gigapixel,
}

#[derive(Deserialize)]
struct Gigapixel {
    url: String,
    size: Size,
    tile: u32,
    #[serde(default)]
    types: Vec<Layer>,
    pattern: Option<String>,
    #[serde(deserialize_with = "deserialize_optional_flexible_u32", default)]
    level: Option<u32>,
    ir: Option<Layer>,
    rx: Option<Layer>,
    uv: Option<Layer>,
}

impl Gigapixel {
    fn layers(&self) -> Result<Vec<Layer>, DiscoveryError> {
        if !self.types.is_empty() {
            return Ok(self.types.clone());
        }
        let pattern = self.pattern.clone().ok_or_else(|| {
            DiscoveryError::InvalidMetadata(
                "legacy Second Canvas metadata has no normal pattern".into(),
            )
        })?;
        let level = self.level.ok_or_else(|| {
            DiscoveryError::InvalidMetadata(
                "legacy Second Canvas metadata has no normal level".into(),
            )
        })?;
        let mut layers = vec![Layer {
            name: Some("Normal".into()),
            kind: Some("normal".into()),
            pattern,
            level,
        }];
        for (kind, layer) in [("ir", &self.ir), ("rx", &self.rx), ("uv", &self.uv)] {
            if let Some(layer) = layer {
                let mut layer = layer.clone();
                layer.kind.get_or_insert_with(|| kind.into());
                layers.push(layer);
            }
        }
        Ok(layers)
    }
}

#[derive(Clone, Deserialize)]
struct Layer {
    name: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    pattern: String,
    #[serde(deserialize_with = "deserialize_flexible_u32")]
    level: u32,
}

impl Layer {
    fn is_normal(&self) -> bool {
        self.kind
            .as_deref()
            .or(self.name.as_deref())
            .is_some_and(|value| value.eq_ignore_ascii_case("normal"))
    }

    fn title(&self) -> Option<String> {
        self.name.clone().or_else(|| self.kind.clone())
    }
}

#[derive(Clone, Copy, Deserialize)]
struct Size {
    w: u32,
    h: u32,
}

fn deserialize_flexible_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Value {
        Number(u32),
        String(String),
    }
    match Value::deserialize(deserializer)? {
        Value::Number(value) => Ok(value),
        Value::String(value) => value.parse().map_err(serde::de::Error::custom),
    }
}

fn deserialize_optional_flexible_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<serde_json::Value>::deserialize(deserializer)?.map_or(Ok(None), |value| {
        deserialize_flexible_u32(value.into_deserializer())
            .map(Some)
            .map_err(serde::de::Error::custom)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{DiscoveredEntry, TileSource};

    const LEGACY: &[u8] = include_bytes!(
        "../../../../testdata/scenarios/rs-core/formats/payloads/second_canvas/legacy.json"
    );
    const LEGACY_STRING: &[u8] = include_bytes!(
        "../../../../testdata/scenarios/rs-core/formats/payloads/second_canvas/legacy-string-level.json"
    );
    const MODERN: &[u8] = include_bytes!(
        "../../../../testdata/scenarios/rs-core/formats/payloads/second_canvas/modern.json"
    );

    #[test]
    fn parses_legacy_and_modern_layer_variants() {
        let legacy = catalog("https://fixtures.test/legacy.json", LEGACY).unwrap();
        assert_eq!(legacy.len(), 4);
        let legacy_string =
            catalog("https://fixtures.test/legacy-string.json", LEGACY_STRING).unwrap();
        assert_eq!(legacy_string.len(), 2);
        let modern = catalog("https://fixtures.test/modern.json", MODERN).unwrap();
        assert_eq!(modern.len(), 2);
    }

    #[test]
    fn builds_zero_based_jpeg_tile_urls_at_each_level() {
        let catalog = catalog("https://fixtures.test/modern.json", MODERN).unwrap();
        let DiscoveredEntry::Ready(image) = &catalog.entries()[0] else {
            panic!("expected ready image");
        };
        let TileSource::Positioned(tiles) = &image.levels.last().unwrap().source else {
            panic!("expected positioned tiles");
        };
        let first = tiles.tiles().next().unwrap().unwrap();
        assert_eq!(
            first.request.uri,
            "https://sc.example.test/gigapixel/modern/normal_3_0_0.jpg"
        );
        assert_eq!(tiles.image_size(), Some(Vec2d { x: 1300, y: 900 }));
        let last = tiles.tiles().last().unwrap().unwrap();
        assert_eq!(last.destination, Vec2d { x: 1024, y: 512 });
        assert_eq!(last.expected_size, None, "padded edge tiles are clipped");
        assert!(last.request.headers.is_empty());
    }

    #[test]
    fn viewer_pages_resolve_their_js_configuration() {
        let frame = "https://museum.s3.amazonaws.com/web/image.html?x=1&y=2";
        let page = br#"<iframe src=/other-image></iframe><template><iframe src=https://wrong.s3.amazonaws.com/web/image.html></iframe></template><iframe src='https://museum.s3.amazonaws.com/web/image.html?x=1&amp;y=2'></iframe>"#;
        let (result, requests) = crate::test_support::discover(
            SPEC,
            "https://museum.test/",
            &[(page, None), (MODERN, None)],
        );
        assert!(result.is_ok());
        assert_eq!(
            requests
                .iter()
                .map(|request| request.uri.as_str())
                .collect::<Vec<_>>(),
            ["https://museum.test/", frame]
        );
        for (uri, page, expected) in [
            (
                "https://fixtures.test/web/index.html?js=metadata%2Fmodern.json&ua=test",
                br#"<script src="scw.min.js"></script>"#.as_slice(),
                "https://fixtures.test/web/metadata/modern.json",
            ),
            (
                "https://fixtures.test/web/gallery/metropolis_es.html",
                br#"<script src="scv.min.js"></script><script>scv.load({ "hash":"metropolis_es.json" });</script>"#,
                "https://fixtures.test/web/gallery/metropolis_es.json",
            ),
        ] {
            assert_eq!(viewer_config_uri(uri, page).unwrap(), expected, "{uri}");
        }
    }
}
