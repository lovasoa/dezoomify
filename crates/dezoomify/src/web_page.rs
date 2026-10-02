//! Generic HTML page parsing helpers shared by the site-specific formats.

use std::sync::LazyLock;

use regex::Regex;

use crate::core::resolve_relative;
use crate::markup::attribute;

static SCRIPT_ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\s+([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?"#)
        .expect("constant HTML attribute pattern")
});
static JAVASCRIPT_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:text|application)/(?:x-)?(?:java|ecma)script|text/(?:jscript|livescript|javascript1\.[0-5]))?$").expect("constant JavaScript MIME pattern")
});
static SCRIPT_BLOCK: LazyLock<regex::bytes::Regex> = LazyLock::new(|| {
    let inert = [
        "style", "title", "textarea", "noscript", "iframe", "xmp", "noembed", "noframes",
    ]
    .map(|tag| format!(r"<{tag}\b[^>]*>.*?</{tag}\s*>"))
    .join("|");
    regex::bytes::Regex::new(&format!(r#"(?is-u)<!--.*?-->|{inert}|<plaintext\b[^>]*>.*$|<(script)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:/>|>(.*?)</script\s*>)|<(/?template|base)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|(<(?:[^>"']|"[^"]*"|'[^']*')*>)"#))
        .expect("constant HTML script pattern")
});

/// A script in parser order (immediate scripts before deferred scripts). Relative configuration uses the document base,
/// while `source` retains the original, entity-decoded attribute value.
/// `fetch_base` is captured at the tag; deferred execution uses the final `base`.
pub(crate) struct Script<T> {
    pub source: Option<String>,
    pub body: T,
    pub base: String,
    pub fetch_base: String,
}

fn script_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    SCRIPT_ATTRIBUTE.captures_iter(tag).find_map(|c| {
        c[1].eq_ignore_ascii_case(name).then(|| {
            (2..5)
                .find_map(|i| c.get(i))
                .map_or("", |value| value.as_str())
        })
    })
}

fn visit_tags<'a>(
    bytes: &'a [u8],
    uri: &str,
    mut visit: impl FnMut(regex::bytes::Captures<'a>, &str),
) -> String {
    let (mut base, mut has_base, mut templates) = (uri.to_owned(), false, 0usize);
    for c in SCRIPT_BLOCK.captures_iter(bytes) {
        if let Some(tag) = c.get(4) {
            match String::from_utf8_lossy(tag.as_bytes())
                .to_ascii_lowercase()
                .as_str()
            {
                "template" => templates += 1,
                "/template" => templates = templates.saturating_sub(1),
                "base" if templates == 0 && !has_base => {
                    if let Some(href) = script_attribute(
                        &String::from_utf8_lossy(c.get(5).unwrap().as_bytes()),
                        "href",
                    ) {
                        base = resolve_relative(uri, &decode_html_entities(href));
                        has_base = true;
                    }
                }
                _ => {}
            }
            continue;
        }
        if templates == 0 {
            visit(c, &base);
        }
    }
    base
}

/// Body load handlers run after scripts, unlike interactive event handlers.
pub(crate) fn load_handlers(text: &str, uri: &str) -> Vec<Script<String>> {
    let mut handlers = Vec::new();
    let base = visit_tags(text.as_bytes(), uri, |c, _| {
        let Some(tag) = c.get(6) else {
            return;
        };
        let tag = String::from_utf8_lossy(tag.as_bytes());
        if tag.to_ascii_lowercase().starts_with("<body")
            && tag
                .as_bytes()
                .get(5)
                .is_some_and(|b| b.is_ascii_whitespace() || *b == b'>')
            && let Some(handler) = script_attribute(&tag, "onload")
        {
            handlers.push(decode_html_entities(handler));
        }
    });
    handlers
        .into_iter()
        .map(|body| Script {
            source: None,
            body,
            base: base.clone(),
            fetch_base: base.clone(),
        })
        .collect()
}

/// Extract active JavaScript blocks without interpreting their contents.
/// Comments, template contents and other raw text elements are excluded;
/// the first base element applies only to scripts that follow it.
pub(crate) fn scripts<'a>(text: &'a str, uri: &str) -> Vec<Script<&'a str>> {
    scripts_bytes(text.as_bytes(), uri)
        .into_iter()
        .map(|script| Script {
            source: script.source,
            body: std::str::from_utf8(script.body).expect("slice of UTF-8 source"),
            base: script.base,
            fetch_base: script.fetch_base,
        })
        .collect()
}

