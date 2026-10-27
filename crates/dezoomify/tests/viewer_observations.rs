mod support;

use dezoomify::core::default_registry;
use dezoomify::core::discovery::{DiscoveryInput, DiscoveryLimits};
use dezoomify::model::{
    DiscoveryInputKind, Size, TileSource, ViewerLevel, ViewerObservation, ViewerPyramid,
    ViewerTileRequest,
};

fn observation() -> ViewerObservation {
    ViewerObservation {
        dezoomify_viewer: ViewerPyramid {
            source_url: "https://museum.test/art".into(),
            handle: "123".into(),
            levels: vec![ViewerLevel {
                level: 7,
                size: Size {
                    width: 513,
                    height: 257,
                },
                tile_size: Size {
                    width: 256,
                    height: 128,
                },
                overlap: Size {
                    width: 0,
                    height: 0,
                },
                grid_size: Size {
                    width: 3,
                    height: 3,
                },
            }],
        },
    }
}

fn discover(
    observation: ViewerObservation,
) -> Result<dezoomify::core::DiscoveryCatalog, dezoomify::core::DiscoveryError> {
    support::discover_inputs(
        default_registry(),
        vec![
            DiscoveryInput::with_contents(
                "https://museum.test/art#observed",
                serde_json::to_vec(&observation).unwrap(),
            )
            .with_kind(DiscoveryInputKind::ObservedViewer),
        ],
        DiscoveryLimits::default(),
        |_| panic!("complete observations must not fetch metadata"),
    )
    .0
}

#[test]
fn live_grids_share_edge_geometry_and_keep_the_viewer_canonical() {
    let image = support::ready_image(discover(observation()).unwrap());
    assert_eq!(image.format, "viewer");
    assert_eq!(image.source_url.as_deref(), Some("https://museum.test/art"));
    let dezoomify::core::TileSource::Grid(grid) = &image.levels[0].source else {
        panic!("viewer grid")
    };
    let tiles = grid
        .tiles_row_major()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(tiles.len(), 9);
    assert_eq!(
        tiles[8].source,
        TileSource::Viewer(ViewerTileRequest {
            handle: "123".into(),
            source_url: "https://museum.test/art".into(),
            level: 7,
            column: 2,
            row: 2,
        })
    );
    assert_eq!(
        tiles[8].expected_size,
        Some(dezoomify::Vec2d { x: 1, y: 1 })
    );
}

#[test]
fn complete_format_metadata_keeps_loader_only_siblings_without_fetching() {
    let (catalog, requests) = support::discover_inputs(
        default_registry(),
        vec![
            DiscoveryInput::with_contents(
                "https://museum.test/art#observed",
                serde_json::to_vec(&observation()).unwrap(),
            )
            .with_kind(DiscoveryInputKind::ObservedViewer),
            DiscoveryInput::with_contents(
                "https://museum.test/image/info.json",
                include_bytes!("../../../fixtures/iiif/v3/info.json").to_vec(),
            )
            .with_kind(DiscoveryInputKind::ObservedMetadata),
        ],
        Default::default(),
        |_| panic!("complete snapshots must not fetch"),
    );
    let catalog = catalog.unwrap();
    assert_eq!(catalog.len(), 2);
    assert!(
        matches!(&catalog.entries()[0], dezoomify::core::DiscoveredEntry::Ready(image) if image.format == "iiif")
    );
    assert!(
        matches!(&catalog.entries()[1], dezoomify::core::DiscoveredEntry::Ready(image) if image.format == "viewer")
    );
    assert!(requests.is_empty());
}

#[test]
fn recognized_metadata_precedes_a_live_loader_and_failure_keeps_the_loader_available() {
    for (uri, available) in [
        ("https://museum.test/image/info.json", true),
        ("https://museum.test/iipsrv?IIIF=/image.tif/info.json", true),
        ("https://museum.test/image/info.json", false),
    ] {
        let (result, requests) = support::discover_inputs(
            default_registry(),
            vec![
                DiscoveryInput::with_contents(
                    "https://museum.test/art#observed",
                    serde_json::to_vec(&observation()).unwrap(),
                )
                .with_kind(DiscoveryInputKind::ObservedViewer),
                DiscoveryInput::new(uri).with_kind(DiscoveryInputKind::ObservedResource),
            ],
            Default::default(),
            |request| {
                assert_eq!(request, uri);
                available.then(|| {
                    Ok((
                        include_bytes!("../../../fixtures/iiif/v3/info.json").to_vec(),
                        None,
                    ))
                })
            },
        );
        let image = support::ready_image(result.unwrap());
        assert_eq!(image.format, if available { "iiif" } else { "viewer" });
        assert_eq!(requests.len(), 1);
    }
}

#[test]
fn inconsistent_or_unbounded_observations_are_rejected() {
    for invalid in [
        "grid",
        "size",
        "duplicates",
        "foreign",
        "capability",
        "levels",
    ] {
        let mut observation = observation();
        let pyramid = &mut observation.dezoomify_viewer;
        match invalid {
            "grid" => pyramid.levels[0].grid_size.width = 2,
            "size" => pyramid.levels[0].tile_size.height = 0,
            "duplicates" => pyramid.levels.push(pyramid.levels[0].clone()),
            "foreign" => pyramid.source_url = "file:///private".into(),
            "capability" => pyramid.handle = "https://museum.test/art".into(),
            _ => pyramid.levels = vec![pyramid.levels[0].clone(); 65],
        }
        assert!(discover(observation).is_err(), "{invalid}");
    }
}
