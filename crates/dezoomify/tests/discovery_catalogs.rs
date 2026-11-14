mod support;

use dezoomify::model::{JobInput, Options, ResourceResponse, Size};

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
