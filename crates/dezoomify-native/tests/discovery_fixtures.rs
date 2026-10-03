//! Historical viewer/metadata regressions use the same Node origin as products.
use dezoomify::core::discovery::{DiscoveryInput, DiscoveryLimits};
use dezoomify::core::{default_registry, DiscoveredEntry, Grid, ResolvedLevel, TileSource};
use dezoomify::model::{Error, ResourceRead, ResourceResponse};
mod support;

fn grid(level: &ResolvedLevel) -> Option<&Grid> {
    match &level.source {
        TileSource::Grid(grid) => Some(grid),
        TileSource::Adaptive(source) => source.declared_grid(),
        _ => None,
    }
}

#[test]
fn historical_inputs_preserve_geometry_and_addressed_tiles() {
    let origin = support::start_fixture_server();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _entered = runtime.enter();
    let client = reqwest::Client::new();
    let registry = default_registry();
    for (input, format, width, height, count, first, last) in [
        (
            "https://fixtures.test/zoomify/ImageProperties.xml",
            "zoomify",
            512,
            512,
            4,
            "https://fixtures.test/zoomify/TileGroup0/1-0-0.jpg",
            "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
        ),
        (
            "https://fixtures.test/zoomify-base-href/product.html",
            "zoomify",
            512,
            512,
            4,
            "https://fixtures.test/zoomify-base-href/assets/maps/sample/TileGroup0/1-0-0.jpg",
            "https://fixtures.test/zoomify-base-href/assets/maps/sample/TileGroup0/1-1-1.jpg",
        ),
        (
            "https://fixtures.test/deepzoom/sample.dzi",
            "deepzoom",
            512,
            512,
            4,
            "https://fixtures.test/deepzoom/sample_files/9/0_0.jpg",
            "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
        ),
        (
            "https://fixtures.test/deepzoom/png_files/9/1_1.png",
            "deepzoom",
            512,
            512,
            4,
            "https://fixtures.test/deepzoom/png_files/9/0_0.png",
            "https://fixtures.test/deepzoom/png_files/9/1_1.png",
        ),
        (
            "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
            "deepzoom",
            512,
            512,
            4,
            "https://fixtures.test/deepzoom/jpeg_files/9/0_0.jpeg",
            "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
        ),
        (
            "https://fixtures.test/deepzoom/legacy-embed.html",
            "deepzoom",
            512,
            512,
            4,
            "https://fixtures.test/deepzoom/legacy_files/9/0_0.jpg",
            "https://fixtures.test/deepzoom/legacy_files/9/1_1.jpg",
        ),
        (
            "http://127.0.0.1/fixtures/iiif-v2/info.json",
            "iiif",
            512,
            512,
            4,
            "http://127.0.0.1:PORT/iiif/v2/0,0,256,256/256,256/0/native.png",
            "http://127.0.0.1:PORT/iiif/v2/256,256,256,256/256,256/0/native.png",
        ),
        (
            "https://fixtures.test/iip?FIF=/image.tif",
            "iipimage",
            512,
            512,
            4,
            "https://fixtures.test/iip?FIF=/image.tif&JTL=1,0",
            "https://fixtures.test/iip?FIF=/image.tif&JTL=1,3",
        ),
        (
            "https://fixtures.test/krpano/pano.xml",
            "krpano",
            512,
            512,
            4,
            "https://fixtures.test/krpano/tiles/l1/1_1.jpg",
            "https://fixtures.test/krpano/tiles/l1/2_2.jpg",
        ),
        (
            "https://fixtures.test/xl/sample.imgi?cmd=info",
            "xlimage",
            512,
            512,
            4,
            "https://fixtures.test/xl/sample.imgi?cmd=tile&x=0&y=0&z=1",
            "https://fixtures.test/xl/sample.imgi?cmd=tile&x=1&y=1&z=1",
        ),
        (
            "https://fixtures.test/topviewer/data.json",
            "topviewer",
            512,
            512,
            4,
            "http://127.0.0.1:PORT/topviewer/sample-file/10.jpg",
            "http://127.0.0.1:PORT/topviewer/sample-file/13.jpg",
        ),
        (
            "https://fixtures.test/fsi/server?type=info&source=image&image=image",
            "fsi",
            512,
            512,
            1,
            "https://fixtures.test/fsi/server?type=image&source=image&width=512&height=512&rect=0,0,1,1",
            "https://fixtures.test/fsi/server?type=image&source=image&width=512&height=512&rect=0,0,1,1",
        ),
        (
            "https://fixtures.test/lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true",
            "lizardtech",
            1024,
            1024,
            4,
            "https://fixtures.test/lizardtech/iserv/getimage?cat=North%20America%20and%20United%20States&item=NorthAmerica%2FUS1566a.sid&wid=512&hei=512&oif=jpeg&lev=0&cp=0.25,0.25",
            "https://fixtures.test/lizardtech/iserv/getimage?cat=North%20America%20and%20United%20States&item=NorthAmerica%2FUS1566a.sid&wid=512&hei=512&oif=jpeg&lev=0&cp=0.75,0.75",
        ),
        (
            "https://fixtures.test/vls/zoom/1",
            "vls",
            512,
            512,
            1,
            "https://fixtures.test/image/tiler/square/fixture/0/0/0",
            "https://fixtures.test/image/tiler/square/fixture/0/0/0",
        ),
        (
            "https://fixtures.test/hungaricana/imagesize/sample.ecw",
            "hungaricana",
            512,
            512,
            1,
            "https://fixtures.test/hungaricana/image/sample.ecw/eead7a64b71d28891bac75371a7dac53",
            "https://fixtures.test/hungaricana/image/sample.ecw/eead7a64b71d28891bac75371a7dac53",
        ),
        (
            "https://fixtures.test/wmts/WMTSCapabilities.xml",
            "wmts",
            2816,
            2816,
            121,
            "http://127.0.0.1:PORT/wmts/EPSG3857/0/0/0.jpg",
            "http://127.0.0.1:PORT/wmts/EPSG3857/0/10/10.jpg",
        ),
        (
            "https://fixtures.test/arcgis/MapServer",
            "arcgis",
            768,
            768,
            9,
            "https://fixtures.test/arcgis/MapServer/tile/7/1/2",
            "https://fixtures.test/arcgis/MapServer/tile/7/3/4",
        ),
        (
            "https://fixtures.test/iiif-v3/info.json",
            "iiif",
            512,
            512,
            4,
            "http://127.0.0.1:PORT/iiif/v3/0,0,256,256/256,256/0/default.jpg",
            "http://127.0.0.1:PORT/iiif/v3/256,256,256,256/256,256/0/default.jpg",
        ),
        (
            "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
            "iiif",
            512,
            512,
            4,
            "http://127.0.0.1:PORT/iiif/onb/10048A37/uk4nGb4kQHe3msbC/0,0,256,256/256,256/0/default.jpg",
            "http://127.0.0.1:PORT/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg",
        ),
        (
            "https://fixtures.test/deepzoom/iframe-parent.html",
            "deepzoom",
            512,
            512,
            4,
            "https://fixtures.test/deepzoom/sample_files/9/0_0.jpg",
            "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
        ),
        (
            "https://fixtures.test/arcgis/MapServer?token=fixture&f=html",
            "arcgis",
            768,
            768,
            9,
            "https://fixtures.test/arcgis/MapServer/tile/7/1/2?token=fixture",
            "https://fixtures.test/arcgis/MapServer/tile/7/3/4?token=fixture",
        ),
        (
            "https://fixtures.test/zoomify/flash.html",
            "zoomify",
            512,
            512,
            4,
            "https://fixtures.test/zoomify/TileGroup0/1-0-0.jpg",
            "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
        ),
        (
            "https://biblio.unibe.ch/web-apps/maps/zoomify.php?col=ryh&pic=Ryh_7906_6",
            "zoomify",
            512,
            512,
            4,
            "https://biblio.unibe.ch/zoomify/TileGroup0/1-0-0.jpg",
            "https://biblio.unibe.ch/zoomify/TileGroup0/1-1-1.jpg",
        ),
        (
            "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
            "zoomify",
            512,
            512,
            4,
            "https://www.ngv.vic.gov.au/zoomify/TileGroup0/1-0-0.jpg",
            "https://www.ngv.vic.gov.au/zoomify/TileGroup0/1-1-1.jpg",
        ),
        (
            "https://fixtures.test/zoomify/iframe-parent.html",
            "zoomify",
            512,
            512,
            4,
            "https://fixtures.test/zoomify/TileGroup0/1-0-0.jpg",
            "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
        ),
    ] {
        let mut current = input.to_string();
        let mut image = None;
        for _ in 0..3 {
            let catalog = runtime
                .block_on(registry.discover(
                    vec![DiscoveryInput::new(&current)],
                    DiscoveryLimits::default(),
                    |request, _| {
                        let client = &client;
                        let origin = &origin;
                        async move {
                            let response = client
                                .get(dezoomify_fixture_server::replay_url(origin, &request.uri))
                                .send()
                                .await
                                .and_then(reqwest::Response::error_for_status)
                                .map_err(|error| Error::DiscoveryFailed {
                                    failure: error.to_string().into(),
                                    cause: None,
                                })?;
                            Ok(ResourceRead::Response {
                                response: ResourceResponse {
                                    bytes: response.bytes().await.unwrap().to_vec(),
                                    final_uri: None,
                                },
                            })
                        }
                    },
                ))
                .unwrap_or_else(|error| panic!("{input}: {error:?}"));
            match catalog.into_entries().into_iter().next().expect(input) {
                DiscoveredEntry::Ready(ready) => {
                    image = Some(ready);
                    break;
                }
                DiscoveredEntry::Deferred(next) => current = next.uri,
            }
        }
        let image = image.expect("deferred resolution exhausted");
        assert_eq!(image.format, format, "{input}");
        let level = image
            .levels
            .iter()
            .find(|level| {
                grid(level).is_some_and(|grid| {
                    let size = grid.image_size();
                    size.x == width && size.y == height
                })
            })
            .expect(input);
        let tiles: Vec<_> = grid(level)
            .unwrap()
            .tiles_row_major()
            .map(|tile| tile.unwrap().request.uri)
            .collect();
        assert_eq!(tiles.len(), count, "{input}");
        let normalize = |uri: &str| uri.replace("http://127.0.0.1:PORT", &origin);
        assert_eq!(tiles.first().unwrap(), &normalize(first), "{input}");
        assert_eq!(tiles.last().unwrap(), &normalize(last), "{input}");
    }
}
