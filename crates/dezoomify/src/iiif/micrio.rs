use crate::core::{
    DiscoveryRoute,
    discovery::{css_when, viewer},
};

pub(super) const ROUTE: DiscoveryRoute = viewer(css_when("micr-io[id]", |tag| {
    tag.attribute("id")
        .is_some_and(|id| id.len() == 5 && id.bytes().all(|b| b.is_ascii_alphanumeric()))
}))
.attribute_url("id", "https://i.micr.io/", "/info.json");
