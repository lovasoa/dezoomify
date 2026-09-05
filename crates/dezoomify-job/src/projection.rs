//! Core→protocol catalog projection.
//!
//! Projects a [`dezoomify_core::core::model::ImageCatalog`] into the stable
//! wire DTOs of [`dezoomify_protocol::dto`]. The projection is total and
//! deterministic: every core entry maps to exactly one wire image in catalog
//! order, core private enums are reduced to stable `source_kind` strings, and
//! unknown geometry projects to zero rather than being dropped. Identifier
//! scoping is the only lossy-free rule: a core stable id that does not
//! already carry the wire prefix (`img:`/`lvl:`) receives it.

use dezoomify_core::core::model::{CatalogEntry, ImageCatalog, StableId};
use dezoomify_protocol::dto::{CatalogDto, ImageDto, LevelDto, Readiness};

/// Stable projection failure. Never branches on display strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    /// A core image id cannot be scoped to a wire `img:` id.
    InvalidImageId { id: String },
    /// A core level id cannot be scoped to a wire `lvl:` id.
    InvalidLevelId { image: String, level: String },
}

impl std::fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidImageId { id } => {
                write!(
                    f,
                    "catalog image id {id:?} cannot be projected to an img: id"
                )
            }
            Self::InvalidLevelId { image, level } => write!(
                f,
                "level id {level:?} in image {image:?} cannot be projected to a lvl: id"
            ),
        }
    }
}

impl std::error::Error for ProjectionError {}

/// Stable wire names for core tile-source kinds. Core enums stay private.
fn source_kind(level: &dezoomify_core::core::model::LevelDescriptor) -> &'static str {
    use dezoomify_core::core::tile_plan::TileSource;
    match &level.source {
        TileSource::Grid(_) => "grid",
        TileSource::Positioned(_) => "positioned",
        TileSource::DiscoverableGrid(_) => "discoverable-grid",
        TileSource::Adaptive(_) => "adaptive",
    }
}

/// Scope a core stable id under a wire prefix unless it already carries it.
fn scoped_id(prefix: &str, id: &StableId) -> Option<String> {
    let raw = id.as_str();
    let candidate = if raw.starts_with(&format!("{prefix}:")) {
        raw.to_string()
    } else {
        format!("{prefix}:{raw}")
    };
    (candidate.len() <= 128).then_some(candidate)
}

fn level_dto(
    image_id: &StableId,
    level: &dezoomify_core::core::model::LevelDescriptor,
) -> Result<LevelDto, ProjectionError> {
    let id = scoped_id("lvl", level.id()).ok_or_else(|| ProjectionError::InvalidLevelId {
        image: image_id.to_string(),
        level: level.id().to_string(),
    })?;
    let size = level.source.image_size();
    let tile = level.source.tile_size();
    Ok(LevelDto {
        id: id.parse().map_err(|_| ProjectionError::InvalidLevelId {
            image: image_id.to_string(),
            level: level.id().to_string(),
        })?,
        width: size.map_or(0, |s| u64::from(s.x)),
        height: size.map_or(0, |s| u64::from(s.y)),
        tile_width: tile.map_or(0, |t| u64::from(t.x)),
        tile_height: tile.map_or(0, |t| u64::from(t.y)),
    })
}

fn image_dto(entry: &CatalogEntry) -> Result<ImageDto, ProjectionError> {
    match entry {
        CatalogEntry::Ready(image) => {
            let id =
                scoped_id("img", &image.id).ok_or_else(|| ProjectionError::InvalidImageId {
                    id: image.id.to_string(),
                })?;
            let levels = image
                .levels
                .iter()
                .map(|level| level_dto(&image.id, level))
                .collect::<Result<Vec<_>, _>>()?;
            // The image dimensions are the largest known level; zero when no
            // level declares its size up front (probe-driven sources).
            let (width, height) = levels.iter().fold((0u64, 0u64), |(w, h), level| {
                ((w.max(level.width)), h.max(level.height))
            });
            Ok(ImageDto {
                id: id.parse().map_err(|_| ProjectionError::InvalidImageId {
                    id: image.id.to_string(),
                })?,
                label: image.title.clone().unwrap_or_else(|| image.id.to_string()),
                format: image.format.to_string(),
                width,
                height,
                readiness: Readiness::Ready,
                source_kind: image.levels.first().map_or("unknown", source_kind).into(),
                levels,
            })
        }
        CatalogEntry::Deferred(image) => {
            let id =
                scoped_id("img", &image.id).ok_or_else(|| ProjectionError::InvalidImageId {
                    id: image.id.to_string(),
                })?;
            Ok(ImageDto {
                id: id.parse().map_err(|_| ProjectionError::InvalidImageId {
                    id: image.id.to_string(),
                })?,
                label: image.title.clone().unwrap_or_else(|| image.uri.clone()),
                format: String::new(),
                width: 0,
                height: 0,
                readiness: Readiness::Deferred,
                source_kind: "deferred".into(),
                levels: Vec::new(),
            })
        }
    }
}

