//! Effective request construction: core tile requests + safe defaults +
//! optional scoped authorization. `Cookie`/`Authorization` are forbidden
//! through public untrusted fields; redirects rebuild headers per URL.

use std::collections::BTreeMap;

use crate::auth::EphemeralAuthorization;

#[derive(Clone, Debug)]
pub struct EffectiveRequest {
    pub uri: String,
    pub headers: BTreeMap<String, String>,
}

pub fn build_request(
    uri: &str,
    extra: &BTreeMap<String, String>,
    auth: Option<&EphemeralAuthorization>,
) -> Result<EffectiveRequest, String> {
    for key in extra.keys() {
        if key.eq_ignore_ascii_case("cookie") || key.eq_ignore_ascii_case("authorization") {
            return Err("cookie/authorization forbidden in public headers".to_string());
        }
    }
    let mut headers = BTreeMap::new();
    headers.insert("user-agent".to_string(), "dezoomify-ng/1.0".to_string());
    headers.extend(extra.clone());
    if let Some(auth) = auth {
        let (scheme, host, port, path) = split_url(uri)?;
        if let Some(cookie) = auth.header_for(&scheme, &host, port, &path) {
            headers.insert("cookie".to_string(), cookie);
        }
    }
    Ok(EffectiveRequest {
        uri: uri.to_string(),
        headers,
    })
}

/// Rebuild headers for a redirect target: authorization only survives when
/// the new URL remains inside the original scope.
pub fn rebuild_for_redirect(
    previous: &EffectiveRequest,
    next_uri: &str,
    auth: Option<&EphemeralAuthorization>,
) -> Result<EffectiveRequest, String> {
    let mut headers = previous.headers.clone();
    headers.remove("cookie");
    if let Some(auth) = auth {
        let (scheme, host, port, path) = split_url(next_uri)?;
        if let Some(cookie) = auth.header_for(&scheme, &host, port, &path) {
            headers.insert("cookie".to_string(), cookie);
        }
    }
    Ok(EffectiveRequest {
        uri: next_uri.to_string(),
        headers,
    })
}

fn split_url(uri: &str) -> Result<(String, String, Option<u16>, String), String> {
    let (scheme, rest) = uri.split_once("://").ok_or("bad url")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    if authority.contains('@') {
        return Err("userinfo rejected".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if p.bytes().all(|b| b.is_ascii_digit()) => {
            (h.to_string(), p.parse::<u16>().ok())
        }
        _ => (authority.to_string(), None),
    };
    Ok((scheme.to_string(), host, port, path))
}
