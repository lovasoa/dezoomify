//! Pure Google Arts & Culture two-stage discovery.

use crate::Vec2d;
use crate::core::discovery::{metadata, url_matches, url_suffix, viewer};
use crate::core::{
    DiscoveryError, DiscoveryResource, DiscoveryRoute, FormatSpec, Grid, ImagePlan, ParsedResource,
    ProcessingRecipe, Request, ResolvedLevel,
};
use std::sync::Arc;
use tile_info::{PageInfo, TileInfo};
pub(crate) mod decryption;
mod tile_info;
mod url;

const ROUTES: &[DiscoveryRoute] = &[
    metadata(url_suffix("=g")).child_metadata(parse_tile_information),
    viewer(url_matches(is_google_arts_url)).extract_metadata(parse_page),
];

pub const SPEC: FormatSpec =
    FormatSpec::new("google_arts_and_culture", ROUTES).with_display_name("Arts & Culture");

fn is_google_arts_url(uri: &str) -> bool {
    uri.contains("artsandculture.google.com") || uri.contains("g.co/arts/")
}

fn parse_page(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let source = std::str::from_utf8(resource.bytes())
        .map_err(|error| DiscoveryError::InvalidMetadata(error.to_string()))?;
    let page = source
        .parse::<PageInfo>()
        .map_err(|error| DiscoveryError::InvalidMetadata(error.to_string()))?;
    Ok(ParsedResource::Follow(Request::new(page.tile_info_url())))
}

fn parse_tile_information(
    resource: DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let page = resource
        .context()
        .resources()
        .map(DiscoveryResource::bytes)
        .filter_map(|bytes| std::str::from_utf8(bytes).ok())
        .find_map(|source| source.parse::<PageInfo>().ok())
        .map(Arc::new)
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Google Arts page metadata is missing".into())
        })?;
    decode(&page, resource.bytes()).map(ParsedResource::Image)
}

