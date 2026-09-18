//! Total core-to-protocol catalog projection.

use dezoomify_core::core::model::{CatalogEntry, ImageCatalog, LevelDescriptor};
use dezoomify_protocol::dto::{CatalogDto, CatalogEntryDto, ImageDto, ImageRequestDto, LevelDto};

fn source_kind(level: &LevelDescriptor) -> &'static str {
    use dezoomify_core::core::tile_plan::TileSource;
    match &level.source {
        TileSource::Grid(_) => "grid",
        TileSource::Positioned(_) => "positioned",
        TileSource::DiscoverableGrid(_) => "discoverable-grid",
        TileSource::Adaptive(_) => "adaptive",
    }
}

fn level_dto(position: usize, level: &LevelDescriptor) -> LevelDto {
    let size = level.source.image_size();
    let tile = level.source.tile_size();
    LevelDto {
        label: level.display_label(position),
        width: size.map_or(0, |value| u64::from(value.x)),
        height: size.map_or(0, |value| u64::from(value.y)),
        tile_width: tile.map_or(0, |value| u64::from(value.x)),
        tile_height: tile.map_or(0, |value| u64::from(value.y)),
    }
}

fn image_dto(entry: &CatalogEntry) -> CatalogEntryDto {
    match entry {
        CatalogEntry::Ready(image) => {
            let levels: Vec<_> = image
                .levels
                .iter()
                .enumerate()
                .map(|(position, level)| level_dto(position, level))
                .collect();
            let (width, height) = levels.iter().fold((0, 0), |(width, height), level| {
                (width.max(level.width), height.max(level.height))
            });
            CatalogEntryDto::Image(ImageDto {
                title: image.title.clone(),
                format: image.format.to_string(),
                width,
                height,
                source_kind: image.levels.first().map_or("unknown", source_kind).into(),
                levels,
            })
        }
        CatalogEntry::Deferred(image) => CatalogEntryDto::ImageRequest(ImageRequestDto {
            title: image.title.clone(),
            uri: image.uri.clone(),
        }),
    }
}

/// Project the immutable catalog without inventing duplicate identity fields.
#[must_use]
pub fn project_catalog(catalog: &ImageCatalog) -> CatalogDto {
    CatalogDto {
        entries: catalog.entries().iter().map(image_dto).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dezoomify_core::core::model::{DeferredImage, ImageDescriptor};
    use dezoomify_core::core::tile_plan::{Grid, GridRequests, GridTile};
    use dezoomify_core::Vec2d;

    #[derive(Debug)]
    struct TestRequests;

    impl GridRequests for TestRequests {
        fn request(&self, _tile: GridTile) -> dezoomify_core::core::Request {
            dezoomify_core::core::Request::new("memory://tile")
        }
    }

    #[test]
    fn projection_preserves_order_and_uses_positional_level_labels() {
        let level = LevelDescriptor::new(
            Grid::new(
                Vec2d::square(512),
                Vec2d::square(256),
                Vec2d::default(),
                TestRequests,
            )
            .unwrap(),
        );
        let catalog = ImageCatalog::new([
            CatalogEntry::Ready(ImageDescriptor {
                title: None,
                format: "zoomify",
                levels: vec![level],
                warnings: Vec::new(),
            }),
            CatalogEntry::Deferred(DeferredImage {
                uri: "https://fixtures.test/manifest".into(),
                title: None,
                warnings: Vec::new(),
            }),
        ]);
        let dto = project_catalog(&catalog);
        let CatalogEntryDto::Image(image) = &dto.entries[0] else {
            panic!("ready entries project to images");
        };
        assert_eq!(image.title, None);
        assert_eq!(
            image.levels[0].label,
            "Level 1 (  512 x   512 pixels,   4 tiles)"
        );
        let CatalogEntryDto::ImageRequest(request) = &dto.entries[1] else {
            panic!("deferred entries project to image requests");
        };
        assert_eq!(request.title, None);
        assert_eq!(request.uri, "https://fixtures.test/manifest");

        assert_eq!(dto.entries.len(), 2);
    }
}
