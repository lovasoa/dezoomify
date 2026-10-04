//! Generic HTML page parsing helpers shared by the site-specific formats.

use std::sync::LazyLock;

use regex::Regex;

use crate::core::resolve_relative;
use html5gum::{DefaultEmitter, StartTag, State, Token, Tokenizer};
use std::borrow::Cow;

type HtmlTokens<'a> = Tokenizer<html5gum::StringReader<'a>, DefaultEmitter<usize>>;

// Keep the tokenizer state machine shared across tag consumers and raw-text scans.
#[inline(never)]
fn next_token(tokens: &mut HtmlTokens<'_>) -> Option<Token<usize>> {
    tokens.next().and_then(Result::ok)
}

static JAVASCRIPT_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:text|application)/(?:x-)?(?:java|ecma)script|text/(?:jscript|livescript|javascript1\.[0-5]))?$").expect("constant JavaScript MIME pattern")
});
/// Decoded attributes and untouched raw-text contents in source order.
pub(crate) struct Tag<'a> {
    tag: StartTag<usize>,
    pub body: &'a [u8],
}
impl Tag<'_> {
    pub fn name(&self) -> &[u8] {
        &self.tag.name
    }
    pub fn attribute(&self, name: &str) -> Option<Cow<'_, str>> {
        self.tag
            .attributes
            .get(name.as_bytes())
            .map(|value| String::from_utf8_lossy(value))
    }
}

/// Tokenize without building a DOM: preserve script order and legacy-encoded bodies.
/// Template contents and raw-text elements cannot create active descendant tags.
#[inline(never)]
pub(crate) fn tags(bytes: &[u8]) -> Box<dyn Iterator<Item = Tag<'_>> + '_> {
    let emitter = DefaultEmitter::<usize>::new_with_span();
    let mut tokens = Tokenizer::new_with_emitter(bytes, emitter);
    let mut templates = 0usize;
    Box::new(std::iter::from_fn(move || {
        loop {
            let tag = match next_token(&mut tokens)? {
                Token::StartTag(tag) => tag,
                Token::EndTag(tag) if tag.name.as_slice() == b"template" => {
                    templates = templates.saturating_sub(1);
                    continue;
                }
                _ => continue,
            };
            let state = if tag.name.as_slice() == b"noframes" {
                Some(State::RawText)
            } else {
                html5gum::naive_next_state(&tag.name)
            };
            let mut body = &bytes[..0];
            // Preserve support for historical self-closing viewer script tags.
            if let Some(state) = state
                && (!tag.self_closing || tag.name.as_slice() != b"script")
            {
                tokens.set_state(state);
                let end = std::iter::from_fn(|| next_token(&mut tokens))
                    .find_map(|token| {
                        if let Token::EndTag(end) = token {
                            Some(end.span.start)
                        } else {
                            None
                        }
                    })
                    .unwrap_or(bytes.len());
                body = &bytes[tag.span.end..end];
            }
            if tag.name.as_slice() == b"template" {
                templates += 1;
            }
            if templates == 0 {
                return Some(Tag { tag, body });
            }
        }
    }))
}

/// A script in parser order (immediate scripts before deferred scripts). Relative configuration uses the document base,
/// while `source` retains the original, entity-decoded attribute value.
/// `fetch_base` is captured at the tag; deferred execution uses the final `base`.
pub(crate) struct Script<T> {
    pub source: Option<String>,
    pub body: T,
    pub base: String,
    pub fetch_base: String,
}

fn visit_tags<'a>(bytes: &'a [u8], uri: &str, mut visit: impl FnMut(Tag<'a>, &str)) -> String {
    let (mut base, mut has_base) = (uri.to_owned(), false);
    for tag in tags(bytes) {
        if tag.name() == b"base"
            && !has_base
            && let Some(href) = tag.attribute("href")
        {
            base = resolve_relative(uri, &href);
            has_base = true;
        }
        visit(tag, &base);
    }
    base
}

