use crate::core::DiscoveryRoute;
use crate::core::discovery::{css, viewer};
use regex::bytes::Regex as BytesRegex;
use std::sync::LazyLock;
static IMAGE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)(?P<image>(?:https?://|/|\./|\.\./)[^"'\s<>]+\?IIIF=[^"'\s<>]+?/full/[^"'\s<>]+)"#,
    )
    .expect("constant National Gallery IIIF image pattern")
});
pub(super) const ROUTES: &[DiscoveryRoute] = &[
    viewer(css("[src*=\"?IIIF=\" i][src*=\"/full/\" i]")).follow_attribute("src"),
    DiscoveryRoute::regex_link(&IMAGE, "$image"),
];
