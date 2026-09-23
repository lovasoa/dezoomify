//! Small attribute parser shared by HTML snippets and simple XML viewers.

use std::sync::LazyLock;

use regex::Regex;

static ATTRIBUTE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*["']([^"']*)["']"#)
        .expect("constant markup attribute pattern")
});

/// Return a quoted attribute value from a tag, matching names without case.
pub(crate) fn attribute<'a>(tag: &'a str, wanted: &str) -> Option<&'a str> {
    ATTRIBUTE_RE.captures_iter(tag).find_map(|captures| {
        (captures.get(1)?.as_str().eq_ignore_ascii_case(wanted))
            .then(|| captures.get(2).expect("attribute value capture").as_str())
    })
}
