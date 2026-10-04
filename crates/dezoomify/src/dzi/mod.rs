//! Pure discovery for Deep Zoom Image descriptors.

use std::sync::{Arc, LazyLock};

use dzi_file::DziFile;
use regex::{Regex, bytes::Regex as BytesRegex};

use crate::Vec2d;
use crate::core::discovery::{
    any, html_matches, image_url, metadata, url_matches, url_suffix, viewer,
};
use crate::core::{
    CatalogPlan, DiscoveryError, DiscoveryResource, DiscoveryRoute, FormatSpec, Grid, ImagePlan,
    ParsedResource, RejectionKind, Request, ResolvedLevel,
};
use crate::json_utils::all_json;

mod dzi_file;

static TILE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("_files/\\d+/\\d+_\\d+\\.(jpe?g|png)$").expect("constant DZI tile pattern")
});
static SEADRAGON_EMBED: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)\bseadragon\s*\.\s*embed\s*\([^,]*,[^,]*,\s*["'](?P<metadata>[^"']+)["']"#,
    )
    .expect("constant Seadragon embed pattern")
});
const ROUTES: &[DiscoveryRoute] = &[
    image_url(is_tile_url).resolve_metadata(tile_metadata),
    viewer(url_matches(is_bl_viewer_url)).resolve_metadata(bl_metadata),
    viewer(url_matches(is_nla_view_url)).resolve_metadata(nla_metadata),
    viewer(url_matches(is_polona_item_url)).decode(follow_polona_json),
    metadata(url_matches(is_polona_json_url)).decode(follow_polona_dzi),
    paris::ARK_ROUTE,
    paris::MANIFEST_ROUTE,
    viewer(html_matches(contains_seadragon_embed)).decode(follow_seadragon_embed),
    viewer(html_matches(has_wdl_template)).decode(follow_wdl_template),
    DiscoveryRoute::regex_link(&DZI_LINK_RE, "$url"),
    DiscoveryRoute::regex_link(&DZI_ATTR_RE, "$url"),
    metadata(url_suffix(".dzi")).decode(decode_catalog),
    metadata(any()).decode(decode_catalog),
];

pub const SPEC: FormatSpec =
    FormatSpec::new("deepzoom", ROUTES).with_display_name("Seadragon (Deep Zoom Image)");

fn is_tile_url(input: &str) -> bool {
    TILE_URL.is_match(input)
}

static POLONA_ITEM_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"polona\.pl/item/\d+/").expect("constant Polona item pattern"));

static DZI_LINK_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?i)(?P<url>[^"'()<>]+\.(?:xml|dzi))"#).expect("constant DZI link pattern")
});

static DZI_ATTR_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?i)[^a-z]dzi["'<>\s:=]+(?P<url>[^<"']*)"#)
        .expect("constant DZI attribute pattern")
});

static WDL_TEMPLATE_RE: LazyLock<BytesRegex> =
    LazyLock::new(|| BytesRegex::new(r#""([^"]+\.dzi)""#).expect("constant WDL template pattern"));

static WDL_VIEW_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"view/(\d+)/(\d+)").expect("constant WDL view pattern"));

fn has_wdl_template(bytes: &[u8]) -> bool {
    bytes
        .windows(b"dziUrlTemplate".len())
        .any(|window| window == b"dziUrlTemplate")
}

fn follow_wdl_template(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let template = WDL_TEMPLATE_RE
        .captures(resource.bytes())
        .and_then(|captures| captures.get(1))
        .map(|capture| String::from_utf8_lossy(capture.as_bytes()).into_owned())
        .ok_or_else(|| DiscoveryError::InvalidMetadata("WDL page declares no template".into()))?;
    let view = WDL_VIEW_RE.captures(resource.uri()).ok_or_else(|| {
        DiscoveryError::InvalidMetadata("WDL page URL has no view coordinates".into())
    })?;
    let url = template
        .replace("{group}", &view[1])
        .replace("{index}", &view[2]);
    Ok(resource.follow_relative(&url))
}

fn tile_metadata(input: &str) -> Result<Request, DiscoveryError> {
    let matched = TILE_URL
        .find(input)
        .ok_or_else(|| DiscoveryError::InvalidMetadata("not a DZI tile URL".into()))?;
    Ok(Request::new(format!("{}.dzi", &input[..matched.start()])))
}

fn is_bl_viewer_url(uri: &str) -> bool {
    uri.contains("bl.uk/manuscripts/Viewer.aspx")
}

