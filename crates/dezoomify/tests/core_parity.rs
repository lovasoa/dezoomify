//! Format-specific geometry, adaptive probing, and malformed metadata.
//! Successful format saves belong to the shared product fixture matrix.

use dezoomify::Vec2d;
use dezoomify::core::discovery::DiscoveryError;
use dezoomify::model::ProbeOutcome;
mod support;
use dezoomify::core::{DiscoveryCatalog, TileSource, default_registry};
use support::{grid, grid_tile_uri, ready_image, resource_uri, tile_urls};

type Resource<'a> = (&'a str, &'a [u8]);

macro_rules! coverage_fixture {
    ($path:literal) => {
        include_bytes!(concat!(
            "../../../testdata/scenarios/rs-core/formats/payloads/coverage/",
            $path
        ))
    };
}

fn discover(input: &str, resources: &[Resource<'_>]) -> Result<DiscoveryCatalog, DiscoveryError> {
    support::discover_resources(default_registry(), input, resources).0
}

#[test]
fn zoomify_group_boundaries_use_cumulative_tile_counts() {
    let input = "https://fixtures.test/zoomify/ImageProperties.xml";
    let metadata = br#"<IMAGE_PROPERTIES WIDTH="4096" HEIGHT="4096" NUMTILES="341" VERSION="1.8" TILESIZE="256" />"#;
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    let urls = tile_urls(image.levels.last().unwrap());
    assert_eq!(urls.len(), 256);
    assert!(urls[170].ends_with("/TileGroup0/4-10-10.jpg"));
    assert!(urls[171].ends_with("/TileGroup1/4-11-10.jpg"));
    assert!(urls[255].ends_with("/TileGroup1/4-15-15.jpg"));
}

#[test]
fn deepzoom_overlap_advances_tile_origins_without_gaps() {
    let input = "https://fixtures.test/deepzoom/overlap.dzi";
    let metadata = br#"<Image TileSize="256" Overlap="1" Format="jpg"><Size Width="512" Height="512" /></Image>"#;
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    let level = image.levels.last().unwrap();
    assert_eq!(grid(level).overlap(), Vec2d::square(1));
    let origins: Vec<_> = grid(level)
        .tiles_row_major()
        .map(|tile| {
            let tile = tile.unwrap();
            (tile.destination.x, tile.destination.y)
        })
        .collect();
    assert_eq!(origins, [(0, 0), (255, 0), (0, 255), (255, 255)]);
}

#[test]
fn iiif_probe_falls_back_to_caret_size_and_preserves_probe_tile() {
    let input = "https://fixtures.test/iiif/bruun-rasmussen/info.json";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("iiif/bruun-rasmussen-info.json"))],
        )
        .unwrap(),
    );
    let level = image
        .levels
        .iter()
        .find(|level| level.scale_factor == Some(1))
        .unwrap();
    let TileSource::Adaptive(source) = &level.source else {
        panic!("IIIF level must use adaptive probing")
    };
    let host = support::MemoryHost::default();
    host.probe_results.borrow_mut().extend([
        ProbeOutcome::Missing,
        ProbeOutcome::Available {
            width: std::num::NonZeroU64::new(256).unwrap(),
            height: std::num::NonZeroU64::new(256).unwrap(),
        },
    ]);
    let resolved = futures::executor::block_on(source.resolve(&host, 2))
        .unwrap()
        .unwrap();
    let probes = host.probes.borrow();
    assert!(resource_uri(&probes[0].source).ends_with("/256,256/0/default.jpg"));
    assert!(resource_uri(&probes[1].source).ends_with("/^256,/0/default.jpg"));
    assert_eq!(resolved.previously_output, [Vec2d::default()]);
    assert_eq!(
        grid_tile_uri(&resolved.grid, 0),
        resource_uri(&probes[1].source)
    );
}

#[test]
fn krpano_explicit_level_expands_tile_coordinates() {
    let input = "https://fixtures.test/krpano/pano.xml";
    let metadata = br#"<krpano><image tilesize="256"><level tiledimagewidth="512" tiledimageheight="512"><front url="tiles/l%l/%v_%h.jpg" /></level></image></krpano>"#;
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    assert_eq!(
        tile_urls(image.levels.last().unwrap()).last().unwrap(),
        "https://fixtures.test/krpano/tiles/l1/2_2.jpg"
    );
}

#[test]
fn arcgis_viewer_preserves_encoded_basemap_credentials() {
    let input = "https://fixtures.test/arcgis/viewer?basemapUrl=https%3A%2F%2Ffixtures.test%2Farcgis%2FMapServer%3Ftoken%3Dfixture";
    let metadata = "https://fixtures.test/arcgis/MapServer?token=fixture&f=json";
    let image = ready_image(
        discover(
            input,
            &[(metadata, coverage_fixture!("arcgis/MapServer.json"))],
        )
        .unwrap(),
    );
    assert_eq!(image.format, "arcgis");
    assert!(tile_urls(image.levels.last().unwrap())[0].ends_with("?token=fixture"));
}

#[test]
fn malformed_metadata_is_rejected() {
    let cases: &[(&str, &[Resource<'_>], &str)] = &[
        (
            "https://fixtures.test/xl/sample.imgi?cmd=info",
            &[(
                "https://fixtures.test/xl/sample.imgi?cmd=info",
                b"<image><width>0</width></image>",
            )],
            "XLimage",
        ),
        (
            "https://fixtures.test/topviewer/data.json",
            &[("https://fixtures.test/topviewer/data.json", b"{}")],
            "TopViewer",
        ),
        (
            "https://fixtures.test/fsi/server?type=info&source=image",
            &[(
                "https://fixtures.test/fsi/server?type=info&source=image",
                b"<property width value=\"512\" />",
            )],
            "FSI",
        ),
        (
            "https://fixtures.test/lizardtech/iserv/calcrgn?item=image",
            &[(
                "https://fixtures.test/lizardtech/iserv/calcrgn?item=image",
                b"<ImageServer />",
            )],
            "LizardTech",
        ),
        (
            "https://fixtures.test/wmts/WMTSCapabilities.xml",
            &[(
                "https://fixtures.test/wmts/WMTSCapabilities.xml",
                b"<Capabilities />",
            )],
            "WMTS",
        ),
        (
            "https://fixtures.test/arcgis/MapServer",
            &[(
                "https://fixtures.test/arcgis/MapServer?f=json",
                coverage_fixture!("arcgis/uncached.json"),
            )],
            "ArcGIS",
        ),
    ];
    for (input, resources, label) in cases {
        // Rejection can trigger fallback reads; missing resources are intentional here.
        let result = support::discover_with(default_registry(), input, |uri| {
            resources
                .iter()
                .find(|(candidate, _)| *candidate == uri)
                .map(|(_, bytes)| bytes.to_vec())
        });
        assert!(result.is_err(), "{label} accepted malformed metadata");
    }
}
