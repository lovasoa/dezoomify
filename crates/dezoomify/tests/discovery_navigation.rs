use dezoomify::core::discovery::{DiscoveryError, DiscoveryInput, DiscoveryLimits};
use dezoomify::core::{
    DiscoveredEntry, DiscoveryCatalog, Registry, default_registry, registry_for,
};
use dezoomify::model::{DiscoveryInputKind, Error, ResourceRead, ResourceResponse};
use std::cell::RefCell;

const PAGE: &str = "https://museum.test/viewer";
const FRAME: &[u8] = br#"<iframe src="/art"></iframe>"#;
const DZI: &[u8] =
    br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#;
const IIIF:&[u8]=br#"{"@context":"http://iiif.io/api/image/2/context.json","@id":"https://image.test/book","width":512,"height":512,"tiles":[{"width":256,"scaleFactors":[1,2]}]}"#;
const ZOOMIFY:&[u8]=br#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#;
fn observed(url: &str) -> DiscoveryInput {
    DiscoveryInput::new(url).with_kind(DiscoveryInputKind::ObservedResource)
}
fn lookup(
    registry: Registry,
    inputs: Vec<DiscoveryInput>,
    replies: &[(&str, &[u8])],
    limits: DiscoveryLimits,
    redirect: Option<&str>,
) -> Result<DiscoveryCatalog, DiscoveryError> {
    let requested = RefCell::new(Vec::new());
    let result = futures::executor::block_on(registry.discover(inputs, limits, |request, _| {
        requested.borrow_mut().push(request.uri.clone());
        let found = replies
            .iter()
            .find(|(uri, _)| *uri == request.uri)
            .map(|(_, bytes)| ResourceRead::Response {
                response: ResourceResponse {
                    bytes: bytes.to_vec(),
                    final_uri: if request.uri == PAGE {
                        redirect.map(str::to_owned)
                    } else {
                        None
                    },
                },
            });
        async move {
            found.ok_or_else(|| Error::DiscoveryFailed {
                detail: Some(format!("no fixture: {}", request.uri)),
                cause: None,
            })
        }
    }));
    let requests = requested.borrow();
    for uri in requests.iter() {
        assert_eq!(
            requests
                .iter()
                .filter(|candidate| *candidate == uri)
                .count(),
            1,
            "resource reads are shared: {uri}"
        );
    }
    result
}
fn trace(inputs: Vec<DiscoveryInput>, replies: &[(&str, &[u8])]) -> DiscoveryCatalog {
    lookup(
        default_registry(),
        inputs,
        replies,
        Default::default(),
        None,
    )
    .unwrap()
}
fn image(inputs: Vec<DiscoveryInput>, replies: &[(&str, &[u8])], format: &str) {
    let catalog = trace(inputs, replies);
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("one ready image expected")
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
            vec![
                DiscoveryInput::with_contents(PAGE, html),
                observed("https://image.test/preview/ImageProperties.xml"),
            ],
            &[(url, bytes)],
            format,
        );
        image(
            vec![
                observed("https://image.test/wmts/viewer"),
                observed(url),
                DiscoveryInput::with_contents(PAGE, FRAME),
            ],
            &[(url, bytes)],
            format,
        );
    }
    for url in [
        "https://image.test/ImageProperties.xml?signature=test-double",
        "https://image.test/TileGroup0/1-0-0.jpg?signature=test-double",
    ] {
        image(
            vec![DiscoveryInput::with_contents(PAGE, FRAME), observed(url)],
            &[(
                "https://image.test/ImageProperties.xml?signature=test-double",
                ZOOMIFY,
            )],
            "zoomify",
        );
    }
}
#[test]
fn source_catalogs_and_readable_documents_precede_observed_previews() {
    let manifest = include_bytes!(
        "../../../testdata/scenarios/web/core-discovery/payloads/fixtures.test/iiif-presentation/manifest.json"
    );
    let preview = observed("https://image.test/TileGroup0/0-0-0.jpg");
    let catalog = trace(
        vec![
            preview.clone(),
            DiscoveryInput::with_contents(PAGE, manifest.as_slice()),
        ],
        &[],
    );
    assert!(
        catalog
            .entries()
            .iter()
            .any(|e| matches!(e, DiscoveredEntry::Deferred(_)))
    );
    image(
        vec![
            DiscoveryInput::with_contents(PAGE, FRAME),
            preview,
            DiscoveryInput::with_contents("https://museum.test/child", DZI)
                .with_kind(DiscoveryInputKind::ObservedDocument),
        ],
        &[],
        "deepzoom",
    );
}
#[test]
fn failed_duplicate_observations_leave_navigation_and_opaque_content_available() {
    image(
        vec![
            DiscoveryInput::with_contents(PAGE, FRAME),
            observed("https://museum.test/opaque"),
            observed("https://museum.test/broken.dzi"),
            observed("https://museum.test/broken.dzi"),
        ],
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
            vec![DiscoveryInput::new(PAGE)],
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
        vec![DiscoveryInput::with_contents(
            PAGE,
            br#"<a href="broken.dzi">Image</a><iframe src="/art"></iframe>"#.as_slice(),
        )],
        &[
            ("https://museum.test/broken.dzi", b"invalid"),
            ("https://museum.test/art", DZI),
        ],
        "deepzoom",
    );
}
#[test]
fn redirects_entities_and_explicit_format_apply_to_navigation() {
    let catalog = lookup(
        registry_for("deepzoom").unwrap(),
        vec![
            DiscoveryInput::new(PAGE),
            observed("https://image.test/ImageProperties.xml"),
        ],
        &[
            (PAGE, br#"<iframe src="art?x=1&amp;y=2"></iframe>"#),
            ("https://viewer.test/final/art?x=1&y=2", DZI),
        ],
        Default::default(),
        Some("https://viewer.test/final/page"),
    )
    .unwrap();
    assert!(
        matches!(&catalog.entries()[0],DiscoveredEntry::Ready(image) if image.format=="deepzoom")
    );
}
#[test]
fn local_paths_and_only_supported_iframe_sources_are_followed() {
    image(
        vec![DiscoveryInput::new("/books/viewer.html")],
        &[
            ("/books/viewer.html", br#"<iframe src="art"></iframe>"#),
            ("/books/art", DZI),
        ],
        "deepzoom",
    );
    let html=br#"<iframe data-src="/wrong"></iframe><iframe src=""></iframe><iframe src="javascript:void(0)"></iframe><iframe src="/art"></iframe>"#;
    image(
        vec![DiscoveryInput::new(PAGE)],
        &[(PAGE, html), ("https://museum.test/art", DZI)],
        "deepzoom",
    );
}
#[test]
fn navigation_cycles_and_resource_budgets_are_independent_of_parser_count() {
    for resources in [1, 2] {
        let result = lookup(
            default_registry(),
            vec![DiscoveryInput::new(PAGE)],
            &[(PAGE, FRAME), ("https://museum.test/art", DZI)],
            DiscoveryLimits {
                resources,
                ..Default::default()
            },
            None,
        );
        assert_eq!(result.is_ok(), resources == 2);
    }
    assert!(
        lookup(
            default_registry(),
            vec![DiscoveryInput::with_contents(PAGE, FRAME)],
            &[(
                "https://museum.test/art",
                br#"<iframe src="/viewer"></iframe><iframe src="/art"></iframe>"#
            )],
            Default::default(),
            None
        )
        .is_err()
    );
}
#[test]
fn supplied_inputs_and_fetched_documents_share_limits() {
    for (inputs, limits, expected) in [
        (
            vec![DiscoveryInput::new(PAGE); 2],
            DiscoveryLimits {
                resources: 1,
                ..Default::default()
            },
            DiscoveryError::ResourceLimitExceeded,
        ),
        (
            vec![DiscoveryInput::with_contents(PAGE, FRAME)],
            DiscoveryLimits {
                retained_bytes: 1,
                ..Default::default()
            },
            DiscoveryError::MetadataSizeLimitExceeded,
        ),
    ] {
        assert_eq!(
            lookup(default_registry(), inputs, &[], limits, None).unwrap_err(),
            expected
        );
    }
    let error = lookup(
        default_registry(),
        vec![DiscoveryInput::with_contents(PAGE, FRAME)],
        &[("https://museum.test/art", DZI)],
        DiscoveryLimits {
            retained_bytes: DZI.len(),
            ..Default::default()
        },
        None,
    )
    .unwrap_err();
    assert!(matches!(
        error,
        DiscoveryError::Host(ref error) if matches!(error.cause(), Error::ResourceLimit { .. })
    ));
}

#[test]
fn observed_metadata_wins_without_reading_a_valid_but_lower_priority_frame() {
    let reads = RefCell::new(Vec::new());
    let catalog = futures::executor::block_on(default_registry().discover(
        vec![
            DiscoveryInput::with_contents(PAGE, FRAME),
            observed("https://image.test/book/info.json"),
        ],
        Default::default(),
        |request, _| {
            reads.borrow_mut().push(request.uri.clone());
            async move {
                Ok(ResourceRead::Response {
                    response: ResourceResponse {
                        bytes: if request.uri.ends_with("info.json") {
                            IIIF.to_vec()
                        } else {
                            DZI.to_vec()
                        },
                        final_uri: None,
                    },
                })
            }
        },
    ))
    .unwrap();
    assert!(matches!(&catalog.entries()[0],DiscoveredEntry::Ready(image) if image.format=="iiif"));
    assert!(
        !reads
            .borrow()
            .iter()
            .any(|uri| uri == "https://museum.test/art")
    );
}
