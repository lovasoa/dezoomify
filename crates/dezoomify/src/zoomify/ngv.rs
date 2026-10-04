use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;

use crate::core::{
    DiscoveryError, DiscoveryResource, DiscoveryRoute, ParsedResource, Request, resolve_relative,
};

use super::{append_path_component, capture_text};

static IMAGE_PATH: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?is)\bvar\s+url\s*=\s*['"](?P<image>[^'"]+)['"]"#)
        .expect("constant NGV Zoomify path pattern")
});

use crate::core::discovery::{url_matches, viewer};
pub(super) const ROUTE: DiscoveryRoute =
    viewer(url_matches(is_work_page)).decode(follow_image_path);

pub(super) fn is_work_page(uri: &str) -> bool {
    uri.contains("ngv.vic.gov.au/explore/collection/work")
}

pub(super) fn follow_image_path(
    resource: DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let path = IMAGE_PATH
        .captures(resource.bytes())
        .and_then(|captures| capture_text(&captures, "image"))
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("NGV page does not declare a Zoomify path".into())
        })?;
    let image_uri = resolve_relative(resource.final_uri(), &path);
    Ok(ParsedResource::Follow(Request::new(append_path_component(
        &image_uri,
        "ImageProperties.xml",
    ))))
}
