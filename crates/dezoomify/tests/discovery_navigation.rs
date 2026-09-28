use dezoomify::core::discovery::{
    DiscoveryError, DiscoveryInput, DiscoveryLimits, DiscoveryOperation, ResourceResponse,
};
use dezoomify::core::{DiscoveredEntry, DiscoveryCatalog, default_registry, registry_for};
use dezoomify::model::DiscoveryInputKind;

const PAGE: &str = "https://museum.test/viewer";
const FRAME: &[u8] = br#"<iframe src="/art"></iframe>"#;
const DZI: &[u8] =
    br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#;
const IIIF: &[u8] = br#"{"@context":"http://iiif.io/api/image/2/context.json","@id":"https://image.test/book","width":512,"height":512,"tiles":[{"width":256,"scaleFactors":[1,2]}]}"#;
const ZOOMIFY: &[u8] = br#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#;

fn observed(url: &str) -> DiscoveryInput {
    DiscoveryInput::new(url).with_kind(DiscoveryInputKind::ObservedResource)
}

fn start(inputs: impl Into<Vec<DiscoveryInput>>) -> DiscoveryOperation {
    default_registry().start_inputs(inputs.into())
}

fn supply(
    operation: &mut DiscoveryOperation,
    uri: &str,
    bytes: &[u8],
) -> Result<(), DiscoveryError> {
    let need = operation
        .next_priority_need()?
        .expect("expected metadata request");
    assert_eq!(need.request.uri, uri);
    operation.provide(ResourceResponse::new(need.id, bytes))
}

fn trace(mut operation: DiscoveryOperation, replies: &[(&str, &[u8])]) -> DiscoveryCatalog {
    for (uri, bytes) in replies {
        supply(&mut operation, uri, bytes).unwrap();
    }
    assert!(operation.missing_resources().unwrap().is_empty());
    operation.finish().unwrap()
}

fn image(operation: DiscoveryOperation, replies: &[(&str, &[u8])], format: &str) {
    let catalog = trace(operation, replies);
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("expected one image")
    };
    assert_eq!(image.format, format);
}

