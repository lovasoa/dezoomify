mod support;
use dezoomify::core::discovery::{DiscoveryError, DiscoveryInput, DiscoveryLimits};
use dezoomify::core::{
    DiscoveredEntry, DiscoveryCatalog, Registry, RejectionKind, default_registry, registry_for,
};
use dezoomify::model::{DiscoveryInputKind, ResourceRead, ResourceResponse};
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
fn filename_patterns_supply_picker_filters_and_preserve_prefixed_names() {
    for (format, pattern, extension, bytes) in [
        (
            "custom",
            "*tiles.yaml",
            "yaml",
            include_bytes!("../../../testdata/scenarios/rs-core/formats/payloads/tiles.yaml")
                .as_slice(),
        ),
        ("zoomify", "*ImageProperties.xml", "xml", ZOOMIFY),
    ] {
        let registry = registry_for(format).unwrap();
        let spec = registry.file_formats().next().unwrap();
        assert_eq!(spec.file_names().collect::<Vec<_>>(), [pattern]);
        assert_eq!(
            spec.file_filter_extensions().collect::<Vec<_>>(),
            [extension]
        );
        assert_eq!(spec.file_help(), None);
        let filename = pattern.trim_start_matches('*');
        for name in [filename.to_owned(), format!("local-{filename}")] {
            let input = format!("file:///My%20collection/{name}");
            let catalog = lookup(
                registry.clone(),
                vec![DiscoveryInput::with_contents(&input, bytes)],
                &[],
                Default::default(),
                None,
            )
            .unwrap();
            assert!(matches!(catalog.entries(), [DiscoveredEntry::Ready(_)]));
        }
        for wrong_name in [format!("{filename}.bak"), filename.to_ascii_uppercase()] {
            let input = format!("file:///My%20collection/{wrong_name}");
            assert!(
                lookup(
                    registry.clone(),
                    vec![DiscoveryInput::with_contents(&input, bytes)],
                    &[],
                    Default::default(),
                    None,
                )
                .is_err(),
                "{input}"
            );
        }
    }
}

