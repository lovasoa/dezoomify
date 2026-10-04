use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;

use crate::core::DiscoveryRoute;

static IMAGE_PATH: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?is)\bvar\s+url\s*=\s*['"](?P<image>[^'"]+)['"]"#)
        .expect("constant NGV Zoomify path pattern")
});

use crate::core::discovery::{url_matches, viewer};
pub(super) const ROUTE: DiscoveryRoute =
    viewer(url_matches(is_work_page)).regex_file(&IMAGE_PATH, "ImageProperties.xml");

pub(super) fn is_work_page(uri: &str) -> bool {
    uri.contains("ngv.vic.gov.au/explore/collection/work")
}
