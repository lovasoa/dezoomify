//! Native Messaging wire envelopes (lean, `serde_json`).
//!
//! JSON shapes for the `dezoomify-native-host` stdio channel. Every message
//! is length-prefixed by [`crate::native_host::framing`]; this module owns
//! the JSON projection and bounds. Cookie values appear only in the single
//! inbound `credential` message; every outbound envelope carries names and
//! scopes only, never values. Diagnostics are redacted separately
//! (see `redaction.rs`).

use serde::{Deserialize, Serialize};

/// Longest accepted source URL (matches deep-link and protocol bounds).
pub const MAX_SOURCE_URL_LEN: usize = 2048;
/// Most cookies accepted in one credential message.
pub const MAX_COOKIES: usize = 64;
/// Longest cookie name / value.
pub const MAX_COOKIE_NAME_LEN: usize = 256;
pub const MAX_COOKIE_VALUE_LEN: usize = 4096;
/// Longest challenge / nonce / job correlation id.
pub const MAX_TOKEN_LEN: usize = 128;

/// One scoped cookie in a credential message. `origin` is the exact scope
/// the value may be used for; siblings never receive it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CookieEntry {
    pub name: String,
    pub value: String,
    pub origin: String,
}

/// Extension -> host requests. `extension_id` is informational only:
/// browser enforcement of the manifest allowlist authenticates the channel,
/// never a self-asserted payload field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HostRequest {
    Handshake {
        #[serde(default)]
        protocol: Option<String>,
        #[serde(rename = "clientVersion")]
        #[serde(default)]
        client_version: Option<u32>,
    },
    Negotiate {
        #[serde(rename = "clientVersion")]
        client_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "extensionId")]
        #[serde(default)]
        extension_id: Option<String>,
    },
    Consent {
        challenge: String,
        nonce: String,
        #[serde(rename = "jobId")]
        job_id: String,
        origins: Vec<String>,
        #[serde(rename = "cookieNames")]
        #[serde(default)]
        cookie_names: Vec<String>,
        confirmed: bool,
    },
    Credential {
        challenge: String,
        nonce: String,
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "sourceUrl")]
        source_url: String,
        origins: Vec<String>,
        #[serde(default)]
        cookies: Vec<CookieEntry>,
    },
    Decline {
        challenge: String,
    },
}

/// Parse one framed JSON body into a typed request.
///
/// Returns a stable error code + safe message (never secret values) when the
/// body is oversize, malformed, or names an unknown kind.
pub fn parse_request(body: &[u8]) -> Result<HostRequest, (String, String)> {
    if body.is_empty() {
        return Err(("handoff.rejected".to_string(), "empty message".to_string()));
    }
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| ("handoff.rejected".to_string(), "malformed JSON".to_string()))?;
    let kind = value.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    match kind {
        "handshake" | "negotiate" | "consent" | "credential" | "decline" => {
            serde_json::from_value(value).map_err(|_| {
                (
                    "handoff.rejected".to_string(),
                    "malformed envelope".to_string(),
                )
            })
        }
        "" => Err((
            "handoff.rejected".to_string(),
            "missing message kind".to_string(),
        )),
        _ => Err((
            "capability.unavailable".to_string(),
            "unknown message kind".to_string(),
        )),
    }
}

/// True for http(s) source URLs without userinfo or secret-bearing content.
/// Mirrors `HandoffDto::validate` and the desktop deep-link source rules so
/// handoff stays bounded, non-secret, and untrusted until confirmed.
#[must_use]
pub fn validate_source_url(url: &str) -> bool {
    if url.is_empty() || url.len() > MAX_SOURCE_URL_LEN {
        return false;
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    // Userinfo credentials are forbidden.
    if let Some(after_scheme) = url.split("://").nth(1) {
        let authority_end = after_scheme
            .find(['/', '?', '#'])
            .unwrap_or(after_scheme.len());
        if after_scheme[..authority_end].contains('@') {
            return false;
        }
    } else {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    for needle in [
        "cookie",
        "authorization",
        "bearer",
        "signature",
        "secret",
        "password",
        "session=",
        "token=",
        "apikey",
        "api_key",
        "file://",
        "/etc/",
        "c:\\",
    ] {
        if lower.contains(needle) {
            return false;
        }
    }
    // Secret query keys (cookie-param smuggling) are forbidden.
    if let Some(query) = url.split('?').nth(1) {
        let query = query.split('#').next().unwrap_or(query);
        for pair in query.split('&') {
            if let Some((key, _)) = pair.split_once('=') {
                match key.to_ascii_lowercase().as_str() {
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
                    | "key" => {
                        return false;
                    }
                    _ => {}
                }
            }
        }
    }
    true
}

/// Validate one cookie entry shape (not scope). Scope (origin allowlist +
/// name allowlist) is enforced by the host against the consented session.
#[must_use]
pub fn validate_cookie_shape(cookie: &CookieEntry) -> bool {
    if cookie.name.is_empty() || cookie.name.len() > MAX_COOKIE_NAME_LEN {
        return false;
    }
    if cookie.value.len() > MAX_COOKIE_VALUE_LEN {
        return false;
    }
    if cookie.origin.is_empty() || cookie.origin.len() > 1024 {
        return false;
    }
    for text in [&cookie.name, &cookie.value] {
        if text.contains(['\r', '\n', '\0']) {
            return false;
        }
    }
    crate::native_host::session::is_valid_origin(&cookie.origin)
}

/// Escape a short safe message for JSON embedding (codes/messages only,
///
/// never cookie values; values never reach this helper).
#[must_use]
pub fn escape_json(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_kinds_parse() {
        let req = parse_request(br#"{"kind":"handshake","protocol":"1.0"}"#).unwrap();
        assert!(matches!(req, HostRequest::Handshake { .. }));
        let req =
            parse_request(br#"{"kind":"negotiate","clientVersion":2,"jobId":"job:1"}"#).unwrap();
        assert!(matches!(req, HostRequest::Negotiate { .. }));
    }

    #[test]
    fn unknown_kind_fails_closed_without_secrets() {
        let (code, _) = parse_request(br#"{"kind":"exfiltrate","cookie":"CANARY"}"#).unwrap_err();
        assert_eq!(code, "capability.unavailable");
    }

    #[test]
    fn malformed_json_rejected() {
        let (code, _) = parse_request(b"not json").unwrap_err();
        assert_eq!(code, "handoff.rejected");
        let (code, _) = parse_request(b"").unwrap_err();
        assert_eq!(code, "handoff.rejected");
    }

    #[test]
    fn source_url_rules_match_handoff() {
        assert!(validate_source_url("https://example.com/item"));
        assert!(!validate_source_url("file:///etc/passwd"));
        assert!(!validate_source_url("https://user:pass@example.com/x"));
        assert!(!validate_source_url("https://example.com/x?token=secret"));
        assert!(!validate_source_url("https://example.com/x?cookie=abc"));
        assert!(!validate_source_url(&format!(
            "https://example.com/{}",
            "a".repeat(3000)
        )));
    }

    #[test]
    fn cookie_shape_rejects_crlf_and_bad_origin() {
        assert!(validate_cookie_shape(&CookieEntry {
            name: "session".into(),
            value: "abc".into(),
            origin: "https://a.example/".into(),
        }));
        assert!(!validate_cookie_shape(&CookieEntry {
            name: "session".into(),
            value: "a\r\nb".into(),
            origin: "https://a.example/".into(),
        }));
        assert!(!validate_cookie_shape(&CookieEntry {
            name: "session".into(),
            value: "abc".into(),
            origin: "file:///etc/passwd".into(),
        }));
    }
}
