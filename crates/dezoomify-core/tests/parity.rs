//! Portable format coverage cases for the implemented dezoomers.
//!
//! The browser suite exercises page adapters which are intentionally outside
//! the current core boundary. These cases cover the same dezoomers when given
//! their metadata URL or metadata bytes directly.

use dezoomify_core::Vec2d;
use dezoomify_core::core::discovery::{
    DiscoveryError, DiscoveryOperation, RequestId, ResourceResponse,
};
use dezoomify_core::core::{
    CatalogEntry, DiscoverableGrid, DiscoverableStep, Grid, ImageCatalog, ImageDescriptor,
    LevelDescriptor, ObservationResult, Registry, TileSource, default_registry,
};

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

fn ready_image(catalog: ImageCatalog) -> ImageDescriptor {
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
            ready_image(discover(input, resources).unwrap())
                .format
                .as_str(),
            *format
        );
    }

    let generic =
        ready_image(discover("https://fixtures.test/tiles/{{X}}_{{Y}}.jpg", &[]).unwrap());
    assert_eq!(generic.format.as_str(), "generic");

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
        ready_image(operation.finish().unwrap()).format.as_str(),
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
    let [CatalogEntry::Deferred(image)] = catalog.entries() else {
        panic!("bulk text must produce a deferred entry");
    };
    assert_eq!(image.id.as_str(), "bulk:0");
}

fn grid(level: &LevelDescriptor) -> &Grid {
    match &level.source {
        TileSource::Grid(grid) => grid,
        source => panic!("expected a rectangular grid, got {source:?}"),
    }
}

fn tile_urls(level: &LevelDescriptor) -> Vec<String> {
    grid(level)
        .tiles_row_major()
        .map(|tile| tile.unwrap().request.uri)
        .collect()
}

#[test]
fn dezoomer_zoomify_metadata_and_tile_cases() {
    let metadata = br#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" VERSION="1.8" TILESIZE="256" />"#;
    let input = "https://fixtures.test/zoomify/ImageProperties.xml";
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    assert_eq!(image.format.as_str(), "zoomify");
    assert_eq!(
        image.levels.last().unwrap().source.image_size(),
        Some(Vec2d::square(512))
    );
    assert!(
        tile_urls(image.levels.last().unwrap())
            .iter()
            .any(|url| url.ends_with("/TileGroup0/1-1-1.jpg"))
    );

    let tile_input = "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg";
    let metadata_input = "https://fixtures.test/zoomify/ImageProperties.xml";
    let image = ready_image(discover(tile_input, &[(metadata_input, metadata)]).unwrap());
    assert_eq!(image.format.as_str(), "zoomify");
    assert_eq!(
        image.levels.last().unwrap().source.image_size(),
        Some(Vec2d::square(512))
    );
}

#[test]
fn dezoomer_zoomify_tile_group_and_full_resolution_cases() {
    let input = "https://fixtures.test/zoomify/multiple-groups/ImageProperties.xml";
    let metadata = br#"<IMAGE_PROPERTIES WIDTH="4096" HEIGHT="4096" NUMTILES="341" VERSION="1.8" TILESIZE="256" />"#;
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    let urls = tile_urls(image.levels.last().unwrap());
    assert_eq!(urls.len(), 256);
    assert_eq!(
        urls[170],
        "https://fixtures.test/zoomify/multiple-groups/TileGroup0/4-10-10.jpg"
    );
    assert_eq!(
        urls[171],
        "https://fixtures.test/zoomify/multiple-groups/TileGroup1/4-11-10.jpg"
    );
    assert_eq!(
        urls.last().unwrap(),
        "https://fixtures.test/zoomify/multiple-groups/TileGroup1/4-15-15.jpg"
    );

    let input = "https://fixtures.test/zoomify-full-numtiles/ImageProperties.xml";
    let metadata = br#"<IMAGE_PROPERTIES WIDTH="10240" HEIGHT="1792" NUMTILES="280" VERSION="1.8" TILESIZE="256" />"#;
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    let urls = tile_urls(image.levels.last().unwrap());
    assert_eq!(urls.len(), 280);
    assert!(urls.iter().all(|url| url.contains("/TileGroup0/6-")));
    assert!(urls.iter().any(|url| url.ends_with("/6-16-6.jpg")));
}

