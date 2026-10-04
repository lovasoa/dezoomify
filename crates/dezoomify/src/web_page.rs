//! Document projections and script ordering shared by viewer formats.
use crate::core::{DiscoveryResource, resolve_relative};
use regex::Regex;
use std::sync::LazyLock;

use crate::model::HtmlDocument;
static JAVASCRIPT_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:text|application)/(?:x-)?(?:java|ecma)script|text/(?:jscript|livescript|javascript1\.[0-5]))?$").expect("constant JavaScript MIME pattern")
});

pub(crate) struct Script {
    pub source: Option<String>,
    pub body: String,
    pub base: String,
    pub fetch_base: String,
}

/// Immediate scripts use the base seen so far; deferred scripts use the final base.
/// Script text is DOM textContent, never entity-decoded or executed.
pub(crate) fn scripts(resource: DiscoveryResource<'_>) -> Vec<Script> {
    let mut base = resource.final_uri().to_owned();
    let mut has_base = false;
    let mut scripts = Vec::new();
    for tag in resource.select("base[href], script") {
        if tag.name == "base" && !has_base {
            base = resolve_relative(
                resource.final_uri(),
                tag.attribute("href").unwrap_or_default(),
            );
            has_base = true;
        }
        if tag.name != "script" {
            continue;
        }
        let kind = tag.attribute("type").unwrap_or_default();
        let module = kind.trim().eq_ignore_ascii_case("module");
        if !module
            && (tag.attribute("nomodule").is_some()
                || !JAVASCRIPT_TYPE.is_match(kind.split(';').next().unwrap_or_default().trim()))
        {
            continue;
        }
        let source = tag.attribute("src");
        if source.is_some_and(|src| src.trim().is_empty()) {
            continue;
        }
        let deferred = module || (source.is_some() && tag.attribute("defer").is_some());
        scripts.push((
            deferred,
            Script {
                source: source.map(str::to_owned),
                body: tag.text.clone(),
                base: base.clone(),
                fetch_base: base.clone(),
            },
        ));
    }
    // A standalone JavaScript response has no authored HTML elements.
    if !resource.is_html() {
        return vec![Script {
            source: None,
            body: resource.text_lossy().into_owned(),
            base: base.clone(),
            fetch_base: base,
        }];
    }
    scripts.sort_by_key(|(deferred, _)| *deferred);
    for (deferred, script) in &mut scripts {
        if *deferred {
            script.base = base.clone();
        }
    }
    scripts
        .into_iter()
        .map(|(_, script)| script)
        .chain(
            resource
                .select("body[onload]")
                .filter_map(|tag| tag.attribute("onload"))
                .map(|body| Script {
                    source: None,
                    body: body.to_owned(),
                    base: base.clone(),
                    fetch_base: base.clone(),
                }),
        )
        .collect()
}

pub(crate) fn script_bodies(resource: DiscoveryResource<'_>) -> impl Iterator<Item = &[u8]> {
    resource
        .select("base[href], script")
        .filter(|tag| tag.name == "script" && tag.attribute("src").is_none())
        .map(|tag| tag.text.as_bytes())
        .chain((!resource.is_html()).then(|| resource.bytes()))
}

pub(crate) fn iframe_sources(resource: DiscoveryResource<'_>) -> impl Iterator<Item = &str> {
    resource
        .select("iframe[src]")
        .filter_map(|tag| tag.attribute("src"))
        .map(str::trim)
        .filter(|src| !src.is_empty())
}

pub(crate) fn page_base(resource: DiscoveryResource<'_>) -> String {
    resource
        .select("base[href]")
        .next()
        .and_then(|tag| tag.attribute("href"))
        .map_or_else(
            || resource.final_uri().into(),
            |href| resolve_relative(resource.final_uri(), href),
        )
}

pub(crate) fn page_title(resource: DiscoveryResource<'_>) -> Option<String> {
    resource
        .select(HtmlDocument::TITLE_META)
        .filter_map(|tag| tag.attribute("content"))
        .chain(resource.select("title").map(|tag| tag.text.as_str()))
        .map(str::trim)
        .find(|title| !title.is_empty())
        .map(str::to_owned)
}

