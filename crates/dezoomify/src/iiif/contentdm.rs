use url::Url;

use crate::core::{DiscoveryError, DiscoveryResource, DiscoveryRoute, ParsedResource, Request};

use crate::core::discovery::{metadata as metadata_route, url_matches, viewer};
pub(super) const RECORD_ROUTE: DiscoveryRoute =
    viewer(url_matches(is_record)).resolve_metadata(metadata);
pub(super) const METADATA_ROUTE: DiscoveryRoute =
    metadata_route(url_matches(is_metadata)).decode(follow_info);

pub(super) fn is_record(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    matches!(url.path_segments().map(Iterator::collect::<Vec<_>>).as_deref(), Some(["digital", "collection", _, "id", id, ..]) if id.parse::<u64>().is_ok())
}

pub(super) fn metadata(uri: &str) -> Result<Request, DiscoveryError> {
    let url = Url::parse(uri)
        .map_err(|_| DiscoveryError::InvalidMetadata("invalid CONTENTdm URL".into()))?;
    let segments = url
        .path_segments()
        .map(Iterator::collect::<Vec<_>>)
        .ok_or_else(|| DiscoveryError::InvalidMetadata("invalid CONTENTdm path".into()))?;
    let ["digital", "collection", collection, "id", identifier, ..] = segments.as_slice() else {
        return Err(DiscoveryError::InvalidMetadata(
            "invalid CONTENTdm record URL".into(),
        ));
    };
    Ok(Request::new(format!(
        "{}/digital/api/singleitem/collection/{collection}/id/{identifier}",
        url.origin().ascii_serialization()
    )))
}

pub(super) fn is_metadata(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| {
        matches!(
            url.path_segments()
                .map(Iterator::collect::<Vec<_>>)
                .as_deref(),
            Some(["digital", "api", "singleitem", "collection", _, "id", _])
        )
    })
}

pub(super) fn follow_info(
    resource: DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let info_uri = serde_json::from_slice::<serde_json::Value>(resource.bytes())
        .ok()
        .and_then(|value| value.get("iiifInfoUri")?.as_str().map(str::to_owned))
        .filter(|uri| !uri.is_empty())
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("CONTENTdm metadata has no IIIF URL".into())
        })?;
    let base = Url::parse(resource.final_uri())
        .map_err(|_| DiscoveryError::InvalidMetadata("invalid CONTENTdm metadata URL".into()))?;
    let origin = base.origin().ascii_serialization();
    let uri = if Url::parse(&info_uri).is_ok() {
        info_uri
    } else if info_uri.starts_with("/digital/") {
        format!("{origin}{info_uri}")
    } else if info_uri.starts_with('/') {
        format!("{origin}/digital{info_uri}")
    } else {
        format!("{origin}/digital/{info_uri}")
    };
    Ok(ParsedResource::Follow(Request::new(uri)))
}
