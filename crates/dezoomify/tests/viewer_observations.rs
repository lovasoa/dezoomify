mod support;

use dezoomify::core::default_registry;
use dezoomify::core::discovery::{DiscoveryInput, DiscoveryLimits};
use dezoomify::model::{
    DiscoveryInputKind, Interaction, ResourceRead, ResourceResponse, Size, TileSource, ViewerLevel,
    ViewerPyramid, ViewerTileRequest,
};
use std::cell::RefCell;

const PAGE: &str = "https://museum.test/art";

fn pyramid() -> ViewerPyramid {
    ViewerPyramid {
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
    }
}

fn typed(url: &str, pyramid: ViewerPyramid) -> DiscoveryInput {
    DiscoveryInput {
        url: url.into(),
        contents: None,
        kind: DiscoveryInputKind::ObservedViewer,
        viewer: Some(pyramid),
    }
}

fn discover(
    pyramid: ViewerPyramid,
) -> Result<dezoomify::core::DiscoveryCatalog, dezoomify::core::DiscoveryError> {
    discover_at(PAGE, pyramid)
}

fn discover_at(
    url: &str,
    pyramid: ViewerPyramid,
) -> Result<dezoomify::core::DiscoveryCatalog, dezoomify::core::DiscoveryError> {
    support::discover_inputs(
        default_registry(),
        vec![typed(url, pyramid)],
        DiscoveryLimits::default(),
        |_| panic!("complete observations must not fetch metadata"),
    )
    .0
}

#[test]
fn viewers_on_one_page_stay_distinct_and_duplicates_do_not_add_choices() {
    let mut second = pyramid();
    second.handle = "456".into();
    let (catalog, requests) = support::discover_inputs(
        default_registry(),
        vec![
            typed(PAGE, pyramid()),
            typed(PAGE, second),
            typed(PAGE, pyramid()),
        ],
        DiscoveryLimits::default(),
        |uri| panic!("typed observations must not fetch: {uri}"),
    );
    let catalog = catalog.unwrap();
    assert_eq!(catalog.len(), 2);
    assert!(
        catalog
            .entries()
            .iter()
            .all(|entry| matches!(entry, dezoomify::core::DiscoveredEntry::Ready(image) if image.format == "viewer"))
    );
    assert!(requests.is_empty());
}

#[test]
fn live_grids_share_edge_geometry_and_keep_the_viewer_canonical() {
    let image = support::ready_image(discover(pyramid()).unwrap());
    assert_eq!(image.format, "viewer");
    assert_eq!(image.source_url.as_deref(), Some(PAGE));
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
            source_url: PAGE.into(),
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
            typed(PAGE, pyramid()),
            DiscoveryInput::new("https://museum.test/image/info.json")
                .with_kind(DiscoveryInputKind::ObservedResource),
            DiscoveryInput::new("https://museum.test/image/0,0,256,256/256,256/0/default.png")
                .with_kind(DiscoveryInputKind::ObservedResource),
            DiscoveryInput::new("https://museum.test/image/256,0,256,256/256,256/0/default.png")
                .with_kind(DiscoveryInputKind::ObservedResource),
            DiscoveryInput::with_contents(
                "https://museum.test/image/info.json",
                include_str!("../../../fixtures/iiif/v3/info.json")
                    .replace("{{origin}}/fixtures/iiif/v3", "https://museum.test/image"),
            )
            .with_kind(DiscoveryInputKind::ObservedMetadata),
        ],
        Default::default(),
        |uri| panic!("complete snapshots must not fetch: {uri}"),
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
fn live_sources_precede_weak_resource_reads() {
    let metadata = DiscoveryInput::with_contents(
        "https://museum.test/art#metadata",
        include_bytes!("../../../fixtures/deepzoom/basic/image.dzi"),
    )
    .with_kind(DiscoveryInputKind::ObservedMetadata);
    let viewer = typed(PAGE, pyramid());
    for (expected, live) in [
        ("deepzoom", Some(metadata)),
        ("viewer", Some(viewer)),
        ("vls", None),
    ] {
        let available = live.is_some();
        let reads = RefCell::new(Vec::new());
        let registry = default_registry();
        let catalog = futures::executor::block_on(registry.discover(
            vec![
                DiscoveryInput::with_contents("https://museum.test/page", "<html></html>"),
                DiscoveryInput::new("https://museum.test/zoom/1")
                    .with_kind(DiscoveryInputKind::ObservedResource),
            ],
            Default::default(),
            |request, interaction| {
                assert_eq!(interaction, Interaction::Forbidden);
                reads.borrow_mut().push(request.uri);
                async {
                    Ok(ResourceRead::Response {
                        response: ResourceResponse {
                            bytes: include_bytes!(
                                "../../../fixtures/vls/approximate-basic/zoom/1.html"
                            )
                            .to_vec(),
                            final_uri: None,
                        },
                    })
                }
            },
            support::parse_html,
            |interaction| {
                assert_eq!(interaction, Interaction::Forbidden);
                let inputs = live.clone().into_iter().collect();
                async move { Ok(inputs) }
            },
        ))
        .unwrap();
        assert_eq!(support::ready_image(catalog).format, expected);
        assert_eq!(
            *reads.borrow(),
            if available {
                vec![]
            } else {
                vec!["https://museum.test/zoom/1"]
            }
        );
    }
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
                typed(PAGE, pyramid()),
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
        let mut pyramid = pyramid();
        match invalid {
            "grid" => pyramid.levels[0].grid_size.width = 2,
            "size" => pyramid.levels[0].tile_size.height = 0,
            "duplicates" => pyramid.levels.push(pyramid.levels[0].clone()),
            "foreign" => {
                assert!(
                    discover_at("file:///private", pyramid.clone()).is_err(),
                    "{invalid}"
                );
                continue;
            }
            "capability" => pyramid.handle = PAGE.into(),
            _ => pyramid.levels = vec![pyramid.levels[0].clone(); 65],
        }
        assert!(discover(pyramid).is_err(), "{invalid}");
    }
}