#[test]
fn dezoomer_ngv_viewer_page_case() {
    let input = "https://www.ngv.vic.gov.au/explore/collection/work/3867/";
    let image = ready_image(
        discover(
            input,
            &[
                (input, coverage_fixture!("zoomify/ngv.html")),
                (
                    "https://www.ngv.vic.gov.au/zoomify/ImageProperties.xml",
                    coverage_fixture!("zoomify/ngv-ImageProperties.xml"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "zoomify");
    assert!(
        tile_urls(image.levels.last().unwrap())
            .iter()
            .any(|url| url == "https://www.ngv.vic.gov.au/zoomify/TileGroup0/1-1-1.jpg")
    );
}

#[test]
fn dezoomer_deepzoom_metadata_and_tile_cases() {
    let cases = [
        (
            "https://fixtures.test/deepzoom/sample.dzi",
            br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512" /></Image>"# as &[u8],
            "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
        ),
        (
            "https://fixtures.test/deepzoom/png.dzi",
            br#"<Image TileSize="256" Overlap="0" Format="png"><Size Width="512" Height="512" /></Image>"#,
            "https://fixtures.test/deepzoom/png_files/9/1_1.png",
        ),
        (
            "https://fixtures.test/deepzoom/jpeg.dzi",
            br#"<Image TileSize="256" Overlap="0" Format="jpeg"><Size Width="512" Height="512" /></Image>"#,
            "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
        ),
    ];
    for (input, metadata, expected_tile) in cases {
        let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
        assert_eq!(image.format.as_str(), "deepzoom");
        assert!(
            tile_urls(image.levels.last().unwrap())
                .iter()
                .any(|url| url == expected_tile)
        );
    }

    let tile_cases = [
        (
            "https://fixtures.test/deepzoom/png_files/9/1_1.png",
            "https://fixtures.test/deepzoom/png.dzi",
            br#"<Image TileSize="256" Overlap="0" Format="png"><Size Width="512" Height="512" /></Image>"# as &[u8],
            "https://fixtures.test/deepzoom/png_files/9/1_1.png",
        ),
        (
            "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
            "https://fixtures.test/deepzoom/jpeg.dzi",
            br#"<Image TileSize="256" Overlap="0" Format="jpeg"><Size Width="512" Height="512" /></Image>"#,
            "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
        ),
    ];
    for (input, metadata_input, metadata, expected_tile) in tile_cases {
        let image = ready_image(discover(input, &[(metadata_input, metadata)]).unwrap());
        assert!(
            tile_urls(image.levels.last().unwrap())
                .iter()
                .any(|url| url == expected_tile)
        );
    }
}

#[test]
fn dezoomer_deepzoom_overlap_case() {
    let input = "https://fixtures.test/deepzoom/overlap.dzi";
    let metadata = br#"<Image TileSize="256" Overlap="1" Format="jpg"><Size Width="512" Height="512" /></Image>"#;
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    let level = image.levels.last().unwrap();
    assert_eq!(grid(level).overlap(), Vec2d::square(1));
    assert_eq!(
        grid(level)
            .tiles_row_major()
            .map(|tile| {
                let tile = tile.unwrap();
                (tile.destination.x, tile.destination.y)
            })
            .collect::<Vec<_>>(),
        [(0, 0), (255, 0), (0, 255), (255, 255)]
    );
}

#[test]
fn dezoomer_paris_ark_page_case() {
    let input = "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs";
    let reader = "https://bibliotheques-specialisees.paris.fr/in/imageReader.xhtml?id=ark:/73873/pf0001115743/0017&updateUrl=updateUrl1653&ark=/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs&selectedTab=otherdocs";
    let image = ready_image(
        discover(
            input,
            &[
                (input, b""),
                (reader, coverage_fixture!("deepzoom/paris-reader.html")),
                (
                    "https://fixtures.test/deepzoom/sample.xml",
                    br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512" /></Image>"#,
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "deepzoom");
    assert!(
        tile_urls(image.levels.last().unwrap())
            .iter()
            .any(|url| url == "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg")
    );
}

#[test]
fn dezoomer_iiif_image_service_cases() {
    let input = "http://127.0.0.1:9877/fixtures/iiif-v2/info.json";
    let image =
        ready_image(discover(input, &[(input, coverage_fixture!("iiif/v2-info.json"))]).unwrap());
    assert_eq!(image.format.as_str(), "iiif");
    assert!(
        tile_urls(image.levels.last().unwrap())
            .iter()
            .any(|url| url == "http://127.0.0.1:9877/iiif/v2/256,256,256,256/256,256/0/native.png")
    );

    let input = "https://fixtures.test/iiif-v3/info.json";
    let image =
        ready_image(discover(input, &[(input, coverage_fixture!("iiif/v3-info.json"))]).unwrap());
    assert!(
        tile_urls(image.levels.last().unwrap())
            .iter()
            .any(|url| url == "https://fixtures.test/iiif-v3/0,0,256,256/256,256/0/default.jpg")
    );

    let page_input = "https://fixtures.test/micrio/viewer.html";
    let micrio_info_input = "https://i.micr.io/KEimL/info.json";
    let image = ready_image(
        discover(
            page_input,
            &[
                (page_input, include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/micrio/viewer.html")),
                (
                    micrio_info_input,
                    include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/dezoomify-core/testdata/micrio/info.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert!(
        tile_urls(image.levels.last().unwrap())
            .iter()
            .any(|url| url == "https://i.micr.io/KEimL/256,256,256,256/256,256/0/default.jpg")
    );

    let input = "https://fixtures.test/iiif-v3/non-divisible/info.json";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("iiif/non-divisible-info.json"))],
        )
        .unwrap(),
    );
    let level = image
        .levels
        .iter()
        .find(|level| level.scale_factor == Some(8))
        .unwrap();
    assert_eq!(level.source.image_size(), Some(Vec2d { x: 620, y: 656 }));
    assert_eq!(
        tile_urls(level),
        ["https://fixtures.test/iiif-v3/non-divisible/0,0,4960,5241/620,656/0/default.jpg"]
    );

    let input = "https://fixtures.test/iiif-map-view/info.json";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("iiif/map-view-info.json"))],
        )
        .unwrap(),
    );
    let level = image
        .levels
        .iter()
        .find(|level| level.scale_factor == Some(1))
        .unwrap();
    assert_eq!(grid(level).tile_size(), Vec2d::square(512));
    assert_eq!(
        tile_urls(level)[0],
        "https://fixtures.test/iiif-map-view/0,0,512,512/512,512/0/native.jpg"
    );

    let input = "http://127.0.0.1:9877/fixtures/iiif-private-id/info.json";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("iiif/private-id-info.json"))],
        )
        .unwrap(),
    );
    assert!(tile_urls(image.levels.last().unwrap()).iter().any(|url| url
        == "http://127.0.0.1:9877/fixtures/iiif-private-id/0,0,256,256/256,256/0/native.png"));

    let input = "http://127.0.0.1:9877/fixtures/iiif-default-port/info.json";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("iiif/default-port-info.json"))],
        )
        .unwrap(),
    );
    assert!(tile_urls(image.levels.last().unwrap()).iter().any(
        |url| url == "http://127.0.0.1:9877/iiif/default-port/0,0,256,256/256,256/0/native.jpg"
    ));

    let input = "https://fixtures.test/iiif-malformed-tile/info.json";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("iiif/malformed-tile-info.json"))],
        )
        .unwrap(),
    );
    assert_eq!(
        tile_urls(image.levels.last().unwrap()),
        ["https://fixtures.test/iiif-malformed-tile/0,0,512,512/512,512/0/default.jpg"]
    );

    let input = "https://fixtures.test/iiif-v2/edge-dimensions/info.json";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("iiif/edge-dimensions-info.json"))],
        )
        .unwrap(),
    );
    assert!(tile_urls(image.levels.last().unwrap()).iter().any(|url| url
        == "https://fixtures.test/iiif-v2/edge-dimensions/256,256,256,128/256,128/0/default.jpg"));
}

#[test]
fn dezoomer_iiif_manifest_case() {
    let manifest_input = "https://fixtures.test/iiif-presentation/manifest.json";
    let info_input = "https://fixtures.test/iiif-presentation/image/info.json";
    let catalog = discover(
        manifest_input,
        &[
            (
                manifest_input,
                coverage_fixture!("iiif/presentation-manifest.json"),
            ),
            (info_input, coverage_fixture!("iiif/presentation-info.json")),
        ],
    )
    .unwrap();
    let [CatalogEntry::Deferred(deferred)] = catalog.entries() else {
        panic!("manifest should produce one deferred image");
    };
    assert_eq!(deferred.uri, info_input);

    let image = ready_image(
        discover(
            info_input,
            &[(info_input, coverage_fixture!("iiif/presentation-info.json"))],
        )
        .unwrap(),
    );
    assert!(
        tile_urls(image.levels.last().unwrap())
            .iter()
            .any(|url| url.ends_with("/iiif-presentation/image/0,0,256,256/256,256/0/native.jpg"))
    );
}

#[test]
fn dezoomer_iiif_plain_image_manifest_remains_deferred() {
    let input = "https://fixtures.test/iiif-presentation/plain-image-manifest.json";
    let catalog = discover(
        input,
        &[(input, coverage_fixture!("iiif/plain-image-manifest.json"))],
    )
    .unwrap();
    assert!(matches!(
        &catalog.entries()[0],
        CatalogEntry::Deferred(image) if image.uri == "https://fixtures.test/iiif-presentation/plain.jpg"
    ));
}

