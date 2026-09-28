use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;

use crate::core::discovery::{url_matches, viewer};
use crate::core::{DiscoveryError, DiscoveryRoute, Request};

static DEEPZOOM_MANIFEST: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)\bdeepZoomManifest\b["']?\s*[:=]\s*["'](?P<metadata>[^"']+\.(?:dzi|xml))["']"#,
    )
    .expect("constant Paris Deep Zoom manifest pattern")
});

pub(super) const ARK_ROUTE: DiscoveryRoute = viewer(url_matches(is_ark)).resolve_metadata(reader);
pub(super) const MANIFEST_ROUTE: DiscoveryRoute =
    DiscoveryRoute::relative_capture(&DEEPZOOM_MANIFEST, "metadata");

pub(super) fn is_ark(uri: &str) -> bool {
    uri.starts_with("https://bibliotheques-specialisees.paris.fr/ark:/")
}

pub(super) fn reader(uri: &str) -> Result<Request, DiscoveryError> {
    let ark = uri
        .strip_prefix("https://bibliotheques-specialisees.paris.fr/ark:")
        .filter(|ark| ark.split('/').filter(|part| !part.is_empty()).count() >= 3)
        .ok_or_else(|| DiscoveryError::InvalidMetadata("invalid Paris ARK URL".into()))?;
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
