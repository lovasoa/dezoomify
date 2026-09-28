use dezoomify::core::discovery::{
    DiscoveryError, DiscoveryLimits, DiscoveryOperation, ResourceResponse,
};
use dezoomify::core::{DiscoveredEntry, default_registry, registry_for};

const DZI: &[u8] =
    br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#;
const IIIF: &[u8] = br#"{"@context":"http://iiif.io/api/image/2/context.json","@id":"https://image.test/book","width":512,"height":512,"tiles":[{"width":256,"scaleFactors":[1,2]}]}"#;

fn supply(operation: &mut DiscoveryOperation, expected: &str, bytes: &[u8]) {
    let needs = operation.missing_resources().unwrap();
    assert_eq!(needs.len(), 1, "unexpected requests: {needs:?}");
    assert_eq!(needs[0].request.uri, expected);
    operation
        .provide(ResourceResponse::new(needs[0].id, bytes))
        .unwrap();
}

fn assert_format(operation: DiscoveryOperation, expected: &str) {
    let catalog = operation.finish().unwrap();
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("expected one ready image")
    };
    assert_eq!(image.format, expected);
}

#[test]
fn format_references_finish_before_generic_iframes_are_requested() {
    for (link, bytes, format) in [
        ("https://image.test/art.dzi", DZI, "deepzoom"),
        ("https://image.test/book/info.json", IIIF, "iiif"),
    ] {
        let page = "https://museum.test/viewer";
        let mut operation = default_registry(page).start(page);
        supply(&mut operation, page, format!(
            r#"<iframe src="https://analytics.test/opt-out"></iframe><a href="{link}">Image</a>"#
        ).as_bytes());
        supply(&mut operation, link, bytes);
        assert!(operation.missing_resources().unwrap().is_empty());
        assert_format(operation, format);
    }
}

#[test]
fn generic_navigation_tries_sibling_frames_and_detects_any_registered_format() {
    let page = "https://museum.test/viewer";
    let mut operation = default_registry(page).start(page);
    supply(
        &mut operation,
        page,
        br#"<iframe src="/analytics"></iframe><iframe src="/art"></iframe>"#,
    );
    supply(
        &mut operation,
        "https://museum.test/analytics",
        b"<html>Unrelated page</html>",
    );
    // The iframe is IIIF, even though Zoomify occurs earlier in the registry.
    supply(&mut operation, "https://museum.test/art", IIIF);
    assert_format(operation, "iiif");
}

#[test]
fn invalid_format_metadata_retains_generic_navigation_fallback() {
    let page = "https://museum.test/viewer";
    let mut operation = default_registry(page).start(page);
    supply(
        &mut operation,
        page,
        br#"<a href="broken.dzi">Image</a><iframe src="/art"></iframe>"#,
    );
    supply(
        &mut operation,
        "https://museum.test/broken.dzi",
        b"invalid metadata",
    );
    supply(&mut operation, "https://museum.test/art", DZI);
    assert_format(operation, "deepzoom");
}

#[test]
fn navigation_resolves_redirects_and_entities_and_respects_explicit_format() {
    let page = "https://museum.test/viewer";
    let mut operation = registry_for("deepzoom").unwrap().start(page);
    let need = operation.missing_resources().unwrap().remove(0);
    operation
        .provide(
            ResourceResponse::new(
                need.id,
                br#"<iframe src="art?x=1&amp;y=2"></iframe>"#.as_slice(),
            )
            .with_final_uri("https://viewer.test/final/page"),
        )
        .unwrap();
    supply(&mut operation, "https://viewer.test/final/art?x=1&y=2", DZI);
    assert_format(operation, "deepzoom");
}

#[test]
fn navigation_is_bounded_and_does_not_repeat_cycles() {
    let page = "https://museum.test/viewer";
    let mut operation = default_registry(page).start(page);
    supply(&mut operation, page, br#"<iframe src="/child"></iframe>"#);
    let need = operation.missing_resources().unwrap().remove(0);
    assert_eq!(need.request.uri, "https://museum.test/child");
    let result = operation.provide(ResourceResponse::new(
        need.id,
        br#"<iframe src="/viewer"></iframe><iframe src="/child"></iframe>"#.as_slice(),
    ));
    assert!(matches!(
        result,
        Err(DiscoveryError::NoCandidateAccepted { .. })
    ));

    let mut operation = default_registry(page).start_with_limits(
        page,
        DiscoveryLimits {
            resources: 1,
            ..DiscoveryLimits::default()
        },
    );
    let need = operation.missing_resources().unwrap().remove(0);
    let result = operation.provide(ResourceResponse::new(
        need.id,
        br#"<iframe src="/child"></iframe>"#.as_slice(),
    ));
    assert!(matches!(
        result,
        Err(DiscoveryError::NoCandidateAccepted { .. })
    ));
}

#[test]
fn native_local_pages_keep_relative_navigation() {
    let page = "/books/viewer.html";
    let mut operation = default_registry(page).start(page);
    supply(&mut operation, page, br#"<iframe src="art"></iframe>"#);
    supply(&mut operation, "/books/art", DZI);
    assert_format(operation, "deepzoom");
}

#[test]
fn generic_navigation_ignores_non_sources_and_unsupported_schemes() {
    let page = "https://museum.test/viewer";
    let mut operation = default_registry(page).start(page);
    supply(&mut operation, page, br#"<iframe data-src="/wrong"></iframe><iframe src=""></iframe><iframe src="javascript:void(0)"></iframe><iframe src="/art"></iframe>"#);
    supply(&mut operation, "https://museum.test/art", DZI);
    assert_format(operation, "deepzoom");
}