/// Preserve script bytes even when surrounding HTML uses a legacy encoding.
pub(crate) fn scripts_bytes<'a>(bytes: &'a [u8], uri: &str) -> Vec<Script<&'a [u8]>> {
    if !SCRIPT_BLOCK.is_match(bytes) {
        return vec![Script {
            source: None,
            body: bytes,
            base: uri.into(),
            fetch_base: uri.into(),
        }];
    }
    let mut scripts = Vec::new();
    let base = visit_tags(bytes, uri, |c, base| {
        if c.get(1).is_none() {
            return;
        }
        let attributes = String::from_utf8_lossy(c.get(2).unwrap().as_bytes());
        let kind = decode_html_entities(script_attribute(&attributes, "type").unwrap_or_default());
        let module = kind.trim().eq_ignore_ascii_case("module");
        if !module && script_attribute(&attributes, "nomodule").is_some() {
            return;
        }
        if !module && !JAVASCRIPT_TYPE.is_match(kind.split(';').next().unwrap_or_default().trim()) {
            return;
        }
        let source = script_attribute(&attributes, "src").map(decode_html_entities);
        if source
            .as_ref()
            .is_some_and(|source| source.trim().is_empty())
        {
            return;
        }
        let deferred =
            module || (source.is_some() && script_attribute(&attributes, "defer").is_some());
        scripts.push((
            deferred,
            Script {
                source,
                body: c.get(3).map_or(&bytes[..0], |body| body.as_bytes()),
                base: base.to_owned(),
                fetch_base: base.to_owned(),
            },
        ));
    });
    scripts.sort_by_key(|(module, _)| *module);
    for (deferred, script) in &mut scripts {
        if *deferred {
            script.base = base.clone();
        }
    }
    scripts.into_iter().map(|(_, script)| script).collect()
}

/// Inline script data, including JSON configuration, outside inert HTML elements.
pub(crate) fn script_bodies(bytes: &[u8]) -> Vec<&[u8]> {
    let mut bodies = Vec::new();
    visit_tags(bytes, "", |c, _| {
        if let Some(body) = c.get(3)
            && script_attribute(
                &String::from_utf8_lossy(c.get(2).unwrap().as_bytes()),
                "src",
            )
            .is_none()
        {
            bodies.push(body.as_bytes());
        }
    });
    bodies
}

static META_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<meta\b[^>]*>").expect("constant meta tag pattern"));
static TITLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<title\b[^>]*>([^<]*)</title>").expect("constant title pattern")
});
static IFRAME_RE: LazyLock<regex::bytes::Regex> = LazyLock::new(|| {
    regex::bytes::Regex::new(r"(?i)<iframe\b[^>]*>").expect("constant iframe source pattern")
});

/// Generic navigation references in document order, without format claims.
/// Empty sources are ignored and HTML character references are decoded.
pub(crate) fn iframe_sources(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    IFRAME_RE
        .find_iter(bytes)
        .filter_map(|tag| std::str::from_utf8(tag.as_bytes()).ok())
        .filter_map(|tag| attribute(tag, "src"))
        .map(decode_html_entities)
        .map(|source| source.trim().to_owned())
        .filter(|source| !source.is_empty())
}