pub fn decode_html_entities(text: &str) -> String {
    html_escape::decode_html_entities(text).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::resource;
    fn ordered(bytes: &[u8], uri: &str) -> Vec<Script> {
        resource(uri, bytes, scripts)
    }
    fn title(page: &str) -> Option<String> {
        resource("", page.as_bytes(), page_title)
    }

    #[test]
    fn active_scripts_keep_literal_contents_and_document_bases() {
        let page = concat!(
            "Server warning <!-- <script src=wrong.js></script> -->",
            "<script src='first.js?x&amp;y'></script>",
            "<base href='../assets/'>",
            "<template><template><script src=wrong.js></script></template></template>",
            "<textarea><script>wrong</script></textarea>",
            "<title><script>wrong</script></title>",
            "<iframe><script>wrong</script></iframe>",
            "<script nomodule>wrong</script>",
            "<script type=text/plain>wrong</script>",
            "<script type='module; charset=utf-8'>wrong</script>",
            "<script type='application/x-javascript; charset=utf-8'>image&amp;name</script>",
            "<base href='/ignored/'>",
            "<script type=module src=second.js></script>"
        );
        let scripts = ordered(page.as_bytes(), "https://images.test/views/book.html");
        assert_eq!(scripts.len(), 3);
        assert_eq!(scripts[0].source.as_deref(), Some("first.js?x&y"));
        assert_eq!(scripts[0].base, "https://images.test/views/book.html");
        assert_eq!(scripts[1].body, "image&amp;name");
        assert_eq!(scripts[1].base, "https://images.test/assets/");
        assert_eq!(scripts[2].source.as_deref(), Some("second.js"));
        assert_eq!(scripts[2].base, scripts[1].base);
        let scripts = ordered(
            b"<script src=''>ignored</script><script src=' &#32; '>ignored</script><script type=MODULE>module</script><script defer src=config.js></script><script>immediate</script><base href='/assets/'>",
            "https://images.test/",
        );
        assert_eq!(scripts[0].body, "immediate");
        assert_eq!(scripts[1].body, "module");
        assert_eq!(scripts[2].source.as_deref(), Some("config.js"));
        assert_eq!(scripts[0].base, "https://images.test/");
        assert_eq!(scripts[1].base, "https://images.test/assets/");
        assert_eq!(scripts[2].fetch_base, "https://images.test/");
        assert_eq!(scripts[2].base, "https://images.test/assets/");
        let scripts = ordered(
            b"\xef\xbb\xbf<title>\xe9</title><script>ASCII</script>",
            "https://images.test/",
        );
        assert_eq!(scripts[0].body, "ASCII");
    }

    #[test]
    fn page_title_prefers_open_graph_metadata() {
        for (page, expected) in [
            (
                "<!-- <meta property=og:title content=wrong> --><template><title>wrong</title></template><meta PROPERTY=og:title content='A > B &amp; C' content=wrong>",
                Some("A > B & C"),
            ),
            (
                "<meta property=\"og:image\" content=\"https://fixtures.test/a.jpg\"><meta property=\"og:title\" content=\"Негатив: У фонтанов\">",
                Some("Негатив: У фонтанов"),
            ),
            (
                "<meta name=\"twitter:title\" content=\"Fallback &amp; Co\">",
                Some("Fallback & Co"),
            ),
            ("<title>Plain page title</title>", Some("Plain page title")),
            ("<title>   </title><meta name=\"x\">", None),
        ] {
            assert_eq!(title(page).as_deref(), expected);
        }
    }

    #[test]
    fn navigation_uses_active_tags_and_decoded_attributes() {
        let page = br#"<!-- <iframe src=wrong> --><template><base href=/wrong><iframe src=wrong></iframe></template><script>const html = '<iframe src=wrong>';</script><textarea><base href=/wrong></textarea><noscript><iframe src=wrong></noscript><base HREF='../assets/?x=1&amp;y=2'><base href=/ignored><iframe title='>' SRC=book?x=1&amp;y=2 src=wrong></iframe>"#;
        assert_eq!(
            resource("https://images.test/views/book.html", page, page_base),
            "https://images.test/assets/?x=1&y=2"
        );
        assert_eq!(
            resource("", page, |resource| iframe_sources(resource)
                .map(str::to_owned)
                .collect::<Vec<_>>()),
            ["book?x=1&y=2"]
        );
        assert_eq!(
            resource("", b"<script>one\r\ntwo\xff</script>", |resource| {
                script_bodies(resource)
                    .map(<[u8]>::to_vec)
                    .collect::<Vec<_>>()
            }),
            ["one\ntwo\u{fffd}".as_bytes()]
        );
    }

    #[test]
    fn html_entities_are_decoded() {
        assert_eq!(decode_html_entities("a &amp; b"), "a & b");
        assert_eq!(decode_html_entities("&#39;"), "'");
        assert_eq!(decode_html_entities("&#x263A;"), "☺");
        assert_eq!(decode_html_entities("&unknown;"), "&unknown;");
    }
}
