mod support;

use dezoomify::core::discovery::{DiscoveryInput, DiscoveryLimits};
use dezoomify::core::{default_registry, registry_for};

const PAGE: &str = "https://museum.test/exhibit/viewer";

#[test]
fn unrelated_image_metadata_leaves_other_formats_discoverable() {
    for metadata in [
        r#"{"width":512,"height":512}"#,
        r#"{"@context":"https://schema.org","@type":"ImageObject","@id":"https://museum.test/thumb.jpg","width":512,"height":512}"#,
        r#"{"type":"ImageProfile","@context":"http://iiif.io/api/image/3/context.json","width":512,"height":512}"#,
        r#"{"type":"Product","items":[{"type":"Canvas","items":[]}],"width":512,"height":512}"#,
    ] {
        let page = format!(
            r#"<script type="application/ld+json">{metadata}</script><script>const image='/art.dzi';</script>"#
        );
        let (catalog, _) = support::discover_inputs(
            default_registry(),
            vec![DiscoveryInput::with_contents(PAGE, page)],
            DiscoveryLimits::default(),
            |uri| {
                (uri == "https://museum.test/art.dzi").then(|| Ok((
                br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#.to_vec(),
                None,
            )))
            },
        );
        assert_eq!(support::ready_image(catalog.unwrap()).format, "deepzoom");
    }
}

#[test]
fn minimal_v1_metadata_requires_an_explicit_info_url() {
    let metadata = br#"{"identifier":"map","width":512,"height":512}"#;
    for (uri, accepted) in [
        ("https://images.test/map/info.json", true),
        ("https://images.test/unrelated.json", false),
    ] {
        let (catalog, _) = support::discover_inputs(
            registry_for("iiif").unwrap(),
            vec![DiscoveryInput::with_contents(uri, metadata.as_slice())],
            DiscoveryLimits::default(),
            |_| None,
        );
        assert_eq!(catalog.is_ok(), accepted);
    }
}
