use super::*;
use crate::Vec2d;
use crate::core::{DiscoveredEntry, DiscoveryCatalog, ImagePlan, ParsedResource};
use crate::test_support::{grid, tile_urls};

const VIEWER: &str = "https://images.test/views/book.html";
const INDEX: &str = r#"<item title="Book &amp; title" total="29" ldata="128,96"><item resource="1499_02/02_001" ext="fzp" label="1/29"/><item resource="1499_02/02_002" ext="fzp" page="2/29"/></item>"#;

fn xml(version: &str, width: u32, height: u32, tile: u32, max: u32) -> String {
    format!(
        r#"<pal ver="{version}"><self nest="ignored"><content><resource service="FZP" url="." src="ignored" x="0" y="0" width="{width}" height="{height}" tilewidth="{tile}" tileheight="{tile}" min="0" max="{max}" pattern="0/00000"/><rect width="1" height="1"/></content><title>Image &amp; title</title><hint>text/plain</hint></self></pal>"#
    )
}

fn parse(text: &str) -> Result<ParsedResource, DiscoveryError> {
    crate::test_support::resource(VIEWER, text.as_bytes(), decode)
}

fn image(text: &str) -> ImagePlan {
    let ParsedResource::Image(image) = parse(text).unwrap() else {
        panic!("expected image")
    };
    image
}

fn follow(text: &str) -> String {
    let ParsedResource::Follow(request) = parse(text).unwrap() else {
        panic!("expected navigation")
    };
    request.uri
}

fn discover(
    input: &str,
    responses: &[(&str, &str, Option<&str>)],
) -> (DiscoveryCatalog, Vec<String>) {
    let (catalog, reads) = crate::test_support::discover_with_responses(
        crate::core::registry_for("fzp").unwrap(),
        input,
        |uri| {
            let (_, bytes, final_uri) = responses
                .iter()
                .find(|(expected, _, _)| *expected == uri)
                .unwrap_or_else(|| panic!("unexpected metadata read {uri}"));
            Some(Ok((
                bytes.as_bytes().to_vec(),
                final_uri.map(str::to_owned),
            )))
        },
    );
    (
        catalog.unwrap(),
        reads.into_iter().map(|request| request.uri).collect(),
    )
}

#[test]
fn verified_geometry_and_original_coordinate_edge_filenames() {
    for (version, width, height, tile, max, full_edge, reduced_edge, reduced_size) in [
        (
            "1.1",
            15122,
            14507,
            512,
            6,
            "14848143360027400171.jpg",
            "14336143360078600171.jpg",
            Vec2d { x: 393, y: 85 },
        ),
        (
            "1.3",
            4912,
            3687,
            256,
            5,
            "04864035840004800103.jpg",
            "04608035840030400103.jpg",
            Vec2d { x: 152, y: 52 },
        ),
        (
            "1.1",
            92479,
            3233,
            256,
            9,
            "92416030720006300161.jpg",
            "92160030720031900161.jpg",
            Vec2d { x: 159, y: 80 },
        ),
    ] {
        let image = image(&xml(version, width, height, tile, max));
        assert_eq!(image.title.as_deref(), Some("Image & title"));
        assert_eq!(image.levels.len(), max as usize + 1);
        let full = grid(&image.levels[0]).unwrap();
        let first = full.tiles_row_major().next().unwrap().unwrap();
        assert_eq!(first.expected_size, Some(Vec2d::square(tile)));
        assert!(
            first
                .request
                .uri
                .ends_with(&format!("0/0000000000{tile:05}{tile:05}.jpg"))
        );
        assert!(
            tile_urls(&image.levels[0])
                .unwrap()
                .last()
                .unwrap()
                .ends_with(full_edge)
        );
        let reduced = grid(&image.levels[1])
            .unwrap()
            .tiles_row_major()
            .last()
            .unwrap()
            .unwrap();
        assert!(reduced.request.uri.ends_with(reduced_edge));
        assert_eq!(reduced.expected_size, Some(reduced_size));
        assert_eq!(reduced.processing, crate::core::ProcessingRecipe::None);
    }
    let floor = image(&xml("1.2", 9, 7, 2, 5));
    assert_eq!(floor.levels.len(), 3); // Zero-sized levels are omitted.
    assert_eq!(
        floor.levels[1].source.image_size(),
        Some(Vec2d { x: 4, y: 3 })
    );
    assert_eq!(floor.levels[1].source.count(), Some(4)); // Fractional strip adds no tile.
    assert!(
        tile_urls(&floor.levels[1])
            .unwrap()
            .last()
            .unwrap()
            .ends_with("1/00004000040000400003.jpg")
    );
    let ceil = image(&xml("1.3", 9, 7, 2, 5));
    assert_eq!(
        ceil.levels[1].source.image_size(),
        Some(Vec2d { x: 5, y: 4 })
    );
    assert_eq!(ceil.levels[1].source.count(), Some(6));
    // The field widths constrain rectangles, not the original dimension alone.
    let wide = image(&xml("1.1", 199998, 2, 99999, 0));
    assert_eq!(wide.levels[0].source.count(), Some(2));
    assert!(tile_urls(&wide.levels[0]).unwrap()[1].ends_with("99999000009999900002.jpg"));
}

