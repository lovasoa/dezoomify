//! Neutral values shared by discovery and tile planning.

use std::fmt::Write as _;

use crate::Vec2d;
use crate::model::{
    Catalog, CatalogEntry as PublicCatalogEntry, Header, Image, ImageRequest, Level, Size,
};

use super::discovery::DiscoveryError;
use super::tile_plan::{Grid, GridTile, TileSource, TileSourceError};

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

impl From<Request> for crate::model::TileSource {
    fn from(request: Request) -> Self {
        Self::Resource(crate::model::ResourceRequest {
            uri: request.uri,
            headers: request.headers,
            purpose: crate::model::RequestPurpose::Tile,
        })
    }
}

pub use crate::model::{ProcessingRecipe, TileRole};

/// A logical tile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TileSpec {
    /// Zero-based position within the selected level's immutable tile plan.
    pub ordinal: u32,
    pub source: crate::model::TileSource,
    /// Top-left output position. The extent is deliberately optional because
    /// probe and custom-layout tiles may only reveal it after decoding.
    pub destination: Vec2d,
    pub expected_size: Option<Vec2d>,
    pub processing: ProcessingRecipe,
    pub role: TileRole,
}

impl TileSpec {
    pub(crate) fn into_tile(mut self, canvas: Option<Size>) -> crate::model::Tile {
        use crate::model::{Point, RequestPurpose, Tile, TilePlacement, TileSource};
        if let TileSource::Resource(request) = &mut self.source {
            request.purpose = if self.role.probe {
                RequestPurpose::Probe
            } else {
                RequestPurpose::Tile
            };
        }
        Tile {
            index: self.ordinal,
            source: self.source,
            placement: TilePlacement {
                position: Point {
                    x: self.destination.x,
                    y: self.destination.y,
                },
                expected_size: self.expected_size.map(|size| Size {
                    width: size.x,
                    height: size.y,
                }),
                canvas,
                processing: self.processing,
                role: self.role,
            },
        }
    }
}

#[derive(Clone, Debug)]
#[doc(hidden)]
pub struct ResolvedLevel {
    pub title: Option<String>,
    pub scale_factor: Option<u32>,
    pub source: TileSource,
    pub warnings: Vec<String>,
}

impl ResolvedLevel {
    #[must_use]
    pub fn new(source: impl Into<TileSource>) -> Self {
        let source = source.into();
        Self {
            title: None,
            scale_factor: None,
            source,
            warnings: Vec::new(),
        }
    }

    /// A regular, non-overlapping level. Other tile sources support overlap,
    /// custom placement, and geometry determined by probing.
    pub fn grid(
        image_size: Vec2d,
        tile_size: Vec2d,
        request: impl Fn(GridTile) -> Request + Send + Sync + 'static,
    ) -> Result<Self, TileSourceError> {
        Ok(Self::new(Grid::with_requests(
            image_size,
            tile_size,
            Vec2d::default(),
            request,
        )?))
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
        if self.levels.is_empty() && self.warnings.is_empty() {
            return Err(DiscoveryError::InvalidMetadata(format!(
                "{format} image has no levels"
            )));
        }
        if self.levels.iter().any(|level| {
            level
                .source
                .count()
                .is_some_and(|count| count > u64::from(u32::MAX))
        }) {
            return Err(DiscoveryError::InvalidMetadata(format!(
                "{format} tile count exceeds supported ordinals"
            )));
        }
        Ok(DiscoveredEntry::Ready(ResolvedImage {
            title: self.title,
            source_url: None,
            format,
            levels: self.levels,
            warnings: self.warnings,
        }))
    }

    pub fn compile(self, format: &'static str) -> Result<DiscoveryCatalog, DiscoveryError> {
        Ok(DiscoveryCatalog::new([self.compile_entry(format)?]))
    }
}

enum CatalogItem {
    Image(ImagePlan),
    Deferred(DeferredResource),
}

/// A metadata file that declares several images or deferred image links.
/// Single-image formats return `ImagePlan` directly and need no catalog code.
pub struct CatalogPlan(Vec<CatalogItem>);

impl CatalogPlan {
    #[must_use]
    pub fn images(images: impl IntoIterator<Item = ImagePlan>) -> Self {
        Self(images.into_iter().map(CatalogItem::Image).collect())
    }

    #[must_use]
    pub fn deferred(resources: impl IntoIterator<Item = DeferredResource>) -> Self {
        Self(resources.into_iter().map(CatalogItem::Deferred).collect())
    }

