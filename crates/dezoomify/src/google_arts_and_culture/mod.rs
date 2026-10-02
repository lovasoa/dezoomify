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
    Ok(ParsedResource::Follow(Request::new(
        page_info(resource)?.tile_info_url(),
    )))
}

fn page_info(resource: DiscoveryResource<'_>) -> Result<PageInfo, DiscoveryError> {
    let source = std::str::from_utf8(resource.bytes())
        .map_err(|error| DiscoveryError::InvalidMetadata(error.to_string()))?;
    let mut page = source
        .parse::<PageInfo>()
        .map_err(|error| DiscoveryError::InvalidMetadata(error.to_string()))?;
    // The viewer supplies a protocol-relative URL; resolve its scheme from
    // the actual page rather than forcing HTTPS on HTTP image servers.
    page.base_url = crate::core::resolve_relative(resource.final_uri(), &page.base_url[6..]);
    Ok(page)
}

fn parse_tile_information(
    resource: DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let page = resource
        .context()
        .resources()
        .find_map(|resource| page_info(resource).ok())
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
            // A page without a signing path cannot tile; reject it once
            // here instead of failing per tile.
            let sign_path = page
                .path()
                .map_err(|error| DiscoveryError::InvalidMetadata(error.to_string()))?
                .to_owned();
            let request_page = Arc::clone(page);
            let source = Grid::with_processed_requests(
                size,
                tile_size,
                Vec2d::default(),
                ProcessingRecipe::GoogleArtsDecrypt,
                move |tile| {
                    let cell: Vec2d = tile.coord.into();
                    Request::new(url::compute_url(
                        &request_page,
                        &sign_path,
                        url::TileCoord {
                            x: cell.x,
                            y: cell.y,
                            z,
                        },
                    ))
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

    const PAGE: &[u8] = include_bytes!(
        "../../../../testdata/scenarios/rs-core/formats/payloads/google_arts_and_culture/page_source.html"
    );
    const TILE_INFO: &[u8] = include_bytes!(
        "../../../../testdata/scenarios/rs-core/formats/payloads/google_arts_and_culture/tile_info.xml"
    );

    fn fixture_catalog() -> DiscoveryCatalog {
        let (catalog, requests) = crate::test_support::discover(
            SPEC,
            "https://artsandculture.google.com/asset/test",
            &[(PAGE, None), (TILE_INFO, None)],
        );
        assert_eq!(requests.len(), 2);
        assert!(requests[1].uri.ends_with("=g"));
        catalog.unwrap()
    }

    #[test]
    fn fixture_preserves_identity_levels_and_tile_geometry() {
        let catalog = fixture_catalog();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("Google Arts produces one ready image");
        };
        assert_eq!(image.format, "google_arts_and_culture");
        assert_eq!(image.title.as_deref(), Some("©Designers Anonymes"));
        assert_eq!(image.levels.len(), 5);
        // Level names must carry the page title, as they did before the core refactor.
        assert!(
            image
                .levels
                .iter()
                .all(|level| level.title.as_deref() == Some("©Designers Anonymes"))
        );
        assert!(image.levels.iter().enumerate().all(|(position, level)| {
            level
                .display_label(position)
                .contains("©Designers Anonymes")
        }));
        let areas: Vec<_> = image
            .levels
            .iter()
            .map(|level| level.source.image_size().unwrap().area())
            .collect();
        assert!(areas.windows(2).all(|pair| pair[0] <= pair[1]));

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
    fn rejects_urls_without_the_required_google_context() {
        for input in [
            "https://example.com/test",
            "https://lh3.googleusercontent.com/image-id=g",
        ] {
            let (result, requests) = crate::test_support::discover(SPEC, input, &[]);
            assert!(
                matches!(result, Err(DiscoveryError::NoCandidateAccepted { .. })),
                "{input}"
            );
            assert!(requests.is_empty(), "{input}");
        }
    }

    #[test]
    fn recognizes_google_arts_short_urls() {
        let (_, requests) = crate::test_support::discover(SPEC, "https://g.co/arts/fixture", &[]);
        assert_eq!(requests[0].uri, "https://g.co/arts/fixture");
    }

    #[test]
    fn invalid_tile_information_is_reported_as_a_parser_error() {
        let (result, _) = crate::test_support::discover(
            SPEC,
            "https://artsandculture.google.com/asset/test",
            &[(PAGE, None), (b"<invalid>not a tile info</invalid>", None)],
        );
        let error = result.unwrap_err().to_string();
        assert!(error.contains("invalid Google Arts tile XML"));
    }
}