#[test]
fn declared_and_observed_metadata_precede_generic_frames() {
    for (url, bytes, format) in [
        ("https://image.test/art.dzi", DZI, "deepzoom"),
        ("https://image.test/book/info.json", IIIF, "iiif"),
    ] {
        let html = format!(r#"<iframe src="/art"></iframe><a href="{url}">Image</a>"#);
        image(
            start([
                DiscoveryInput::with_contents(PAGE, html),
                observed("https://image.test/preview/ImageProperties.xml"),
            ]),
            &[(url, bytes)],
            format,
        );
        image(
            start([
                observed("https://image.test/wmts/viewer"),
                observed(url),
                DiscoveryInput::with_contents(PAGE, FRAME),
            ]),
            &[(url, bytes)],
            format,
        );
    }
    for url in [
        "https://image.test/ImageProperties.xml?signature=test-double",
        "https://image.test/TileGroup0/1-0-0.jpg?signature=test-double",
    ] {
        let mut operation = start([DiscoveryInput::with_contents(PAGE, FRAME), observed(url)]);
        let need = operation.next_priority_need().unwrap().unwrap();
        assert!(
            need.request
                .uri
                .starts_with("https://image.test/ImageProperties.xml")
        );
        operation
            .provide(ResourceResponse::new(need.id, ZOOMIFY))
            .unwrap();
        image(operation, &[], "zoomify");
    }
}

#[test]
fn source_catalogs_and_readable_documents_precede_observed_previews() {
    let manifest = include_bytes!(
        "../../../testdata/scenarios/web/core-discovery/payloads/fixtures.test/iiif-presentation/manifest.json"
    );
    let preview = observed("https://image.test/TileGroup0/0-0-0.jpg");
    let catalog = trace(
        start([
            preview.clone(),
            DiscoveryInput::with_contents(PAGE, manifest.as_slice()),
        ]),
        &[],
    );
    assert!(
        catalog
            .entries()
            .iter()
            .any(|entry| matches!(entry, DiscoveredEntry::Deferred(_)))
    );
    image(
        start([
            DiscoveryInput::with_contents(PAGE, FRAME),
            preview,
            DiscoveryInput::with_contents("https://museum.test/child", DZI)
                .with_kind(DiscoveryInputKind::ObservedDocument),
        ]),
        &[],
        "deepzoom",
    );
}

#[test]
fn failed_duplicate_observations_leave_navigation_and_opaque_content_available() {
    let inputs = [
        DiscoveryInput::with_contents(PAGE, FRAME),
        observed("https://museum.test/opaque"),
        observed("https://museum.test/broken.dzi"),
        observed("https://museum.test/broken.dzi"),
    ];
    image(
        start(inputs),
        &[
            ("https://museum.test/broken.dzi", b"invalid"),
            ("https://museum.test/art", b"unrelated"),
            ("https://museum.test/opaque", DZI),
        ],
        "deepzoom",
    );
}

#[test]
fn sibling_pages_precede_deeper_navigation_but_follow_metadata_first() {
    for (first, destination, bytes, format) in [
        (
            br#"<iframe src="/deep"></iframe>"#.as_slice(),
            "https://museum.test/second",
            IIIF,
            "iiif",
        ),
        (
            br#"<a href="art.dzi">Image</a>"#.as_slice(),
            "https://museum.test/art.dzi",
            DZI,
            "deepzoom",
        ),
    ] {
        image(
            start([DiscoveryInput::new(PAGE)]),
            &[
                (
                    PAGE,
                    br#"<iframe src="/first"></iframe><iframe src="/second"></iframe>"#,
                ),
                ("https://museum.test/first", first),
                (destination, bytes),
            ],
            format,
        );
    }
}

#[test]
fn rejected_declared_metadata_preserves_iframe_fallback() {
    image(
        start([DiscoveryInput::with_contents(
            PAGE,
            br#"<a href="broken.dzi">Image</a><iframe src="/art"></iframe>"#.as_slice(),
        )]),
        &[
            ("https://museum.test/broken.dzi", b"invalid"),
            ("https://museum.test/art", DZI),
        ],
        "deepzoom",
    );
}

#[test]
fn redirects_entities_and_explicit_format_apply_to_navigation() {
    let mut operation = registry_for("deepzoom").unwrap().start_inputs(vec![
        DiscoveryInput::new(PAGE),
        observed("https://image.test/ImageProperties.xml"),
    ]);
    let need = operation.next_priority_need().unwrap().unwrap();
    operation
        .provide(
            ResourceResponse::new(
                need.id,
                br#"<iframe src="art?x=1&amp;y=2"></iframe>"#.as_slice(),
            )
            .with_final_uri("https://viewer.test/final/page"),
        )
        .unwrap();
    image(
        operation,
        &[("https://viewer.test/final/art?x=1&y=2", DZI)],
        "deepzoom",
    );
}

#[test]
fn local_paths_and_only_supported_iframe_sources_are_followed() {
    image(
        start([DiscoveryInput::new("/books/viewer.html")]),
        &[
            ("/books/viewer.html", br#"<iframe src="art"></iframe>"#),
            ("/books/art", DZI),
        ],
        "deepzoom",
    );
    let html = br#"<iframe data-src="/wrong"></iframe><iframe src=""></iframe><iframe src="javascript:void(0)"></iframe><iframe src="/art"></iframe>"#;
    image(
        start([DiscoveryInput::new(PAGE)]),
        &[(PAGE, html), ("https://museum.test/art", DZI)],
        "deepzoom",
    );
}

#[test]
fn navigation_cycles_and_resource_budgets_are_independent_of_parser_count() {
    for resources in [1, 2] {
        let mut operation = default_registry().start_with_limits(
            PAGE,
            DiscoveryLimits {
                resources,
                ..DiscoveryLimits::default()
            },
        );
        let result = supply(&mut operation, PAGE, FRAME);
        if resources == 1 {
            assert!(matches!(
                result,
                Err(DiscoveryError::NoCandidateAccepted { .. })
            ));
        } else {
            result.unwrap();
            image(operation, &[("https://museum.test/art", DZI)], "deepzoom");
        }
    }
    let mut operation = start([DiscoveryInput::with_contents(PAGE, FRAME)]);
    assert!(matches!(
        supply(
            &mut operation,
            "https://museum.test/art",
            br#"<iframe src="/viewer"></iframe><iframe src="/art"></iframe>"#
        ),
        Err(DiscoveryError::NoCandidateAccepted { .. })
    ));
}

#[test]
fn supplied_inputs_and_fetched_documents_share_limits() {
    let registry = default_registry();
    for (inputs, limits, expected) in [
        (
            vec![DiscoveryInput::new(PAGE); 2],
            DiscoveryLimits {
                resources: 1,
                ..DiscoveryLimits::default()
            },
            DiscoveryError::ResourceLimitExceeded,
        ),
        (
            vec![DiscoveryInput::with_contents(PAGE, FRAME)],
            DiscoveryLimits {
                retained_bytes: 1,
                ..DiscoveryLimits::default()
            },
            DiscoveryError::MetadataSizeLimitExceeded,
        ),
    ] {
        assert_eq!(
            registry
                .start_inputs_with_limits(inputs, limits)
                .missing_resources()
                .unwrap_err(),
            expected
        );
    }
    let mut operation = registry.start_inputs_with_limits(
        vec![DiscoveryInput::with_contents(PAGE, FRAME)],
        DiscoveryLimits {
            retained_bytes: DZI.len(),
            ..DiscoveryLimits::default()
        },
    );
    assert_eq!(
        supply(&mut operation, "https://museum.test/art", DZI),
        Err(DiscoveryError::MetadataSizeLimitExceeded)
    );
}
