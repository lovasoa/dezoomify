//! Neutral values shared by discovery and tile planning.

use std::fmt::Write as _;

use crate::Vec2d;
use crate::model::{
    Catalog, CatalogEntry as PublicCatalogEntry, Header, Image, ImageRequest, Level, Size,
};

use super::discovery::DiscoveryError;
use super::tile_plan::TileSource;

/// One portable resource description, used for both metadata and tiles.
#[derive(Clone, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Request {
    pub uri: String,
    pub headers: Vec<Header>,
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
        self.headers.push(Header {
            name: name.into(),
            value: value.into(),
        });
        self
    }

    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str())
    }
}

pub use crate::model::ProcessingRecipe;

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
#[doc(hidden)]
pub struct ResolvedLevel {
    pub title: Option<String>,
    pub scale_factor: Option<u32>,
    pub source: TileSource,
    /// Canonical public geometry constructed together with the private tile
    /// program. The display label is filled after level ordering is frozen.
    pub public: Level,
    pub warnings: Vec<String>,
}

impl ResolvedLevel {
    #[must_use]
    pub fn new(source: impl Into<TileSource>) -> Self {
        let source = source.into();
        let size = source.image_size().map(|value| Size {
            width: value.x,
            height: value.y,
        });
        let tile_size = source.tile_size().map(|value| Size {
            width: value.x,
            height: value.y,
        });
        Self {
            title: None,
            scale_factor: None,
            source,
            public: Level {
                label: String::new(),
                size,
                tile_size,
            },
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

/// A decoded image before its format identity and public catalog are assigned.
/// Format decoders supply only image data; publication is centralized here.
pub struct ImagePlan {
    pub title: Option<String>,
    pub levels: Vec<ResolvedLevel>,
    pub warnings: Vec<String>,
}

impl ImagePlan {
    #[must_use]
    pub fn new(title: Option<String>, levels: Vec<ResolvedLevel>) -> Self {
        Self {
            title,
            levels,
            warnings: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_warnings(mut self, warnings: Vec<String>) -> Self {
        self.warnings = warnings;
        self
    }

    pub fn compile_entry(self, format: &'static str) -> Result<DiscoveredEntry, DiscoveryError> {
        if self.levels.is_empty() {
            return Err(DiscoveryError::Session(format!(
                "{format} image has no levels"
            )));
        }
        if self.levels.iter().any(|level| {
            level
                .source
                .count()
                .is_some_and(|count| count > u64::from(u32::MAX))
        }) {
            return Err(DiscoveryError::Session(format!(
                "{format} tile count exceeds supported ordinals"
            )));
        }
        Ok(DiscoveredEntry::ready(
            format,
            self.title,
            self.levels,
            self.warnings,
        ))
    }

    pub fn compile(self, format: &'static str) -> Result<DiscoveryCatalog, DiscoveryError> {
        Ok(DiscoveryCatalog::new([self.compile_entry(format)?]))
    }
}

#[derive(Clone, Debug, Default)]
#[doc(hidden)]
pub struct ResolvedImage {
    pub title: Option<String>,
    /// Static registry name of the format which produced this descriptor.
    pub format: &'static str,
    pub levels: Vec<ResolvedLevel>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[doc(hidden)]
pub struct DeferredResource {
    pub uri: String,
    pub title: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
#[doc(hidden)]
pub enum DiscoveredEntry {
    Ready(ResolvedImage),
    Deferred(DeferredResource),
}

impl DiscoveredEntry {
    /// Compile one format-owned image plan into a ready catalog entry.
    #[must_use]
    pub fn ready(
        format: &'static str,
        title: Option<String>,
        levels: Vec<ResolvedLevel>,
        warnings: Vec<String>,
    ) -> Self {
        Self::Ready(ResolvedImage {
            title,
            format,
            levels,
            warnings,
        })
    }

    /// Compile one deferred resource into a catalog entry.
    #[must_use]
    pub fn deferred(uri: impl Into<String>, title: Option<String>, warnings: Vec<String>) -> Self {
        Self::Deferred(DeferredResource {
            uri: uri.into(),
            title,
            warnings,
        })
    }
}

#[derive(Clone, Debug, Default)]
#[doc(hidden)]
pub struct DiscoveryCatalog(Vec<DiscoveredEntry>);

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

impl DiscoveryCatalog {
    #[must_use]
    pub fn new(entries: impl IntoIterator<Item = DiscoveredEntry>) -> Self {
        let mut entries: Vec<_> = entries.into_iter().collect();
        for entry in &mut entries {
            if let DiscoveredEntry::Ready(image) = entry
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
        Self(entries)
    }

    /// Compile one ready image into a catalog using the canonical image-plan
    /// shape. Formats supply identity, optional title, and their level
    /// programs; catalog publication owns the remaining defaults.
    #[must_use]
    pub fn ready(format: &'static str, title: Option<String>, levels: Vec<ResolvedLevel>) -> Self {
        Self::ready_with_warnings(format, title, levels, Vec::new())
    }

    /// Compile one ready image whose decoder produced image-wide warnings.
    #[must_use]
    pub fn ready_with_warnings(
        format: &'static str,
        title: Option<String>,
        levels: Vec<ResolvedLevel>,
        warnings: Vec<String>,
    ) -> Self {
        Self::new([DiscoveredEntry::ready(format, title, levels, warnings)])
    }

    /// Canonical public catalog paired with this catalog's private tile
    /// programs. Array positions are preserved exactly.
    #[must_use]
    pub fn public_catalog(&self) -> Catalog {
        Catalog {
            entries: self
                .0
                .iter()
                .map(|entry| match entry {
                    DiscoveredEntry::Ready(image) => {
                        let levels: Vec<_> = image
                            .levels
                            .iter()
                            .enumerate()
                            .map(|(position, level)| {
                                let mut public = level.public.clone();
                                public.label = level.display_label(position);
                                public
                            })
                            .collect();
                        let size = levels.iter().filter_map(|level| level.size.as_ref()).fold(
                            None,
                            |largest: Option<Size>, size| {
                                Some(Size {
                                    width: largest
                                        .as_ref()
                                        .map_or(size.width, |value| value.width.max(size.width)),
                                    height: largest
                                        .as_ref()
                                        .map_or(size.height, |value| value.height.max(size.height)),
                                })
                            },
                        );
                        PublicCatalogEntry::Image(Image {
                            title: image.title.clone(),
                            format: image.format.to_string(),
                            size,
                            source_kind: image
                                .levels
                                .first()
                                .map_or("unknown", |level| level.source.kind_name())
                                .into(),
                            levels,
                        })
                    }
                    DiscoveredEntry::Deferred(image) => {
                        PublicCatalogEntry::ImageRequest(ImageRequest {
                            title: image.title.clone(),
                            uri: image.uri.clone(),
                        })
                    }
                })
                .collect(),
        }
    }

    #[must_use]
    pub fn entries(&self) -> &[DiscoveredEntry] {
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
    pub fn into_entries(self) -> Vec<DiscoveredEntry> {
        self.0
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

    fn level(size: u32) -> ResolvedLevel {
        ResolvedLevel::new(
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
        let catalog = DiscoveryCatalog::new([DiscoveredEntry::Ready(ResolvedImage {
            title: None,
            format: "test",
            levels: vec![level(300), level(100)],
            warnings: Vec::new(),
        })]);
        let DiscoveredEntry::Ready(image) = &catalog.entries()[0] else {
            unreachable!()
        };
        assert_eq!(
            image.levels[0].source.image_size(),
            Some(Vec2d::square(100))
        );
    }

    #[test]
    fn image_plan_compiler_rejects_unusable_tile_ordinals() {
        let oversized = Grid::new(
            Vec2d::square(65_536),
            Vec2d::square(1),
            Vec2d::default(),
            TestSource,
        )
        .unwrap();
        assert!(
            ImagePlan::new(None, vec![ResolvedLevel::new(oversized)])
                .compile("test")
                .unwrap_err()
                .to_string()
                .contains("tile count")
        );
        assert!(ImagePlan::new(None, Vec::new()).compile("test").is_err());
    }
}
