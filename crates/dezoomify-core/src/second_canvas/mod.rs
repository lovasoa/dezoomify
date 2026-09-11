//! Pure discovery for Second Canvas (Madpixel) `gigapixel` JSON metadata.

use std::sync::{Arc, LazyLock};

use regex::bytes::Regex as BytesRegex;
use serde::{Deserialize, de::IntoDeserializer};
use url::Url;

use crate::Vec2d;
use crate::core::{
    CatalogEntry, DezoomerSpec, DiscoveryContext, DiscoveryError, DiscoveryMatch,
    DiscoveryResource, DiscoveryRoute, DiscoveryStep, Grid, ImageCatalog, ImageDescriptor,
    LevelDescriptor, Positioned, PositionedTile, ProcessingRecipe, Request, StableId,
    TileSourceError, resolve_relative,
};

const ROUTES: &[DiscoveryRoute] = &[
    DiscoveryMatch::ContentPredicate(contains_gigapixel).extract(catalog),
    DiscoveryMatch::ContentPredicate(contains_viewer_script).then(follow_viewer_config),
    DiscoveryMatch::ContentPredicate(contains_second_canvas_iframe).then(follow_iframe),
];

pub const SPEC: DezoomerSpec =
    DezoomerSpec::new("second_canvas", ROUTES).with_display_name("Second Canvas");

fn contains_gigapixel(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|document| document.get("gigapixel").cloned())
        .is_some_and(|gigapixel| gigapixel.is_object())
}

fn contains_viewer_script(bytes: &[u8]) -> bool {
    let page = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    page.contains("scw.min.js") || page.contains("scv.min.js")
}

static SECOND_CANVAS_IFRAME_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)<iframe\b[^>]*\bsrc\s*=\s*[\"'](?P<src>https?://[^\"']+\.s3\.amazonaws\.com/web/[^\"']+\.html(?:[?#][^\"']*)?)[\"']"#,
    )
    .expect("constant Second Canvas iframe pattern")
});

static EMBEDDED_CONFIG_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)\bsc[wv]\s*\.\s*load\s*\(\s*\{\s*[\"']hash[\"']\s*:\s*[\"'](?P<config>[^\"']+\.json)[\"']"#,
    )
    .expect("constant Second Canvas embedded configuration pattern")
});

fn contains_second_canvas_iframe(bytes: &[u8]) -> bool {
    SECOND_CANVAS_IFRAME_RE.is_match(bytes)
}

fn follow_viewer_config(
    _: &DiscoveryContext<'_>,
    resource: DiscoveryResource<'_>,
) -> Result<DiscoveryStep, DiscoveryError> {
    Ok(DiscoveryStep::Follow(Request::new(viewer_config_uri(
        resource.final_uri(),
        resource.bytes(),
    )?)))
}

fn follow_iframe(
    _: &DiscoveryContext<'_>,
    resource: DiscoveryResource<'_>,
) -> Result<DiscoveryStep, DiscoveryError> {
    let src = SECOND_CANVAS_IFRAME_RE
        .captures(resource.bytes())
        .and_then(|captures| captures.name("src"))
        .map(|src| String::from_utf8_lossy(src.as_bytes()).replace("&amp;", "&"))
        .ok_or_else(|| DiscoveryError::Session("Second Canvas iframe has no source".into()))?;
    Ok(DiscoveryStep::Follow(Request::new(resolve_relative(
        resource.final_uri(),
        &src,
    ))))
}

fn viewer_config_uri(viewer_uri: &str, viewer_bytes: &[u8]) -> Result<String, DiscoveryError> {
    let viewer = Url::parse(viewer_uri).map_err(|error| {
        DiscoveryError::Session(format!("invalid Second Canvas viewer URL: {error}"))
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
            DiscoveryError::Session("Second Canvas viewer has no JSON configuration".into())
        })?;
    let config = viewer.join(&config).map_err(|error| {
        DiscoveryError::Session(format!("invalid Second Canvas configuration URL: {error}"))
    })?;
    if !config.path().to_ascii_lowercase().ends_with(".json") {
        return Err(DiscoveryError::Session(
            "Second Canvas viewer js configuration is not JSON".into(),
        ));
    }
    Ok(config.into())
}

