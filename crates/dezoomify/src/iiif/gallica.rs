//! Gallica ARK viewers map directly to public IIIF metadata: viewer suffixes
//! do not belong to the service identifier, and an omitted page selects f1.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::core::discovery::{url_matches, viewer};
use crate::core::{DiscoveryError, DiscoveryRoute, Request};

pub(super) const ROUTE: DiscoveryRoute = viewer(url_matches(|uri| info(uri).is_some()))
    .resolve_metadata(|uri| {
        info(uri).ok_or_else(|| DiscoveryError::InvalidMetadata("invalid Gallica ARK URL".into()))
    });

static ARK_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/ark:/(\w+/\w+)(?:/(f\w+))?").expect("constant Gallica ARK pattern")
});

fn info(uri: &str) -> Option<Request> {
    let url = Url::parse(uri).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str() != Some("gallica.bnf.fr") {
        return None;
    }
    let captures = ARK_PATH.captures(url.path())?;
    Some(Request::new(format!(
        "https://gallica.bnf.fr/iiif/ark:/{}/{}/info.json",
        &captures[1],
        captures.get(2).map_or("f1", |page| page.as_str()),
    )))
}
