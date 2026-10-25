mod support;

use dezoomify::core::discovery::{DiscoveryInput, DiscoveryLimits};
use dezoomify::core::{default_registry, registry_for};
use dezoomify::model::DiscoveryInputKind;

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

#[test]
fn emuseum_viewers_supply_geometry_without_info_json() {
    // Issue #1296: distilled from the Asian Art Museum's public viewer HAR.
    let viewer =
        "https://searchcollection.asianart.org/objects/13529/the-sixth-sikh-guru-hargobind-singh";
    let service = "https://searchcollection.asianart.org/internal/media/zoomdispatcher/78199";
    let page = br#"<script>require(["t5/core/pageinit"], function(pi) {
        pi([], [["emuseum/MediaZoom:init",1819,2500,"/internal/media/zoomdispatcher/78199",256,2]]);
    });</script>"#;
    for input in [
        DiscoveryInput::new(viewer),
        DiscoveryInput::with_contents(viewer, page.as_slice())
            .with_kind(DiscoveryInputKind::ObservedDocument),
    ] {
        let (catalog, requests) = support::discover_inputs(
            default_registry(),
            vec![input],
            DiscoveryLimits::default(),
            |uri| (uri == viewer).then(|| Ok((page.to_vec(), None))),
        );
        let image = support::ready_image(catalog.unwrap());
        assert_eq!(image.format, "iiif");
        assert_eq!(image.source_url.as_deref(), Some(viewer));
        let level = image.levels.last().unwrap();
        assert_eq!(
            level.source.image_size(),
            Some(dezoomify::Vec2d { x: 1819, y: 2500 })
        );
        let tiles = support::tile_urls(level).unwrap();
        assert_eq!(tiles.len(), 80);
        assert_eq!(
            tiles[0],
            format!("{service}/0,0,256,256/256,/0/default.jpg")
        );
        assert_eq!(
            tiles[79],
            format!("{service}/1792,2304,27,196/27,/0/default.jpg")
        );
        let half = support::tile_urls(&image.levels[2]).unwrap();
        assert_eq!(
            half[3],
            format!("{service}/1536,0,283,512/142,/0/default.jpg")
        );
        assert!(requests.iter().all(|request| request.uri == viewer));
    }
}

#[test]
fn gallica_viewers_resolve_the_selected_page_without_fetching_html() {
    // Issue #1292: Gallica's viewer does not expose an info.json link. Its
    // public IIIF 1.1 service supplies dimensions without an explicit tile grid.
    for (viewer, service) in [
        (
            "https://gallica.bnf.fr/ark:/12148/btv1b530411200/f1.item.r=wien.zoom",
            "https://gallica.bnf.fr/iiif/ark:/12148/btv1b530411200/f1",
        ),
        (
            "https://gallica.bnf.fr/ark:/12148/btv1b84911377/f1.item.r=wien.zoom",
            "https://gallica.bnf.fr/iiif/ark:/12148/btv1b84911377/f1",
        ),
        (
            "http://gallica.bnf.fr/ark:/12148/btv1b530411200",
            "https://gallica.bnf.fr/iiif/ark:/12148/btv1b530411200/f1",
        ),
        (
            "https://gallica.bnf.fr/ark:/12148/btv1b530411200/f12.item.zoom?lang=FR#viewer",
            "https://gallica.bnf.fr/iiif/ark:/12148/btv1b530411200/f12",
        ),
    ] {
        let info_url = format!("{service}/info.json");
        let metadata = serde_json::json!({
            "profile": "http://library.stanford.edu/iiif/image-api/1.1/compliance.html#level2",
            "width": 7894,
            "height": 6094,
            "@context": "http://library.stanford.edu/iiif/image-api/1.1/context.json",
            "@id": service,
        });
        for input in [
            DiscoveryInput::new(viewer),
            DiscoveryInput::with_contents(viewer, b"<html><body>Gallica viewer</body></html>")
                .with_kind(DiscoveryInputKind::ObservedDocument),
        ] {
            let (catalog, requests) = support::discover_inputs(
                default_registry(),
                vec![input],
                DiscoveryLimits::default(),
                |uri| (uri == info_url).then(|| Ok((metadata.to_string().into_bytes(), None))),
            );
            let image = support::ready_image(catalog.unwrap());
            assert_eq!(image.format, "iiif");
            assert_eq!(image.source_url.as_deref(), Some(info_url.as_str()));
            let level = image.levels.last().unwrap();
            assert_eq!(
                level.source.image_size(),
                Some(dezoomify::Vec2d { x: 7894, y: 6094 })
            );
            assert_eq!(
                support::tile_urls(level).unwrap()[0],
                format!("{service}/0,0,512,512/512,512/0/native.jpg")
            );
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].uri, info_url);
        }
    }
}
