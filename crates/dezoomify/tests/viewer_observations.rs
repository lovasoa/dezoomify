mod support;

use dezoomify::core::default_registry;
use dezoomify::core::discovery::{DiscoveryInput, DiscoveryLimits};
use dezoomify::model::{DiscoveryInputKind, Size, ViewerLevel, ViewerObservation, ViewerPyramid};

fn observation() -> ViewerObservation {
    ViewerObservation {
        dezoomify_viewer: ViewerPyramid {
            source_url: "https://museum.test/art".into(),
            resource_base: "https://museum.test/art#dezoomify-viewer-tile/123/image".into(),
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
            .with_kind(DiscoveryInputKind::ObservedMetadata),
        ],
        DiscoveryLimits::default(),
        |_| panic!("complete observations must not fetch metadata"),
    )
    .0
}

#[test]
fn live_grids_share_edge_geometry_and_keep_the_viewer_canonical() {
    let image = support::ready_image(discover(observation()).unwrap());
    assert_eq!(image.source_url.as_deref(), Some("https://museum.test/art"));
    let urls = support::tile_urls(&image.levels[0]).unwrap();
    assert_eq!(urls.len(), 9);
    assert_eq!(
        urls[8],
        "https://museum.test/art#dezoomify-viewer-tile/123/image/7/2/2/1/1.png"
    );
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
            "foreign" => {
                pyramid.resource_base = "https://other.test/#dezoomify-viewer-tile/123/image".into()
            }
            "capability" => {
                pyramid.resource_base = "https://museum.test/art#dezoomify-viewer-tile/".into()
            }
            _ => pyramid.levels = vec![pyramid.levels[0].clone(); 65],
        }
        assert!(discover(observation).is_err(), "{invalid}");
    }
}
