/// Deep-link envelope version currently produced.
pub const DEEP_LINK_CURRENT_VERSION: u32 = 2;
/// Oldest envelope version still accepted (N-1).
pub const DEEP_LINK_MIN_SUPPORTED_VERSION: u32 = 1;
/// Total deep-link length bound.
pub const MAX_DEEP_LINK_LEN: usize = 2048;
/// Per-field length bound for src/hint values after decoding.
pub const MAX_FIELD_LEN: usize = 1024;
/// Deep-link scheme.
pub const DEEP_LINK_SCHEME: &str = "dezoomify";
/// Deep-link host for the open action.
pub const DEEP_LINK_HOST: &str = "open";

/// Validated deep link awaiting confirmation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLink {
    pub version: u32,
    pub source_url: String,
    pub hint: Option<String>,
}

/// Typed rejection reason; never carries secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkError {
    Oversize,
    InvalidScheme,
    MissingField(&'static str),
    DuplicateField(&'static str),
    UnknownField(String),
    UnsupportedVersion(String),
    MalformedEncoding(String),
    UserinfoForbidden,
    SecretForbidden(String),
    InvalidSource(String),
}

impl std::fmt::Display for DeepLinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeepLinkError::Oversize => write!(f, "deep-link.rejected: oversize beyond 2048 bytes"),
            DeepLinkError::InvalidScheme => {
                write!(f, "deep-link.rejected: scheme must be dezoomify://open")
            }
            DeepLinkError::MissingField(k) => write!(f, "deep-link.rejected: missing field {k}"),
            DeepLinkError::DuplicateField(k) => {
                write!(f, "deep-link.rejected: duplicate field {k}")
            }
            DeepLinkError::UnknownField(k) => write!(f, "deep-link.rejected: unknown field {k}"),
            DeepLinkError::UnsupportedVersion(v) => {
                write!(f, "deep-link.rejected: unsupported version {v}")
            }
            DeepLinkError::MalformedEncoding(m) => {
                write!(f, "deep-link.rejected: malformed percent-encoding ({m})")
            }
            DeepLinkError::UserinfoForbidden => {
                write!(f, "deep-link.rejected: userinfo credentials are forbidden")
            }
            DeepLinkError::SecretForbidden(k) => {
                write!(f, "deep-link.rejected: secret field {k} is forbidden")
            }
            DeepLinkError::InvalidSource(m) => {
                write!(f, "deep-link.rejected: invalid source ({m})")
            }
        }
    }
}

impl std::error::Error for DeepLinkError {}

/// Credential-query lookup over the canonical contract vocabulary
/// `dezoomify::model::SENSITIVE_QUERY_KEYS` (declared once in
/// `crates/dezoomify/src/model.rs`). The TypeScript mirror is
/// `DEEP_LINK_SECRET_QUERY_KEYS` in `packages/shared-ui/src/source-url.ts`;
/// twin membership lock tests (the `sensitive_query_key_membership_is_locked`
/// test below and `apps/desktop/tests/policy-vectors.test.mjs`) pin the two
/// lists together. Matching is case-insensitive exact (never substring) so
/// `/cookie-recipe/` stays valid while `?token=secret` is rejected.
fn is_secret_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    dezoomify::model::SENSITIVE_QUERY_KEYS
        .iter()
        .any(|key| *key == lower)
}

/// Local-path markers that never travel in a deep link (separate from secret
/// query keys above, which are enforced by URL parsing). Substring checks are
/// confined to these path markers; credential keys always use exact-match URL
/// parsing so `/cookie-recipe/` stays valid.
fn source_contains_local_path(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for needle in ["file://", "/etc/", "c:\\"] {
        if lower.contains(needle) {
            return Some(needle.to_string());
        }
    }
    None
}

/// Strict percent-decode; any malformed `%` sequence is an error.
fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("truncated escape".to_string());
            }
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                }
                _ => {
                    return Err(format!(
                        "bad escape %{}{}",
                        bytes[i + 1] as char,
                        bytes[i + 2] as char
                    ));
                }
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "non-utf8 after decode".to_string())
}

