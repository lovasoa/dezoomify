//! Pure discovery for Second Canvas (Madpixel) `gigapixel` JSON metadata.

use std::sync::Arc;

use serde::{Deserialize, de::IntoDeserializer};

use crate::Vec2d;
use crate::core::{
    CatalogEntry, DezoomerSpec, DiscoveryError, DiscoveryMatch, DiscoveryRoute, Grid, ImageCatalog,
    ImageDescriptor, LevelDescriptor, Request, StableId,
};

const ROUTES: &[DiscoveryRoute] =
    &[DiscoveryMatch::ContentPredicate(contains_gigapixel).extract(catalog)];

pub const SPEC: DezoomerSpec =
    DezoomerSpec::new("second_canvas", ROUTES).with_display_name("Second Canvas");

fn contains_gigapixel(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|document| document.get("gigapixel").cloned())
        .is_some_and(|gigapixel| gigapixel.is_object())
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
            let origin = Arc::clone(&origin);
            let pattern = Arc::clone(&pattern);
            let source = Grid::with_requests(
                StableId::new(format!("second-canvas:{}:{level}", layer.id(0))),
                level_size,
                Vec2d::square(gigapixel.tile),
                Vec2d::default(),
                move |tile| {
                    Request::new(format!(
                        "{origin}{pattern}{level}_{}_{}.jpg",
                        tile.coord.column, tile.coord.row
                    ))
                },
            )
            .map_err(|error| {
                DiscoveryError::Session(format!("invalid Second Canvas grid: {error}"))
            })?;
            Ok(LevelDescriptor::new(source)
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
        let TileSource::Grid(grid) = &image.levels.last().unwrap().source else {
            panic!("expected grid");
        };
        let urls: Vec<_> = grid
            .tiles_row_major()
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
    }
}