#[allow(clippy::unnecessary_wraps)]
fn bl_metadata(input: &str) -> Result<Request, DiscoveryError> {
    // British Library viewer pages rewrite to their Proxy metadata endpoint:
    // `Viewer.aspx` becomes `Proxy.ashx` and `ref=<id>` becomes `view=<id>.xml`.
    static BL_REF_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"ref=([^&]*)").expect("constant BL ref pattern"));
    Ok(Request::new(BL_REF_RE.replace(
        &input.replace("Viewer.aspx", "Proxy.ashx"),
        "view=$1.xml",
    )))
}

fn is_polona_item_url(uri: &str) -> bool {
    POLONA_ITEM_RE.is_match(uri)
}

fn is_nla_view_url(uri: &str) -> bool {
    uri.contains("nla.gov.au/")
        && uri
            .rsplit(['?', '#'])
            .next()
            .unwrap_or(uri)
            .ends_with("/view")
}

#[allow(clippy::unnecessary_wraps)]
fn nla_metadata(input: &str) -> Result<Request, DiscoveryError> {
    // National Library of Australia viewer pages expose extensionless DZI
    // metadata next to the viewer path: `.../view` becomes `.../dzi`.
    let base = input.split(['?', '#']).next().unwrap_or(input);
    let parent = base
        .trim_end_matches('/')
        .rfind('/')
        .map_or(base, |index| &base[..index]);
    Ok(Request::new(format!("{parent}/dzi")))
}

fn is_polona_json_url(uri: &str) -> bool {
    uri.contains("polona.pl/resources/item/") && uri.contains("format=json")
}

fn follow_polona_json(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    static ITEM_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"polona\.pl/item/(\d+)/").expect("constant Polona item pattern")
    });
    let id = ITEM_RE
        .captures(resource.uri())
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_owned())
        .ok_or_else(|| DiscoveryError::InvalidMetadata("Polona item URL has no id".into()))?;
    Ok(ParsedResource::Follow(Request::new(format!(
        "http://polona.pl/resources/item/{id}/?format=json"
    ))))
}

fn follow_polona_dzi(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let context = resource.context();
    static PAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"polona\.pl/item/\d+/(\d+)").expect("constant Polona page pattern")
    });
    let page: usize = context
        .resources()
        .find_map(|prior| PAGE_RE.captures(prior.uri()))
        .and_then(|captures| captures.get(1))
        .and_then(|capture| capture.as_str().parse().ok())
        .ok_or_else(|| DiscoveryError::InvalidMetadata("Polona JSON has no item context".into()))?;
    let manifest: serde_json::Value =
        serde_json::from_slice(resource.bytes()).map_err(|error| {
            DiscoveryError::InvalidMetadata(format!("invalid Polona JSON: {error}"))
        })?;
    let dzi = manifest
        .get("pages")
        .and_then(|pages| pages.get(page))
        .and_then(|page| page.get("dzi_url"))
        .and_then(|url| url.as_str())
        .ok_or_else(|| DiscoveryError::InvalidMetadata("Polona JSON has no page DZI URL".into()))?;
    Ok(ParsedResource::Follow(Request::new(dzi.to_owned())))
}

fn contains_seadragon_embed(contents: &[u8]) -> bool {
    SEADRAGON_EMBED.is_match(contents)
}

fn follow_seadragon_embed(
    resource: DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let metadata = SEADRAGON_EMBED
        .captures(resource.bytes())
        .and_then(|captures| captures.name("metadata"))
        .map(|capture| std::str::from_utf8(capture.as_bytes()))
        .transpose()
        .map_err(|_| DiscoveryError::InvalidMetadata("Seadragon metadata URL is not UTF-8".into()))?
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Seadragon embed lacks a metadata URL".into())
        })?;
    Ok(resource.follow_relative(metadata))
}

mod paris;

fn decode_catalog(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let (url, contents) = (resource.final_uri(), resource.bytes());
    let xml_result = serde_xml_rs::from_reader::<'_, DziFile, _>(contents);
    let xml_err = xml_result.as_ref().err().map(ToString::to_string);
    let parsed = xml_result
        .ok()
        .into_iter()
        .chain(all_json::<DziFile>(contents))
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        let detail = xml_err.map(|e| format!(": {e}")).unwrap_or_default();
        return Err(DiscoveryError::InvalidMetadata(format!(
            "unable to parse DZI metadata{detail}"
        )));
    }
    catalog_from_dzi(url, parsed).map(ParsedResource::Catalog)
}