fn has_userinfo(src: &str) -> bool {
    // Look at the authority section before the first /, ?, or #.
    if let Some(after_scheme) = src.split("://").nth(1) {
        let end = after_scheme
            .find(['/', '?', '#'])
            .unwrap_or(after_scheme.len());
        let authority = &after_scheme[..end];
        if authority.contains('@') {
            return true;
        }
    }
    false
}

fn validate_source(src: &str) -> Result<(), DeepLinkError> {
    if src.is_empty() || src.len() > MAX_FIELD_LEN {
        return Err(DeepLinkError::InvalidSource(
            "src must be 1..1024 bytes".to_string(),
        ));
    }
    // URI schemes are case-insensitive (`HTTPS://` is the same scheme as
    // `https://`), matching the TS mirror's URL-based scheme check.
    let scheme_lower = src.to_ascii_lowercase();
    if !(scheme_lower.starts_with("http://") || scheme_lower.starts_with("https://")) {
        return Err(DeepLinkError::InvalidSource(
            "scheme must be http or https".to_string(),
        ));
    }
    // Downstream scheme dispatch is case-sensitive; keep the accepted form
    // normalized so an uppercase scheme cannot be accepted and then refused.
    let src_owned: String;
    let src = if src.starts_with("http://") || src.starts_with("https://") {
        src
    } else {
        src_owned = format!(
            "{}{}",
            &scheme_lower[..scheme_lower.find(':').unwrap_or(0) + 3],
            &src[scheme_lower.find(':').unwrap_or(0) + 3..]
        );
        src_owned.as_str()
    };
    // userinfo credentials must never travel in a deep link.
    if has_userinfo(src) {
        return Err(DeepLinkError::UserinfoForbidden);
    }
    // Local-path markers never travel in a deep link. Credential query keys
    // are enforced below by exact-match URL parsing (never substring), so
    // `/cookie-recipe/` stays valid while `?token=secret` is rejected.
    if let Some(needle) = source_contains_local_path(src) {
        return Err(DeepLinkError::SecretForbidden(needle));
    }
    Ok(())
}

pub fn find_deep_link_in_argv(argv: &[String]) -> Option<String> {
    for arg in argv {
        let candidate = arg.trim();
        if candidate.starts_with(&format!("{DEEP_LINK_SCHEME}://")) {
            return Some(candidate.to_string());
        }
    }
    None
}

/// The first credential key smuggled into a decoded source URL's own query or
/// fragment, if any. Regions mirror the TS `hasSecretQueryParams` in
/// `packages/shared-ui/src/source-url.ts`: the query runs from the first `?`
/// up to the first `#`; the fragment runs from the first `#`. A pair's key is
/// the text before its first `=` (or the whole pair) and counts whether or not
/// a value follows, so bare keys (`?token`) and percent-encoded spellings
/// (`?%74oken=1`) are caught like `?token=secret`. Matching stays exact per
/// key (case-insensitive), never substring.
fn smuggled_secret_key(source: &str) -> Option<String> {
    let before_fragment = source.split_once('#').map_or(source, |(b, _)| b);
    let query = before_fragment.split_once('?').map_or("", |(_, q)| q);
    let fragment = source.split_once('#').map_or("", |(_, f)| f);
    for region in [query, fragment] {
        for pair in region.split('&') {
            if pair.is_empty() {
                continue;
            }
            let raw_key = pair.split_once('=').map_or(pair, |(k, _)| k);
            let key = raw_key.trim_start_matches(['?', '#']);
            if key.is_empty() {
                continue;
            }
            if is_secret_key(key) {
                return Some(key.to_string());
            }
            // Percent-encoded spellings decode like form data (`%74oken` is
            // `token`); a malformed escape can never decode to a key name, so
            // decoding failures are skipped.
            if let Ok(decoded) = percent_decode(key) {
                if decoded != key && is_secret_key(&decoded) {
                    return Some(decoded);
                }
            }
        }
    }
    None
}