/// Best-effort human-readable title of an HTML page.
///
/// Prefers Open Graph and Twitter Card metadata over the plain `<title>`
/// element, decodes HTML entities, and returns `None` when the page declares
/// nothing meaningful. Formats use it to name images after the page that
/// embeds them instead of inventing a generic name.
#[must_use]
pub fn page_title(page: &str) -> Option<String> {
    META_RE
        .captures_iter(page)
        .find_map(|captures| {
            let tag = captures.get(0)?.as_str();
            let key = attribute(tag, "property").or_else(|| attribute(tag, "name"))?;
            let is_title =
                key.eq_ignore_ascii_case("og:title") || key.eq_ignore_ascii_case("twitter:title");
            if !is_title {
                return None;
            }
            let title = decode_html_entities(attribute(tag, "content")?);
            let title = title.trim();
            (!title.is_empty()).then(|| title.to_owned())
        })
        .or_else(|| {
            TITLE_RE.captures(page).and_then(|captures| {
                let title = decode_html_entities(captures.get(1)?.as_str());
                let title = title.trim();
                (!title.is_empty()).then(|| title.to_owned())
            })
        })
}

/// Replace the HTML entities found in `text` by the characters they encode.
///
/// Entities without a known expansion are kept verbatim.
#[must_use]
pub fn decode_html_entities(text: &str) -> String {
    html_escape::decode_html_entities(text).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_scripts_keep_raw_contents_and_document_bases() {
        let page = concat!(
            "Server warning <!-- <script src=wrong.js></script> -->",
            "<script src='first.js?x&amp;y'/>",
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
        let scripts = scripts(page, "https://images.test/views/book.html");
        assert_eq!(scripts.len(), 3);
        assert_eq!(scripts[0].source.as_deref(), Some("first.js?x&y"));
        assert_eq!(scripts[0].base, "https://images.test/views/book.html");
        assert_eq!(scripts[1].body, "image&amp;name");
        assert_eq!(scripts[1].base, "https://images.test/assets/");
        assert_eq!(scripts[2].source.as_deref(), Some("second.js"));
        assert_eq!(scripts[2].base, scripts[1].base);
        let scripts = super::scripts(
            "<script src=''>ignored</script><script src=' &#32; '>ignored</script><script type=MODULE>module</script><script defer src=config.js></script><script>immediate</script><base href='/assets/'>",
            "https://images.test/",
        );
        assert_eq!(scripts[0].body, "immediate");
        assert_eq!(scripts[1].body, "module");
        assert_eq!(scripts[2].source.as_deref(), Some("config.js"));
        assert_eq!(scripts[0].base, "https://images.test/");
        assert_eq!(scripts[1].base, "https://images.test/assets/");
        assert_eq!(scripts[2].fetch_base, "https://images.test/");
        assert_eq!(scripts[2].base, "https://images.test/assets/");
        let scripts = scripts_bytes(
            b"\xef\xbb\xbf<title>\xe9</title><script>ASCII</script>",
            "https://images.test/",
        );
        assert_eq!(scripts[0].body, b"ASCII");
    }

    #[test]
    fn page_title_prefers_open_graph_metadata() {
        assert_eq!(
            page_title(concat!(
                "<meta property=\"og:image\" content=\"https://fixtures.test/a.jpg\">",
                "<meta property=\"og:title\" content=\"Негатив: У фонтанов\">"
            )),
            Some("Негатив: У фонтанов".to_owned())
        );
        assert_eq!(
            page_title("<meta name=\"twitter:title\" content=\"Fallback &amp; Co\">"),
            Some("Fallback & Co".to_owned())
        );
        assert_eq!(
            page_title("<title>Plain page title</title>"),
            Some("Plain page title".to_owned())
        );
        assert_eq!(page_title("<title>   </title><meta name=\"x\">"), None);
    }

    #[test]
    fn html_entities_are_decoded() {
        assert_eq!(decode_html_entities("a &amp; b"), "a & b");
        assert_eq!(decode_html_entities("&#39;"), "'");
        assert_eq!(decode_html_entities("&#x263A;"), "☺");
        assert_eq!(decode_html_entities("&unknown;"), "&unknown;");
    }
}
