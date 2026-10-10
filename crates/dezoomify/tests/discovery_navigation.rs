mod support;
use dezoomify::core::discovery::{DiscoveryError, DiscoveryInput, DiscoveryLimits};
use dezoomify::core::{
    DiscoveredEntry, DiscoveryCatalog, Registry, RejectionKind, default_registry, registry_for,
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
    let (result, requests) = support::discover_inputs(registry, inputs, limits, |uri| {
        replies
            .iter()
            .find(|(expected, _)| *expected == uri)
            .map(|(_, bytes)| {
                Ok((
                    bytes.to_vec(),
                    (uri == PAGE).then(|| redirect.map(str::to_owned)).flatten(),
                ))
            })
    });
    let requests: Vec<_> = requests.iter().map(|request| &request.uri).collect();
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
fn unrelated_content_is_a_route_miss_but_declared_metadata_keeps_its_error() {
    for bytes in [
        br#"<html><script>const settings = {theme: 'dark'};</script><body>Welcome</body></html>"#
            .as_slice(),
        br#"<?xml version="1.0"?><document><title>Welcome</title></document>"#,
        br#"{"theme":"dark"}"#,
        br#"{"description":"scw.min.js TileMatrixSet <krpano> topviews TileSize"}"#,
        br#"<p>Seadragon.embed('x', 'y', 'unrelated')</p>"#,
    ] {
        for (uri, expected) in [
            (PAGE, None),
            ("https://museum.test/settings.js", None),
            ("https://museum.test/art.dzi", Some("deepzoom")),
            ("https://museum.test/info.json", Some("iiif")),
            ("https://museum.test/wmts.xml", Some("wmts")),
            ("https://museum.test/tour.xml", Some("krpano")),
        ] {
            let error = lookup(
                default_registry(),
                vec![DiscoveryInput::with_contents(uri, bytes)],
                &[],
                Default::default(),
                None,
            )
            .unwrap_err();
            let DiscoveryError::NoCandidateAccepted { diagnostics } = error else {
                panic!("expected candidate diagnostics")
            };
            let failures: Vec<_> = diagnostics
                .iter()
                .filter(|diagnostic| {
                    !matches!(
                        diagnostic.kind,
                        RejectionKind::DidNotMatchUrl | RejectionKind::DidNotMatchContent
                    )
                })
                .collect();
            assert_eq!(
                failures.len(),
                usize::from(expected.is_some()),
                "{uri}: {failures:?}"
            );
            if let Some(format) = expected {
                assert_eq!(failures[0].format, format);
                assert_eq!(failures[0].kind, RejectionKind::InvalidMetadata);
            }
        }
    }
}

#[test]
fn opaque_metadata_and_embedded_objects_remain_discoverable() {
    for (bytes, format) in [
        (IIIF, "iiif"),
        (DZI, "deepzoom"),
        (br#"<script>const service = {width:512,height:512,tiles:[{width:256,scaleFactors:[1]}]};</script>"#, "iiif"),
        (br#"<script>OpenSeadragon({tileSources:{Image:{'Tile\u0053ize':256,Format:'jpg',Size:{Width:512,Height:512}}}});</script>"#, "deepzoom"),
        (br#"{"w\u0069dth":512,"height":512}"#, "iiif"),
        (br#"{"type":"ImageService3","width":512,"height":512,"items":[]}"#, "iiif"),
        (include_bytes!("../../../fixtures/wmts/basic/WMTSCapabilities.xml"), "wmts"),
        (include_bytes!("../../../fixtures/krpano/basic/tour.xml"), "krpano"),
        (include_bytes!("../../../fixtures/second_canvas/approximate-basic/metadata.json"), "second_canvas"),
        (include_bytes!("../../../fixtures/fzp/approximate-basic/metadata.xml"), "fzp"),
        (include_bytes!("../../../fixtures/topviewer/approximate-basic/metadata.json"), "topviewer"),
        (br#"<?xml version="1.0"?><k:krpano xmlns:k="urn:krpano"><image tilesize="256"><level tiledimagewidth="512" tiledimageheight="512"><front url="tiles/%h-%v.png"/></level></image></k:krpano>"#, "krpano"),
    ] {
        let bytes = String::from_utf8_lossy(bytes)
            .replace("{{origin}}", "https://museum.test")
            .replace("\"gigapixel\"", "\"giga\\u0070ixel\"");
        image(vec![DiscoveryInput::with_contents(PAGE, bytes)], &[], format);
    }
    for bytes in [
        include_bytes!("../../../fixtures/iiif/manifest/manifest.json").as_slice(),
        include_bytes!("../../../fixtures/iiif/legacy-context/manifest.json"),
    ] {
        let bytes = String::from_utf8_lossy(bytes).replace(
            "\"type\": \"Manifest\"",
            "\"type\": \"Manifest\", \"width\": 512, \"height\": 512",
        );
        let catalog = trace(vec![DiscoveryInput::with_contents(PAGE, bytes)], &[]);
        assert!(matches!(catalog.entries(), [DiscoveredEntry::Deferred(_)]));
    }
}

#[test]
fn metadata_shapes_reject_unrelated_clues_but_keep_decoder_errors() {
    use RejectionKind::{DidNotMatchContent, InvalidMetadata};
    for (bytes, format, kind) in [
        (
            br#"{"gigapixel":false}"#.as_slice(),
            "second_canvas",
            DidNotMatchContent,
        ),
        (
            br#"{"other":{"gigapixel":{}}}"#,
            "second_canvas",
            DidNotMatchContent,
        ),
        (br#"<document><pal/></document>"#, "fzp", DidNotMatchContent),
        (br#"<pal/>"#, "fzp", InvalidMetadata),
        (br#"{"topviews":false}"#, "topviewer", DidNotMatchContent),
        (br#"{"items":false}"#, "iiif", DidNotMatchContent),
        (
            br#"{"gigapixel":{"url":"tiles","size":{"w":512,"h":512},"tile":0}}"#,
            "second_canvas",
            InvalidMetadata,
        ),
        (
            br#"{"n\u0061me":"Museum"}"#,
            "second_canvas",
            DidNotMatchContent,
        ),
    ] {
        let error = lookup(
            default_registry(),
            vec![DiscoveryInput::with_contents(PAGE, bytes)],
            &[],
            Default::default(),
            None,
        )
        .unwrap_err();
        let DiscoveryError::NoCandidateAccepted { diagnostics } = error else {
            panic!("expected candidate diagnostics")
        };
        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.format == format)
            .unwrap();
        assert_eq!(diagnostic.kind, kind);
        assert!(
            diagnostic
                .detail
                .as_ref()
                .is_some_and(|detail| !detail.is_empty())
        );
    }
}

#[test]
fn followed_metadata_retains_errors_even_without_a_content_match() {
    for (format, page, bytes, metadata) in [
        (
            "deepzoom",
            PAGE,
            br#"<script>Seadragon.embed('viewer', 'title', '/metadata');</script>"#.as_slice(),
            "https://museum.test/metadata",
        ),
        (
            "krpano",
            PAGE,
            br#"<script>function viewer() { return krpano; } embedpano({xml:'/metadata'});</script>"#,
            "https://museum.test/metadata",
        ),
        (
            "second_canvas",
            "https://museum.test/viewer?js=/metadata.json",
            br#"<script src="scw.min.js"></script>"#.as_slice(),
            "https://museum.test/metadata.json",
        ),
        (
            "iiif",
            "https://museum.test/viewer?manifest=https://museum.test/metadata",
            b"".as_slice(),
            "https://museum.test/metadata",
        ),
        (
            "topviewer",
            PAGE,
            br#"<img src="https://images.memorix.nl/museum/thumb/example/art.jpg">"#,
            "https://images.memorix.nl/museum/topviewjson/memorix/art",
        ),
    ] {
        let error = lookup(
            registry_for(format).unwrap(),
            vec![DiscoveryInput::with_contents(page, bytes)],
            &[(metadata, b"<html>Unavailable</html>")],
            Default::default(),
            None,
        )
        .unwrap_err();
        let DiscoveryError::NoCandidateAccepted { diagnostics } = error else {
            panic!("expected candidate diagnostics")
        };
        assert_eq!(
            diagnostics[0].kind,
            RejectionKind::InvalidMetadata,
            "{format}: {diagnostics:?}"
        );
    }
}

#[test]
fn followed_viewers_do_not_enable_metadata_fallbacks() {
    image(
        vec![DiscoveryInput::with_contents(
            PAGE,
            br#"<a href="viewer.xml">View</a>"#,
        )],
        &[
            (
                "https://museum.test/viewer.xml",
                br#"<script>Seadragon.embed('viewer', 'title', '/art');</script>"#,
            ),
            ("https://museum.test/art", DZI),
        ],
        "deepzoom",
    );
    let error = lookup(
        registry_for("second_canvas").unwrap(),
        vec![DiscoveryInput::with_contents(
            PAGE,
            br#"<iframe src="https://museum.s3.amazonaws.com/web/viewer.html"></iframe>"#,
        )],
        &[(
            "https://museum.s3.amazonaws.com/web/viewer.html",
            b"<html>Unavailable</html>",
        )],
        Default::default(),
        None,
    )
    .unwrap_err();
    let DiscoveryError::NoCandidateAccepted { diagnostics } = error else {
        panic!("expected candidate diagnostics")
    };
    assert!(
        diagnostics.iter().all(|diagnostic| matches!(
            diagnostic.kind,
            RejectionKind::DidNotMatchUrl | RejectionKind::DidNotMatchContent
        )),
        "{diagnostics:?}"
    );
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
fn desktop_source_is_the_winning_observed_resource_and_can_be_rediscovered() {
    let uri = "https://image.test/book/info.json?signature=exact%2Bvalue";
    let replies = [(uri, IIIF)];
    let catalog = trace(
        vec![DiscoveryInput::with_contents(PAGE, FRAME), observed(uri)],
        &replies,
    );
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("one ready image expected")
    };
    assert_eq!(image.source_url.as_deref(), Some(uri));
    let replayed = trace(vec![DiscoveryInput::new(uri)], &replies);
    assert_eq!(catalog.public_catalog(), replayed.public_catalog());
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
            DiscoveryInput::with_contents(PAGE, b"stale observed page")
                .with_kind(DiscoveryInputKind::ObservedDocument),
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
            DiscoveryInput::with_contents(PAGE, b"stale source page"),
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
            (
                PAGE,
                br#"<base href="../assets/"><iframe src="art?x=1&amp;y=2"></iframe>"#,
            ),
            ("https://viewer.test/assets/art?x=1&y=2", DZI),
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
    for page in [
        FRAME,
        br#"<script>Seadragon.embed('viewer', 'title', '/art');</script>"#,
    ] {
        for resources in [1, 2] {
            let result = lookup(
                default_registry(),
                vec![DiscoveryInput::new(PAGE)],
                &[(PAGE, page), ("https://museum.test/art", DZI)],
                DiscoveryLimits {
                    resources,
                    ..Default::default()
                },
                None,
            );
            assert_eq!(result.is_ok(), resources == 2);
        }
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
    for retained_bytes in [FRAME.len(), DZI.len()] {
        let error = lookup(
            default_registry(),
            vec![DiscoveryInput::with_contents(PAGE, FRAME)],
            &[("https://museum.test/art", DZI)],
            DiscoveryLimits {
                retained_bytes,
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
        support::parse_html,
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
