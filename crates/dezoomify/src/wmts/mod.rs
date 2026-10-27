//! Pure discovery for Web Map Tile Service capabilities documents.

use crate::core::discovery::{any, metadata, url_matches};
use crate::core::{DiscoveryError, DiscoveryRoute, FormatSpec, ImagePlan, ParsedResource};

mod capabilities;
mod layer;
mod tilematrix;

const ROUTES: &[DiscoveryRoute] = &[
    metadata(url_matches(is_wmts_url)).decode(decode),
    metadata(any()).try_decode(try_decode),
];

pub const SPEC: FormatSpec = FormatSpec::new("wmts", ROUTES).with_display_name("WMTS");

fn is_wmts_url(uri: &str) -> bool {
    let uri = uri.to_ascii_lowercase();
    let path = uri.split(['?', '#']).next().unwrap_or(&uri);
    (path.contains("wmts") && path.ends_with(".xml"))
        || (uri.contains("service=wmts") && uri.contains("request=getcapabilities"))
}

fn decode(resource: crate::core::DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let (url, bytes) = (resource.final_uri(), resource.bytes());
    let document = capabilities::parse_document(bytes)?;
    decode_document(url, document)
}

fn try_decode(
    resource: crate::core::DiscoveryResource<'_>,
) -> Option<Result<ParsedResource, DiscoveryError>> {
    let document = capabilities::parse_document(resource.bytes()).ok()?;
    capabilities::find_descendant(&document, "TileMatrixSet")?;
    Some(decode_document(resource.final_uri(), document))
}

fn decode_document(
    url: &str,
    document: capabilities::XmlElement,
) -> Result<ParsedResource, DiscoveryError> {
    let context = layer::parse_context(url, &document)?;
    let levels = layer::build_levels(&context)?;
    if levels.is_empty() {
        return Err(DiscoveryError::InvalidMetadata(
            "WMTS has no tile matrices".into(),
        ));
    }
    Ok(ParsedResource::Image(ImagePlan::new(
        Some(context.layer_name),
        levels,
    )))
}

#[cfg(test)]
fn catalog(url: &str, bytes: &[u8]) -> Result<crate::core::DiscoveryCatalog, DiscoveryError> {
    decode(crate::core::DiscoveryResource::new(url, bytes))?.compile("wmts")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vec2d;
    use crate::test_support::{grid, grid_tile_uri, ready_image};

    #[test]
    fn namespaces_links_limits_and_wgs84_bounds_are_handled_together() {
        let xml = include_bytes!("fixtures/linked-limits.xml");
        let image =
            ready_image(catalog("https://example.test/wmts/capabilities.xml", xml).unwrap());
        assert_eq!(image.title.as_deref(), Some("linked-layer"));
        let grid = grid(&image.levels[0]);
        assert_eq!(grid.image_size(), Vec2d::square(256));
        assert_eq!(
            grid_tile_uri(grid, 0),
            "https://example.test/wmts/tiles/default-style/selected/0/1/1.png"
        );
    }

    #[test]
    fn matrix_dimensions_are_used_without_a_layer_bounding_box() {
        let xml = include_bytes!("fixtures/whole-matrix.xml");

        let image =
            ready_image(catalog("https://example.test/wmts/capabilities.xml", xml).unwrap());
        let grid = grid(&image.levels[0]);
        assert_eq!(grid.image_size(), Vec2d { x: 256, y: 768 });
        assert_eq!(grid.count(), 6);
        assert_eq!(
            grid_tile_uri(grid, grid.count() - 1),
            "https://example.test/wmts/tiles/set/level/2/1.jpg"
        );
    }

    #[test]
    fn a_non_default_style_is_kept_in_relative_tile_urls() {
        let xml = include_bytes!("fixtures/night-style.xml");

        let image =
            ready_image(catalog("https://example.test/wmts/capabilities.xml", xml).unwrap());
        let grid = grid(&image.levels[0]);
        assert_eq!(
            grid_tile_uri(grid, 0),
            "https://example.test/wmts/tiles/night/0/0/0.jpg"
        );
    }

    #[test]
    fn unresolved_template_fields_are_rejected() {
        assert!(
            catalog(
                "https://example.test/wmts/capabilities.xml",
                include_bytes!("fixtures/invalid-template.xml"),
            )
            .is_err()
        );
    }

    #[test]
    fn unknown_bounding_box_crs_is_rejected() {
        assert!(
            catalog(
                "https://example.test/wmts/capabilities.xml",
                include_bytes!("fixtures/unknown-crs.xml"),
            )
            .is_err()
        );
    }
}
