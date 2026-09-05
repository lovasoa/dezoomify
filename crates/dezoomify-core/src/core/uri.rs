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

/// Resolve a tile URL template against `base`, preserving `{placeholder}`
/// holes verbatim.
#[must_use]
pub fn resolve_url_template(base: &str, template: &str) -> String {
    resolve_relative(base, &template.replace('{', "%7B").replace('}', "%7D"))
        .replace("%7B", "{")
        .replace("%7b", "{")
        .replace("%7D", "}")
        .replace("%7d", "}")
}

/// File-name-derived image title: last path segment with its extension
/// stripped, or `None` when nothing meaningful remains.
#[must_use]
pub fn image_title(path: &str) -> Option<String> {
    let file = path.rsplit('/').next()?;
    let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    (!stem.is_empty()).then(|| stem.to_owned())
}

/// Redact credential-bearing parts of a URI for logs, errors, and
/// diagnostics. Strips userinfo and replaces sensitive query values
/// (`apikey`, `token`, `auth`, `session`, `signature`, `secret`, `password`,
/// `cookie`) with `REDACTED`. The delivered `Request.uri` is unchanged;
/// only human-visible copies use this form.
#[must_use]
pub fn redact_uri(uri: &str) -> String {
    let Ok(mut url) = Url::parse(uri) else {
        return redact_query_fallback(uri);
    };
    if !url.username().is_empty() || url.password().is_some() {
        let _ = url.set_username("REDACTED");
        let _ = url.set_password(Some("REDACTED"));
    }
    // Fragments never leave the client; drop them so `token=` in a fragment
    // cannot leak into logs.
    url.set_fragment(None);
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if pairs.iter().any(|(k, _)| is_sensitive_key(k)) {
        url.query_pairs_mut()
            .clear()
            .extend_pairs(pairs.iter().map(|(k, v)| {
                if is_sensitive_key(k) {
                    (k.as_str(), "REDACTED")
                } else {
                    (k.as_str(), v.as_str())
                }
            }));
    }
    url.to_string()
}

/// Origin (`scheme://host[:port]`) without path, query, or userinfo.
/// Used for `Referer` defaults so tile requests do not copy tokens.
#[must_use]
pub fn origin_only(uri: &str) -> String {
    if let Ok(url) = Url::parse(uri)
        && let Some(host) = url.host_str()
    {
        let port = url.port().map_or_else(String::new, |p| format!(":{p}"));
        return format!("{}://{host}{port}/", url.scheme());
    }
    uri.to_owned()
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [
        "apikey",
        "api_key",
        "token",
        "auth",
        "session",
        "signature",
        "secret",
        "password",
        "cookie",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn redact_query_fallback(uri: &str) -> String {
    let (base, query) = uri.split_once('?').unwrap_or((uri, ""));
    if query.is_empty() {
        return uri.to_owned();
    }
    let redacted: Vec<String> = query
        .split('&')
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            if is_sensitive_key(k) {
                format!("{k}=REDACTED")
            } else if v.is_empty() {
                k.to_owned()
            } else {
                pair.to_owned()
            }
        })
        .collect();
    format!("{base}?{}", redacted.join("&"))
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
