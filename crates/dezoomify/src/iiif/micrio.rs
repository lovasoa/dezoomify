use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;

use crate::core::DiscoveryRoute;

pub(super) const ROUTE: DiscoveryRoute =
    DiscoveryRoute::capture_url(&ELEMENT, "id", "https://i.micr.io/", "/info.json");

static ELEMENT: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?is)<micr-io\b[^>]*\bid\s*=\s*["'](?P<id>[A-Za-z0-9]{5})["']"#)
        .expect("constant Micrio custom element pattern")
});
