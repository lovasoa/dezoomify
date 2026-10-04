use crate::core::DiscoveryRoute;
use regex::bytes::Regex as BytesRegex;
use std::sync::LazyLock;
static MICRIO: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?is)(?:philamuseum|philadelphia museum).*?\\?"shortId\\?"\s*:\s*\\?"(?P<id>[A-Za-z0-9_-]{3,32})\\?""#).expect("constant Philadelphia Museum Micrio pattern")
});
pub(super) const ROUTE: DiscoveryRoute =
    DiscoveryRoute::regex_link(&MICRIO, "https://i.micr.io/$id/info.json");
