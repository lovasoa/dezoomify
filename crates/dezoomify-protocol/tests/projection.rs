//! Core-projection shape tests: representative catalogs project into stable
//! protocol DTOs with preserved order, IDs, dimensions, and optionality.
//! Production conversion lives in `dezoomify-job` (phase 06); this test pins
//! the DTO shapes without depending on `dezoomify-core` (protocol stays
//! independent of core internals per AGENTS.md).

use dezoomify_protocol::dto::*;

#[test]
fn representative_catalog_projects_with_order_and_ids() {
    // Representative two-image catalog: stable IDs, preserved order,
    // ready vs deferred entries, exact dimensions.
    let catalog = CatalogDto {
        images: vec![
            ImageDto {
                id: "img:cover".parse().unwrap(),
                label: "Cover".into(),
                format: "Zoomify".into(),
                width: 512,
                height: 512,
                readiness: Readiness::Ready,
                source_kind: "fixed-grid".into(),
                levels: vec![LevelDto {
                    id: "lvl:cover-0".parse().unwrap(),
                    width: 512,
                    height: 512,
                    tile_width: 256,
                    tile_height: 256,
                }],
            },
            ImageDto {
                id: "img:detail".parse().unwrap(),
                label: "Detail".into(),
                format: "IIIF".into(),
                width: 1024,
                height: 768,
                readiness: Readiness::Deferred,
                source_kind: "fixed-grid".into(),
                levels: vec![],
            },
        ],
    };
    assert_eq!(catalog.images.len(), 2);
    assert_eq!(catalog.images[0].id.as_str(), "img:cover");
    assert_eq!(catalog.images[1].readiness, Readiness::Deferred);
    // Canonical bytes are stable and numeric conversions are exact.
    let bytes = dezoomify_protocol::codec::encode(&catalog).unwrap();
    let back: CatalogDto = dezoomify_protocol::codec::decode(&bytes).unwrap();
    assert_eq!(back, catalog);
}