#[test]
fn unsupported_variants_and_invalid_geometry_have_bounded_diagnostics() {
    let original = xml("1.1", 9, 7, 2, 2);
    for (from, to, diagnostic) in [
        ("ver=\"1.1\"", "ver=\"3.0\"", "unsupported version"),
        ("ver=\"1.1\"", "ver=\"1.0\"", "unsupported version"),
        ("ver=\"1.1\"", "ver=\"1.10\"", "unsupported version"),
        (
            "ver=\"1.1\"",
            "ver=\"1.1\" version=\"1.3\"",
            "contradictory",
        ),
        (
            "pattern=\"0/00000\"",
            "pattern=\"0/xxxxx\"",
            "unsupported filename pattern",
        ),
        (
            "service=\"FZP\"",
            "service=\"FZP\" mime=\"image/png\"",
            "unsupported tile MIME",
        ),
        ("x=\"0\"", "x=\"1\"", "unsupported nonzero origin"),
        ("width=\"9\"", "width=\"0\"", "positive"),
        ("width=\"9\"", "width=\"200000\"", "five-digit"),
        ("max=\"2\"", "max=\"32\"", "level range"),
        ("min=\"0\"", "min=\"3\"", "level range"),
        (
            "service=\"FZP\"",
            "service=\"FZP\" divbase=\"3\"",
            "unsupported divbase",
        ),
        (
            "service=\"FZP\"",
            "service=\"FZP\" overlap=\"1\"",
            "overlap",
        ),
        ("url=\".\"", "url=\"../tiles\"", "URL base"),
    ] {
        let error = parse(&original.replace(from, to)).err().unwrap();
        assert!(error.to_string().contains(diagnostic), "{error}");
    }
    for text in [
        xml("1.3", 9, 7, u32::MAX, 2),
        original.replace("width=\"9\"", "width=\"4294967296\""),
        "<unrelated/>".into(),
    ] {
        assert!(parse(&text).is_err());
    }
    assert!(parse(&original.replace("ver=\"1.1\"", "version=\"1.1\"")).is_ok());
    let error = parse(&original.replace("ver=\"1.1\"", &format!("ver=\"{}\"", "bad".repeat(4096))))
        .err()
        .unwrap()
        .to_string();
    assert!(error.len() < 600 && error.contains("characters omitted"));
    assert!(
        parse("<items/>")
            .err()
            .unwrap()
            .to_string()
            .contains("unsupported legacy page index layout")
    );
}

