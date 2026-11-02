//! Shared extraction of literal JavaScript configuration, without execution.
//!
//! Formats provide declaration patterns; strings, comments, regular expressions,
//! and function bodies are handled here to exclude inactive source. This is a
//! limited source recognizer, not a JavaScript evaluator.

use regex::Regex;
use std::sync::LazyLock;

static FUNCTIONS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"\b(?:([\w$]+(?:\s*\.\s*[\w$]+)*)\s*=\s*function\b\s*\*?\s*\([^)]*\)|function\b\s*\*?\s*([\w$]+)?\s*\([^)]*\))\s*\{|=>\s*\{|\b([\w$]+)\s*\([^)]*\)\s*\{"
).expect("constant function pattern")
});
static PROPERTY: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(r#"(?:\b([\w$]+)|'([^']*)'|"([^"]*)")\s*:\s*(?:'([^']*)'|"([^"]*)")\s*(?:,|$)"#)
});
static PROPERTY_NAME: LazyLock<Regex> =
    LazyLock::new(|| literal_regex(r#"(?:\b([\w$]+)|'([^']*)'|"([^\"]*)")\s*:"#));
static ARROWS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"=>\s*").expect("constant arrow pattern"));

/// Last named function definition in the supplied source prefix.
pub(crate) fn function_body<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    captures(&FUNCTIONS, text)
        .filter_map(|c| {
            (c.get(1).or_else(|| c.get(2)).is_some_and(|n| {
                let qualified = n.as_str().replace(char::is_whitespace, "");
                qualified.strip_prefix("window.").unwrap_or(&qualified) == name
            }))
            .then(|| body_at(text, c.get(0).unwrap().end()))
            .flatten()
        })
        .last()
}

/// Function declarations and block arrow functions are inactive until invoked.
pub(crate) fn inside_function(text: &str, position: usize) -> bool {
    captures(&FUNCTIONS, text).any(|c| {
        if c.get(3).is_some_and(|name| {
            matches!(
                name.as_str(),
                "if" | "for" | "while" | "switch" | "catch" | "with"
            )
        }) {
            return false;
        }
        body_at(text, c.get(0).unwrap().end()).is_some_and(|body| {
            let end = body.as_ptr() as usize - text.as_ptr() as usize + body.len() + 1;
            let generator = c
                .get(0)
                .unwrap()
                .as_str()
                .split('(')
                .next()
                .unwrap()
                .contains('*');
            (generator || !immediately_invoked(text, end))
                && contains_position(text, body, position)
        })
    }) || captures(&ARROWS, text).any(|c| {
        let start = c.get(0).unwrap().end();
        let end = expression_end(text, start);
        !text[start..].starts_with('{')
            && !immediately_invoked(text, end)
            && (start..end).contains(&position)
    })
}

fn immediately_invoked(text: &str, end: usize) -> bool {
    text[end..]
        .trim_start_matches(|c: char| c == ')' || c.is_whitespace())
        .starts_with('(')
}

// A concise arrow expression ends at its enclosing delimiter or statement end.
fn expression_end(text: &str, start: usize) -> usize {
    let (mut depth, mut quote, mut escaped) = (0u32, None, false);
    for (offset, byte) in text.bytes().enumerate().skip(start) {
        match quote {
            Some(_) if escaped => escaped = false,
            Some(_) if byte == b'\\' => escaped = true,
            Some(delimiter) if byte == delimiter => quote = None,
            None if matches!(byte, b'\'' | b'"' | b'`') => quote = Some(byte),
            None if matches!(byte, b'(' | b'[' | b'{') => depth += 1,
            None if matches!(byte, b')' | b']' | b'}') => {
                if depth == 0 {
                    return offset;
                }
                depth -= 1;
            }
            None if depth == 0 && matches!(byte, b';' | b',' | b'\n') => return offset,
            _ => {}
        }
    }
    text.len()
}

/// Literal string property; expressions are deliberately excluded.
pub(crate) fn property(text: &str, name: &str) -> Option<String> {
    let key = captures(&PROPERTY_NAME, text)
        .filter(|c| capture_text(c, 1..4) == name)
        .last()?;
    let value = PROPERTY.captures(&text[key.get(0)?.start()..])?;
    (value.get(0)?.start() == 0)
        .then(|| captured_literal(&value, 4..6))
        .flatten()
}

/// Distinguish an omitted property from an explicit nonliteral expression.
pub(crate) fn property_exists(text: &str, name: &str) -> bool {
    captures(&PROPERTY_NAME, text).any(|c| capture_text(&c, 1..4) == name)
}

