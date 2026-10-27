//! UDDragonView serves IIP-shaped JSON under `meta/` and Deep Zoom tiles under
//! the sibling `tiles/` directory. Its IIP resolution count is not a DZI level.

use serde::Deserialize;
use url::Url;

use super::dzi_file::{DziFile, Size};
use crate::core::discovery::{Metadata, json_metadata, url_matches, viewer};
use crate::core::{DiscoveryError, DiscoveryResource, DiscoveryRoute, ParsedResource, Request};
use crate::json_utils::number_or_string;

pub(super) const VIEWER_ROUTE: DiscoveryRoute =
    viewer(url_matches(is_van_eyck_viewer)).resolve_metadata(viewer_metadata);
pub(super) const METADATA_ROUTE: DiscoveryRoute = json_metadata::<Image>();

fn is_van_eyck_viewer(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| {
        url.host_str() == Some("closertovaneyck.kikirpa.be")
            && url
                .fragment()
                .is_some_and(|hash| hash.starts_with("viewer/"))
    })
}

fn viewer_metadata(uri: &str) -> Result<Request, DiscoveryError> {
    let url = Url::parse(uri).map_err(invalid)?;
    let hash = url
        .fragment()
        .and_then(|hash| hash.strip_prefix("viewer/"))
        .ok_or_else(|| invalid("missing Van Eyck viewer selection"))?;
    let parameter = |name: &str| {
        url::form_urlencoded::parse(hash.as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let id = parameter("id1")
        .filter(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| invalid("missing or invalid Van Eyck image ID"))?;
    let repository = match parameter("rep1").as_deref() {
        Some("0") => "ec2/meta/",
        Some("1") => "legacy/meta/iip_",
        Some("2") => "verona/meta/",
        _ => return Err(invalid("unknown Van Eyck image repository")),
    };
    Ok(Request::new(format!(
        "https://data.closertovaneyck.be/{repository}{id}.json"
    )))
}

#[derive(Deserialize)]
struct Dimensions(
    #[serde(deserialize_with = "number_or_string")] u32,
    #[serde(deserialize_with = "number_or_string")] u32,
);

#[derive(Deserialize)]
struct Image {
    fid: String,
    #[serde(rename = "Max-size")]
    size: Dimensions,
    #[serde(rename = "Tile-size")]
    tile_size: Dimensions,
}

impl Metadata for Image {
    fn decode(self, resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        let filename = self
            .fid
            .strip_suffix(".dzi")
            .or_else(|| self.fid.strip_suffix(".jp2"))
            .unwrap_or(&self.fid);
        if filename.is_empty()
            || matches!(filename, "." | "..")
            || filename.contains(['/', '\\', '?', '#'])
        {
            return Err(invalid("invalid UDDragonView image filename"));
        }
        if self.tile_size.0 != self.tile_size.1 {
            return Err(invalid("UDDragonView requires square Deep Zoom tiles"));
        }
        DziFile {
            overlap: 0,
            tile_size: self.tile_size.0,
            format: "jpg".into(),
            size: Size {
                width: self.size.0,
                height: self.size.1,
            },
            base_url: Some(format!("../tiles/{filename}/")),
        }
        .decode(resource)
    }
}

fn invalid(detail: impl std::fmt::Display) -> DiscoveryError {
    DiscoveryError::InvalidMetadata(detail.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vec2d;
    use crate::core::default_registry;
    use crate::test_support::{discover_resources, grid, grid_tile, ready_image, resource_uri};

    #[test]
    fn van_eyck_page_and_metadata_resolve_the_same_exact_pyramid() {
        let page = "https://closertovaneyck.kikirpa.be/ghentaltarpiece/#viewer/rep1=0&id1=7e539d3f03181c46fb42f5249124ddd3";
        let metadata =
            "https://data.closertovaneyck.be/ec2/meta/7e539d3f03181c46fb42f5249124ddd3.json";
        let json = br#"{"fid":"00-10-VIS-HI-AT","Max-size":["104000","64000"],"Tile-size":[256,256],"Resolution-number":10}"#;
        for input in [page, metadata] {
            let (catalog, _) = discover_resources(default_registry(), input, &[(metadata, json)]);
            let image = ready_image(catalog.unwrap());
            assert_eq!(image.source_url.as_deref(), Some(metadata));
            assert_eq!(image.levels.len(), 18);
            let full = grid(image.levels.last().unwrap());
            assert_eq!(
                full.image_size(),
                Vec2d {
                    x: 104_000,
                    y: 64_000
                }
            );
            assert_eq!(full.count(), 101_750);
            let last = grid_tile(full, full.count() - 1);
            assert_eq!(last.expected_size, Some(Vec2d { x: 64, y: 256 }));
            assert_eq!(
                resource_uri(&last.source),
                "https://data.closertovaneyck.be/ec2/tiles/00-10-VIS-HI-AT/17/406_249.jpg"
            );
        }
    }

    #[test]
    fn van_eyck_selection_uses_the_declared_repository() {
        assert_eq!(
            viewer_metadata(
                "https://closertovaneyck.kikirpa.be/ghentaltarpiece/#viewer/id1=abcdef&rep1=1"
            )
            .unwrap()
            .uri,
            "https://data.closertovaneyck.be/legacy/meta/iip_abcdef.json"
        );
        assert_eq!(
            viewer_metadata("https://closertovaneyck.kikirpa.be/verona/#viewer/rep1=2&id1=abcdef")
                .unwrap()
                .uri,
            "https://data.closertovaneyck.be/verona/meta/abcdef.json"
        );
        for selection in ["rep1=3&id1=abcdef", "rep1=0", "rep1=0&id1=../other"] {
            assert!(
                viewer_metadata(&format!(
                    "https://closertovaneyck.kikirpa.be/ghentaltarpiece/#viewer/{selection}"
                ))
                .is_err()
            );
        }
    }
}