/// Project a core catalog into the wire catalog DTO, preserving order.
///
/// # Errors
///
/// [`ProjectionError`] when a core id cannot be scoped to the wire id kind.
pub fn project_catalog(catalog: &ImageCatalog) -> Result<CatalogDto, ProjectionError> {
    let images = catalog
        .entries()
        .iter()
        .map(image_dto)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CatalogDto { images })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dezoomify_core::core::model::{DeferredImage, ImageDescriptor, LevelDescriptor};
    use dezoomify_core::core::tile_plan::Grid;
    use dezoomify_core::Vec2d;

    #[derive(Debug)]
    struct TestRequests;

    impl dezoomify_core::core::tile_plan::GridRequests for TestRequests {
        fn request(
            &self,
            _tile: dezoomify_core::core::tile_plan::GridTile,
        ) -> dezoomify_core::core::model::Request {
            dezoomify_core::core::model::Request::new("memory://tile")
        }
    }

    fn grid_level(id: &str, image: u32, tile: u32) -> LevelDescriptor {
        LevelDescriptor::new(
            Grid::new(
                id.into(),
                Vec2d { x: image, y: image },
                Vec2d { x: tile, y: tile },
                Vec2d::default(),
                TestRequests,
            )
            .unwrap(),
        )
    }

    #[test]
    fn ready_grid_image_projects_with_stable_ids_and_dimensions() {
        let catalog = ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
            id: StableId::new("cover"),
            title: Some("Cover".into()),
            format: StableId::new("zoomify"),
            levels: vec![grid_level("lvl:cover-0", 512, 256)],
            warnings: Vec::new(),
        })]);
        let dto = project_catalog(&catalog).unwrap();
        assert_eq!(dto.images.len(), 1);
        let image = &dto.images[0];
        assert_eq!(image.id.as_str(), "img:cover");
        assert_eq!(image.label, "Cover");
        assert_eq!(image.format, "zoomify");
        assert_eq!(image.readiness, Readiness::Ready);
        assert_eq!(image.source_kind, "grid");
        assert_eq!(image.width, 512);
        assert_eq!(image.height, 512);
        assert_eq!(image.levels.len(), 1);
        let level = &image.levels[0];
        assert_eq!(level.id.as_str(), "lvl:cover-0");
        assert_eq!(level.width, 512);
        assert_eq!(level.tile_width, 256);

        // The projection is wire-stable: canonical encode, decode, compare.
        let bytes = dezoomify_protocol::codec::encode(&dto).unwrap();
        let back: CatalogDto = dezoomify_protocol::codec::decode(&bytes).unwrap();
        assert_eq!(back, dto);
    }

    #[test]
    fn unprefixed_level_ids_receive_the_wire_prefix() {
        let catalog = ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
            id: StableId::new("img:0"),
            title: None,
            format: StableId::new("iiif"),
            levels: vec![grid_level("0", 256, 256)],
            warnings: Vec::new(),
        })]);
        let dto = project_catalog(&catalog).unwrap();
        assert_eq!(dto.images[0].id.as_str(), "img:0");
        assert_eq!(dto.images[0].label, "img:0");
        assert_eq!(dto.images[0].levels[0].id.as_str(), "lvl:0");
    }

    #[test]
    fn deferred_entries_project_without_levels() {
        let catalog = ImageCatalog::new([CatalogEntry::Deferred(DeferredImage {
            id: StableId::new("detail"),
            uri: "https://fixtures.test/manifest".into(),
            title: None,
            warnings: Vec::new(),
        })]);
        let dto = project_catalog(&catalog).unwrap();
        let image = &dto.images[0];
        assert_eq!(image.id.as_str(), "img:detail");
        assert_eq!(image.readiness, Readiness::Deferred);
        assert_eq!(image.source_kind, "deferred");
        assert_eq!(image.format, "");
        assert_eq!(image.levels, Vec::new());
    }

    #[test]
    fn oversized_core_ids_are_rejected() {
        let long = "x".repeat(200);
        let catalog = ImageCatalog::new([CatalogEntry::Ready(ImageDescriptor {
            id: StableId::new(long.as_str()),
            title: None,
            format: StableId::new("test"),
            levels: Vec::new(),
            warnings: Vec::new(),
        })]);
        assert_eq!(
            project_catalog(&catalog),
            Err(ProjectionError::InvalidImageId { id: long })
        );
    }
}