    pub fn compile(self, format: &'static str) -> Result<DiscoveryCatalog, DiscoveryError> {
        let entries = self
            .0
            .into_iter()
            .map(|entry| match entry {
                CatalogItem::Image(plan) => plan.compile_entry(format),
                CatalogItem::Deferred(resource) => Ok(DiscoveredEntry::Deferred(resource)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DiscoveryCatalog::new(entries))
    }
}

#[derive(Clone, Debug, Default)]
#[doc(hidden)]
pub struct ResolvedImage {
    pub title: Option<String>,
    /// Format-designated entry point which can resolve this image's catalog independently.
    pub source_url: Option<String>,
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
    pub size: Option<Size>,
    pub preview: Option<crate::model::Tile>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
#[doc(hidden)]
pub enum DiscoveredEntry {
    Ready(ResolvedImage),
    Deferred(DeferredResource),
}

impl DiscoveredEntry {
    /// Compile one deferred resource into a catalog entry.
    #[must_use]
    pub fn deferred(uri: impl Into<String>, title: Option<String>, warnings: Vec<String>) -> Self {
        Self::Deferred(DeferredResource {
            uri: uri.into(),
            title,
            size: None,
            preview: None,
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
        return Err(DiscoveryError::InvalidMetadata(format!(
            "{format} tile coordinate is out of range"
        )));
    }
    value.to_string().parse::<i64>().map_err(|_| {
        DiscoveryError::InvalidMetadata(format!("{format} tile coordinate is out of range"))
    })
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

    /// Ordered image choices for a host.
    #[must_use]
    pub fn public_catalog(&self) -> Catalog {
        Catalog {
            entries: self
                .0
                .iter()
                .map(|entry| match entry {
                    DiscoveredEntry::Ready(image) => PublicCatalogEntry::Image(image.into()),
                    DiscoveredEntry::Deferred(image) => {
                        PublicCatalogEntry::ImageRequest(ImageRequest {
                            title: image.title.clone(),
                            uri: image.uri.clone(),
                            size: image.size.clone(),
                            preview: image.preview.clone(),
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

    pub(crate) fn with_source_url(mut self, uri: &str) -> Self {
        for entry in &mut self.0 {
            if let DiscoveredEntry::Ready(image) = entry {
                image.source_url = Some(uri.into());
            }
        }
        self
    }
}

impl From<&ResolvedImage> for Image {
    fn from(image: &ResolvedImage) -> Self {
        let levels: Vec<_> = image
            .levels
            .iter()
            .enumerate()
            .map(|(position, level)| Level {
                label: level.display_label(position),
                size: level.source.image_size().map(|value| Size {
                    width: value.x,
                    height: value.y,
                }),
                tile_size: level.source.tile_size().map(|value| Size {
                    width: value.x,
                    height: value.y,
                }),
            })
            .collect();
        let size = levels
            .iter()
            .filter_map(|level| level.size.as_ref())
            .max_by_key(|size| u64::from(size.width) * u64::from(size.height))
            .cloned();
        Self {
            title: image.title.clone(),
            source_url: image.source_url.clone(),
            preview: image_preview(image),
            format: image.format.to_string(),
            size,
            levels,
        }
    }
}

pub(crate) fn image_preview(image: &ResolvedImage) -> Option<crate::model::Tile> {
    let mut candidates: Vec<_> = image
        .levels
        .iter()
        .filter_map(|level| {
            let grid = match &level.source {
                TileSource::Grid(grid) => grid,
                TileSource::Adaptive(source) => source.declared_grid()?,
                _ => return None,
            };
            if grid.count() == 1 {
                let size = grid.image_size();
                (size.x > 0 && size.y > 0 && size.x <= 1024 && size.y <= 1024)
                    .then_some((size, grid))
            } else {
                None
            }
        })
        .collect();
    candidates.sort_by_key(|(size, _)| size.area());
    let (size, grid) = candidates
        .iter()
        .find(|(size, _)| size.x.max(size.y) >= 160)
        .or_else(|| candidates.last())?;
    let tile = grid.tiles_row_major().next()?.ok()?;
    Some(tile.into_tile(Some(Size {
        width: size.x,
        height: size.y,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{Grid, GridRequests, GridTile};
    use crate::test_support::resource_uri;

    #[derive(Debug)]
    struct TestSource;

    impl GridRequests for TestSource {
        fn request(&self, tile: GridTile) -> crate::model::TileSource {
            Request::new(format!("memory://{}/{}", tile.coord.column, tile.coord.row)).into()
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
            source_url: None,
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
        let diagnostics_only = ImagePlan::new(None, Vec::new())
            .with_warnings(vec!["invalid scene".into()])
            .compile("test")
            .unwrap();
        let DiscoveredEntry::Ready(image) = &diagnostics_only.entries()[0] else {
            unreachable!()
        };
        assert!(image.levels.is_empty());
        assert_eq!(image.warnings, ["invalid scene"]);
    }

    #[test]
    fn previews_choose_useful_complete_tiles_with_bounded_geometry() {
        let grid = |size, tile_size| {
            ResolvedLevel::grid(Vec2d::square(size), Vec2d::square(tile_size), move |_| {
                Request::new(format!("memory://level/{size}"))
            })
            .unwrap()
        };
        let image = ResolvedImage {
            source_url: Some("memory://catalog".into()),
            levels: vec![grid(1, 256), grid(128, 256), grid(256, 256), grid(512, 256)],
            ..Default::default()
        };
        let public = Image::from(&image);
        let preview = public.preview.unwrap();
        assert_eq!(resource_uri(&preview.source), "memory://level/256");
        assert_eq!(preview.placement.canvas.unwrap().width, 256);
        assert_eq!(public.size.unwrap().width, 512);
        assert_eq!(public.source_url.as_deref(), Some("memory://catalog"));
        let smaller = ResolvedImage {
            levels: vec![grid(1, 256), grid(128, 256)],
            ..Default::default()
        };
        assert_eq!(
            image_preview(&smaller)
                .unwrap()
                .source
                .resource()
                .unwrap()
                .uri
                .clone(),
            "memory://level/128"
        );
        let unavailable = ResolvedImage {
            levels: vec![grid(512, 256), grid(2048, 2048)],
            ..Default::default()
        };
        assert!(image_preview(&unavailable).is_none());
    }
}