#[test]
fn direct_metadata_and_ordered_deferred_index() {
    let legacy = image(include_str!(
        "../../../../testdata/scenarios/rs-core/formats/payloads/fzp/unversioned.xml"
    ));
    assert_eq!(legacy.title.as_deref(), Some("四ッ谷見附橋（12562-001）"));
    assert_eq!(
        tile_urls(&legacy.levels[1]).unwrap().last().unwrap(),
        "https://images.test/views/1/11264071680101900686.jpg"
    );
    let text = xml("1.1", 9, 7, 2, 2);
    let (catalog, _) = discover(
        "https://images.test/root.xml",
        &[(
            "https://images.test/root.xml",
            &text,
            Some("https://cdn.test/redirected/root.xml?token=ignored"),
        )],
    );
    let image = crate::test_support::ready_image(catalog);
    assert!(
        tile_urls(image.levels.last().unwrap()).unwrap()[0]
            .starts_with("https://cdn.test/redirected/0/")
    );
    let index_uri = "https://images.test/collection/xmls/book.xml";
    let (catalog, reads) = discover(index_uri, &[(index_uri, INDEX, None)]);
    assert_eq!(reads.len(), 1);
    for (i, entry) in catalog.entries().iter().enumerate() {
        let DiscoveredEntry::Deferred(entry) = entry else {
            panic!("expected deferred image")
        };
        assert_eq!(
            entry.uri,
            format!(
                "https://images.test/collection/resources/1499_02/02_00{}/root.xml",
                i + 1
            )
        );
        assert_eq!(entry.title, Some(format!("Book & title - {}/29", i + 1)));
    }
    assert_eq!(catalog.len(), 2);
    assert!(parse(INDEX).is_err()); // Arbitrary index layouts supply no invented base.
    let invalid_siblings = INDEX.replace(
        "<item resource=",
        "<item ext=\"fzp\"/><item ext=\"fzp\" resource=\"../invalid\"/><item resource=",
    );
    let (catalog, reads) = discover(index_uri, &[(index_uri, &invalid_siblings, None)]);
    assert_eq!((catalog.len(), reads.len()), (2, 1));
    let DiscoveredEntry::Deferred(first) = &catalog.entries()[0] else {
        panic!()
    };
    assert_eq!(first.warnings.len(), 1);
    assert!(first.warnings[0].contains("skipped 4 images"));
}

#[test]
fn literal_navigation_and_comparison_catalog() {
    for page in [
        "jime_vars.ResourcePath='../resources/'; lime('nested/image&amp;name','fzp');",
        "Lime.Viewer.loadIn('view',{path:'../resources/',name:'nested/image&amp;name',type:'fzp'});",
        "lime('nested/image&amp;name','fzp',{path:'../resources/'});",
    ] {
        assert_eq!(
            follow(page),
            "https://images.test/resources/nested/image&amp;name/root.xml"
        );
    }
    assert_eq!(
        follow("jime_vars.IndexPath='../wrong/'; jime_vars.IndexPath=''; lime('book','xml');"),
        "https://images.test/views/book.xml"
    );
    assert!(!crate::test_support::resource(
        VIEWER,
        b"<script src=viewer.js></script>",
        viewer::recognizes
    ));
    assert!(viewer::image_uri("https://images.test/", "../image").is_err());
    for page in [
        "jime_vars.ResourcePath='../resources/'; lime('image','fzp',{path:choosePath()});",
        "lime_compare('visible','fzp','infrared','fzp',{path:'../pictures/',syncpath:choosePath()});",
        "lime_compare('visible','fzp','infrared','fzp',{path:'../pictures/',glasspath:choosePath()});",
    ] {
        assert!(
            parse(page)
                .err()
                .unwrap()
                .to_string()
                .contains("unsupported dynamic Lime path")
        );
    }
    let page = "lime_compare('visible','fzp','infrared','fzp',{'path':'../pictures/','syncpath':'../comparison/'});";
    let (catalog, _) = discover(VIEWER, &[(VIEWER, page, None)]);
    assert_eq!(catalog.len(), 2);
    for (entry, name) in catalog
        .entries()
        .iter()
        .zip(["pictures/visible", "comparison/infrared"])
    {
        let DiscoveredEntry::Deferred(entry) = entry else {
            panic!()
        };
        assert_eq!(entry.uri, format!("https://images.test/{name}/root.xml"));
    }
}

