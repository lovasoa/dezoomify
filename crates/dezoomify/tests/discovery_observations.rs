use dezoomify::core::discovery::{
    DiscoveryError, DiscoveryInput, DiscoveryLimits, DiscoveryOperation, ResourceResponse,
};
use dezoomify::core::{DiscoveredEntry, default_registry, registry_for};
use dezoomify::model::DiscoveryInputKind;

const PAGE: &str = "https://museum.test/viewer";
const HTML: &[u8] = br#"<iframe src="https://analytics.test/opt-out"></iframe>"#;
const XML: &[u8] = br#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#;
const DZI: &[u8] =
    br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#;

fn observed(url: &str) -> DiscoveryInput {
    DiscoveryInput::new(url).with_kind(DiscoveryInputKind::ObservedResource)
}

fn supply(operation: &mut DiscoveryOperation, uri: &str, bytes: &[u8]) {
    let needs = operation.missing_resources().unwrap();
    assert_eq!(needs.len(), 1, "{needs:?}");
    assert_eq!(needs[0].request.uri, uri);
    operation
        .provide(ResourceResponse::new(needs[0].id, bytes))
        .unwrap();
}

#[test]
fn recognized_resources_precede_unrelated_navigation_and_opaque_traffic() {
    for metadata in [
        "https://museum.test/image/ImageProperties.xml?signature=test-double",
        "https://museum.test/image/TileGroup0/1-0-0.jpg?signature=test-double",
    ] {
        let mut operation = default_registry(PAGE).start_inputs(vec![
            DiscoveryInput::with_contents(PAGE, HTML),
            observed("https://analytics.test/tracker.js"),
            observed(metadata),
        ]);
        let needs = operation.missing_resources().unwrap();
        assert!(
            needs
                .iter()
                .all(|need| need.request.uri.starts_with("https://museum.test/image/"))
        );
        let need = needs
            .iter()
            .find(|need| need.request.uri.contains("/image/ImageProperties.xml"))
            .unwrap();
        // A signed redirect does not change the original Zoomify tile base.
        operation
            .provide(
                ResourceResponse::new(need.id, XML)
                    .with_final_uri("https://cdn.test/signed/metadata?signature=test-double"),
            )
            .unwrap();
        assert!(operation.missing_resources().unwrap().is_empty());
        let catalog = operation.finish().unwrap();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("ready image")
        };
        assert_eq!(image.format, "zoomify");
        assert_eq!(
            image.levels.last().unwrap().source.image_size(),
            Some(dezoomify::Vec2d { x: 512, y: 512 })
        );
    }
}

#[test]
fn source_catalog_has_priority_over_observed_preview_even_if_inputs_are_reversed() {
    let manifest = include_bytes!(
        "../../../testdata/scenarios/web/core-discovery/payloads/fixtures.test/iiif-presentation/manifest.json"
    );
    let mut operation = default_registry(PAGE).start_inputs(vec![
        observed("https://museum.test/preview/TileGroup0/0-0-0.jpg"),
        DiscoveryInput::with_contents(PAGE, manifest.as_slice()),
    ]);
    assert!(operation.missing_resources().unwrap().is_empty());
    let catalog = operation.finish().unwrap();
    assert!(
        catalog
            .entries()
            .iter()
            .any(|entry| matches!(entry, DiscoveredEntry::Deferred(_)))
    );
}

#[test]
fn readable_child_document_precedes_resource_observations_and_navigation() {
    let mut operation = default_registry(PAGE).start_inputs(vec![
        DiscoveryInput::with_contents(PAGE, HTML),
        observed("https://museum.test/preview/ImageProperties.xml"),
        DiscoveryInput::with_contents("https://museum.test/child", DZI)
            .with_kind(DiscoveryInputKind::ObservedDocument),
    ]);
    assert!(operation.missing_resources().unwrap().is_empty());
    let catalog = operation.finish().unwrap();
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("ready image")
    };
    assert_eq!(image.format, "deepzoom");
}

#[test]
fn failed_recognition_retains_navigation_and_unknown_resources_as_fallbacks() {
    let mut operation = default_registry(PAGE).start_inputs(vec![
        DiscoveryInput::with_contents(PAGE, HTML),
        observed("https://museum.test/opaque"),
        observed("https://museum.test/broken/ImageProperties.xml"),
    ]);
    supply(
        &mut operation,
        "https://museum.test/broken/ImageProperties.xml",
        b"invalid",
    );
    supply(
        &mut operation,
        "https://analytics.test/opt-out",
        b"<html>unrelated</html>",
    );
    supply(&mut operation, "https://museum.test/opaque", DZI);
    assert!(operation.is_complete());
}

#[test]
fn duplicate_observations_reuse_outcomes_and_explicit_format_is_respected() {
    let mut operation = registry_for("deepzoom").unwrap().start_inputs(vec![
        DiscoveryInput::with_contents(PAGE, HTML),
        observed("https://museum.test/broken.dzi"),
        observed("https://museum.test/broken.dzi"),
        observed("https://museum.test/zoom/ImageProperties.xml"),
    ]);
    supply(&mut operation, "https://museum.test/broken.dzi", b"invalid");
    // Zoomify is not recognized in a Deep Zoom-only search.
    supply(&mut operation, "https://analytics.test/opt-out", DZI);
    assert!(operation.is_complete());
}

#[test]
fn supplied_documents_and_fetched_resources_share_one_byte_budget() {
    let mut operation = registry_for("deepzoom").unwrap().start_inputs_with_limits(
        vec![
            DiscoveryInput::with_contents(PAGE, b"unrecognized"),
            observed("https://museum.test/art.dzi"),
        ],
        DiscoveryLimits {
            retained_bytes: DZI.len(),
            ..DiscoveryLimits::default()
        },
    );
    let need = operation.missing_resources().unwrap().remove(0);
    assert!(matches!(
        operation.provide(ResourceResponse::new(need.id, DZI)),
        Err(DiscoveryError::MetadataSizeLimitExceeded)
    ));
}

#[test]
fn batch_inputs_are_bounded_before_discovery_begins() {
    let registry = default_registry(PAGE);
    let mut operation = registry.start_inputs_with_limits(
        vec![DiscoveryInput::new(PAGE); 2],
        DiscoveryLimits {
            resources: 1,
            ..DiscoveryLimits::default()
        },
    );
    assert!(matches!(
        operation.missing_resources(),
        Err(DiscoveryError::ResourceLimitExceeded)
    ));
    let mut operation = registry.start_inputs_with_limits(
        vec![DiscoveryInput::with_contents(PAGE, HTML)],
        DiscoveryLimits {
            retained_bytes: 1,
            ..DiscoveryLimits::default()
        },
    );
    assert!(matches!(
        operation.missing_resources(),
        Err(DiscoveryError::MetadataSizeLimitExceeded)
    ));
}
