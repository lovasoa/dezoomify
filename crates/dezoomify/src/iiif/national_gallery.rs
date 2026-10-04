use regex::bytes::Regex as BytesRegex;
use std::sync::LazyLock;
static IMAGE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)(?P<image>(?:https?://|/|\./|\.\./)[^"'\s<>]+\?IIIF=[^"'\s<>]+?/full/[^"'\s<>]+)"#,
    )
    .expect("constant National Gallery IIIF image pattern")
});
pub(super) const ROUTES: &[crate::core::DiscoveryRoute] = &[
    crate::core::discovery::viewer(crate::core::discovery::css(
        "[src*=\"?IIIF=\" i][src*=\"/full/\" i]",
    ))
    .follow_attribute("src"),
    crate::core::DiscoveryRoute::regex_link(&IMAGE, "$image"),
];
