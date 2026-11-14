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

#[test]
fn repeated_seadragon_embeds_offer_every_image() {
    let urls = links(
        "deepzoom",
        br#"<script>
        Seadragon.embed('first', 'viewer', 'first.dzi');
        Seadragon.embed('second', 'viewer', 'second.dzi');
    </script>"#,
    );
    assert_eq!(
        urls,
        [
            "https://museum.test/first.dzi",
            "https://museum.test/second.dzi"
        ]
    );
}

#[test]
fn repeated_topviewer_thumbnails_offer_every_image() {
    let urls = links(
        "topviewer",
        br#"<img src="https://images.memorix.nl/archive/thumb/path/first.jpg">
        <img src="https://images.memorix.nl/archive/thumb/path/second.jpg">
        <img src="https://images.memorix.nl/archive/thumb/path/first.jpg">"#,
    );
    assert_eq!(
        urls,
        [
            "https://images.memorix.nl/archive/topviewjson/memorix/first",
            "https://images.memorix.nl/archive/topviewjson/memorix/second",
        ]
    );
}

#[test]
fn every_matching_zoomify_element_offers_its_image() {
    let urls = links(
        "zoomify",
        br#"<div class="ete-openlayers-src">/first</div>
        <div class="ete-openlayers-src">/second</div>
        <url>/unrelated-fallback</url>"#,
    );
    assert_eq!(
        urls,
        [
            "https://museum.test/first/ImageProperties.xml",
            "https://museum.test/second/ImageProperties.xml"
        ]
    );
}

#[test]
fn different_reference_routes_share_duplicate_addresses() {
    let urls = links(
        "fsi",
        br#"<img src="/server?source=first&amp;type=image">
        <a href="/server?source=second&amp;type=image">second</a>
        <script>const duplicate = '/server?source=first&type=image';</script>"#,
    );
    assert_eq!(
        urls,
        [
            "https://museum.test/server?source=first&type=image",
            "https://museum.test/server?source=second&type=image"
        ]
    );
}

#[test]
fn empty_reference_elements_do_not_hide_valid_images() {
    let urls = links(
        "deepzoom",
        br#"<div dzi="/first"></div><div dzi=""></div><div dzi="/second"></div>"#,
    );
    assert_eq!(
        urls,
        ["https://museum.test/first", "https://museum.test/second"]
    );
}

fn links(format: &str, page: &[u8]) -> Vec<String> {
    let (catalog, _) = support::discover_inputs(
        registry_for(format).unwrap(),
        vec![DiscoveryInput::with_contents(
            "https://museum.test/object",
            page,
        )],
        Default::default(),
        |_| panic!("unselected images must not be fetched"),
    );
    catalog
        .unwrap()
        .into_entries()
        .into_iter()
        .map(|entry| match entry {
            DiscoveredEntry::Deferred(image) => image.uri,
            _ => panic!("expected image choices"),
        })
        .collect()
}
