// Deep-link parsing for `dezoomify://open` (lean shell, std only).
//
// Every website/deep-link handoff is bounded, versioned, non-secret,
// untrusted input. Accepted links still require explicit user confirmation
// before any network or file effect; rejected or unconfirmed links produce
// no effect.

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
            DeepLinkError::InvalidScheme => write!(f, "deep-link.rejected: scheme must be dezoomify://open"),
            DeepLinkError::MissingField(k) => write!(f, "deep-link.rejected: missing field {k}"),
            DeepLinkError::DuplicateField(k) => write!(f, "deep-link.rejected: duplicate field {k}"),
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
            DeepLinkError::InvalidSource(m) => write!(f, "deep-link.rejected: invalid source ({m})"),
        }
    }
}

impl std::error::Error for DeepLinkError {}

fn is_secret_key(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "cookie"
            | "cookies"
            | "authorization"
            | "proxy-authorization"
            | "bearer"
            | "token"
            | "signature"
            | "sig"
            | "auth"
            | "secret"
            | "password"
            | "session"
            | "sid"
            | "apikey"
            | "api_key"
            | "key"
    )
}

fn source_contains_secret(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for needle in [
        "cookie",
        "authorization",
        "bearer",
        "token=",
        "signature",
        "secret",
        "password",
        "session=",
        "apikey",
        "api_key",
        "file://",
        "/etc/",
        "c:\\",
    ] {
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
                _ => return Err(format!("bad escape %{}{}", bytes[i + 1] as char, bytes[i + 2] as char)),
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
            .find(|c| c == '/' || c == '?' || c == '#')
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
        return Err(DeepLinkError::InvalidSource("src must be 1..1024 bytes".to_string()));
    }
    if !(src.starts_with("http://") || src.starts_with("https://")) {
        return Err(DeepLinkError::InvalidSource("scheme must be http or https".to_string()));
    }
    // userinfo credentials must never travel in a deep link.
    if has_userinfo(src) {
        return Err(DeepLinkError::UserinfoForbidden);
    }
    if let Some(needle) = source_contains_secret(src) {
        return Err(DeepLinkError::SecretForbidden(needle));
    }
    Ok(())
}

/// Parse and validate one `dezoomify://open` URL. No effect is performed.
pub fn parse_deep_link(url: &str) -> Result<DeepLink, DeepLinkError> {
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
    let query = url.splitn(2, '?').nth(1).unwrap_or("");
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
            None => return Err(DeepLinkError::MalformedEncoding(format!("pair without =: {pair}"))),
        };
        // Field names are literal; encoded names are rejected as malformed.
        if name.contains('%') {
            return Err(DeepLinkError::MalformedEncoding("encoded field name".to_string()));
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
    // Version must be a plain integer; dotted or signed forms are rejected.
    // Supported: 2 (current) and 1 (N-1). Rejected: 0 (N-2) and 3+ (future).
    let version: u32 = version_raw
        .parse()
        .map_err(|_| DeepLinkError::UnsupportedVersion(version_raw.clone()))?;
    if version < DEEP_LINK_MIN_SUPPORTED_VERSION || version > DEEP_LINK_CURRENT_VERSION {
        return Err(DeepLinkError::UnsupportedVersion(version_raw));
    }
    let source_url = percent_decode(&src_raw).map_err(DeepLinkError::MalformedEncoding)?;
    validate_source(&source_url)?;
    // Secret query keys inside the decoded source are also forbidden
    // (cookie-param style smuggling).
    if let Some(q) = source_url.split('?').nth(1) {
        for pair in q.split('&') {
            if let Some((k, _)) = pair.split_once('=') {
                if is_secret_key(k) {
                    return Err(DeepLinkError::SecretForbidden(k.to_string()));
                }
            }
        }
    }
    let hint = match hint_raw {
        Some(raw) => {
            let decoded = percent_decode(&raw).map_err(DeepLinkError::MalformedEncoding)?;
            if decoded.len() > 256 {
                return Err(DeepLinkError::InvalidSource("hint beyond 256 bytes".to_string()));
            }
            if decoded.contains('\0') {
                return Err(DeepLinkError::InvalidSource("hint contains NUL".to_string()));
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

/// Every accepted link requires independent user confirmation.
pub fn requires_confirmation(_link: &DeepLink) -> bool {
    true
}

/// Gate any network or file effect on explicit confirmation.
///
/// Returns the link only when `confirmed` is true; otherwise reports a
/// pending-confirmation state and the caller must perform no effect.
pub fn apply_after_confirmation(link: DeepLink, confirmed: bool) -> Result<DeepLink, DeepLinkError> {
    if !confirmed {
        return Err(DeepLinkError::MissingField("confirm"));
    }
    debug_assert!(requires_confirmation(&link));
    Ok(link)
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
        assert!(requires_confirmation(&cur));
    }

    #[test]
    fn n_minus_2_and_future_rejected() {
        assert!(matches!(
            parse_deep_link(&link("0", "https%3A%2F%2Fexample.com%2Fitem")),
            Err(DeepLinkError::UnsupportedVersion(_))
        ));
        assert!(matches!(
            parse_deep_link(&link("3", "https%3A%2F%2Fexample.com%2Fitem")),
            Err(DeepLinkError::UnsupportedVersion(_))
        ));
    }

    #[test]
    fn oversize_userinfo_cookie_malformed_rejected() {
        let big = format!("dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2F{}", "a".repeat(3000));
        assert_eq!(parse_deep_link(&big).unwrap_err(), DeepLinkError::Oversize);
        let userinfo = link("2", "https%3A%2F%2Fuser%3Apass%40example.com%2Fx");
        assert_eq!(parse_deep_link(&userinfo).unwrap_err(), DeepLinkError::UserinfoForbidden);
        let cookie = "dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx&cookie=abc".to_string();
        assert!(matches!(parse_deep_link(&cookie), Err(DeepLinkError::SecretForbidden(_))));
        let bad = link("2", "https%3A%2F%2Fexample.com%2F%ZZ");
        assert!(matches!(parse_deep_link(&bad), Err(DeepLinkError::MalformedEncoding(_))));
    }

    #[test]
    fn no_effect_without_confirm() {
        let link = parse_deep_link(&link("2", "https%3A%2F%2Fexample.com%2Fitem")).unwrap();
        assert!(apply_after_confirmation(link.clone(), false).is_err());
        assert!(apply_after_confirmation(link, true).is_ok());
    }
}