#[test]
fn script_order_and_document_bases() {
    let metadata = xml("1.1", 9, 7, 2, 2);
    for (page, scripts, target) in [
        (
            "jime_vars.ResourcePath=''; lime('actual','fzp');",
            vec![],
            "views/actual/root.xml",
        ),
        (
            "Lime.Viewer.loadIn('view',{path:'',name:'actual',type:'fzp'});",
            vec![],
            "views/actual/root.xml",
        ),
        (
            "<script src=defaults.js></script><script>jime_vars.ResourcePath='../wrong/';</script><script src=override.js></script><script>lime('actual','fzp');</script>",
            vec![
                ("defaults.js", "jime_vars.ResourcePath='../old/';"),
                ("override.js", "jime_vars.ResourcePath='';"),
            ],
            "views/actual/root.xml",
        ),
        (
            "<script src=config.js></script><base href='../assets/'><template><script>lime('wrong','fzp');</script></template><script>lime('actual','fzp');</script><script src=analytics.js></script>",
            vec![("config.js", "jime_vars.ResourcePath='images/';")],
            "assets/images/actual/root.xml",
        ),
        (
            "<script>jime_vars.ResourcePath='../resources/'; lime('actual','fzp');</script><base href='/wrong/'><script src=analytics.js></script>",
            vec![],
            "resources/actual/root.xml",
        ),
        (
            "<script src=start.js></script><base href='/wrong/'><script>lime('later','fzp',{path:'../wrong/'});</script>",
            vec![(
                "start.js",
                "Lime.Viewer.loadIn('view',{path:'../resources/',name:'first',type:'fzp'});",
            )],
            "resources/first/root.xml",
        ),
    ] {
        let target = format!("https://images.test/{target}");
        let script_uris = scripts
            .iter()
            .map(|(src, _)| crate::core::resolve_relative(VIEWER, src))
            .collect::<Vec<_>>();
        let mut replies = vec![(VIEWER, page, None), (&target, metadata.as_str(), None)];
        replies.extend(
            scripts
                .iter()
                .zip(&script_uris)
                .map(|((_, body), uri)| (uri.as_str(), *body, None)),
        );
        let (_, reads) = discover(VIEWER, &replies);
        assert_eq!(reads.last(), Some(&target));
        assert_eq!(reads.len(), scripts.len() + 2);
    }
}

#[test]
fn failed_auxiliary_scripts_preserve_required_fetch_errors() {
    use crate::model::{Error, ErrorTransport, Failure};
    for failed in ["", "config.js", "root.xml"] {
        let metadata = xml("1.1", 9, 7, 2, 2);
        let (result, reads) = crate::test_support::discover_with_responses(
            crate::core::registry_for("fzp").unwrap(),
            VIEWER,
            |uri| {
                let body = if uri == VIEWER {
                    Some(
                        "<script src=missing.js></script><script src=config.js></script><script src=aux.js></script><script>lime('actual','fzp');</script>",
                    )
                } else if uri.ends_with("config.js") && failed != "config.js" {
                    Some("jime_vars.ResourcePath='../resources/';")
                } else if uri.ends_with("aux.js") {
                    Some("var auxiliary = true;")
                } else if failed != "root.xml" && uri.ends_with("root.xml") {
                    Some(metadata.as_str())
                } else {
                    None
                };
                Some(
                    body.map(|text| (text.as_bytes().to_vec(), None))
                        .ok_or_else(|| Error::HttpError {
                            status: 404,
                            retry_after_ms: None,
                            preview: None,
                            transport: ErrorTransport::Direct,
                            failure: Failure {
                                request: Some(uri.into()),
                                detail: None,
                            },
                        }),
                )
            },
        );
        assert_eq!(reads.len(), if failed == "config.js" { 4 } else { 5 });
        if !failed.is_empty() {
            let DiscoveryError::NoCandidateAccepted { diagnostics } = result.unwrap_err() else {
                panic!()
            };
            let Error::HttpError {
                status: 404,
                failure,
                ..
            } = diagnostics[0].cause.as_deref().unwrap()
            else {
                panic!()
            };
            assert_eq!(
                failure.request.as_deref(),
                Some(if failed == "config.js" {
                    "https://images.test/views/config.js"
                } else {
                    "https://images.test/resources/actual/root.xml"
                })
            );
        } else {
            assert_eq!(result.unwrap().len(), 1);
        }
    }
}

