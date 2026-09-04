//! Pure URI and local-resource reference resolution.

use url::Url;

/// Resolve `reference` against an opaque URL or local resource name.
#[must_use]
pub fn resolve_relative(base: &str, reference: &str) -> String {
    if Url::parse(reference).is_ok() {
        return reference.to_owned();
    }
    if let Ok(url) = Url::parse(base)
        && let Ok(resolved) = url.join(reference)
    {
        return resolved.to_string();
    }
    // Absolute references that URL parsing rejects (e.g. tile URL templates
    // carrying `{placeholders}`) still win over base concatenation.
    if has_uri_scheme(reference) {
        return reference.to_owned();
    }
    if reference.starts_with('/')
        || reference.starts_with('\\')
        || (reference.len() >= 2
            && reference.as_bytes()[1] == b':'
            && reference.as_bytes()[0].is_ascii_alphabetic())
    {
        return reference.to_owned();
    }
    let directory = base.rfind(['/', '\\']).map_or("", |index| &base[..index]);
    let directory = directory.trim_end_matches(['/', '\\']);
    if directory.is_empty() {
        reference.to_owned()
    } else {
        format!("{directory}/{reference}")
    }
}

/// True for `scheme://` references. `C:\` style paths carry no `//`, so the
/// Windows-drive branch below is unaffected.
fn has_uri_scheme(reference: &str) -> bool {
    let bytes = reference.as_bytes();
    let mut i = 0;
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    while i < bytes.len()
        && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'+' | b'-' | b'.'))
    {
        i += 1;
    }
    reference[i..].starts_with("://")
}

#[cfg(test)]
mod tests {
    use super::resolve_relative;

    #[test]
    fn resolves_urls_and_portable_local_references() {
        assert_eq!(resolve_relative("/a/b", "c/d"), "/a/c/d");
        assert_eq!(
            resolve_relative("C:\\foo\\bar\\tour.js", "tour.xml"),
            "C:\\foo\\bar/tour.xml"
        );
        assert_eq!(resolve_relative("http://a.b/x/", "c/d"), "http://a.b/x/c/d");
        assert_eq!(
            resolve_relative("/metadata/tour.xml", "/tiles/0_0.jpg"),
            "/tiles/0_0.jpg"
        );
        assert_eq!(
            resolve_relative(
                "https://fixtures.test/wmts/WMTSCapabilities.xml",
                "http://127.0.0.1:PORT/wmts/{TileMatrix}/{TileCol}/{TileRow}.jpg"
            ),
            "http://127.0.0.1:PORT/wmts/{TileMatrix}/{TileCol}/{TileRow}.jpg"
        );
    }
}
