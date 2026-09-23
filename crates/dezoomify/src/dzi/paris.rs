use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;

use crate::core::{DiscoveryError, DiscoveryMatch, DiscoveryRoute, Request};

static DEEPZOOM_MANIFEST: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)\bdeepZoomManifest\b["']?\s*[:=]\s*["'](?P<metadata>[^"']+\.(?:dzi|xml))["']"#,
    )
    .expect("constant Paris Deep Zoom manifest pattern")
});

pub(super) const ARK_ROUTE: DiscoveryRoute = DiscoveryMatch::UrlPredicate(is_ark).map_url(reader);
pub(super) const MANIFEST_ROUTE: DiscoveryRoute =
    DiscoveryRoute::relative_capture(&DEEPZOOM_MANIFEST, "metadata");

pub(super) fn prefers(uri: &str) -> bool {
    is_ark(uri)
}

pub(super) fn is_ark(uri: &str) -> bool {
    uri.starts_with("https://bibliotheques-specialisees.paris.fr/ark:/")
}

pub(super) fn reader(uri: &str) -> Result<Request, DiscoveryError> {
    let ark = uri
        .strip_prefix("https://bibliotheques-specialisees.paris.fr/ark:")
        .filter(|ark| ark.split('/').filter(|part| !part.is_empty()).count() >= 3)
        .ok_or_else(|| DiscoveryError::Session("invalid Paris ARK URL".into()))?;
    let mut parts = ark.split('/').filter(|part| !part.is_empty());
    let prefix = format!(
        "/{}/{}/{}",
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default()
    );
    Ok(Request::new(format!(
        "https://bibliotheques-specialisees.paris.fr/in/imageReader.xhtml?id=ark:{prefix}&updateUrl=updateUrl1653&ark={ark}&selectedTab=otherdocs"
    )))
}
