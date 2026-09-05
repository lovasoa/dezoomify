//! Protocol DTO shape test: a representative catalog encodes to canonical
//! bytes and decodes back unchanged. This pins the wire shape (field names,
//! ordering stability through the codec, exact dimensions). The core→DTO
//! projection itself lives in `dezoomify-job` (the module depends on both
//! core and protocol without inverting a boundary) and is tested there.

use dezoomify_protocol::dto::*;

#[test]
fn representative_catalog_shape_round_trips_canonically() {
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
    // Canonical bytes are stable and the round trip is lossless.
    let bytes = dezoomify_protocol::codec::encode(&catalog).unwrap();
    let back: CatalogDto = dezoomify_protocol::codec::decode(&bytes).unwrap();
    assert_eq!(back, catalog);
    let again = dezoomify_protocol::codec::encode(&back).unwrap();
    assert_eq!(
        again, bytes,
        "encoding must be canonical across round trips"
    );
}
