use crate::core::{
    DiscoveryRoute,
    discovery::{css, viewer},
};

pub(super) const ROUTE: DiscoveryRoute = viewer(css("micr-io[id]:not([id=\"\"])")).attribute_url(
    "id",
    "https://i.micr.io/",
    "/info.json",
);