pub(crate) fn literal_regex(pattern: &str) -> Regex {
    Regex::new(
        &pattern
            .replace("([^']*)", r"((?:\\[\s\S]|[^'\\])*)")
            .replace("([^\"]*)", r#"((?:\\[\s\S]|[^"\\])*)"#),
    )
    .unwrap()
}

// Parse only the captured, quoted string using the existing JSON5 dependency.
pub(crate) fn captured_literal(
    c: &regex::Captures<'_>,
    mut groups: std::ops::Range<usize>,
) -> Option<String> {
    let raw = groups.find_map(|group| c.get(group))?;
    let matched = c.get(0)?;
    let start = raw.start() - matched.start();
    json5::from_str(&matched.as_str()[start - 1..start + raw.len() + 1]).ok()
}

pub(crate) fn captures<'a>(
    regex: &'a Regex,
    text: &'a str,
) -> impl Iterator<Item = regex::Captures<'a>> {
    let (mut position, mut quote, mut escaped) = (0, None, false);
    regex.captures_iter(text).filter(move |capture| {
        let start = capture.get(0).unwrap().start();
        for &byte in &text.as_bytes()[position..start] {
            match quote {
                Some(_) if escaped => escaped = false,
                Some(_) if byte == b'\\' => escaped = true,
                Some(delimiter) if byte == delimiter => quote = None,
                None if matches!(byte, b'\'' | b'"' | b'`') => quote = Some(byte),
                _ => {}
            }
        }
        position = start;
        quote.is_none() && !text[..start].trim_end().ends_with(['.', '$'])
    })
}

pub(crate) fn captured(regex: &Regex, text: &str) -> Option<String> {
    let captures = captures(regex, text)
        .filter(|c| !inside_function(text, c.get(0).unwrap().start()))
        .filter(|c| {
            let matched = c.get(0).unwrap();
            !regex.as_str().starts_with("(?m)")
                || matched.as_str().trim_end().ends_with(';')
                || (!text[matched.end()..].trim_start().starts_with([
                    '+', '-', '*', '/', '%', '.', '[', '(', '?', ':', ',', '=', '&', '|', '`', '<',
                    '>',
                ]) && !text[matched.end()..].trim_start().starts_with("in ")
                    && !text[matched.end()..]
                        .trim_start()
                        .starts_with("instanceof "))
        })
        .last()?;
    captured_literal(&captures, 1..3)
}

pub(crate) fn capture_text<'a>(
    captures: &regex::Captures<'a>,
    mut groups: std::ops::Range<usize>,
) -> &'a str {
    groups
        .find_map(|group| captures.get(group))
        .expect("one literal alternative is captured")
        .as_str()
}

pub(crate) fn body_at(text: &str, start: usize) -> Option<&str> {
    let (mut depth, mut quote, mut escaped) = (1u32, None, false);
    for (offset, byte) in text.bytes().enumerate().skip(start) {
        match quote {
            Some(_) if escaped => escaped = false,
            Some(_) if byte == b'\\' => escaped = true,
            Some(delimiter) if byte == delimiter => quote = None,
            None if matches!(byte, b'\'' | b'"' | b'`') => quote = Some(byte),
            None if byte == b'{' => depth += 1,
            None if byte == b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..offset]);
                }
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn contains_position(text: &str, body: &str, position: usize) -> bool {
    let start = body.as_ptr() as usize - text.as_ptr() as usize;
    (start..start + body.len()).contains(&position)
}

/// Mask comments and regex literals while preserving byte offsets and strings.
/// Lexical context is tracked in one pass, including regexes after conditions.
pub(crate) fn mask(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = bytes.to_vec();
    let mut position = 0;
    let mut quote = None;
    let mut context = RegexContext::new();
    while position < bytes.len() {
        let byte = bytes[position];
        if let Some(delimiter) = quote {
            if byte == b'\\' {
                position += 2;
                continue;
            }
            if byte == delimiter {
                quote = None;
            }
        } else if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
            context.value();
        } else if let Some(end) = comment_end(text, position) {
            out[position..end].fill(b' ');
            position = end;
            continue;
        } else if byte == b'/'
            && context.allowed
            && let Some(end) = regex_end(bytes, position)
        {
            out[position..=end].fill(b' ');
            position = end + 1;
            context.value();
            continue;
        } else {
            position += context.token(&text[position..]);
            continue;
        }
        position += 1;
    }
    String::from_utf8(out).expect("comment removal preserves UTF-8")
}

/// Whether the next slash begins a regex, retaining only the preceding token
/// and whether each open parenthesis belongs to a control statement.
struct RegexContext {
    allowed: bool,
    control: bool,
    parentheses: Vec<bool>,
}

impl RegexContext {
    fn new() -> Self {
        Self {
            allowed: true,
            control: false,
            parentheses: Vec::new(),
        }
    }

    fn value(&mut self) {
        self.allowed = false;
        self.control = false;
    }

