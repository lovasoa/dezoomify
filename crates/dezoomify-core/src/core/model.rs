//! Neutral values shared by discovery and tile planning.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use crate::Vec2d;

use super::discovery::DiscoveryError;
use super::tile_plan::TileSource;

/// One portable resource description, used for both metadata and tiles.
#[derive(Clone, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Request {
    pub uri: String,
    pub headers: BTreeMap<String, String>,
}

impl Request {
    #[must_use]
    pub fn new(uri: impl Into<String>) -> Self {
        Self {
            uri: uri.into(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }
}

/// A byte-processing operation applied to a fetched tile payload before it
/// is decoded as an image.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ProcessingRecipe {
    None,
    /// Strips Google Arts & Culture tile encryption (see
    /// `google_arts_and_culture::decryption`).
    GoogleArtsDecrypt,
}

/// How an acquired tile participates in adaptive probing and final output.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum TileRole {
    Output,
    /// A probe which must not be added to the output canvas.
    Probe,
    /// A successful probe is output; a missing probe is not an output failure.
    ProbeAndOutput,
}

/// A logical tile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TileSpec {
    /// Zero-based position within the selected level's immutable tile plan.
    pub ordinal: u32,
    pub request: Request,
    /// Top-left output position. The extent is deliberately optional because
    /// probe and custom-layout tiles may only reveal it after decoding.
    pub destination: Vec2d,
    pub expected_size: Option<Vec2d>,
    pub processing: ProcessingRecipe,
    pub role: TileRole,
}

#[derive(Clone, Debug)]
pub struct LevelDescriptor {
    pub title: Option<String>,
    pub scale_factor: Option<u32>,
    pub source: TileSource,
    pub warnings: Vec<String>,
}

impl LevelDescriptor {
    #[must_use]
    pub fn new(source: impl Into<TileSource>) -> Self {
        Self {
            title: None,
            scale_factor: None,
            source: source.into(),
            warnings: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_title(mut self, title: Option<String>) -> Self {
        self.title = title;
        self
    }

    #[must_use]
    pub const fn with_scale_factor(mut self, scale_factor: Option<u32>) -> Self {
        self.scale_factor = scale_factor;
        self
    }

    #[must_use]
    pub fn with_warnings(mut self, warnings: Vec<String>) -> Self {
        self.warnings = warnings;
        self
    }

    /// Human-readable label for interactive pickers.
    ///
    /// Shows the level title (or positional label as a fallback) followed by the
    /// image size, tile size and tile count whenever they are known.
    #[must_use]
    pub fn display_label(&self, position: usize) -> String {
        let label = self
            .title
            .clone()
            .unwrap_or_else(|| format!("Level {}", position + 1));
        let size = self.source.image_size();
        let count = self.source.count();
        if size.is_none() && count.is_none() {
            return label;
        }
        let mut out = String::with_capacity(label.len() + 40);
        let _ = write!(out, "{label} (");
        let mut sep = "";
        if let Some(Vec2d { x, y }) = size {
            let _ = write!(out, "{x: >5} x {y: >5} pixels");
            sep = ",";
        }
        if let Some(count) = count {
            let _ = write!(out, "{sep}{count: >4} tiles");
        }
        let _ = write!(out, ")");
        out
    }
}

#[derive(Clone, Debug, Default)]
pub struct ImageDescriptor {
    pub title: Option<String>,
    /// Static registry name of the format which produced this descriptor.
    pub format: &'static str,
    pub levels: Vec<LevelDescriptor>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeferredImage {
    pub uri: String,
    pub title: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum CatalogEntry {
    Ready(ImageDescriptor),
    Deferred(DeferredImage),
}

#[derive(Clone, Debug, Default)]
pub struct ImageCatalog(pub Vec<CatalogEntry>);

/// Floor a fractional tile coordinate, rejecting non-finite or out-of-range
/// values. `format` names the site format in the error message.
pub(crate) fn floor_index(value: f64, format: &str) -> Result<i64, DiscoveryError> {
    let value = value.floor();
    if !value.is_finite() {
        return Err(DiscoveryError::Session(format!(
            "{format} tile coordinate is out of range"
        )));
    }
    value
        .to_string()
        .parse::<i64>()
        .map_err(|_| DiscoveryError::Session(format!("{format} tile coordinate is out of range")))
}

impl ImageCatalog {
    #[must_use]
    pub fn new(entries: impl IntoIterator<Item = CatalogEntry>) -> Self {
        Self(entries.into_iter().collect())
    }

    #[must_use]
    pub fn entries(&self) -> &[CatalogEntry] {
        &self.0
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn into_entries(self) -> Vec<CatalogEntry> {
        self.0
    }

    /// Enforce deterministic level ordering before the catalog is published.
    #[must_use]
    pub fn normalize(mut self) -> Self {
        for entry in &mut self.0 {
            if let CatalogEntry::Ready(image) = entry
                && image
                    .levels
                    .iter()
                    .all(|level| level.source.image_size().is_some())
            {
                image.levels.sort_by_key(|level| {
                    level.source.image_size().expect("all sizes checked").area()
                });
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{Grid, GridRequests, GridTile};

    #[derive(Debug)]
    struct TestSource;

    impl GridRequests for TestSource {
        fn request(&self, tile: GridTile) -> Request {
            Request::new(format!("memory://{}/{}", tile.coord.column, tile.coord.row))
        }
    }

    fn level(size: u32) -> LevelDescriptor {
        LevelDescriptor::new(
            Grid::new(
                Vec2d::square(size),
                Vec2d::square(1),
                Vec2d::default(),
                TestSource,
            )
            .unwrap(),
        )
    }

    #[test]
    fn display_label_includes_geometry_and_tile_count() {
        let mut level = level(100);
        level.source = Grid::new(
            Vec2d::square(100),
            Vec2d::square(100),
            Vec2d::default(),
            TestSource,
        )
        .unwrap()
        .into();
        let label = level.display_label(2);
        assert_eq!(label, "Level 3 (  100 x   100 pixels,   1 tiles)");
        level.title = Some("Krpano Cube forward".into());
        assert!(level.display_label(2).starts_with("Krpano Cube forward ("));
    }

    #[test]
    fn normalization_orders_levels_deterministically() {
        let catalog = ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
            title: None,
            format: "test",
            levels: vec![level(300), level(100)],
            warnings: Vec::new(),
        })])
        .normalize();
        let CatalogEntry::Ready(image) = &catalog.entries()[0] else {
            unreachable!()
        };
        assert_eq!(
            image.levels[0].source.image_size(),
            Some(Vec2d::square(100))
        );
    }
}