#[test]
fn deployed_wrappers_share_document_relative_discovery() {
    const NARA: &str = r#"(function(window,document){window.lime=function(src,type,param){
        if(typeof param['path']==='undefined') param['path']='../resources/';
        window.jQuery(document).ready(function(){
            Lime.Viewer.loadIn('view',{path:param['path'],name:src,type:type});
        });};})(window,document);"#;
    const NIHON: &str = r#"window.lime=function(src,type){window.jQuery(document).ready(function(){
        Lime.Viewer.init('view',{preview:{resourcepath:'../resources/',indexpath:'../xmls/'}});
        Lime.Viewer.loadIn('view',{name:src,type:type});});};"#;
    let metadata = xml("1.1", 9, 7, 2, 2);
    let viewer = "https://images.test/collection/views/book.html?l=1&amp;n=6";
    for (script_path, call, config, target, first) in [
        (
            "../limescripts/lime.js",
            "lime('book');",
            "var lime_depth=limeGetScriptDepth(); function lime(name){lime2_common(name,'xml',{});} jime_vars.ResourcePath=lime_depth['dir']+'resources/'; jime_vars.IndexPath=lime_depth['dir']+'xmls/';",
            "../xmls/book.xml",
            "../resources/1499_02/02_001/root.xml",
        ),
        (
            "limescripts/lime.js",
            "lime('image','fzp');",
            "var lime_depth=limeGetScriptDepth(); jime_vars.ResourcePath=lime_depth['dir']+'resources/';",
            "resources/image/root.xml",
            "resources/image/root.xml",
        ),
        (
            "/common/lime.js?x&y",
            "lime('book','xml',{indexpath:'../xmls/',path:'../custom/'});",
            NIHON,
            "../xmls/book.xml",
            "../custom/1499_02/02_001/root.xml",
        ),
        (
            "../limescripts/lime.js?x&y",
            "lime('book','xml');",
            r#"var lime_depth=limeGetScriptDepth();
            function lime(src,type){lime2_common(src,type,{});}
            function lime2_common(src,type,param){
                jime_vars.ResourcePath=lime_depth['dir']+'resources/';
                jime_vars.IndexPath=lime_depth['dir']+'xmls/';}"#,
            "../xmls/book.xml",
            "../resources/1499_02/02_001/root.xml",
        ),
        (
            "/common/lime.js?x&y",
            "lime('book','xml');",
            NIHON,
            "../xmls/book.xml",
            "../resources/1499_02/02_001/root.xml",
        ),
        (
            "/common/lime.js?x&y",
            "lime('image','fzp',{loc:512,ini:'87000,1600'});",
            NARA,
            "../resources/image/root.xml",
            "../resources/image/root.xml",
        ),
        (
            "/common/lime.js?x&y",
            "lime('image','fzp',{path:'../custom/'});",
            NARA,
            "../custom/image/root.xml",
            "../custom/image/root.xml",
        ),
        (
            "/common/lime.js?x&y",
            "lime_future('image','fzp');",
            "function lime_other(src,type){Lime.Viewer.loadIn('view',{path:'../wrong/',name:src,type:type});} function lime_future(src,type){Lime.Viewer.loadIn('view',{path:'../pictures/',name:src,type:type});}",
            "../pictures/image/root.xml",
            "../pictures/image/root.xml",
        ),
        (
            "/common/lime.js?x&y",
            "lime('book','xml');",
            "jime_vars.ResourcePath='../tiles/'; jime_vars.IndexPath='../indexes/';",
            "../indexes/book.xml",
            "../tiles/1499_02/02_001/root.xml",
        ),
        (
            "/common/lime.js?x&y",
            "lime('image','fzp');",
            "<!--\njime_vars.ResourcePath='../resources/';\n//-->",
            "../resources/image/root.xml",
            "../resources/image/root.xml",
        ),
    ] {
        // Shared scripts can be hosted elsewhere; configuration stays document-relative.
        let page = format!(
            "<script src='{}'></script><body onclick=\"lime('unused','fzp')\" onload=\"{call}\">",
            script_path.replace('&', "&amp;")
        );
        let script_uri = crate::core::resolve_relative(viewer, script_path);
        let target = crate::core::resolve_relative(viewer, target);
        let payload = if target.ends_with("/root.xml") {
            metadata.as_str()
        } else {
            INDEX
        };
        let (catalog, reads) = discover(
            viewer,
            &[
                (viewer, &page, None),
                (&script_uri, config, None),
                (&target, payload, None),
            ],
        );
        assert_eq!(reads.len(), 3);
        assert_eq!(reads[2], target);
        let entry = &catalog.entries()[0];
        if let DiscoveredEntry::Deferred(entry) = entry {
            assert_eq!(entry.uri, crate::core::resolve_relative(viewer, first));
        } else {
            assert_eq!(catalog.len(), 1);
        }
    }
}
