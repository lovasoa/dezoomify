mod support;

use dezoomify::{
    core::{default_registry, discovery::DiscoveryInput},
    model::{JobInput, Options, ResourceResponse, Size},
};

#[test]
fn iiif_and_deep_zoom_images_on_the_same_page_are_both_offered() {
    let page_url = "https://museum.test/object";
    let iiif = "https://images.test/scan/info.json";
    let dzi = "https://images.test/other-scan.dzi";
    let page = format!(r#"<script>const scans = ["{iiif}", "{dzi}"];</script>"#);
    let dzi_metadata = br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="1024" Height="768"/></Image>"#;
    for (index, expected) in [
        (
            0,
            Size {
                width: 512,
                height: 512,
            },
        ),
        (
            1,
            Size {
                width: 1024,
                height: 768,
            },
        ),
    ] {
        let host = support::MemoryHost {
            resources: [
                (page_url, page.as_bytes()),
                (
                    iiif,
                    include_bytes!("../../../fixtures/iiif/v2/info.json").as_slice(),
                ),
                (dzi, dzi_metadata.as_slice()),
            ]
            .into_iter()
            .map(|(url, bytes)| {
                (
                    url.into(),
                    ResourceResponse {
                        bytes: bytes.to_vec(),
                        final_uri: None,
                    },
                )
            })
            .collect(),
            ..Default::default()
        };
        host.image.set(index);
        let output = futures::executor::block_on(dezoomify::dezoomify(
            vec![JobInput::new(page_url)],
            Options::default(),
            &host,
        ))
        .unwrap();
        assert_eq!(host.catalogs.borrow()[0].entries.len(), 2);
        assert_eq!(output.canvas, Some(expected));
    }
}

#[test]
fn embedded_images_from_different_formats_remain_selectable() {
    let metadata = include_str!("../../../fixtures/iiif/v2/info.json");
    let page = format!(
        r#"<script type="application/json">{metadata}</script>
        <script>const scan = {{"TileSize":256,"Overlap":0,"Format":"jpg",
            "Url":"https://images.test/other_files/","Size":{{"Width":1024,"Height":768}}}};</script>"#
    );
    let (catalog, _) = support::discover_inputs(
        default_registry(),
        vec![DiscoveryInput::with_contents(
            "https://museum.test/object",
            page,
        )],
        Default::default(),
        |_| panic!("both images are described in the page"),
    );
    assert_eq!(catalog.unwrap().len(), 2);
}

#[test]
fn the_same_catalog_found_on_two_pages_appears_once() {
    let page = br#"<script>const scan = 'https://images.test/image.dzi';</script>"#;
    let (catalog, _) = support::discover_inputs(
        default_registry(),
        ["https://museum.test/first", "https://museum.test/second"]
            .into_iter()
            .map(|url| DiscoveryInput::with_contents(url, page))
            .collect(),
        Default::default(),
        |_| {
            Some(Ok((
                include_bytes!("../../../fixtures/deepzoom/basic/image.dzi").to_vec(),
                None,
            )))
        },
    );
    assert_eq!(catalog.unwrap().len(), 1);
}

#[test]
fn overlapping_catalogs_offer_each_shared_image_once() {
    let first = include_str!("../../../fixtures/iiif/catalog/manifest.json");
    let second = first.replace("\"second\"", "\"third\"");
    let (catalog, _) = support::discover_inputs(
        default_registry(),
        vec![
            DiscoveryInput::with_contents("https://museum.test/one.json", first),
            DiscoveryInput::with_contents("https://museum.test/two.json", second),
        ],
        Default::default(),
        |_| panic!("image metadata is resolved after selection"),
    );
    let urls: Vec<_> = catalog
        .unwrap()
        .into_entries()
        .into_iter()
        .map(|entry| match entry {
            dezoomify::core::DiscoveredEntry::Deferred(image) => image.uri,
            _ => panic!("expected image choices"),
        })
        .collect();
    assert_eq!(
        urls,
        [
            "https://museum.test/first/info.json",
            "https://museum.test/second/info.json",
            "https://museum.test/third/info.json"
        ]
    );
}