    fn token(&mut self, text: &str) -> usize {
        let character = text.chars().next().unwrap();
        if character.is_whitespace() {
            return character.len_utf8();
        }
        if character.is_alphanumeric() || matches!(character, '_' | '$') {
            let end = text
                .char_indices()
                .find(|(_, c)| !c.is_alphanumeric() && !matches!(c, '_' | '$'))
                .map_or(text.len(), |(offset, _)| offset);
            let word = &text[..end];
            self.allowed = matches!(
                word,
                "return" | "throw" | "case" | "yield" | "typeof" | "void" | "delete"
            );
            self.control = matches!(word, "if" | "while" | "for" | "with" | "switch" | "catch");
            return end;
        }
        self.allowed = match character {
            '(' => {
                self.parentheses.push(self.control);
                true
            }
            ')' => self.parentheses.pop().unwrap_or(false),
            _ => "=[{,:;!?&|+-*%~^<>".contains(character),
        };
        self.control = false;
        character.len_utf8()
    }
}

fn comment_end(text: &str, position: usize) -> Option<usize> {
    let tail = &text.as_bytes()[position..];
    if tail.starts_with(b"//")
        || tail.starts_with(b"<!--")
        || (tail.starts_with(b"-->")
            && text[..position]
                .rsplit(['\n', '\r'])
                .next()
                .unwrap_or_default()
                .trim()
                .is_empty())
    {
        return Some(
            position
                + tail
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .unwrap_or(tail.len()),
        );
    }
    tail.starts_with(b"/*").then(|| {
        position
            + tail[2..]
                .windows(2)
                .position(|pair| pair == b"*/")
                .map_or(tail.len(), |end| end + 4)
    })
}

fn regex_end(bytes: &[u8], position: usize) -> Option<usize> {
    let mut end = position + 1;
    let mut class = false;
    while end < bytes.len() && !matches!(bytes[end], b'\n' | b'\r') {
        match bytes[end] {
            b'\\' => end += 1,
            b'[' => class = true,
            b']' => class = false,
            b'/' if !class => break,
            _ => {}
        }
        end += 1;
    }
    (bytes.get(end) == Some(&b'/')).then_some(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_code_preserves_division_and_masks_regexes_after_nested_conditions() {
        let library =
            r#"function scale(x){return value(x) / 2;} if (ready(")", "é")) /[/'"]/.test(value);"#;
        let source = format!("{} path='image.dzi';", library.repeat(1024));
        let visible = mask(&source);
        assert!(visible.starts_with("function scale(x){return value(x) / 2;}"));
        assert!(!visible.contains("/[/'\"]/.test"));
        assert!(visible.ends_with("path='image.dzi';"));
        assert_eq!(visible.len(), source.len());
    }

    #[test]
    fn literal_strings_properties_and_inactive_source() {
        let assignment = literal_regex(r#"(?m)\bpath\s*=\s*(?:'([^']*)'|"([^"]*)")\s*(?:;|$)"#);
        for (source, expected) in [
            (r"path='folio\/1';", Some("folio/1")),
            (r"path='folio\x2f1';", Some("folio/1")),
            (r"path='folio\u002f1';", Some("folio/1")),
            (r"path='image\'one';", Some("image'one")),
            (r"path='image\uD83D\uDE00';", Some("image😀")),
            ("path='a&amp;b';", Some("a&amp;b")),
            (r"path='bad\xZZ';", None),
            (
                "path='right'; function unused(){path='wrong';}",
                Some("right"),
            ),
            (
                "path='right'; const unused=()=>{path='wrong';};",
                Some("right"),
            ),
            (
                "path='right'; const unused=()=>path='wrong';",
                Some("right"),
            ),
            (
                "path='right'; tools.preview=function(){path='wrong';};",
                Some("right"),
            ),
            (
                "path='right'; const tools={preview(){path='wrong';}};",
                Some("right"),
            ),
            (
                "path='right'; class Tools {preview(){path='wrong';}}",
                Some("right"),
            ),
            (
                "path='right'; const preview=function*(){path='wrong';};",
                Some("right"),
            ),
            (
                "path='right'; (function*(){path='wrong';})();",
                Some("right"),
            ),
            ("while (remaining-->0) path='right';", Some("right")),
            ("path='right';\n --> path='wrong';", Some("right")),
            (
                "const example=\"path='wrong';\"; path='right';",
                Some("right"),
            ),
            (
                "/* path='wrong'; */ path='right'; // path='wrong';",
                Some("right"),
            ),
            (
                r#"if (enabled) /"/.test(value); const re=/[/'"]/; path='right';"#,
                Some("right"),
            ),
            ("backup.path='wrong';", None),
            ("path='wrong'\n + dynamic;", None),
            ("path='wrong'\n [dynamic];", None),
            ("path='wrong'\n in dynamic;", None),
        ] {
            assert_eq!(
                captured(&assignment, &mask(source)).as_deref(),
                expected,
                "{source}"
            );
        }
        assert_eq!(
            property("path:'old', path:'../resources/'", "path").as_deref(),
            Some("../resources/")
        );
        assert_eq!(property("path:'old', path:choosePath()", "path"), None);
        let source = mask("(()=>loadIn())()");
        assert!(!inside_function(&source, source.find("loadIn").unwrap()));
        let source = mask(
            "function viewer(){ return {path:'old'}; } window.viewer=function(){return {path:'new'};};",
        );
        assert!(function_body(&source, "viewer").unwrap().contains("new"));
    }
}
