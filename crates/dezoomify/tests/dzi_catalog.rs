mod support;

use dezoomify::{
    core::{DiscoveredEntry, discovery::DiscoveryInput, registry_for},
    model::Size,
};

#[test]
fn every_distinct_dzi_link_can_be_selected() {
    let page = br#"<base href="https://images.test/scans/">
        <script>const scans = ["small.dzi", "large.dzi?key=a&amp;b=c", "small.dzi"];</script>"#;
    let (catalog, _) = support::discover_inputs(
        registry_for("deepzoom").unwrap(),
        vec![DiscoveryInput::with_contents(
            "https://museum.test/object",
            page,
        )],
        Default::default(),
        |_| panic!("image links are resolved after selection"),
    );
    let entries = catalog.unwrap().into_entries();
    let urls: Vec<_> = entries
        .iter()
        .map(|entry| match entry {
            DiscoveredEntry::Deferred(image) => image.uri.as_str(),
            _ => panic!("expected selectable image links"),
        })
        .collect();
    assert_eq!(
        urls,
        [
            "https://images.test/scans/small.dzi",
            "https://images.test/scans/large.dzi?key=a&b=c",
        ]
    );
    for (url, width) in urls.into_iter().zip([2480, 4603]) {
        let metadata = format!(
            r#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="{width}" Height="1628"/></Image>"#
        );
        let (selected, _) = support::discover_resources(
            registry_for("deepzoom").unwrap(),
            url,
            &[(url, metadata.as_bytes())],
        );
        let image = support::ready_image(selected.unwrap());
        assert_eq!(
            dezoomify::model::Image::from(&image).size,
            Some(Size {
                width,
                height: 1628
            })
        );
    }
}