fn catalog_from_dzi(
    url: &str,
    images: impl IntoIterator<Item = DziFile>,
) -> Result<CatalogPlan, DiscoveryError> {
    let mut plans = Vec::new();
    for image in images {
        if image.tile_size == 0 {
            return Err(DiscoveryError::InvalidMetadata(
                "invalid DZI zero tile size".into(),
            ));
        }
        if image.get_size().x == 0 || image.get_size().y == 0 {
            return Err(DiscoveryError::Rejected {
                kind: RejectionKind::NoImage,
                cause: None,
                detail: Some("the document declares an empty image".into()),
            });
        }
        let base_url: Arc<str> = image.base_url(url).into();
        let image_size = image.get_size();
        let tile_size = image.get_tile_size();
        let max_level = image.max_level();
        let mut levels: Vec<_> = std::iter::successors(Some(image_size), |size| {
            (size.x > 1 || size.y > 1).then(|| size.ceil_div(Vec2d::square(2)))
        })
        .zip((0..=max_level).rev())
        .enumerate()
        .map(|(ordinal, (size, zoom))| {
            let base_url = Arc::clone(&base_url);
            let format = image.format.clone();
            let source =
                Grid::with_requests(size, tile_size, Vec2d::square(image.overlap), move |tile| {
                    let cell: Vec2d = tile.coord.into();
                    // `?tile=` query bases (NLA) join without a separator.
                    let separator = if base_url.ends_with(['=', '/']) {
                        ""
                    } else {
                        "/"
                    };
                    Request::new(format!(
                        "{base_url}{separator}{zoom}/{}_{}.{format}",
                        cell.x, cell.y
                    ))
                })
                .map_err(|error| {
                    DiscoveryError::InvalidMetadata(format!("invalid DZI grid: {error}"))
                })?;
            Ok(ResolvedLevel::new(source).with_title(Some(format!("DZI level {ordinal}"))))
        })
        .collect::<Result<Vec<_>, DiscoveryError>>()?;
        levels.reverse();
        let title = base_url
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .map(|s| s.trim_end_matches("_files").to_owned());
        plans.push(ImagePlan::new(title, levels));
    }
    Ok(CatalogPlan::images(plans))
}

#[cfg(test)]
fn load_catalog(
    url: &str,
    contents: &[u8],
) -> Result<crate::core::DiscoveryCatalog, DiscoveryError> {
    decode_catalog(DiscoveryResource::new(url, contents))?.compile("deepzoom")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{DiscoveredEntry, TileSource};
    use crate::test_support::ready_image;

    #[test]
    fn panorama_preserves_urls_overlap_and_normalized_level_order() {
        let contents = br#"<Image TileSize="256" Overlap="2" Format="jpg"><Size Width="600" Height="300"/></Image>"#;
        let catalog = load_catalog("http://x.fr/y/test.dzi", contents).unwrap();
        let DiscoveredEntry::Ready(image) = &catalog.entries()[0] else {
            panic!("DZI is immediately ready")
        };
        assert_eq!(image.title.as_deref(), Some("test"));
        let levels = ready_image(catalog).levels;
        assert_eq!(levels.len(), 11);
        assert!(
            levels
                .windows(2)
                .all(|pair| pair[0].source.image_size().unwrap().area()
                    <= pair[1].source.image_size().unwrap().area())
        );
        let TileSource::Grid(plan) = &levels[9].source else {
            panic!("DZI is a grid");
        };
        let urls: Vec<_> = plan
            .tiles_row_major()
            .take(2)
            .map(Result::unwrap)
            .map(|tile| tile.request.uri)
            .collect();
        assert_eq!(
            urls.join(","),
            "http://x.fr/y/test_files/9/0_0.jpg,http://x.fr/y/test_files/9/1_0.jpg"
        );
    }

    #[test]
    fn parses_xml_with_bom_and_openseadragon_configuration() {
        let bom = "\u{feff}<Image TileSize=\"256\" Overlap=\"0\" Format=\"jpg\"><Size Width=\"6261\" Height=\"6047\"/></Image>";
        let catalog = load_catalog("http://test.com/test.xml", bom.as_bytes()).unwrap();
        assert_eq!(catalog.len(), 1);
        let image = ready_image(catalog);
        assert_eq!(
            image.levels.last().unwrap().source.image_size(),
            Some(Vec2d { x: 6261, y: 6047 })
        );
        let script = r#"OpenSeadragon({tileSources:{Image:{Url:"/example-images/highsmith/highsmith_files/",Format:"jpg",Overlap:"2",TileSize:"256",Size:{Height:"9221",Width:"7026"}}}});"#;
        let levels =
            ready_image(load_catalog("http://test.com/x/test.xml", script.as_bytes()).unwrap())
                .levels;
        let large = levels.last().unwrap();
        assert_eq!(large.source.image_size(), Some(Vec2d { x: 7026, y: 9221 }));
        let TileSource::Grid(plan) = &large.source else {
            unreachable!()
        };
        assert_eq!(
            plan.tiles_row_major().next().unwrap().unwrap().request.uri,
            "http://test.com/example-images/highsmith/highsmith_files/14/0_0.jpg"
        );
    }
}
