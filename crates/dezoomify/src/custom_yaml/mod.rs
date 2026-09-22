//! Pure discovery for explicit `tiles.yaml` layouts.

use std::collections::HashMap;

use serde::Deserialize;

use crate::Vec2d;
use crate::core::{
    DiscoveryCatalog, DiscoveryError, DiscoveryMatch, FormatSpec, Positioned, ProcessingRecipe,
    Request, ResolvedLevel, TileSourceError,
};
use crate::default_headers;
use crate::model::Header;

mod tile_set;
mod variable;

pub const SPEC: FormatSpec = FormatSpec::new("custom", &[DiscoveryMatch::Any.extract(catalog)])
    .with_display_name("Custom tiles")
    .recognizing(is_tiles_yaml, "not a tiles.yaml file")
    .preferring(is_tiles_yaml);

fn is_tiles_yaml(uri: &str) -> bool {
    uri.split(['?', '#'])
        .next()
        .is_some_and(|path| path.ends_with("tiles.yaml"))
}

fn catalog(_: &str, bytes: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
    catalog_from_yaml(bytes)
}

#[derive(Deserialize)]
struct CustomYamlTiles {
    #[serde(flatten)]
    tile_set: tile_set::TileSet,
    #[serde(default = "default_headers")]
    headers: HashMap<String, String>,
    title: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

fn catalog_from_yaml(bytes: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
    let yaml: CustomYamlTiles = serde_yaml::from_slice(bytes)
        .map_err(|error| DiscoveryError::Session(format!("invalid tiles.yaml: {error}")))?;
    let mut headers: Vec<_> = yaml
        .headers
        .into_iter()
        .map(|(name, value)| Header { name, value })
        .collect();
    headers.sort_by(|left, right| left.name.cmp(&right.name));
    yaml.tile_set
        .len()
        .map_err(|error| DiscoveryError::Session(format!("invalid tiles.yaml: {error}")))?;
    let size = yaml.width.zip(yaml.height).map(|(x, y)| Vec2d { x, y });
    Ok(DiscoveryCatalog::ready(
        "custom",
        yaml.title,
        vec![ResolvedLevel::new(Positioned::from_generator(
            size,
            CustomTiles {
                tile_set: yaml.tile_set,
                headers,
            },
        ))],
    ))
}

#[derive(Clone, Debug)]
struct CustomTiles {
    tile_set: tile_set::TileSet,
    headers: Vec<Header>,
}

impl crate::core::tile_plan::PositionedGenerator for CustomTiles {
    fn count(&self) -> u64 {
        self.tile_set.len().expect("tile domain was validated")
    }

    fn tile(
        &self,
        ordinal: u64,
    ) -> Result<crate::core::tile_plan::PositionedTile, TileSourceError> {
        let entry = self
            .tile_set
            .tile_at(ordinal)
            .map_err(|error| TileSourceError::InvalidTile(error.to_string()))?;
        Ok(crate::core::tile_plan::PositionedTile {
            request: Request {
                uri: entry.uri,
                headers: self.headers.clone(),
            },
            destination: entry.position,
            processing: ProcessingRecipe::None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{DiscoveredEntry, TileRole, TileSource};

    #[test]
    fn parses_bundled_example_headers() {
        let yaml_path = format!(
            "{}/../../testdata/scenarios/rs-core/formats/payloads/tiles.yaml",
            env!("CARGO_MANIFEST_DIR")
        );
        let yaml: CustomYamlTiles =
            serde_yaml::from_reader(std::fs::File::open(yaml_path).unwrap()).unwrap();
        assert!(yaml.headers.contains_key("Referer"));
        let catalog = catalog_from_yaml(include_bytes!(
            "../../../../testdata/scenarios/rs-core/formats/payloads/tiles.yaml"
        ))
        .unwrap();
        let DiscoveredEntry::Ready(image) = &catalog.entries()[0] else {
            panic!("custom YAML is immediately ready")
        };
        assert_eq!(image.title.as_deref(), Some("A Palace"));
    }

    #[test]
    fn uses_bundled_default_headers() {
        let yaml: CustomYamlTiles =
            serde_yaml::from_str("url_template: test.com\nvariables: []").unwrap();
        assert!(yaml.headers.contains_key("User-Agent"));
    }

    #[test]
    fn recognizes_tiles_yaml_with_a_query_or_fragment() {
        assert!(is_tiles_yaml("https://example.test/tiles.yaml?version=2"));
        assert!(is_tiles_yaml("https://example.test/tiles.yaml#preview"));
        assert!(!is_tiles_yaml("https://example.test/tiles.yml"));
    }

    #[test]
    fn template_plan_is_replayable_without_collecting_tiles() {
        let catalog = catalog_from_yaml(
            br#"
variables:
  - name: x
    from: 0
    to: 1
  - name: y
    from: 0
    to: 1
url_template: "https://example.test/{{x}}/{{y}}"
x_template: x
y_template: y
"#,
        )
        .unwrap();
        let image = match &catalog.entries()[0] {
            DiscoveredEntry::Ready(image) => image,
            DiscoveredEntry::Deferred(_) => panic!("custom YAML is immediately ready"),
        };
        let TileSource::Positioned(plan) = &image.levels[0].source else {
            panic!("custom YAML is positioned");
        };
        assert_eq!(plan.count(), 4);
        let tiles: Vec<_> = plan.tiles().collect::<Result<_, _>>().unwrap();
        let first = &tiles[0];
        let last = &tiles[3];
        assert_eq!(first.ordinal, 0);
        assert_eq!(first.role, TileRole::Output);
        assert_eq!(first.request.uri, "https://example.test/0/0");
        assert_eq!(last.request.uri, "https://example.test/1/1");
        assert_eq!(first, &plan.tiles().next().unwrap().unwrap());
    }

    #[test]
    fn tile_expression_errors_keep_their_message() {
        // x_template evaluates to a value larger than u32: the error must
        // surface its own message, not a generic geometry-overflow message.
        let catalog = catalog_from_yaml(
            br#"
variables:
  - name: x
    from: 0
    to: 1
url_template: "https://example.test/{{x}}"
x_template: "5000000000 + x"
y_template: y
"#,
        )
        .unwrap();
        let image = match &catalog.entries()[0] {
            DiscoveredEntry::Ready(image) => image,
            DiscoveredEntry::Deferred(_) => panic!("custom YAML is immediately ready"),
        };
        let TileSource::Positioned(plan) = &image.levels[0].source else {
            panic!("custom YAML is positioned");
        };
        let error = plan.tiles().next().unwrap().unwrap_err().to_string();
        assert!(
            error.contains("Number too large"),
            "unexpected error message: {error}"
        );
        assert!(
            !error.contains("overflowed u32"),
            "expression errors must not be reported as geometry overflow: {error}"
        );
    }
}