pub fn parse_deep_link(url: &str) -> Result<DeepLink, DeepLinkError> {
    // Surrounding whitespace never travels in the envelope (the argv scan and
    // the TS mirror `parseRawDeepLinkUrl` both trim first).
    let url = url.trim();
    if url.len() > MAX_DEEP_LINK_LEN {
        return Err(DeepLinkError::Oversize);
    }
    let prefix = format!("{DEEP_LINK_SCHEME}://{DEEP_LINK_HOST}");
    if !(url == prefix
        || url.starts_with(&format!("{prefix}?"))
        || url.starts_with(&format!("{prefix}/"))
        || url.starts_with(&format!("{prefix}/?")))
    {
        return Err(DeepLinkError::InvalidScheme);
    }
    let query = url.split_once('?').map(|x| x.1).unwrap_or("");
    // Strip fragment: fragments never carry job input.
    let query = query.split('#').next().unwrap_or("");
    if query.is_empty() {
        return Err(DeepLinkError::MissingField("v"));
    }
    let mut version_raw: Option<String> = None;
    let mut src_raw: Option<String> = None;
    let mut hint_raw: Option<String> = None;
    let mut seen_v = false;
    let mut seen_src = false;
    let mut seen_hint = false;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (name, value) = match pair.split_once('=') {
            Some((n, v)) => (n, v),
            None => {
                return Err(DeepLinkError::MalformedEncoding(format!(
                    "pair without =: {pair}"
                )));
            }
        };
        // Field names are literal; encoded names are rejected as malformed.
        if name.contains('%') {
            return Err(DeepLinkError::MalformedEncoding(
                "encoded field name".to_string(),
            ));
        }
        match name {
            "v" => {
                if seen_v {
                    return Err(DeepLinkError::DuplicateField("v"));
                }
                seen_v = true;
                version_raw = Some(value.to_string());
            }
            "src" => {
                if seen_src {
                    return Err(DeepLinkError::DuplicateField("src"));
                }
                seen_src = true;
                src_raw = Some(value.to_string());
            }
            "hint" => {
                if seen_hint {
                    return Err(DeepLinkError::DuplicateField("hint"));
                }
                seen_hint = true;
                hint_raw = Some(value.to_string());
            }
            other => {
                if is_secret_key(other) {
                    return Err(DeepLinkError::SecretForbidden(other.to_string()));
                }
                return Err(DeepLinkError::UnknownField(other.to_string()));
            }
        }
    }
    let version_raw = version_raw.ok_or(DeepLinkError::MissingField("v"))?;
    let src_raw = src_raw.ok_or(DeepLinkError::MissingField("src"))?;
    // Version must be a plain unsigned integer: digits only, with no sign and
    // no leading zero, so `+2`, `02`, `1.0`, and `2_0` are rejected exactly
    // like the TS mirror (`parseRawDeepLinkUrl` accepts only "1" and "2").
    // Supported: 2 (current) and 1 (N-1). Rejected: 0 (N-2) and 3+ (future).
    let plain_digits = !version_raw.is_empty()
        && version_raw.bytes().all(|b| b.is_ascii_digit())
        && (version_raw == "0" || !version_raw.starts_with('0'));
    let version: u32 = match (plain_digits, version_raw.parse::<u32>()) {
        (true, Ok(version)) => version,
        _ => return Err(DeepLinkError::UnsupportedVersion(version_raw)),
    };
    if !(DEEP_LINK_MIN_SUPPORTED_VERSION..=DEEP_LINK_CURRENT_VERSION).contains(&version) {
        return Err(DeepLinkError::UnsupportedVersion(version_raw));
    }
    let source_url = percent_decode(&src_raw).map_err(DeepLinkError::MalformedEncoding)?;
    // Surrounding whitespace in the decoded source is normalized away, like
    // the TS mirror's `.trim()`.
    let source_url = source_url.trim().to_string();
    validate_source(&source_url)?;
    // Secret query or fragment keys inside the decoded source are also
    // forbidden (cookie-param style smuggling).
    if let Some(key) = smuggled_secret_key(&source_url) {
        return Err(DeepLinkError::SecretForbidden(key));
    }
    let hint = match hint_raw {
        Some(raw) => {
            let decoded = percent_decode(&raw).map_err(DeepLinkError::MalformedEncoding)?;
            if decoded.len() > 256 {
                return Err(DeepLinkError::InvalidSource(
                    "hint beyond 256 bytes".to_string(),
                ));
            }
            if decoded.contains('\0') {
                return Err(DeepLinkError::InvalidSource(
                    "hint contains NUL".to_string(),
                ));
            }
            if decoded.is_empty() {
                None
            } else {
                Some(decoded)
            }
        }
        None => None,
    };
    Ok(DeepLink {
        version,
        source_url,
        hint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(v: &str, src: &str) -> String {
        format!("dezoomify://open?v={v}&src={src}")
    }

    #[test]
    fn current_and_n_minus_1_accepted() {
        let cur = parse_deep_link(&link("2", "https%3A%2F%2Fexample.com%2Fitem")).unwrap();
        assert_eq!(cur.version, 2);
        let prev = parse_deep_link(&link("1", "https%3A%2F%2Fexample.com%2Fitem")).unwrap();
        assert_eq!(prev.version, 1);
    }

    #[test]
    fn n_minus_2_and_future_rejected() {
        for version in ["0", "3", "99"] {
            assert!(
                matches!(
                    parse_deep_link(&link(version, "https%3A%2F%2Fexample.com%2Fitem")),
                    Err(DeepLinkError::UnsupportedVersion(_))
                ),
                "version {version} must be rejected"
            );
        }
        // Dotted and non-integer versions are also rejected.
        for version in ["1.0", "abc", "-1"] {
            assert!(
                matches!(
                    parse_deep_link(&link(version, "https%3A%2F%2Fexample.com%2Fitem")),
                    Err(DeepLinkError::UnsupportedVersion(_))
                ),
                "version {version:?} must be rejected"
            );
        }
    }

    #[test]
    fn duplicate_fields_rejected() {
        for url in [
            "dezoomify://open?v=2&v=2&src=https%3A%2F%2Fexample.com%2Fx".to_string(),
            format!(
                "dezoomify://open?v=2&src={}&src={}",
                "https%3A%2F%2Fexample.com%2Fx", "https%3A%2F%2Fexample.com%2Fy"
            ),
        ] {
            assert!(
                matches!(parse_deep_link(&url), Err(DeepLinkError::DuplicateField(_))),
                "{url} must be rejected as duplicate"
            );
        }
    }

    #[test]
    fn unknown_and_missing_fields_rejected() {
        let unknown = "dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx&extra=1";
        assert!(matches!(
            parse_deep_link(unknown),
            Err(DeepLinkError::UnknownField(_))
        ));
        let missing_src = "dezoomify://open?v=2";
        assert!(matches!(
            parse_deep_link(missing_src),
            Err(DeepLinkError::MissingField("src"))
        ));
        let empty_query = "dezoomify://open";
        assert!(matches!(
            parse_deep_link(empty_query),
            Err(DeepLinkError::MissingField("v"))
        ));
    }

    #[test]
    fn smuggled_source_query_secrets_rejected() {
        for smuggled in ["cookie=abc", "token=abc", "session=abc", "apikey=abc"] {
            let url = link("2", &format!("https%3A%2F%2Fexample.com%2Fx%3F{smuggled}"));
            assert!(
                matches!(
                    parse_deep_link(&url),
                    Err(DeepLinkError::SecretForbidden(_))
                ),
                "smuggled {smuggled} must be rejected"
            );
        }
    }

    #[test]
    fn truncated_percent_escapes_rejected() {
        for bad in [
            link("2", "https%3A%2F%2Fexample.com%2F%2"),
            link("2", "https%3A%2F%2Fexample.com%2F%"),
            link("2", "https%3A%2F%2Fexample.com%2F%ZZ"),
        ] {
            assert!(
                matches!(
                    parse_deep_link(&bad),
                    Err(DeepLinkError::MalformedEncoding(_))
                ),
                "{bad} must be rejected as malformed"
            );
        }
    }

    #[test]
    fn source_url_rules_are_enforced() {
        // Fragments never carry job input.
        let fragment = link("2", "https%3A%2F%2Fexample.com%2Fitem%23frag");
        assert_eq!(
            parse_deep_link(&fragment).unwrap().source_url,
            "https://example.com/item#frag"
        );
        // '+' decodes to a space, like form encoding.
        let plus = link("2", "https%3A%2F%2Fexample.com%2Fa+b");
        assert_eq!(
            parse_deep_link(&plus).unwrap().source_url,
            "https://example.com/a b"
        );
        // Non-http(s) source schemes are rejected.
        let ftp = link("2", "ftp%3A%2F%2Fexample.com%2Fx");
        assert!(matches!(
            parse_deep_link(&ftp),
            Err(DeepLinkError::InvalidSource(_))
        ));
        // src beyond the per-field bound is rejected after decoding.
        let big = link(
            "2",
            &format!("https%3A%2F%2Fexample.com%2F{}", "a".repeat(1100)),
        );
        assert!(matches!(
            parse_deep_link(&big),
            Err(DeepLinkError::InvalidSource(_))
        ));
    }

    #[test]
    fn hint_rules_are_enforced() {
        let base = "https%3A%2F%2Fexample.com%2Fitem";
        let with_hint = format!("dezoomify://open?v=2&src={base}&hint=Zoomify");
        let parsed = parse_deep_link(&with_hint).unwrap();
        assert_eq!(parsed.hint.as_deref(), Some("Zoomify"));
        let empty_hint = format!("dezoomify://open?v=2&src={base}&hint=");
        assert_eq!(parse_deep_link(&empty_hint).unwrap().hint, None);
        let nul_hint = format!("dezoomify://open?v=2&src={base}&hint=a%00b");
        assert!(matches!(
            parse_deep_link(&nul_hint),
            Err(DeepLinkError::InvalidSource(_))
        ));
        let long_hint = format!("dezoomify://open?v=2&src={base}&hint={}", "h".repeat(300));
        assert!(matches!(
            parse_deep_link(&long_hint),
            Err(DeepLinkError::InvalidSource(_))
        ));
    }

    #[test]
    fn oversize_userinfo_cookie_malformed_rejected() {
        let big = format!(
            "dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2F{}",
            "a".repeat(3000)
        );
        assert_eq!(parse_deep_link(&big).unwrap_err(), DeepLinkError::Oversize);
        let userinfo = link("2", "https%3A%2F%2Fuser%3Apass%40example.com%2Fx");
        assert_eq!(
            parse_deep_link(&userinfo).unwrap_err(),
            DeepLinkError::UserinfoForbidden
        );
        let cookie =
            "dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx&cookie=abc".to_string();
        assert!(matches!(
            parse_deep_link(&cookie),
            Err(DeepLinkError::SecretForbidden(_))
        ));
        let bad = link("2", "https%3A%2F%2Fexample.com%2F%ZZ");
        assert!(matches!(
            parse_deep_link(&bad),
            Err(DeepLinkError::MalformedEncoding(_))
        ));
    }

    #[test]
    fn argv_scan_finds_first_deep_link() {
        let argv = vec![
            "dezoomify-desktop".to_string(),
            "--help".to_string(),
            "dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx".to_string(),
        ];
        assert_eq!(
            find_deep_link_in_argv(&argv).as_deref(),
            Some("dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx")
        );
        let none: Vec<String> = vec!["dezoomify-desktop".to_string()];
        assert_eq!(find_deep_link_in_argv(&none), None);
        let empty: Vec<String> = Vec::new();
        assert_eq!(find_deep_link_in_argv(&empty), None);
        // Non-deep-link schemes are ignored.
        let other = vec!["app".to_string(), "https://example.com/x".to_string()];
        assert_eq!(find_deep_link_in_argv(&other), None);
    }

    /// Deliberate membership lock for the canonical credential vocabulary
    /// `dezoomify::model::SENSITIVE_QUERY_KEYS`, mirrored by
    /// `DEEP_LINK_SECRET_QUERY_KEYS` in `packages/shared-ui/src/source-url.ts`
    /// and pinned there by `apps/desktop/tests/policy-vectors.test.mjs`. Any
    /// change updates both languages and this lock in the same change.
    #[test]
    fn sensitive_query_key_membership_is_locked() {
        let expected: &[&str] = &[
            "access-token",
            "access_token",
            "api-key",
            "api_key",
            "apikey",
            "auth",
            "authorization",
            "bearer",
            "code",
            "cookie",
            "cookies",
            "credential",
            "key",
            "passwd",
            "password",
            "proxy-authorization",
            "secret",
            "session",
            "sessionid",
            "sessiontoken",
            "set-cookie",
            "sid",
            "sig",
            "signature",
            "state",
            "ticket",
            "token",
            "x-api-key",
        ];
        assert_eq!(dezoomify::model::SENSITIVE_QUERY_KEYS, expected);
        let mut sorted = expected.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, expected, "canonical list stays sorted and unique");
    }

    /// Stable rejection class names asserted by `testdata/deep-link-vectors.json`.
    fn error_class(err: &DeepLinkError) -> &'static str {
        match err {
            DeepLinkError::Oversize => "oversize",
            DeepLinkError::InvalidScheme => "invalid-scheme",
            DeepLinkError::MissingField(_) => "missing-field",
            DeepLinkError::DuplicateField(_) => "duplicate-field",
            DeepLinkError::UnknownField(_) => "unknown-field",
            DeepLinkError::UnsupportedVersion(_) => "unsupported-version",
            DeepLinkError::MalformedEncoding(_) => "malformed-encoding",
            DeepLinkError::UserinfoForbidden => "userinfo-forbidden",
            DeepLinkError::SecretForbidden(_) => "secret-forbidden",
            DeepLinkError::InvalidSource(_) => "invalid-source",
        }
    }

    /// Shared cross-language oracle: every case in
    /// `testdata/deep-link-vectors.json` is asserted here and by
    /// `apps/desktop/tests/policy-vectors.test.mjs` against the TS mirror
    /// `parseRawDeepLinkUrl`, so the two parsers can never accept or reject
    /// different inputs unnoticed.
    #[test]
    fn deep_link_vectors_match_the_shared_oracle() {
        let doc: serde_json::Value =
            serde_json::from_str(include_str!("../../../../testdata/deep-link-vectors.json"))
                .expect("testdata/deep-link-vectors.json parses");
        let cases = doc["cases"].as_array().expect("cases array");
        assert!(
            (15..=25).contains(&cases.len()),
            "the vector list stays bounded ({} cases)",
            cases.len()
        );
        for case in cases {
            let name = case["name"].as_str().expect("case name");
            let raw = case["raw"].as_str().expect("case raw");
            if let Some(reject) = case["reject"].as_str() {
                let err = parse_deep_link(raw).expect_err(&format!("{name} must reject"));
                assert_eq!(error_class(&err), reject, "{name}: wrong rejection class");
            } else {
                let accept = &case["accept"];
                let parsed = parse_deep_link(raw).unwrap_or_else(|_| panic!("{name} must accept"));
                assert_eq!(
                    parsed.source_url,
                    accept["sourceUrl"].as_str().expect("sourceUrl"),
                    "{name}: source_url"
                );
                assert_eq!(
                    parsed.version,
                    u32::try_from(accept["version"].as_u64().expect("version")).expect("u32"),
                    "{name}: version"
                );
                let hint = if accept["hint"].is_null() {
                    None
                } else {
                    Some(accept["hint"].as_str().expect("hint").to_string())
                };
                assert_eq!(parsed.hint, hint, "{name}: hint");
            }
        }
    }
}
