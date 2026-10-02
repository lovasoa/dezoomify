//! Request construction with safe defaults. `Cookie`/`Authorization` are forbidden
//! through public untrusted fields; redirects rebuild headers per URL.

use std::collections::BTreeMap;

use dezoomify::model::Error;

#[derive(Clone, Debug)]
pub struct EffectiveRequest {
    pub uri: String,
    pub headers: BTreeMap<String, String>,
}

pub fn build_request(
    uri: &str,
    extra: &BTreeMap<String, String>,
) -> Result<EffectiveRequest, Error> {
    for key in extra.keys() {
        if key.eq_ignore_ascii_case("cookie") || key.eq_ignore_ascii_case("authorization") {
            return Err(Error::AuthForbiddenHeader);
        }
    }
    let mut headers = BTreeMap::new();
    headers.insert("user-agent".to_string(), "dezoomify/1.0".to_string());
    // Header names are case-insensitive: normalize so the same name can
    // never appear twice with different cases on the wire.
    for (name, value) in extra {
        headers.insert(name.to_ascii_lowercase(), value.clone());
    }
    Ok(EffectiveRequest {
        uri: uri.to_string(),
        headers,
    })
}

/// Remove credentials before scoped user headers are applied to a redirect.
pub fn rebuild_for_redirect(previous: &EffectiveRequest, next_uri: &str) -> EffectiveRequest {
    let mut headers = previous.headers.clone();
    headers.remove("cookie");
    headers.remove("authorization");
    EffectiveRequest {
        uri: next_uri.to_string(),
        headers,
    }
}
