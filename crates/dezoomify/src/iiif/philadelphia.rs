use crate::core::DiscoveryRoute;
use regex::bytes::Regex as BytesRegex;
use std::sync::LazyLock;
static MICRIO: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?is)(?:philamuseum|philadelphia museum).*?\\?"shortId\\?"\s*:\s*\\?"(?P<id>[A-Za-z0-9_-]{3,32})\\?""#).expect("constant Philadelphia Museum Micrio pattern")
});
pub(super) const ROUTE: DiscoveryRoute =
    DiscoveryRoute::capture_url(&MICRIO, "id", "https://i.micr.io/", "/info.json");
