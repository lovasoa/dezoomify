use url::Url;

use crate::core::discovery::{Specificity::High, url_matches, viewer};
use crate::core::{DiscoveryError, DiscoveryRoute, Request};

pub(super) const ROUTE: DiscoveryRoute =
    viewer(url_matches(is_entry).specificity(High)).resolve_metadata(manifest);

pub(super) fn is_entry(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    matches!(url.host_str(), Some("viewer.onb.ac.at")) && {
        let identifier = url.path().trim_matches('/');
        identifier.starts_with(|c: char| c.is_ascii_digit())
            && identifier.chars().all(|c| c.is_ascii_alphanumeric())
    } || matches!(url.host_str(), Some("digital.onb.ac.at"))
        && url.path() == "/RepViewer/viewer.faces"
        && url
            .query_pairs()
            .any(|(name, value)| name == "doc" && !value.is_empty())
}

pub(super) fn manifest(uri: &str) -> Result<Request, DiscoveryError> {
    let url =
        Url::parse(uri).map_err(|_| DiscoveryError::InvalidMetadata("invalid ONB URL".into()))?;
    let identifier = match url.host_str() {
        Some("viewer.onb.ac.at") => url
            .path_segments()
            .and_then(|mut segments| segments.next())
            .map(str::to_owned),
        Some("digital.onb.ac.at") => url
            .query_pairs()
            .find_map(|(name, value)| (name == "doc").then(|| value.into_owned())),
        _ => None,
    }
    .filter(|identifier| !identifier.is_empty())
    .ok_or_else(|| DiscoveryError::InvalidMetadata("missing ONB document identifier".into()))?;
    Ok(Request::new(format!(
        "https://api.onb.ac.at/iiif/presentation/v3/manifest/{identifier}"
    )))
}

#[test]
fn document_viewers_follow_their_manifest_without_fetching_the_page() {
    let metadata = include_bytes!("../../../../fixtures/iiif/v2/info.json").as_slice();
    for uri in [
        "https://viewer.onb.ac.at/10048A37/?token=exact%2Bvalue#page=1",
        "https://digital.onb.ac.at/RepViewer/viewer.faces?doc=10048A37",
    ] {
        let (catalog, requests) = crate::test_support::discover_resources(
            crate::core::registry_for("iiif").unwrap(),
            uri,
            &[(
                "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
                metadata,
            )],
        );
        assert_eq!(catalog.unwrap().len(), 1);
        assert_eq!(requests.len(), 1);
    }
}
