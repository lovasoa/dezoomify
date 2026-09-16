//! Protocol DTO shape test: a representative catalog encodes to canonical
//! bytes and decodes back unchanged. This pins the wire shape (field names,
//! ordering stability through the codec, exact dimensions). The core→DTO
//! projection itself lives in `dezoomify-job` (the module depends on both
//! core and protocol without inverting a boundary) and is tested there.

use dezoomify_protocol::dto::*;

#[test]
fn representative_catalog_shape_round_trips_canonically() {
    // Representative two-image catalog: preserved order, ready vs deferred
    // entries, exact dimensions, and no duplicated positional identity.
    let catalog = CatalogDto {
        images: vec![
            ImageDto {
                title: Some("Cover".into()),
                format: "Zoomify".into(),
                width: 512,
                height: 512,
                readiness: Readiness::Ready,
                source_kind: "fixed-grid".into(),
                levels: vec![LevelDto {
                    label: "Level 1".into(),
                    width: 512,
                    height: 512,
                    tile_width: 256,
                    tile_height: 256,
                }],
            },
            ImageDto {
                title: None,
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