#[test]
fn conventional_filename_routes_keep_content_based_fallbacks() {
    for (format, names, bytes) in [
        ("iiif", ["info.json", "manifest.json"], IIIF),
        (
            "krpano",
            ["tiles.xml", "tour.xml"],
            include_bytes!("../../../fixtures/krpano/basic/tour.xml").as_slice(),
        ),
    ] {
        let registry = registry_for(format).unwrap();
        let spec = registry.file_formats().next().unwrap();
        assert_eq!(spec.file_names().collect::<Vec<_>>(), names);
        let catalog = lookup(
            registry,
            vec![DiscoveryInput::with_contents(
                "file:///collection/renamed",
                bytes,
            )],
            &[],
            Default::default(),
            None,
        )
        .unwrap();
        assert!(matches!(catalog.entries(), [DiscoveredEntry::Ready(_)]));
    }
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
        br#"<html><head><title>Jarvis DZI viewer</title><link href="viewer.css" rel="stylesheet"></head><body></body></html>"#,
        br#"function xhr(){try{return new C.XMLHttpRequest}catch(e){}};var u=window.XMLHttpRequest;"#,
        br#"const scripts = ['viewer.xml.js', 'viewer.dzi.js'];"#,
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
fn dzi_links_skip_javascript_identifiers_and_preserve_query_parameters() {
    for extension in ["xml", "dzi"] {
        let metadata = format!("https://museum.test/art.{extension}?token=exact%2Bvalue&v=2");
        let script = format!(
            r#"function xhr(){{try{{return new C.XMLHttpRequest}}catch(e){{}}}};var u=window.XMLHttpRequest;
            viewer.openDzi('/proxy?filename=' + unescape('fragment.{extension}'));
            const script = 'viewer.{extension}.js'; const image = '{metadata}';"#
        );
        let (catalog, requests) = support::discover_inputs(
            registry_for("deepzoom").unwrap(),
            vec![DiscoveryInput::with_contents(PAGE, script)],
            Default::default(),
            |uri| (uri == metadata).then(|| Ok((DZI.to_vec(), None))),
        );
        let image = support::ready_image(catalog.unwrap());
        assert_eq!(image.source_url.as_deref(), Some(metadata.as_str()));
        assert_eq!(
            requests
                .iter()
                .map(|request| request.uri.as_str())
                .collect::<Vec<_>>(),
            [metadata.as_str()]
        );
    }
}

#[test]
fn dzi_options_decode_literals_without_following_library_messages() {
    const TARGET: &str = "https://museum.test/opaque?token=exact%2Bvalue&v=2";
    for contents in [
        r#"<script>const errors={Dzi:"Hmm, this doesn\'t appear to be a valid Deep Zoom Image."}; const options={dzi:'/\x6fpaque?token=exact%2Bvalue&v=2'};</script>"#,
        r#"const options={'dzi':"/opaque?token=exact%2Bvalue&v=2"};"#,
        r#"const options={"dzi":'/opaque?token=exact%2Bvalue&v=2'};"#,
        r#"<div dzi="/opaque?token=exact%2Bvalue&amp;v=2"></div>"#,
    ] {
        let (catalog, requests) = support::discover_inputs(
            registry_for("deepzoom").unwrap(),
            vec![DiscoveryInput::with_contents(PAGE, contents)],
            Default::default(),
            |uri| {
                assert_eq!(uri, TARGET);
                Some(Ok((DZI.to_vec(), None)))
            },
        );
        assert_eq!(support::ready_image(catalog.unwrap()).format, "deepzoom");
        assert_eq!(requests.len(), 1);
    }
    let (catalog, requests) = support::discover_inputs(
        registry_for("deepzoom").unwrap(),
        vec![DiscoveryInput::with_contents(
            PAGE,
            r#"const errors={Dzi:"Hmm, this doesn\'t appear to be a valid Deep Zoom Image."}; const example="dzi: 'not-an-image'";"#,
        )],
        Default::default(),
        |_| panic!("library messages and quoted examples are not image references"),
    );
    assert!(catalog.is_err());
    assert!(requests.is_empty());
}

#[test]
fn opaque_metadata_and_embedded_objects_remain_discoverable() {
    for (bytes, format) in [
        (IIIF, "iiif"),
        (DZI, "deepzoom"),
        (br#"<script>const service = {width:512,height:512,tiles:[{width:256,scaleFactors:[1]}]};</script>"#, "iiif"),
        (br#"<script>OpenSeadragon({tileSources:{Image:{'Tile\u0053ize':256,Format:'jpg',Size:{Width:512,Height:512}}}});</script>"#, "deepzoom"),
        (br#"{"protocol":"http://iiif.io/api/image","w\u0069dth":512,"height":512}"#, "iiif"),
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
        include_bytes!("../../../fixtures/iiif/repeated-metadata/manifest.json"),
        include_bytes!("../../../fixtures/iiif/mixed-media/manifest.json"),
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
fn national_gallery_handoff_uses_the_detected_iiif_metadata() {
    const PAGE: &str =
        "https://www.nationalgallery.org.uk/paintings/hans-holbein-the-younger-the-ambassadors";
    const INFO: &str = "https://www.nationalgallery.org.uk/server.iip?IIIF=/fronts/N-1314-00-000267-XL-PYR.tif/info.json";
    let page = br#"<img src="/server.iip?IIIF=/fronts/N-1314-00-000267-XL-PYR.tif/full/!80,50/0/default.jpg">"#;
    let info = br#"{"@context":"http://iiif.io/api/image/3/context.json","id":"https://www.nationalgallery.org.uk/server.iip?IIIF=/fronts/N-1314-00-000267-XL-PYR.tif","type":"ImageService3","width":512,"height":512,"tiles":[{"width":256,"scaleFactors":[1,2]}]}"#;
    let catalog = trace(
        vec![DiscoveryInput::with_contents(PAGE, page)],
        &[(INFO, info)],
    );
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("one ready image expected")
    };
    assert_eq!(image.source_url.as_deref(), Some(INFO));
    let replayed = trace(vec![DiscoveryInput::new(INFO)], &[(INFO, info)]);
    assert_eq!(catalog.public_catalog(), replayed.public_catalog());
}

#[test]
fn self_contained_metadata_handoffs_are_canonical_and_independently_reusable() {
    let cases: &[(&str, &[u8], &str, &[u8])] = &[
        ("deepzoom", br#"<script>Seadragon.embed('viewer', 'image', 'https://image.test/art.dzi');</script>"#, "https://image.test/art.dzi", DZI),
        ("deepzoom", br#"<script>const image = './art name.dzi';</script>"#, "https://museum.test/art%20name.dzi", DZI),
        ("iiif", br#"<script>const image = 'https://image.test/book/info.json';</script>"#, "https://image.test/book/info.json", IIIF),
        ("zoomify", br#"<script>zoomifyImagePath = 'https://image.test/pyramid';</script>"#, "https://image.test/pyramid/ImageProperties.xml", ZOOMIFY),
        ("fzp", br#"<script>lime('image','fzp',{path:'https://image.test/resources/'});</script>"#, "https://image.test/resources/image/root.xml", br#"<pal ver="1.3"><content><resource service="FZP" url="." x="0" y="0" width="512" height="512" tilewidth="256" tileheight="256" min="0" max="1"/></content></pal>"#),
    ];
    for &(format, page, metadata_uri, metadata) in cases {
        let discover = |input| {
            lookup(
                registry_for(format).unwrap(),
                vec![input],
                &[(metadata_uri, metadata)],
                Default::default(),
                None,
            )
            .unwrap()
        };
        let from_page = discover(DiscoveryInput::with_contents(PAGE, page));
        let [DiscoveredEntry::Ready(image)] = from_page.entries() else {
            panic!("{format}: one ready image expected")
        };
        assert_eq!(image.source_url.as_deref(), Some(metadata_uri), "{format}");
        let from_metadata = discover(DiscoveryInput::new(metadata_uri));
        assert_eq!(
            from_page.public_catalog(),
            from_metadata.public_catalog(),
            "{format}"
        );
    }
}

#[test]
fn canonical_target_retains_redirects_and_exact_query_parameters() {
    let requested = "https://image.test/book/info.json?download=exact%2Bvalue";
    let redirected = "https://cdn.test/book/info.json?download=exact%2Bvalue&version=2";
    let page = format!(r#"<script>const image = "{requested}";</script>"#);
    let (catalog, _) = support::discover_inputs(
        registry_for("iiif").unwrap(),
        vec![DiscoveryInput::with_contents(PAGE, page)],
        Default::default(),
        |uri| (uri == requested).then(|| Ok((IIIF.to_vec(), Some(redirected.into())))),
    );
    let image = support::ready_image(catalog.unwrap());
    assert_eq!(image.source_url.as_deref(), Some(redirected));
}
#[test]
fn failed_duplicate_observations_leave_opaque_iframe_targets_available() {
    image(
        vec![
            DiscoveryInput::with_contents(PAGE, FRAME),
            observed("https://museum.test/opaque"),
            observed("https://museum.test/broken.dzi"),
            observed("https://museum.test/broken.dzi"),
        ],
        &[
            ("https://museum.test/broken.dzi", b"invalid"),
            (
                "https://museum.test/art",
                br#"<iframe src="/opaque"></iframe>"#,
            ),
            ("https://museum.test/opaque", DZI),
        ],
        "deepzoom",
    );
}
#[test]
fn unknown_inventory_is_ignored_but_explicit_sources_are_read() {
    const UNKNOWN: &str = "https://museum.test/assets/opaque.js";
    let inventory = || {
        [
            UNKNOWN,
            "https://museum.test/assets/style.css",
            "https://museum.test/assets/settings.json",
            "https://museum.test/assets/settings.xml",
            "https://analytics.test/beacon?event=page",
            "https://analytics.test/playlist.js",
            "https://analytics.test/?source=analytics",
            "https://analytics.test/media?q=1",
            "https://analytics.test/image/opaque",
            "https://analytics.test/random.js",
            "https://analytics.test/collect?dl=https%3A%2F%2Fartsandculture.google.com%2Fasset%2Ftest",
            "https://analytics.test/collect?dl=https%3A%2F%2Fhungaricana.hu%2Fimages%2Ftest",
            "https://analytics.test/collect#hungaricana.hu",
            "https://artsandculture.google.com@analytics.test/collect",
            "https://analytics.test/artsandculture.google.com/asset/test",
            "https://artsandculture.google.com.analytics.test/collect",
            "https://hungaricana.hu@analytics.test/collect",
            "https://analytics.test/hungaricana.hu/collect",
            "https://hungaricana.hu.analytics.test/collect",
            "https://analytics.test/collect?ref=imagesize/image.ecw",
            "https://metadata.dzi",
            "https://metadata.zif",
            "https://metadata.txt",
            "https://tiles.yaml",
            "https://wmts.xml/collect",
            "https://analytics.test/collect?ref=service=wmts&other=request=getcapabilities",
            "https://analytics.test/collect#service=wmts&request=getcapabilities",
            "https://analytics.test/collect?ref=/lizardtech/iserv/calcrgn",
            "https://analytics.test/collect?ref=https://images.test/iip?FIF=art.tif",
            "https://analytics.test/iip?fifty=50",
            "https://metadata.imgi",
            "https://metadata.imgf",
            "https://analytics.test/collect?ref=https://www.bl.uk/manuscripts/Viewer.aspx?ref=sample",
            "https://bl.uk.evil.test/manuscripts/Viewer.aspx?ref=sample",
            "https://www.bl.uk/manuscripts/Viewer.aspx.js?ref=sample",
            "https://analytics.test/collect?ref=https://polona.pl/item/123/0",
            "https://polona.pl.evil.test/item/123/0",
            "https://analytics.test/collect?ref=https://polona.pl/resources/item/123/&format=json",
            "https://polona.pl/resources/item/123/?otherformat=json",
            "https://analytics.test/collect?ref=https://biblio.unibe.ch/web-apps/maps/zoomify.php",
            "https://biblio.unibe.ch/web-apps/maps/zoomify.php.js",
            "https://analytics.test/collect?ref=https://www.ngv.vic.gov.au/explore/collection/work/3867/",
            "https://www.ngv.vic.gov.au/explore/collection/work.js",
            "https://viewer.onb.ac.at/assets/runtime.js",
            "https://viewer.onb.ac.at/10048A37/thumbnail.jpg",
            "https://digital.onb.ac.at/RepViewer/viewer.faces?doc=",
            "https://analytics.test/server?next=https://images.test/server?source=art",
            "https://analytics.test/collect?ref=https://images.test/art_files/9/0_0.jpg",
            "https://analytics.test/collect?ref=https://images.test/art/TileGroup0/0-0-0.jpg",
        ]
        .into_iter()
        .map(observed)
        .collect::<Vec<_>>()
    };
    let mut inputs = vec![DiscoveryInput::with_contents(PAGE, "<html></html>")];
    inputs.extend(inventory());
    let (result, requests) =
        support::discover_inputs(default_registry(), inputs, Default::default(), |uri| {
            panic!("passive inventory alone must not trigger a read: {uri}")
        });
    assert!(matches!(
        result,
        Err(DiscoveryError::NoCandidateAccepted { .. })
    ));
    assert!(requests.is_empty());

    let (result, requests) = support::discover_inputs(
        default_registry(),
        vec![DiscoveryInput::new(UNKNOWN)],
        Default::default(),
        |uri| {
            assert_eq!(uri, UNKNOWN);
            Some(Ok((DZI.to_vec(), None)))
        },
    );
    assert_eq!(support::ready_image(result.unwrap()).format, "deepzoom");
    assert_eq!(requests.len(), 1);
}

#[test]
fn generic_json_names_yield_to_tiles_metadata() {
    let tiles = "https://image.test/tiles.xml";
    for name in ["info.json", "manifest.json"] {
        let (catalog, requests) = support::discover_inputs(
            default_registry(),
            vec![
                DiscoveryInput::with_contents(PAGE, "<html></html>"),
                observed(&format!("https://other.test/{name}")),
                observed(tiles),
            ],
            Default::default(),
            |uri| {
                assert_eq!(
                    uri, tiles,
                    "tile evidence should avoid ambiguous JSON reads"
                );
                Some(Ok((
                    include_bytes!("../../../fixtures/krpano/basic/tour.xml").to_vec(),
                    None,
                )))
            },
        );
        assert_eq!(support::ready_image(catalog.unwrap()).format, "krpano");
        assert_eq!(requests.len(), 1);
    }
}

#[test]
fn distinctive_viewer_paths_precede_generic_metadata_names() {
    let api = "https://museum.test/digital/api/singleitem/collection/archive/id/42";
    let info = "https://image.test/art/info.json";
    let (catalog, requests) = support::discover_inputs(
        default_registry(),
        vec![
            DiscoveryInput::with_contents(PAGE, "<html></html>"),
            observed("https://other.test/info.json"),
            observed("https://museum.test/digital/collection/archive/id/42"),
        ],
        Default::default(),
        |uri| {
            Some(Ok((
                match uri {
                    uri if uri == api => {
                        br#"{"iiifInfoUri":"https://image.test/art/info.json"}"#.to_vec()
                    }
                    uri if uri == info => IIIF.to_vec(),
                    unexpected => {
                        panic!("distinctive viewer should precede generic metadata: {unexpected}")
                    }
                },
                None,
            )))
        },
    );
    assert_eq!(support::ready_image(catalog.unwrap()).format, "iiif");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.uri.as_str())
            .collect::<Vec<_>>(),
        [api, info]
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
fn nla_viewer_queries_do_not_hide_the_metadata_route() {
    image(
        vec![DiscoveryInput::new(
            "https://nla.gov.au/nla.obj-123/view?part=1#preview",
        )],
        &[("https://nla.gov.au/nla.obj-123/dzi", DZI)],
        "deepzoom",
    );
}

#[test]
fn a_large_resource_inventory_is_ranked_before_spending_the_read_budget() {
    let metadata = "https://museum.test/proxy?filename=objectimages/painting.dzi";
    let mut inputs = vec![DiscoveryInput::with_contents(PAGE, "<html></html>")];
    inputs.extend(
        [
            "https://analytics.test/playlist.js",
            "https://analytics.test/bulk.js",
            "https://analytics.test/event?source=page",
            "https://analytics.test/media?event=view",
            "https://analytics.test/image/icon.png",
        ]
        .into_iter()
        .map(observed),
    );
    inputs.extend((0..5000).map(|index| observed(&format!("https://analytics.test/{index}.js"))));
    inputs.extend((0..8).map(|index| {
        observed(&format!(
            "https://museum.test/proxy?filename=objectimages/painting_files/9/{index}_0.jpg"
        ))
    }));
    let (catalog, requests) = support::discover_inputs(
        default_registry(),
        inputs,
        DiscoveryLimits {
            resources: 3,
            ..Default::default()
        },
        |uri| {
            assert_eq!(uri, metadata, "unrelated observations must not be fetched");
            Some(Ok((DZI.to_vec(), None)))
        },
    );
    assert_eq!(
        support::ready_image(catalog.unwrap()).source_url.as_deref(),
        Some(metadata)
    );
    assert_eq!(requests.len(), 1);
}

#[test]
fn resource_attempts_are_shared_across_formats_and_navigation() {
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
            if resources == 1 {
                assert_eq!(result.unwrap_err(), DiscoveryError::ResourceLimitExceeded);
            } else {
                assert!(result.is_ok());
            }
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
fn an_endless_chain_of_distinct_pages_stops_at_the_resource_limit() {
    let mut next = 0;
    let (result, requests) = support::discover_inputs(
        default_registry(),
        vec![DiscoveryInput::new(PAGE)],
        DiscoveryLimits {
            resources: 3,
            ..Default::default()
        },
        |_| {
            next += 1;
            Some(Ok((
                format!("<iframe src='/page/{next}'></iframe>").into_bytes(),
                None,
            )))
        },
    );
    assert_eq!(result.unwrap_err(), DiscoveryError::ResourceLimitExceeded);
    assert_eq!(requests.len(), 3);
}
#[test]
fn observed_metadata_wins_without_reading_a_valid_but_lower_priority_frame() {
    let reads = RefCell::new(Vec::new());
    let catalog = futures::executor::block_on(default_registry().discover(
        vec![
            DiscoveryInput::with_contents(PAGE, FRAME),
            observed("https://image.test/proxy?filename=objectimages/art.dzi&cache=yes"),
        ],
        Default::default(),
        |request, _| {
            reads.borrow_mut().push(request.uri);
            async move {
                Ok(ResourceRead::Response {
                    response: ResourceResponse {
                        bytes: DZI.to_vec(),
                        final_uri: None,
                    },
                })
            }
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    ))
    .unwrap();
    assert!(
        matches!(&catalog.entries()[0],DiscoveredEntry::Ready(image) if image.format=="deepzoom")
    );
    assert!(
        !reads
            .borrow()
            .iter()
            .any(|uri| uri == "https://museum.test/art")
    );
}

#[test]
fn iframe_evidence_promotes_an_existing_resource() {
    let (catalog, requests) = support::discover_inputs(
        default_registry(),
        vec![
            DiscoveryInput::with_contents(PAGE, FRAME),
            observed("https://analytics.test/opaque"),
            observed("https://museum.test/art"),
        ],
        Default::default(),
        |uri| (uri == "https://museum.test/art").then(|| Ok((DZI.to_vec(), None))),
    );
    assert_eq!(support::ready_image(catalog.unwrap()).format, "deepzoom");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.uri.as_str())
            .collect::<Vec<_>>(),
        ["https://museum.test/art"]
    );
}

#[test]
fn generic_markers_yield_to_specific_metadata_references() {
    for marker in [
        "<url>/unrelated</url>",
        "<script>const accessnumber = 'unrelated';</script>",
        r#"<div id="map" vls:ot_id="1" vls:width="512" vls:height="512"></div>
           <var id="zoomTileSize" value="256">"#,
    ] {
        for (reference, target) in [
            ("Seadragon.embed('viewer', 'title', '/art');", "/art"),
            ("const image = '/art.dzi';", "/art.dzi"),
            ("openDzi('/art.xml');", "/art.xml"),
        ] {
            let target = format!("https://museum.test{target}");
            let (catalog, _) = support::discover_inputs(
                default_registry(),
                vec![DiscoveryInput::with_contents(
                    PAGE,
                    format!(
                        "{marker}<script>const unrelated = '/config.xml'; {reference}</script>"
                    ),
                )],
                Default::default(),
                |uri| {
                    assert_eq!(uri, target, "specific evidence must precede generic links");
                    Some(Ok((DZI.to_vec(), None)))
                },
            );
            assert_eq!(support::ready_image(catalog.unwrap()).format, "deepzoom");
        }
    }
}