fn decode(page: &Arc<PageInfo>, bytes: &[u8]) -> Result<ImagePlan, DiscoveryError> {
    let TileInfo {
        tile_width,
        tile_height,
        pyramid_level,
        ..
    } = serde_xml_rs::from_reader(bytes).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("invalid Google Arts tile XML: {error}"))
    })?;
    let levels: Vec<_> = pyramid_level
        .into_iter()
        .enumerate()
        .map(|(z, level)| {
            let size = Vec2d {
                x: tile_width * level.num_tiles_x - level.empty_pels_x,
                y: tile_height * level.num_tiles_y - level.empty_pels_y,
            };
            let tile_size = Vec2d {
                x: tile_width,
                y: tile_height,
            };
            let request_page = Arc::clone(page);
            let source = Grid::with_processed_requests(
                size,
                tile_size,
                Vec2d::default(),
                ProcessingRecipe::GoogleArtsDecrypt,
                move |tile| {
                    let cell: Vec2d = tile.coord.into();
                    Request::new(url::compute_url(&request_page, cell.x, cell.y, z))
                },
            )
            .map_err(|error| {
                DiscoveryError::InvalidMetadata(format!("invalid Google Arts grid: {error}"))
            })?;
            Ok(ResolvedLevel::new(source).with_title(Some(page.name.clone())))
        })
        .collect::<Result<Vec<_>, DiscoveryError>>()?;
    Ok(ImagePlan::new(Some(page.name.clone()), levels))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{DiscoveredEntry, DiscoveryCatalog, TileSource};

    fn fixture_catalog() -> DiscoveryCatalog {
        let (catalog, requests) = crate::test_support::discover(
            SPEC,
            "https://artsandculture.google.com/asset/test",
            &[
                (
                    include_bytes!(
                        "../../../../testdata/scenarios/rs-core/formats/payloads/google_arts_and_culture/page_source.html"
                    ),
                    None,
                ),
                (
                    include_bytes!(
                        "../../../../testdata/scenarios/rs-core/formats/payloads/google_arts_and_culture/tile_info.xml"
                    ),
                    None,
                ),
            ],
        );
        assert_eq!(requests.len(), 2);
        assert!(requests[1].uri.ends_with("=g"));
        catalog.unwrap()
    }

    #[test]
    fn discovers_fixture_as_five_replayable_levels() {
        let catalog = fixture_catalog();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("Google Arts produces one ready image");
        };
        assert_eq!(image.levels.len(), 5);
        // Level names must carry the page title, as they did before the core refactor.
        assert!(
            image
                .levels
                .iter()
                .all(|level| level.title.as_deref() == Some(image.title.as_deref().unwrap_or("")))
        );
        assert!(image.levels.iter().enumerate().all(|(position, level)| {
            level
                .display_label(position)
                .contains("©Designers Anonymes")
        }));
        assert!(
            image
                .levels
                .windows(2)
                .all(|levels| levels[0].source.image_size().unwrap().area()
                    <= levels[1].source.image_size().unwrap().area())
        );
        let TileSource::Grid(plan) = &image.levels[0].source else {
            panic!("Google Arts geometry is a grid");
        };
        let tile = plan.tiles_row_major().next().unwrap().unwrap();
        assert_eq!(tile.processing, ProcessingRecipe::GoogleArtsDecrypt);
    }

    #[test]
    fn rejects_non_google_urls_without_requesting_data() {
        let (result, requests) =
            crate::test_support::discover(SPEC, "https://example.com/test", &[]);
        assert!(matches!(
            result,
            Err(DiscoveryError::NoCandidateAccepted { .. })
        ));
        assert!(requests.is_empty());
    }

    #[test]
    fn does_not_advertise_tile_metadata_without_the_required_page_context() {
        let (result, requests) = crate::test_support::discover(
            SPEC,
            "https://lh3.googleusercontent.com/image-id=g",
            &[],
        );
        assert!(matches!(
            result,
            Err(DiscoveryError::NoCandidateAccepted { .. })
        ));
        assert!(requests.is_empty());
    }

    #[test]
    fn recognizes_google_arts_short_urls() {
        let (_, requests) = crate::test_support::discover(SPEC, "https://g.co/arts/fixture", &[]);
        assert_eq!(requests[0].uri, "https://g.co/arts/fixture");
    }

    #[test]
    fn catalog_preserves_page_identity_and_tile_geometry() {
        let catalog = fixture_catalog();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("Google Arts produces one ready image");
        };
        assert_eq!(image.format, "google_arts_and_culture");
        assert_eq!(image.title.as_deref(), Some("©Designers Anonymes"));

        let level = image.levels.last().expect("largest level");
        assert_eq!(level.source.image_size(), Some(Vec2d { x: 5436, y: 4080 }));
        assert_eq!(level.source.tile_size(), Some(Vec2d { x: 512, y: 512 }));
        let TileSource::Grid(plan) = &level.source else {
            panic!("Google Arts geometry is a grid");
        };
        assert_eq!(plan.count(), 88);
        let tiles: Vec<_> = plan.tiles_row_major().map(Result::unwrap).collect();
        let first = &tiles[0];
        assert_eq!(first.destination, Vec2d::default());
        assert_eq!(first.expected_size, Some(Vec2d { x: 512, y: 512 }));
        assert!(first.request.uri.contains("=x0-y0-z4-t"));
        assert_eq!(first.processing, ProcessingRecipe::GoogleArtsDecrypt);
        let last = &tiles[87];
        assert_eq!(last.destination, Vec2d { x: 5120, y: 3584 });
        assert_eq!(last.expected_size, Some(Vec2d { x: 316, y: 496 }));
        assert!(last.request.uri.contains("=x10-y7-z4-t"));
    }

    #[test]
    fn invalid_tile_information_is_reported_as_a_parser_error() {
        let (result, _) = crate::test_support::discover(
            SPEC,
            "https://artsandculture.google.com/asset/test",
            &[
                (
                    include_bytes!(
                        "../../../../testdata/scenarios/rs-core/formats/payloads/google_arts_and_culture/page_source.html"
                    ),
                    None,
                ),
                (b"<invalid>not a tile info</invalid>", None),
            ],
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("invalid Google Arts tile XML")
        );
    }
}