#[test]
fn dezoomer_iiif_url_adapters_follow_metadata() {
    let manifest = coverage_fixture!("iiif/presentation-manifest.json");
    for input in [
        "https://fixtures.test/mirador?manifest=https%3A%2F%2Ffixtures.test%2Fiiif-presentation%2Fmanifest.json",
        "https://fixtures.test/uv/#?manifest=https%3A%2F%2Ffixtures.test%2Fiiif-presentation%2Fmanifest.json",
    ] {
        let catalog = discover(
            input,
            &[(
                "https://fixtures.test/iiif-presentation/manifest.json",
                manifest,
            )],
        )
        .unwrap();
        let [CatalogEntry::Deferred(image)] = catalog.entries() else {
            panic!("manifest adapter must produce one deferred image");
        };
        assert_eq!(
            image.uri,
            "https://fixtures.test/iiif-presentation/image/info.json"
        );
    }

    for input in [
        "https://viewer.onb.ac.at/10048A37/",
        "https://viewer.onb.ac.at/10048A37/137",
        "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
        "https://digital.onb.ac.at/RepViewer/viewer.faces?doc=10048A37&order=1",
    ] {
        let catalog = discover(
            input,
            &[(
                "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
                coverage_fixture!("iiif/onb-manifest.json"),
            )],
        )
        .unwrap();
        let [CatalogEntry::Deferred(image)] = catalog.entries() else {
            panic!("ONB adapter must produce one deferred image");
        };
        assert_eq!(
            image.uri,
            "https://api.onb.ac.at/iiif/image/v3/10048A37/uk4nGb4kQHe3msbC/info.json"
        );
    }

    let input = "https://fixtures.test/digital/collection/OKMaps/id/6483/rec/6";
    let image = ready_image(
        discover(
            input,
            &[
                (
                    "https://fixtures.test/digital/api/singleitem/collection/OKMaps/id/6483",
                    coverage_fixture!("iiif/contentdm-metadata.json"),
                ),
                (
                    "https://fixtures.test/digital/iiif/OKMaps/6483/info.json",
                    coverage_fixture!("iiif/contentdm-info.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "iiif");
    assert!(tile_urls(image.levels.last().unwrap()).iter().any(|url| url
        == "https://fixtures.test/digital/iiif/OKMaps/6483/256,256,256,256/256,256/0/native.jpg"));
}

#[test]
fn dezoomer_iiif_page_adapters_follow_metadata() {
    let page = "https://fixtures.test/national-gallery.html";
    let image = ready_image(
        discover(
            page,
            &[
                (page, coverage_fixture!("iiif/national-gallery.html")),
                (
                    "https://fixtures.test/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif/info.json",
                    coverage_fixture!("iiif/national-gallery-info.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "iiif");

    for (page, page_fixture, info_fixture, id) in [
        (
            "https://fixtures.test/philamuseum-escaped.html",
            coverage_fixture!("iiif/philamuseum-escaped.html") as &[u8],
            coverage_fixture!("iiif/philamuseum-info.json") as &[u8],
            "QYRjM",
        ),
        (
            "https://fixtures.test/philamuseum-raw.html",
            coverage_fixture!("iiif/philamuseum-raw.html") as &[u8],
            coverage_fixture!("iiif/philamuseum-raw-info.json") as &[u8],
            "Raw01",
        ),
    ] {
        let info_uri = format!("https://i.micr.io/{id}/info.json");
        let image = ready_image(
            discover(page, &[(page, page_fixture), (&info_uri, info_fixture)]).unwrap(),
        );
        assert!(
            tile_urls(image.levels.last().unwrap()).iter().any(|url| url
                == &format!("https://i.micr.io/{id}/256,256,256,256/256,256/0/default.jpg"))
        );
    }
}

#[test]
fn dezoomer_iipimage_query_case() {
    let input = "https://fixtures.test/iip?FIF=/image.tif";
    let metadata_input =
        "https://fixtures.test/iip?FIF=/image.tif&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number";
    let metadata = b"Max-size:512 512\nTile-size:256 256\nResolution-number:2";
    let image = ready_image(discover(input, &[(metadata_input, metadata)]).unwrap());
    assert_eq!(image.format.as_str(), "iipimage");
    let urls = tile_urls(image.levels.last().unwrap());
    assert_eq!(urls[0], "https://fixtures.test/iip?FIF=/image.tif&JTL=1,0");
    assert_eq!(urls[3], "https://fixtures.test/iip?FIF=/image.tif&JTL=1,3");
}

#[test]
fn dezoomer_krpano_explicit_level_case() {
    let input = "https://fixtures.test/krpano/pano.xml";
    let metadata = br#"<krpano>
      <image tilesize="256">
        <level tiledimagewidth="512" tiledimageheight="512">
          <front url="tiles/l%l/%v_%h.jpg" />
        </level>
      </image>
    </krpano>"#;
    let image = ready_image(discover(input, &[(input, metadata)]).unwrap());
    assert_eq!(image.format.as_str(), "krpano");
    assert_eq!(
        tile_urls(image.levels.last().unwrap()).last(),
        Some(&"https://fixtures.test/krpano/tiles/l1/2_2.jpg".to_owned())
    );
}

fn resolve_generic(template: &str, available: &[(u32, u32, Vec2d)]) -> (Grid, Vec<Vec2d>) {
    let mut step = DiscoverableGrid::new("coverage:generic".into(), template.into()).start();
    loop {
        step = match step {
            DiscoverableStep::Probe { tile, continuation } => {
                let result = available
                    .iter()
                    .find(|(x, y, _)| tile.request.uri == render_xy(template, *x, *y))
                    .map_or(ObservationResult::Missing, |(_, _, size)| {
                        ObservationResult::Available { size: *size }
                    });
                continuation.submit(result).unwrap()
            }
            DiscoverableStep::Resolved {
                grid,
                previously_output,
            } => return (grid, previously_output),
            DiscoverableStep::Empty => panic!("generic fixture unexpectedly had no tiles"),
            DiscoverableStep::Error(error) => panic!("unexpected adaptive error: {error}"),
        };
    }
}

fn render_xy(template: &str, x: u32, y: u32) -> String {
    template
        .replace("{{X}}", &x.to_string())
        .replace("{{Y}}", &y.to_string())
}

#[test]
fn dezoomer_generic_probe_cases() {
    let cases = [
        (
            "padded.svg?x={{X}}&y={{Y}}",
            (Vec2d { x: 512, y: 512 }, Vec2d::square(256)),
            &[
                (0, 0, Vec2d::square(256)),
                (1, 0, Vec2d::square(256)),
                (0, 1, Vec2d::square(256)),
                (1, 1, Vec2d::square(256)),
            ][..],
        ),
        (
            "large.svg?x={{X}}&y={{Y}}",
            (Vec2d { x: 1024, y: 512 }, Vec2d::square(512)),
            &[(0, 0, Vec2d::square(512)), (1, 0, Vec2d::square(512))][..],
        ),
        (
            "edge.svg?x={{X}}&y={{Y}}",
            (Vec2d { x: 512, y: 512 }, Vec2d::square(256)),
            &[
                (0, 0, Vec2d::square(256)),
                (1, 0, Vec2d { x: 1, y: 256 }),
                (0, 1, Vec2d { x: 256, y: 14 }),
                (1, 1, Vec2d { x: 1, y: 14 }),
            ][..],
        ),
        (
            "boundary.svg?x={{X}}&y={{Y}}",
            (Vec2d { x: 256_000, y: 256 }, Vec2d::square(256)),
            &(0..1000)
                .map(|x| (x, 0, Vec2d::square(256)))
                .collect::<Vec<_>>()[..],
        ),
        (
            "one.svg?x={{X}}&y={{Y}}",
            (Vec2d { x: 768, y: 256 }, Vec2d::square(256)),
            &[
                (0, 0, Vec2d::square(256)),
                (1, 0, Vec2d::square(256)),
                (2, 0, Vec2d::square(256)),
            ][..],
        ),
    ];
    for (template, (expected_size, expected_tile_size), available) in cases {
        let (grid, _) = resolve_generic(template, available);
        assert_eq!(grid.image_size(), expected_size, "{template}");
        assert_eq!(grid.tile_size(), expected_tile_size, "{template}");
    }

    let (grid, previously_output) = resolve_generic(
        "missing-origin.svg?x={{X}}&y={{Y}}",
        &[
            (1, 0, Vec2d::square(256)),
            (0, 1, Vec2d::square(256)),
            (1, 1, Vec2d::square(256)),
        ],
    );
    assert_eq!(grid.image_size(), Vec2d::square(512));
    assert_eq!(grid.tile_size(), Vec2d::square(256));
    assert!(!previously_output.contains(&Vec2d { x: 256, y: 256 }));
}

#[test]
fn dezoomer_generic_encoded_templates_are_recognized() {
    let input = "https://fixtures.test/generic/padded.svg?x=%7B%7BX%7D%7D&y=%7B%7BY%7D%7D";
    let catalog = discover(input, &[]).unwrap();
    let CatalogEntry::Ready(image) = &catalog.entries()[0] else {
        panic!("generic template should be immediately ready");
    };
    let TileSource::DiscoverableGrid(grid) = &image.levels[0].source else {
        panic!("generic template should remain discoverable");
    };
    let DiscoverableStep::Probe { tile, .. } = grid.clone().start() else {
        panic!("generic template should start with a probe");
    };
    assert_eq!(
        tile.request.uri,
        "https://fixtures.test/generic/padded.svg?x=0&y=0"
    );

    let input = "https://fixtures.test/generic/padded.svg?x=%7B%7BX:05%7D%7D&y=%7B%7BY:05%7D%7D";
    let catalog = discover(input, &[]).unwrap();
    let CatalogEntry::Ready(image) = &catalog.entries()[0] else {
        panic!("generic padded template should be immediately ready");
    };
    let TileSource::DiscoverableGrid(grid) = &image.levels[0].source else {
        panic!("generic padded template should remain discoverable");
    };
    let DiscoverableStep::Probe { tile, .. } = grid.clone().start() else {
        panic!("generic padded template should start with a probe");
    };
    assert_eq!(
        tile.request.uri,
        "https://fixtures.test/generic/padded.svg?x=00000&y=00000"
    );
}

#[test]
fn dezoomer_generic_one_by_one_placeholders_are_missing_tiles() {
    let template = "https://fixtures.test/generic/placeholder.svg?x={{X}}&y={{Y}}";
    let mut step = DiscoverableGrid::new("coverage:placeholder".into(), template.into()).start();
    loop {
        step = match step {
            DiscoverableStep::Probe { tile, continuation } => {
                let query = tile.request.uri.split_once('?').unwrap().1;
                let mut coordinates = query
                    .split('&')
                    .map(|part| part.split_once('=').unwrap().1.parse::<u32>().unwrap());
                let x = coordinates.next().unwrap();
                let y = coordinates.next().unwrap();
                let result = if x < 2 && y < 2 {
                    ObservationResult::Available {
                        size: Vec2d::square(256),
                    }
                } else {
                    ObservationResult::Available {
                        size: Vec2d::square(1),
                    }
                };
                continuation.submit(result).unwrap()
            }
            DiscoverableStep::Resolved { grid, .. } => {
                assert_eq!(grid.image_size(), Vec2d::square(512));
                assert_eq!(grid.tile_size(), Vec2d::square(256));
                return;
            }
            DiscoverableStep::Empty => panic!("placeholder fixture unexpectedly had no tiles"),
            DiscoverableStep::Error(error) => panic!("unexpected adaptive error: {error}"),
        };
    }
}

#[test]
fn dezoomer_google_short_url_is_a_supported_input() {
    let input = "https://g.co/arts/fixture";
    let registry = default_registry(input);
    let mut operation: DiscoveryOperation = registry.start(input);
    let needs = operation.missing_resources().unwrap();
    assert_eq!(needs.len(), 1);
    assert_eq!(needs[0].id, RequestId(0));
    assert_eq!(needs[0].request.uri, input);
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
            ready_image(discover(input, resources).unwrap())
                .format
                .as_str(),
            *format
        );
    }
}

#[test]
fn part_three_direct_protocols_generate_expected_tiles() {
    let image = ready_image(
        discover(
            "https://fixtures.test/xl/sample.imgi?cmd=info",
            &[(
                "https://fixtures.test/xl/sample.imgi?cmd=info",
                coverage_fixture!("xlimage/sample.imgi.xml"),
            )],
        )
        .unwrap(),
    );
    assert_eq!(
        tile_urls(image.levels.last().unwrap()).last().unwrap(),
        "https://fixtures.test/xl/sample.imgi?cmd=tile&x=1&y=1&z=1"
    );
    assert_eq!(image.title.as_deref(), Some("sample"));

    let image = ready_image(
        discover(
            "https://fixtures.test/topviewer/data.json",
            &[(
                "https://fixtures.test/topviewer/data.json",
                coverage_fixture!("topviewer/data.json"),
            )],
        )
        .unwrap(),
    );
    assert_eq!(
        tile_urls(image.levels.last().unwrap()).last().unwrap(),
        "https://fixtures.test/topviewer/sample-file/13.jpg"
    );
    assert_eq!(image.title.as_deref(), Some("sample-file"));

    let image = ready_image(
        discover(
            "https://fixtures.test/fsi/server?type=info&source=image",
            &[(
                "https://fixtures.test/fsi/server?type=info&source=image",
                coverage_fixture!("fsi/info.txt"),
            )],
        )
        .unwrap(),
    );
    assert_eq!(
        tile_urls(image.levels.last().unwrap())[0],
        "https://fixtures.test/fsi/server?type=image&source=image&width=512&height=512&rect=0,0,1,1"
    );
    assert_eq!(image.title.as_deref(), Some("image"));

    let image = ready_image(
        discover(
            "https://fixtures.test/lizardtech/iserv/calcrgn?item=image",
            &[(
                "https://fixtures.test/lizardtech/iserv/calcrgn?item=image",
                coverage_fixture!("lizardtech/calcrgn.xml"),
            )],
        )
        .unwrap(),
    );
    assert_eq!(
        tile_urls(image.levels.last().unwrap()).last().unwrap(),
        "https://fixtures.test/lizardtech/iserv/getimage?cat=North%20America%20and%20United%20States&item=NorthAmerica%2FUS1566a.sid&wid=512&hei=512&oif=jpeg&lev=0&cp=0.75,0.75"
    );
    assert_eq!(image.title.as_deref(), Some("US1566a"));

    let image = ready_image(
        discover(
            "https://fixtures.test/vls/zoom/1",
            &[(
                "https://fixtures.test/vls/zoom/1",
                coverage_fixture!("vls/zoom.html"),
            )],
        )
        .unwrap(),
    );
    assert_eq!(
        tile_urls(image.levels.last().unwrap())[0],
        "https://fixtures.test/image/tiler/square/fixture/0/0/0"
    );
    assert_eq!(image.title.as_deref(), Some("Fixture Volume"));

    let image = ready_image(
        discover(
            "https://fixtures.test/hungaricana/imagesize/sample.ecw",
            &[(
                "https://fixtures.test/hungaricana/imagesize/sample.ecw",
                coverage_fixture!("hungaricana/sample.ecw.json"),
            )],
        )
        .unwrap(),
    );
    assert!(
        tile_urls(image.levels.last().unwrap())[0]
            .starts_with("https://fixtures.test/hungaricana/image/sample.ecw/")
    );
    assert_eq!(image.title.as_deref(), Some("sample"));

    let image = ready_image(
        discover(
            "https://fixtures.test/wmts/WMTSCapabilities.xml",
            &[(
                "https://fixtures.test/wmts/WMTSCapabilities.xml",
                coverage_fixture!("wmts/WMTSCapabilities.xml"),
            )],
        )
        .unwrap(),
    );
    assert_eq!(
        tile_urls(image.levels.last().unwrap()).last().unwrap(),
        "https://fixtures.test/wmts/EPSG3857/0/10/10.jpg"
    );

    let image = ready_image(
        discover(
            "https://fixtures.test/arcgis/MapServer?token=fixture&f=html",
            &[(
                "https://fixtures.test/arcgis/MapServer?token=fixture&f=json",
                coverage_fixture!("arcgis/MapServer.json"),
            )],
        )
        .unwrap(),
    );
    let level = image.levels.last().unwrap();
    assert_eq!(level.source.image_size(), Some(Vec2d { x: 768, y: 768 }));
    assert_eq!(image.title.as_deref(), Some("Fixture Basemap"));
    assert_eq!(
        tile_urls(level).last().unwrap(),
        "https://fixtures.test/arcgis/MapServer/tile/7/3/4?token=fixture"
    );
}

#[test]
fn xlimage_exposes_server_zoom_levels() {
    let input = "https://fixtures.test/xl/pyramid.imgf?cmd=info";
    let image = ready_image(
        discover(
            input,
            &[(input, coverage_fixture!("xlimage/pyramid.imgf.xml"))],
        )
        .unwrap(),
    );
    assert_eq!(image.levels.len(), 3);
    assert!(image.levels.iter().all(|level| {
        level
            .title
            .as_deref()
            .is_some_and(|title| title.starts_with("XLimage level "))
    }));
    assert_eq!(
        image.levels[0].source.image_size(),
        Some(Vec2d { x: 250, y: 175 })
    );
    assert_eq!(
        image.levels[1].source.image_size(),
        Some(Vec2d { x: 500, y: 350 })
    );
    assert_eq!(
        image.levels[2].source.image_size(),
        Some(Vec2d { x: 1000, y: 700 })
    );
    assert_eq!(
        tile_urls(&image.levels[0])[0],
        "https://fixtures.test/xl/pyramid.imgf?cmd=tile&x=0&y=0&z=4"
    );
}

#[test]
fn part_three_page_adapters_follow_their_metadata_resources() {
    let image = ready_image(
        discover(
            "https://fixtures.test/archive/thumbnail.html",
            &[
                (
                    "https://fixtures.test/archive/thumbnail.html",
                    coverage_fixture!("topviewer/thumbnail.html"),
                ),
                (
                    "https://images.memorix.nl/demo/topviewjson/memorix/sample-file",
                    coverage_fixture!("topviewer/data.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "topviewer");

    let image = ready_image(discover(
        "https://fixtures.test/topviewer/mediabank.html",
        &[
            (
                "https://fixtures.test/topviewer/mediabank.html",
                coverage_fixture!("topviewer/mediabank.html"),
            ),
            (
                "https://fixtures.test/mediabank/media?label=fixture&mode=full&rows=1&apiKey=fixture-key&entities%5B0%5D=fixture-entity",
                coverage_fixture!("topviewer/media.json"),
            ),
            (
                "https://fixtures.test/topviewer/data.json",
                coverage_fixture!("topviewer/data.json"),
            ),
        ],
    )
    .unwrap());
    assert_eq!(image.format.as_str(), "topviewer");

    let detail = "https://fixtures.test/archive/detail/record-id/media/asset-id";
    let media = "https://fixtures.test/mediabank/media/record-id?apiKey=fixture-key";
    let image = ready_image(
        discover(
            detail,
            &[
                (
                    detail,
                    br#"<pic-mediabank data-api-key="fixture-key" data-api-url="/mediabank/"></pic-mediabank>"#,
                ),
                (
                    media,
                    br#"{"media":[{"asset":[{"uuid":"other-id","topview":"https://fixtures.test/topviewer/wrong.json"},{"uuid":"asset-id","topview":"https://fixtures.test/topviewer/data.json"}]}]}"#,
                ),
                (
                    "https://fixtures.test/topviewer/data.json",
                    coverage_fixture!("topviewer/data.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "topviewer");

    let image = ready_image(
        discover(
            "https://fixtures.test/archive/fsi.html",
            &[
                (
                    "https://fixtures.test/archive/fsi.html",
                    coverage_fixture!("fsi/page.html"),
                ),
                (
                    "https://fixtures.test/fsi/server?type=info&source=image",
                    coverage_fixture!("fsi/info.txt"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "fsi");

    let image = ready_image(
        discover(
            "https://fixtures.test/hungaricana/page.html",
            &[
                (
                    "https://fixtures.test/hungaricana/page.html",
                    coverage_fixture!("hungaricana/inline-images.html"),
                ),
                (
                    "https://fixtures.test/hungaricana/image/page/first.ecw",
                    coverage_fixture!("hungaricana/sample.ecw.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "hungaricana");
}

#[test]
fn pnav_probe_resolves_scaled_crop_grid_without_repeating_the_probe() {
    let catalog = discover(
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
    )
    .unwrap();
    let image = ready_image(catalog);
    let TileSource::Adaptive(source) = &image.levels[0].source else {
        panic!("pnav must expose a probe-driven source")
    };
    let DiscoverableStep::Probe { tile, continuation } = source.start() else {
        panic!("pnav must begin with a probe")
    };
    assert_eq!(
        tile.request.uri,
        "https://fixtures.test/fixtures/pnav/image.jpg?w=2000&h=2000&cl=0&ct=0&cw=512&ch=512"
    );
    let DiscoverableStep::Resolved {
        grid,
        previously_output,
    } = continuation
        .submit(ObservationResult::Available {
            size: Vec2d::square(2000),
        })
        .unwrap()
    else {
        panic!("pnav probe must resolve")
    };
    assert_eq!(grid.image_size(), Vec2d::square(2000));
    assert_eq!(grid.count(), 1);
    assert_eq!(previously_output, [Vec2d::default()]);
    assert_eq!(
        grid.tiles_row_major().next().unwrap().unwrap().request.uri,
        tile.request.uri
    );

    let image = ready_image(
        discover(
            "https://fixtures.test/entity/OBJECT/1/",
            &[
                (
                    "https://fixtures.test/entity/OBJECT/1/",
                    coverage_fixture!("pnav/page.html"),
                ),
                (
                    "https://fixtures.test/fixtures/pnav/image.json",
                    coverage_fixture!("pnav/image.json"),
                ),
            ],
        )
        .unwrap(),
    );
    assert_eq!(image.format.as_str(), "pnav");
    assert_eq!(image.title.as_deref(), Some("Fixture Object"));
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

// ---------------------------------------------------------------------------
// Scenario parity: shared web scenarios driven through core discovery and
// compared with the legacy-web oracle transcripts. Candidate destination
// results are written to expected/core.json with DEZOOMIFY_UPDATE_CORE=1 and
// compared by default.
// ---------------------------------------------------------------------------

mod scenario_parity {
    use dezoomify_core::core::discovery::{DiscoveryError, ResourceResponse};
    use dezoomify_core::core::{CatalogEntry, ImageCatalog, TileSource, default_registry};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn scenarios_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios")
    }

    /// Map of servable URL -> payload bytes for scenarios, from routes.json.
    /// Keys cover http/https and query-stripped variants.
    fn route_map(scenarios: &[&str]) -> HashMap<String, Vec<u8>> {
        let mut map = HashMap::new();
        for scenario in scenarios {
            let dir = scenarios_dir().join(scenario);
            let routes: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join("routes.json")).expect("routes.json"),
            )
            .expect("parse routes");
            for route in routes["routes"].as_array().expect("routes array") {
                let payload = match route.get("payload").and_then(|p| p.as_str()) {
                    Some(p) => p,
                    None => continue,
                };
                let mut bytes = std::fs::read(dir.join(payload)).expect("payload bytes");
                let host = route.get("host").and_then(|h| h.as_str()).unwrap_or("");
                if let Some(path) = route.get("path").and_then(|p| p.as_str()) {
                    // Mirror server templating with deterministic values so core
                    // output compares directly against normalized oracle text.
                    if route
                        .get("headers")
                        .and_then(|h| h.get("Content-Type"))
                        .and_then(|c| c.as_str())
                        .is_some_and(|c| {
                            c.starts_with("text/")
                                || c.contains("json")
                                || c.contains("xml")
                                || c.contains("javascript")
                        })
                    {
                        let text = String::from_utf8_lossy(&bytes)
                            .replace("{{origin}}", "http://127.0.0.1:PORT");
                        let text = text.replace("{{host}}", host);
                        bytes = text.into_bytes();
                    }
                    for scheme in ["http", "https"] {
                        map.insert(format!("{scheme}://{host}{path}"), bytes.clone());
                    }
                }
            }
        }
        map
    }

    fn drive(input: &str, map: &HashMap<String, Vec<u8>>) -> Result<ImageCatalog, DiscoveryError> {
        drive_scoped(input, map, input)
    }

    fn drive_scoped(
        input: &str,
        map: &HashMap<String, Vec<u8>>,
        scope: &str,
    ) -> Result<ImageCatalog, DiscoveryError> {
        let mut operation = default_registry(input).start(input);
        loop {
            let Some(need) = operation.next_priority_need()? else {
                return operation.finish();
            };
            let uri = need.request.uri.clone();
            // Deterministic test origin used for templated payloads.
            let uri = uri.replace(":PORT", "");
            let empty = Vec::new();
            let bytes = map
                .get(&uri)
                .or_else(|| map.get(uri.split('?').next().unwrap_or(&uri)))
                .or_else(|| {
                    // Mirror the server's legacy suffix/index fallback.
                    let base = uri.split('?').next().unwrap_or(&uri);
                    [".html", ".json", ".xml", ".txt"]
                        .iter()
                        .find_map(|suffix| map.get(&format!("{base}{suffix}")))
                })
                .or_else(|| {
                    let base = uri.split('?').next().unwrap_or(&uri);
                    ["index.html", "index.json", "index.xml", "index.txt"]
                        .iter()
                        .find_map(|index| {
                            map.get(&format!("{}/{index}", base.trim_end_matches('/')))
                        })
                })
                .or_else(|| {
                    // Speculative input fetches (one per candidate) carry no
                    // fixture: every candidate requests the input URL to run
                    // content matchers, including formats that map it away
                    // without reading it. Empty bytes let them reject honestly.
                    let base = uri.split('?').next().unwrap_or(&uri);
                    let scope_base = scope.split('?').next().unwrap_or(scope);
                    (base == scope || base == scope_base).then_some(&empty)
                })
                .unwrap_or_else(|| panic!("no scenario payload for requested {uri}"));
            operation.provide(ResourceResponse::new(need.id, bytes.clone()))?;
        }
    }

    fn first_grid_tiles(
        catalog: &ImageCatalog,
        map: &HashMap<String, Vec<u8>>,
        input: &str,
        want_width: Option<u32>,
        want_height: Option<u32>,
    ) -> (String, u32, u32, Vec<String>) {
        let entry = catalog.entries().first().expect("one entry");
        let image = match entry {
            CatalogEntry::Ready(image) => image.clone(),
            // Resolve deferred entries explicitly, mirroring host behavior.
            CatalogEntry::Deferred(d) => {
                let resolved = drive_scoped(&d.uri, map, &d.uri).expect("resolve deferred");
                match resolved.entries().first().expect("resolved entry") {
                    CatalogEntry::Ready(image) => image.clone(),
                    CatalogEntry::Deferred(d) => panic!("doubly deferred {}", d.uri),
                }
            }
        };
        // Legacy downloads the highest fitting level; match the oracle
        // dimensions when several levels exist.
        let level = match (want_width, want_height) {
            (Some(w), Some(h)) => image
                .levels
                .iter()
                .find(|l| level_size(l) == Some((w, h)))
                .unwrap_or_else(|| image.levels.first().expect("one level")),
            _ => image.levels.first().expect("one level"),
        };
        let display = default_registry(input)
            .spec_named(image.format.as_str())
            .map(|s| s.display_name().to_string())
            .unwrap_or_else(|| image.format.as_str().to_string());
        let format = display;
        match &level.source {
            TileSource::Grid(grid) => {
                let size = grid.image_size();
                let tiles: Vec<String> = grid
                    .tiles_row_major()
                    .map(|t| t.expect("grid tile").request.uri.clone())
                    .collect();
                (format, size.x, size.y, tiles)
            }
            TileSource::Adaptive(source) => {
                // Drive scripted probe observations (decoded size = oracle
                // image dims) to the resolved grid, then enumerate it.
                let (w, h) = (want_width.unwrap_or(512), want_height.unwrap_or(512));
                let mut step = source.start();
                let mut grid = None;
                for _ in 0..4096 {
                    match step {
                        dezoomify_core::core::DiscoverableStep::Probe {
                            tile: _,
                            continuation,
                        } => {
                            step = continuation
                                .submit(dezoomify_core::core::ObservationResult::Available {
                                    size: dezoomify_core::Vec2d { x: w, y: h },
                                })
                                .expect("probe submit");
                        }
                        dezoomify_core::core::DiscoverableStep::Resolved { grid: g, .. } => {
                            grid = Some(g);
                            break;
                        }
                        dezoomify_core::core::DiscoverableStep::Empty => break,
                        dezoomify_core::core::DiscoverableStep::Error(e) => {
                            panic!("adaptive error: {e:?}")
                        }
                    }
                }
                let grid = grid.expect("adaptive resolved");
                let size = grid.image_size();
                let tiles: Vec<String> = grid
                    .tiles_row_major()
                    .map(|t| t.expect("grid tile").request.uri.clone())
                    .collect();
                (format, size.x, size.y, tiles)
            }
            other => panic!("expected grid or adaptive source, got {other:?}"),
        }
    }

    fn level_size(level: &dezoomify_core::core::LevelDescriptor) -> Option<(u32, u32)> {
        match &level.source {
            TileSource::Grid(grid) => {
                let size = grid.image_size();
                Some((size.x, size.y))
            }
            _ => None,
        }
    }

    fn legacy_transcript(scenario: &str) -> serde_json::Value {
        let path = scenarios_dir()
            .join(scenario)
            .join("expected/legacy-web.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("legacy transcript"))
            .expect("parse transcript")
    }

    fn core_result_path(scenario: &str) -> PathBuf {
        scenarios_dir().join(scenario).join("expected/core.json")
    }

    /// Compare one discovery case against its oracle transcript. Returns a
    /// mismatch description plus the canonical destination result.
    fn check_case(
        scenario: &str,
        map: &HashMap<String, Vec<u8>>,
        input: &str,
        legacy_format: &str,
    ) -> (Option<String>, serde_json::Value) {
        let transcript = legacy_transcript(scenario);
        let oracle = transcript["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .find(|c| {
                c["input"] == input
                    || c["input"].as_str().is_some_and(|rel| {
                        rel.starts_with('/') && format!("http://127.0.0.1{rel}") == input
                    })
            })
            .unwrap_or_else(|| panic!("oracle lacks input {input}"));
        let catalog = drive(input, map)
            .unwrap_or_else(|e| panic!("core discovery failed for {input}: {e:?}"));
        let oracle_width = oracle["width"].as_u64().map(|w| w as u32);
        let oracle_height = oracle["height"].as_u64().map(|h| h as u32);
        let (format, width, height, tiles) =
            first_grid_tiles(&catalog, map, input, oracle_width, oracle_height);
        let mut problems = Vec::new();
        if oracle["format"] != serde_json::Value::Null && oracle["format"] != format {
            problems.push(format!("format: oracle={} core={format}", oracle["format"]));
        }
        let _ = legacy_format;
        if oracle["width"] != serde_json::Value::Null && oracle["width"] != width {
            problems.push(format!("width: oracle={} core={width}", oracle["width"]));
        }
        if oracle["height"] != serde_json::Value::Null && oracle["height"] != height {
            problems.push(format!("height: oracle={} core={height}", oracle["height"]));
        }
        if oracle["tileCount"] != serde_json::Value::Null
            && oracle["tileCount"] != serde_json::json!(tiles.len())
        {
            problems.push(format!(
                "tileCount: oracle={} core={}",
                oracle["tileCount"],
                tiles.len()
            ));
        }
        if oracle["lastTile"] != serde_json::Value::Null {
            let expected = oracle["lastTile"].as_str().unwrap_or("");
            let got = tiles.last().cloned().unwrap_or_default();
            if normalize_url(&got) != normalize_url(expected) {
                problems.push(format!("lastTile:\n  oracle={expected}\n  core  ={got}"));
            }
        }
        let result = serde_json::json!({
            "input": input,
            "format": format,
            "width": width,
            "height": height,
            "tileCount": tiles.len(),
            "firstTile": tiles.first(),
            "lastTile": tiles.last(),
        });
        if problems.is_empty() {
            (None, result)
        } else {
            (
                Some(format!(
                    "{scenario} :: {input}\n  - {}",
                    problems.join("\n  - ")
                )),
                result,
            )
        }
    }

    fn normalize_url(url: &str) -> String {
        // Hosts/ports vary between oracle runs only by the normalized PORT
        // token; strip scheme+authority query noise for comparison.
        let without_scheme = url.split("://").nth(1).unwrap_or(url);
        let path = without_scheme.split_once('/').map(|(_, p)| p).unwrap_or("");
        // Drop volatile query keys while keeping significant ones.
        let (path, query) = match path.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (path, None),
        };
        match query {
            Some(q) => format!("{path}?{q}"),
            None => path.to_string(),
        }
    }

    macro_rules! parity_cases {
        ($scenario:literal, $maps:expr, $cases:expr) => {{
            let map = route_map($maps);
            let mut mismatches = Vec::new();
            let mut results = Vec::new();
            for (input, legacy_format) in $cases {
                let (mismatch, result) = check_case($scenario, &map, input, legacy_format);
                if let Some(m) = mismatch {
                    mismatches.push(m);
                }
                results.push(result);
            }
            let aggregate = serde_json::json!({
                "scenario": $scenario,
                "cases": results,
            });
            let path = core_result_path($scenario);
            if std::env::var("DEZOOMIFY_UPDATE_CORE").is_ok() {
                std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
                std::fs::write(
                    &path,
                    serde_json::to_string_pretty(&aggregate).expect("json") + "\n",
                )
                .expect("write core.json");
            } else if path.is_file() {
                let expected: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).expect("read"))
                        .expect("parse");
                assert_eq!(
                    expected, aggregate,
                    "scenario {} core.json drift; regenerate with DEZOOMIFY_UPDATE_CORE=1 after review",
                    $scenario
                );
            }
            assert!(
                mismatches.is_empty(),
                "scenario parity mismatches:\n{}",
                mismatches.join("\n")
            );
        }};
    }

    const WEB_MAPS: &[&str] = &[
        "web/core-discovery",
        "web/zoomify-pages",
        "web/seadragon-pages",
        "web/iiif-discovery",
        "web/topviewer",
        "web/site-adapters",
        "web/query-params",
        "web/generic-probing",
        "web/auto-precedence",
        "web/auto-cycle",
        "web/assembly",
        "web/proxy",
    ];

    #[test]
    fn web_core_discovery_matches_oracle() {
        parity_cases!(
            "web/core-discovery",
            WEB_MAPS,
            [
                (
                    "https://fixtures.test/zoomify/ImageProperties.xml",
                    "Zoomify"
                ),
                (
                    "https://fixtures.test/zoomify-base-href/product.html",
                    "Zoomify"
                ),
                (
                    "https://fixtures.test/deepzoom/sample.dzi",
                    "Seadragon (Deep Zoom Image)"
                ),
                (
                    "https://fixtures.test/deepzoom/png_files/9/1_1.png",
                    "Seadragon (Deep Zoom Image)"
                ),
                (
                    "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
                    "Seadragon (Deep Zoom Image)"
                ),
                (
                    "https://fixtures.test/deepzoom/legacy-embed.html",
                    "Seadragon (Deep Zoom Image)"
                ),
                ("http://127.0.0.1/fixtures/iiif-v2/info.json", "IIIF"),
                (
                    "https://fixtures.test/mirador?manifest=https://fixtures.test/iiif-presentation/manifest.json",
                    "IIIF"
                ),
                (
                    "https://fixtures.test/uv/#?manifest=https%3A%2F%2Ffixtures.test%2Fiiif-presentation%2Fmanifest.json",
                    "IIIF"
                ),
                ("https://fixtures.test/micrio-custom-element", "IIIF"),
                ("https://fixtures.test/iip?FIF=/image.tif", "IIPImage"),
                ("https://fixtures.test/krpano/pano.xml", "krpano"),
                ("https://fixtures.test/xl/sample.imgi?cmd=info", "XLimage"),
                ("https://fixtures.test/topviewer/data.json", "TopViewer"),
                (
                    "https://fixtures.test/topviewer/page?FIF=not-iip",
                    "TopViewer"
                ),
                (
                    "https://fixtures.test/fsi/server?type=info&source=image&image=image",
                    "FSI"
                ),
                (
                    "https://fixtures.test/lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true",
                    "LizardTech ImageServer"
                ),
                ("https://fixtures.test/vls/zoom/1", "VLS"),
                (
                    "https://fixtures.test/hungaricana/imagesize/sample.ecw",
                    "Hungaricana"
                ),
                ("https://fixtures.test/wmts/WMTSCapabilities.xml", "WMTS"),
                ("https://fixtures.test/arcgis/MapServer", "ArcGIS MapServer"),
                ("https://fixtures.test/entity/OBJECT/1", "pnav"),
            ]
        );
    }

    #[test]
    fn web_iiif_discovery_matches_oracle() {
        parity_cases!(
            "web/iiif-discovery",
            WEB_MAPS,
            [
                ("https://fixtures.test/iiif-v3/info.json", "IIIF"),
                ("https://viewer.onb.ac.at/10048A37/", "IIIF"),
                (
                    "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
                    "IIIF"
                ),
            ]
        );
    }

    #[test]
    fn web_page_adapters_match_oracle() {
        parity_cases!(
            "web/zoomify-pages",
            WEB_MAPS,
            [
                ("https://fixtures.test/zoomify/flash.html", "Zoomify"),
                (
                    "https://biblio.unibe.ch/web-apps/maps/zoomify.php?col=ryh&pic=Ryh_7906_6",
                    "Zoomify"
                ),
                (
                    "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
                    "Zoomify"
                ),
                (
                    "https://fixtures.test/zoomify/iframe-parent.html",
                    "Zoomify"
                ),
            ]
        );
        parity_cases!(
            "web/seadragon-pages",
            WEB_MAPS,
            [
                (
                    "https://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar",
                    "Seadragon (Deep Zoom Image)"
                ),
                (
                    "https://polona.pl/item/9388882/0/",
                    "Seadragon (Deep Zoom Image)"
                ),
                (
                    "https://nla.gov.au/nla.obj-152642460/view",
                    "Seadragon (Deep Zoom Image)"
                ),
                (
                    "https://fixtures.test/deepzoom/iframe-parent.html",
                    "Seadragon (Deep Zoom Image)"
                ),
            ]
        );
        parity_cases!(
            "web/topviewer",
            WEB_MAPS,
            [
                (
                    "https://www.beeldbankgroningen.nl/beelden/detail/53479cae-899f-0ac1-8913-40276a93a4f7/media/1c7914ee-3f37-0d37-3218-48eba1c3a97f?mode=detail&view=horizontal&rows=1&page=4&fq%5B%5D=search_s_download:%22Nee%22&sort=random%7B1785398988616%7D%20asc",
                    "TopViewer"
                ),
                (
                    "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc",
                    "TopViewer"
                ),
            ]
        );
        parity_cases!(
            "web/site-adapters",
            WEB_MAPS,
            [(
                "https://fixtures.test/arcgis/MapServer?token=fixture&f=html",
                "ArcGIS MapServer"
            ),]
        );
    }

    /// Scripted adaptive probing mirrors the `web/generic-probing` padded
    /// shape at the core level: in-area probes report 256x256, everything
    /// else is missing. The program must terminate at the exact 512x512 grid.
    #[test]
    fn adaptive_padded_shape_resolves() {
        use dezoomify_core::Vec2d;
        use dezoomify_core::core::{DiscoverableGrid, DiscoverableStep, ObservationResult};

        let grid = DiscoverableGrid::new(
            dezoomify_core::core::StableId::new("test"),
            "http://127.0.0.1/tile.svg?x={{X}}&y={{Y}}".to_string(),
        );
        let mut step = grid.start();
        let mut probes = 0;
        loop {
            match step {
                DiscoverableStep::Probe { tile, continuation } => {
                    probes += 1;
                    assert!(probes < 100, "adaptive probing did not terminate");
                    let (x, y) = parse_probe(&tile.request.uri);
                    let result = if (0..2).contains(&x) && (0..2).contains(&y) {
                        ObservationResult::Available {
                            size: Vec2d { x: 256, y: 256 },
                        }
                    } else {
                        ObservationResult::Missing
                    };
                    step = continuation.submit(result).expect("submit");
                }
                DiscoverableStep::Resolved { grid, .. } => {
                    assert_eq!(grid.image_size(), Vec2d { x: 512, y: 512 });
                    assert_eq!(grid.count(), 4);
                    assert!(probes > 4, "expected multi-step probing, got {probes}");
                    return;
                }
                DiscoverableStep::Empty => panic!("padded shape resolved empty"),
                DiscoverableStep::Error(e) => panic!("adaptive error: {e:?}"),
            }
        }
    }

    fn parse_probe(uri: &str) -> (i64, i64) {
        let query = uri.split('?').nth(1).unwrap_or("");
        let mut x = -1;
        let mut y = -1;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            match k {
                "x" => x = v.parse().unwrap_or(-1),
                "y" => y = v.parse().unwrap_or(-1),
                _ => {}
            }
        }
        (x, y)
    }
}