/// Body load handlers run after scripts, unlike interactive event handlers.
pub(crate) fn load_handlers(text: &str, uri: &str) -> Vec<Script<String>> {
    let mut handlers = Vec::new();
    let base = visit_tags(text.as_bytes(), uri, |c, _| {
        if c.name() == b"body"
            && let Some(handler) = c.attribute("onload")
        {
            handlers.push(handler.into_owned());
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
    let mut tokens = Tokenizer::new_with_emitter(bytes, DefaultEmitter::<usize>::new_with_span());
    if !std::iter::from_fn(|| next_token(&mut tokens)).any(|token| {
        matches!(
            token,
            Token::StartTag(_) | Token::EndTag(_) | Token::Comment(_) | Token::Doctype(_)
        )
    }) {
        return vec![Script {
            source: None,
            body: bytes,
            base: uri.into(),
            fetch_base: uri.into(),
        }];
    }
    let mut scripts = Vec::new();
    let base = visit_tags(bytes, uri, |c, base| {
        if c.name() != b"script" {
            return;
        }
        let kind = c.attribute("type").unwrap_or_default();
        let module = kind.trim().eq_ignore_ascii_case("module");
        if !module
            && (c.attribute("nomodule").is_some()
                || !JAVASCRIPT_TYPE.is_match(kind.split(';').next().unwrap_or_default().trim()))
        {
            return;
        }
        let source = c.attribute("src").map(Cow::into_owned);
        if source
            .as_ref()
            .is_some_and(|source| source.trim().is_empty())
        {
            return;
        }
        let deferred = module || (source.is_some() && c.attribute("defer").is_some());
        scripts.push((
            deferred,
            Script {
                source,
                body: c.body,
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
    visit_tags(bytes, "", |tag, _| {
        if tag.name() == b"script" && tag.attribute("src").is_none() {
            bodies.push(tag.body);
        }
    });
    bodies
}

/// Generic navigation references in document order, excluding inert content.
pub(crate) fn iframe_sources(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    tags(bytes)
        .filter(|tag| tag.name() == b"iframe")
        .filter_map(|tag| tag.attribute("src").map(|src| src.trim().to_owned()))
        .filter(|src| !src.is_empty())
}

/// The first active HTML base, resolved against the redirected resource URI.
pub(crate) fn page_base(bytes: &[u8], uri: &str) -> String {
    tags(bytes)
        .find_map(|tag| {
            (tag.name() == b"base")
                .then(|| tag.attribute("href").map(Cow::into_owned))
                .flatten()
        })
        .map_or_else(|| uri.into(), |href| resolve_relative(uri, &href))
}

/// Best-effort human-readable title of an HTML page.
///
/// Prefers Open Graph and Twitter Card metadata over the plain `<title>`
/// element, decodes HTML entities, and returns `None` when the page declares
/// nothing meaningful. Formats use it to name images after the page that
/// embeds them instead of inventing a generic name.
#[must_use]
pub fn page_title(page: &str) -> Option<String> {
    let mut fallback = None;
    for tag in tags(page.as_bytes()) {
        if tag.name() == b"title" && fallback.is_none() {
            fallback = Some(decode_html_entities(&String::from_utf8_lossy(tag.body)));
        }
        if tag.name() == b"meta"
            && let Some(key) = tag.attribute("property").or_else(|| tag.attribute("name"))
            && (key.eq_ignore_ascii_case("og:title") || key.eq_ignore_ascii_case("twitter:title"))
            && let Some(title) = tag.attribute("content")
            && !title.trim().is_empty()
        {
            return Some(title.trim().to_owned());
        }
    }
    fallback
        .map(|title| title.trim().to_owned())
        .filter(|title| !title.is_empty())
}

/// Replace the HTML entities found in `text` by the characters they encode.
///
/// Entities without a known expansion are kept verbatim.
#[must_use]
pub fn decode_html_entities(text: &str) -> String {
    let mut tokens =
        Tokenizer::new_with_emitter(text.as_bytes(), DefaultEmitter::<usize>::new_with_span());
    tokens.set_state(State::RcData);
    let mut bytes = Vec::new();
    while let Some(token) = next_token(&mut tokens) {
        if let Token::String(text) = token {
            bytes.extend_from_slice(&text);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
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
            page_title(
                "<!-- <meta property=og:title content=wrong> --><template><title>wrong</title></template><meta PROPERTY=og:title content='A > B &amp; C' content=wrong>"
            ),
            Some("A > B & C".into())
        );
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
    fn navigation_uses_active_tags_and_decoded_attributes() {
        let page = br#"<!-- <iframe src=wrong> --><template><base href=/wrong><iframe src=wrong></iframe></template><script>const html = '<iframe src=wrong>';</script><textarea><base href=/wrong></textarea><noscript><iframe src=wrong></noscript><base HREF='../assets/?x=1&amp;y=2'><base href=/ignored><iframe title='>' SRC=book?x=1&amp;y=2 src=wrong></iframe>"#;
        assert_eq!(
            page_base(page, "https://images.test/views/book.html"),
            "https://images.test/assets/?x=1&y=2"
        );
        assert_eq!(iframe_sources(page).collect::<Vec<_>>(), ["book?x=1&y=2"]);
        assert_eq!(
            script_bodies(b"<script>one\r\ntwo\xff</script>"),
            [b"one\r\ntwo\xff".as_slice()]
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