fn catalog(_: &str, bytes: &[u8]) -> Result<ImageCatalog, DiscoveryError> {
    let document: Document = serde_json::from_slice(bytes).map_err(|error| {
        DiscoveryError::Session(format!("unable to parse Second Canvas metadata: {error}"))
    })?;
    let gigapixel = document.gigapixel;
    if gigapixel.url.is_empty()
        || gigapixel.size.w == 0
        || gigapixel.size.h == 0
        || gigapixel.tile == 0
    {
        return Err(DiscoveryError::Session(
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
            DiscoveryError::Session("Second Canvas metadata has no image layers".into())
        })?;

    let entries = layers
        .into_iter()
        .enumerate()
        .map(|(index, layer)| {
            let image_size = layer_size(gigapixel.size, normal_level, layer.level)?;
            let levels = build_levels(&gigapixel, &layer, image_size)?;
            let layer_title = layer.title();
            Ok(CatalogEntry::Ready(ImageDescriptor {
                id: StableId::new(format!("second-canvas:{}", layer.id(index))),
                title: document.title.clone().map(|title| {
                    if layer.is_normal() {
                        title
                    } else {
                        layer_title.map_or(title.clone(), |layer_title| {
                            format!("{title} ({layer_title})")
                        })
                    }
                }),
                format: StableId::new("second_canvas"),
                levels,
                ..Default::default()
            }))
        })
        .collect::<Result<Vec<_>, DiscoveryError>>()?;
    ImageCatalog::new(entries)
        .normalize()
        .map_err(|error| DiscoveryError::Session(error.to_string()))
}

fn layer_size(size: Size, normal_level: u32, layer_level: u32) -> Result<Vec2d, DiscoveryError> {
    let divisor = 1_u32
        .checked_shl(normal_level.saturating_sub(layer_level))
        .ok_or_else(|| DiscoveryError::Session("Second Canvas level is too large".into()))?;
    Ok(Vec2d {
        x: size.w.div_ceil(divisor),
        y: size.h.div_ceil(divisor),
    })
}

fn build_levels(
    gigapixel: &Gigapixel,
    layer: &Layer,
    image_size: Vec2d,
) -> Result<Vec<LevelDescriptor>, DiscoveryError> {
    let origin: Arc<str> = gigapixel.url.clone().into();
    let pattern: Arc<str> = layer.pattern.clone().into();
    (0..=layer.level)
        .map(|level| {
            let downscale = 1_u32.checked_shl(layer.level - level).ok_or_else(|| {
                DiscoveryError::Session("Second Canvas level is too large".into())
            })?;
            let level_size = Vec2d {
                x: image_size.x.div_ceil(downscale),
                y: image_size.y.div_ceil(downscale),
            };
            let validation_origin = Arc::clone(&origin);
            let validation_pattern = Arc::clone(&pattern);
            let validation = Grid::with_requests(
                StableId::new(format!("second-canvas:{}:{level}", layer.id(0))),
                level_size,
                Vec2d::square(gigapixel.tile),
                Vec2d::default(),
                move |tile| {
                    Request::new(format!(
                        "{validation_origin}{validation_pattern}{level}_{}_{}.jpg",
                        tile.coord.column, tile.coord.row
                    ))
                },
            )
            .map_err(|error| {
                DiscoveryError::Session(format!("invalid Second Canvas grid: {error}"))
            })?;
            // Second Canvas serves full-sized padded JPEGs for edge cells.
            // Keep their decoded size and let the declared canvas crop padding
            // instead of scaling edge pixels down in browser runtimes.
            let source = Positioned::from_generator(
                StableId::new(format!("second-canvas:{}:{level}", layer.id(0))),
                Some(level_size),
                SecondCanvasTiles {
                    origin: Arc::clone(&origin),
                    pattern: Arc::clone(&pattern),
                    level,
                    tile_size: gigapixel.tile,
                    shape: validation.shape(),
                    count: validation.count(),
                },
            );
            Ok(LevelDescriptor::new(source)
                .with_scale_factor(Some(downscale))
                .with_title(Some(format!("Second Canvas level {level}"))))
        })
        .collect()
}

#[derive(Clone, Debug)]
struct SecondCanvasTiles {
    origin: Arc<str>,
    pattern: Arc<str>,
    level: u32,
    tile_size: u32,
    shape: Vec2d,
    count: u64,
}

impl crate::core::tile_plan::PositionedGenerator for SecondCanvasTiles {
    fn count(&self) -> u64 {
        self.count
    }

    fn tile(&self, ordinal: u64) -> Result<PositionedTile, TileSourceError> {
        let column = u32::try_from(ordinal % u64::from(self.shape.x))
            .map_err(|_| TileSourceError::ArithmeticOverflow)?;
        let row = u32::try_from(ordinal / u64::from(self.shape.x))
            .map_err(|_| TileSourceError::ArithmeticOverflow)?;
        let destination = Vec2d {
            x: column
                .checked_mul(self.tile_size)
                .ok_or(TileSourceError::ArithmeticOverflow)?,
            y: row
                .checked_mul(self.tile_size)
                .ok_or(TileSourceError::ArithmeticOverflow)?,
        };
        Ok(PositionedTile {
            request: Request::new(format!(
                "{}{}{}_{}_{}.jpg",
                self.origin, self.pattern, self.level, column, row
            )),
            destination,
            processing: ProcessingRecipe::None,
        })
    }
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
            DiscoveryError::Session("legacy Second Canvas metadata has no normal pattern".into())
        })?;
        let level = self.level.ok_or_else(|| {
            DiscoveryError::Session("legacy Second Canvas metadata has no normal level".into())
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

    fn id(&self, fallback: usize) -> String {
        self.kind
            .as_deref()
            .or(self.name.as_deref())
            .map(str::to_ascii_lowercase)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| fallback.to_string())
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
    use crate::core::TileSource;

    fn fixture(name: &str) -> &'static [u8] {
        match name {
            "legacy" => include_bytes!(
                "../../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/second_canvas/legacy.json"
            ),
            "legacy-string" => include_bytes!(
                "../../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/second_canvas/legacy-string-level.json"
            ),
            "modern" => include_bytes!(
                "../../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/second_canvas/modern.json"
            ),
            _ => panic!("unknown fixture"),
        }
    }

    #[test]
    fn parses_legacy_and_modern_layer_variants() {
        let legacy = catalog("https://fixtures.test/legacy.json", fixture("legacy")).unwrap();
        assert_eq!(legacy.len(), 4);
        let legacy_string = catalog(
            "https://fixtures.test/legacy-string.json",
            fixture("legacy-string"),
        )
        .unwrap();
        assert_eq!(legacy_string.len(), 2);
        let modern = catalog("https://fixtures.test/modern.json", fixture("modern")).unwrap();
        assert_eq!(modern.len(), 2);
    }

    #[test]
    fn builds_zero_based_jpeg_tile_urls_at_each_level() {
        let catalog = catalog("https://fixtures.test/modern.json", fixture("modern")).unwrap();
        let CatalogEntry::Ready(image) = &catalog.entries()[0] else {
            panic!("expected ready image");
        };
        let TileSource::Positioned(tiles) = &image.levels.last().unwrap().source else {
            panic!("expected positioned tiles");
        };
        let urls: Vec<_> = tiles
            .tiles()
            .map(|tile| tile.unwrap().request.uri)
            .collect();
        assert_eq!(
            urls[0],
            "https://sc.example.test/gigapixel/modern/normal_3_0_0.jpg"
        );
        assert_eq!(
            urls.last().unwrap(),
            "https://sc.example.test/gigapixel/modern/normal_3_2_1.jpg"
        );
        assert_eq!(tiles.image_size(), Some(Vec2d { x: 1300, y: 900 }));
        let last = tiles.tiles().last().unwrap().unwrap();
        assert_eq!(last.destination, Vec2d { x: 1024, y: 512 });
        assert_eq!(last.expected_size, None, "padded edge tiles are clipped");
    }

    #[test]
    fn viewer_js_parameter_resolves_against_the_viewer_page() {
        assert_eq!(
            viewer_config_uri(
                "https://fixtures.test/web/index.html?js=metadata%2Fmodern.json&ua=test",
                b"<script src=\"scw.min.js\"></script>",
            )
            .unwrap(),
            "https://fixtures.test/web/metadata/modern.json"
        );
    }

    #[test]
    fn embedded_viewer_hash_resolves_against_the_viewer_page() {
        assert_eq!(
            viewer_config_uri(
                "https://fixtures.test/web/gallery/metropolis_es.html",
                br#"<script src="scv.min.js"></script><script>scv.load({ "hash":"metropolis_es.json" });</script>"#,
            )
            .unwrap(),
            "https://fixtures.test/web/gallery/metropolis_es.json"
        );
    }
}
