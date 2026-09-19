//! Portable format coverage: each implemented format is reachable through
//! automatic discovery, page adapters follow their metadata, and malformed
//! metadata is rejected. Exact tile URL spelling lives in E2E, not here.

use dezoomify_core::core::discovery::{DiscoveryError, ResourceResponse};
use dezoomify_core::core::{CatalogEntry, ImageCatalog, Registry, default_registry};

type Resource<'a> = (&'a str, &'a [u8]);

macro_rules! coverage_fixture {
    ($path:literal) => {
        include_bytes!(concat!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/coverage/", $path))
    };
}

fn discover(input: &str, resources: &[Resource<'_>]) -> Result<ImageCatalog, DiscoveryError> {
    discover_with(default_registry(input), input, resources)
}

fn discover_with(
    registry: Registry,
    input: &str,
    resources: &[Resource<'_>],
) -> Result<ImageCatalog, DiscoveryError> {
    let mut operation = registry.start(input);
    loop {
        let Some(need) = operation.next_priority_need()? else {
            return operation.finish();
        };
        let Some(bytes) = resources
            .iter()
            .find(|(uri, _)| *uri == need.request.uri)
            .map(|(_, bytes)| *bytes)
        else {
            return Err(DiscoveryError::Session(format!(
                "test fixture does not provide requested resource: {}",
                need.request.uri
            )));
        };
        operation.provide(ResourceResponse::new(need.id, bytes))?;
    }
}

fn ready_image(catalog: ImageCatalog) -> dezoomify_core::core::ImageDescriptor {
    match catalog.into_entries().into_iter().next() {
        Some(CatalogEntry::Ready(image)) => image,
        Some(CatalogEntry::Deferred(image)) => {
            panic!("expected a ready image, got deferred URI {}", image.uri)
        }
        None => panic!("expected one image"),
    }
}

#[test]
fn automatic_discovery_selects_every_ready_format() {
    let cases: &[(&str, &[Resource<'_>], &str)] = &[
        (
            "https://fixtures.test/tiles.yaml",
            &[ (
                "https://fixtures.test/tiles.yaml",
                include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/tiles.yaml"),
            ) ],
            "custom",
        ),
        (
            "https://fixtures.test/zoomify/ImageProperties.xml",
            &[ (
                "https://fixtures.test/zoomify/ImageProperties.xml",
                br#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" VERSION="1.8" TILESIZE="256" />"#,
            ) ],
            "zoomify",
        ),
        (
            "https://fixtures.test/iiif/info.json",
            &[ (
                "https://fixtures.test/iiif/info.json",
                coverage_fixture!("iiif/v3-info.json"),
            ) ],
            "iiif",
        ),
        (
            "https://fixtures.test/deepzoom/sample.dzi",
            &[ (
                "https://fixtures.test/deepzoom/sample.dzi",
                br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512" /></Image>"#,
            ) ],
            "deepzoom",
        ),
        (
            "https://fixtures.test/krpano/pano.xml",
            &[ (
                "https://fixtures.test/krpano/pano.xml",
                br#"<krpano><image tilesize="256"><level tiledimagewidth="512" tiledimageheight="512"><front url="tiles/l%l/%v_%h.jpg" /></level></image></krpano>"#,
            ) ],
            "krpano",
        ),
        (
            "https://fixtures.test/second-canvas/modern.json",
            &[ (
                "https://fixtures.test/second-canvas/modern.json",
                include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/second_canvas/modern.json"),
            ) ],
            "second_canvas",
        ),
        (
            "https://fixtures.test/iip?FIF=/image.tif",
            &[ (
                "https://fixtures.test/iip?FIF=/image.tif&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number",
                b"Max-size:512 512\nTile-size:256 256\nResolution-number:2",
            ) ],
            "iipimage",
        ),
    ];
    for (input, resources, format) in cases {
        assert_eq!(
            ready_image(discover(input, resources).unwrap()).format,
            *format
        );
    }

    let generic =
        ready_image(discover("https://fixtures.test/tiles/{{X}}_{{Y}}.jpg", &[]).unwrap());
    assert_eq!(generic.format, "generic");

    let input = "https://artsandculture.google.com/asset/test";
    let mut operation = default_registry(input).start(input);
    let page = operation.next_priority_need().unwrap().unwrap();
    operation
        .provide(ResourceResponse::new(
            page.id,
            include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/google_arts_and_culture/page_source.html"),
        ))
        .unwrap();
    let tile_info = operation.next_priority_need().unwrap().unwrap();
    operation
        .provide(ResourceResponse::new(
            tile_info.id,
            include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/google_arts_and_culture/tile_info.xml"),
        ))
        .unwrap();
    assert_eq!(
        ready_image(operation.finish().unwrap()).format,
        "google_arts_and_culture"
    );

    let catalog = discover(
        "https://fixtures.test/list.txt",
        &[(
            "https://fixtures.test/list.txt",
            b"https://example.test/image.dzi",
        )],
    )
    .unwrap();
    let [CatalogEntry::Deferred(_)] = catalog.entries() else {
        panic!("bulk text must produce a deferred entry");
    };
}

#[test]
fn second_canvas_viewer_page_follows_its_js_configuration() {
    let viewer = "https://fixtures.test/second-canvas/web/index.html?js=metadata%2Fmodern.json";
    let metadata = "https://fixtures.test/second-canvas/web/metadata/modern.json";
    let image = ready_image(
        discover(
            viewer,
            &[
                (
                    viewer,
                    include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/second_canvas/viewer.html"),
                ),
                (
                    metadata,
                    include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/second_canvas/modern.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format, "second_canvas");
}

#[test]
fn automatic_discovery_selects_part_three_formats() {
    let cases: &[(&str, &[Resource<'_>], &str)] = &[
        (
            "https://fixtures.test/xl/sample.imgi?cmd=info",
            &[(
                "https://fixtures.test/xl/sample.imgi?cmd=info",
                coverage_fixture!("xlimage/sample.imgi.xml"),
            )],
            "xlimage",
        ),
        (
            "https://fixtures.test/topviewer/data.json",
            &[(
                "https://fixtures.test/topviewer/data.json",
                coverage_fixture!("topviewer/data.json"),
            )],
            "topviewer",
        ),
        (
            "https://fixtures.test/fsi/server?type=info&source=image",
            &[(
                "https://fixtures.test/fsi/server?type=info&source=image",
                coverage_fixture!("fsi/info.txt"),
            )],
            "fsi",
        ),
        (
            "https://fixtures.test/lizardtech/iserv/calcrgn?item=image",
            &[(
                "https://fixtures.test/lizardtech/iserv/calcrgn?item=image",
                coverage_fixture!("lizardtech/calcrgn.xml"),
            )],
            "lizardtech",
        ),
        (
            "https://fixtures.test/vls/zoom/1",
            &[(
                "https://fixtures.test/vls/zoom/1",
                coverage_fixture!("vls/zoom.html"),
            )],
            "vls",
        ),
        (
            "https://fixtures.test/hungaricana/imagesize/sample.ecw",
            &[(
                "https://fixtures.test/hungaricana/imagesize/sample.ecw",
                coverage_fixture!("hungaricana/sample.ecw.json"),
            )],
            "hungaricana",
        ),
        (
            "https://fixtures.test/wmts/WMTSCapabilities.xml",
            &[(
                "https://fixtures.test/wmts/WMTSCapabilities.xml",
                coverage_fixture!("wmts/WMTSCapabilities.xml"),
            )],
            "wmts",
        ),
        (
            "https://fixtures.test/arcgis/MapServer",
            &[(
                "https://fixtures.test/arcgis/MapServer?f=json",
                coverage_fixture!("arcgis/MapServer.json"),
            )],
            "arcgis",
        ),
        (
            "https://fixtures.test/arcgis/viewer?basemapUrl=https%3A%2F%2Ffixtures.test%2Farcgis%2FMapServer%3Ftoken%3Dfixture",
            &[(
                "https://fixtures.test/arcgis/MapServer?token=fixture&f=json",
                coverage_fixture!("arcgis/MapServer.json"),
            )],
            "arcgis",
        ),
        (
            "https://fixtures.test/entity/OBJECT/1",
            &[
                (
                    "https://fixtures.test/entity/OBJECT/1",
                    coverage_fixture!("pnav/page.html"),
                ),
                (
                    "https://fixtures.test/fixtures/pnav/image.json",
                    coverage_fixture!("pnav/image.json"),
                ),
            ],
            "pnav",
        ),
    ];

    for (input, resources, format) in cases {
        assert_eq!(
            ready_image(discover(input, resources).unwrap()).format,
            *format
        );
    }
}

#[test]
fn part_three_malformed_metadata_is_rejected() {
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
        assert!(
            discover(input, resources).is_err(),
            "{label} accepted malformed metadata"
        );
    }
}
