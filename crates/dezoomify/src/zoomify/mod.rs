//! Pure discovery for Zoomify viewers, `ImageProperties.xml` pyramids, and
//! inline `OpenSeadragon` `zoomifytileservice` configurations (which carry
//! their own geometry, so no metadata fetch is needed).

use std::sync::{Arc, LazyLock};

use serde::{Deserialize, Deserializer};
use url::Url;

use crate::json_utils::all_json;
use image_properties::{ImageProperties, ZoomLevelInfo};
use regex::{Regex, bytes::Regex as BytesRegex};

use crate::Vec2d;
use crate::core::discovery::{html_matches, image_url, metadata, url_matches, url_suffix, viewer};
use crate::core::{
    CatalogPlan, DiscoveryError, DiscoveryRoute, FormatSpec, ImagePlan, ParsedResource, Request,
    ResolvedLevel, resolve_relative,
};

mod image_properties;

const ROUTES: &[DiscoveryRoute] = &[
    metadata(url_suffix("ImageProperties.xml")).decode(image_properties),
    image_url(is_tile_url).resolve_metadata(tile_metadata),
    metadata(url_matches(is_broker_url)).extract_metadata(broker_catalog_step),
    viewer(html_matches(has_inline_tile_service)).decode(inline_catalog),
    viewer(html_matches(contains_zoomify_declaration))
        .extract_metadata(extract_image_properties_url),
    viewer(html_matches(has_fluid_access_number)).extract_metadata(extract_fluid_catalog),
    viewer(url_matches(is_unibe_page)).extract_metadata(extract_unibe_catalog),
    viewer(html_matches(has_openlayers_source)).extract_metadata(extract_openlayers_catalog),
    ngv::ROUTE,
    viewer(html_matches(has_ete_url)).extract_metadata(extract_ete_catalog),
];

pub const SPEC: FormatSpec = FormatSpec::new("zoomify", ROUTES).with_display_name("Zoomify");

static SHOW_IMAGE_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?i)(?:\bZ\s*\.\s*)?\bshowImage\s*\([^,]*,\s*["'](?P<image>[^"']+)["']"#)
        .expect("constant Zoomify showImage pattern")
});

static TILE_SERVICE_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?is)\btype["']?\s*:\s*["']zoomifytileservice["'].*?\btilesUrl["']?\s*:\s*["'](?P<image>[^"']+)"#,
    )
    .expect("constant Zoomify tile service pattern")
});

// Inline OpenSeadragon configurations carry geometry (`width`, `height`,
// `tilesUrl`, optional `tileSize`), e.g. geographicus.com. They are parsed
// as JavaScript objects via the shared brace-scan + `json5` helper (which
// tolerates unquoted keys, single quotes, and trailing commas), never with
// field regexes. Every field is optional so enclosing viewer objects parse
// but are filtered out by the marker below.
#[derive(Debug, Deserialize)]
struct RawInlineTileService {
    #[serde(rename = "type", default)]
    service_type: Option<String>,
    #[serde(default, deserialize_with = "optional_u32")]
    width: Option<u32>,
    #[serde(default, deserialize_with = "optional_u32")]
    height: Option<u32>,
    #[serde(default)]
    #[serde(rename = "tilesUrl")]
    tiles_url: Option<String>,
    #[serde(default, deserialize_with = "optional_u32")]
    #[serde(rename = "tileSize")]
    tile_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NumberOrText {
    Number(u32),
    Text(String),
}

fn optional_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<NumberOrText>::deserialize(deserializer).map(|value| {
        value.and_then(|value| match value {
            NumberOrText::Number(number) => Some(number),
            NumberOrText::Text(text) => text.trim().parse().ok(),
        })
    })
}

/// At most this many inline sources become catalog entries.
const MAX_INLINE_SERVICES: usize = 8;

static IMAGE_PATH_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"zoomifyImagePath\s*=\s*["']?(?P<image>[^"'&\s;]+)"#)
        .expect("constant Zoomify image path pattern")
});

static FLUID_ACCESS_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?i)accessnumber\s*=\s*["']?(?P<access>[^"'&\s;]+)"#)
        .expect("constant Zoomify Fluid access-number pattern")
});

static UNIBE_URL_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"url\s*=\s*'(?P<path>[^']*)'").expect("constant Unibe URL pattern")
});

static OPENLAYERS_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?is)<[^>]*class="ete-openlayers-src"[^>]*>(?P<source>.*?)</.*?>"#)
        .expect("constant OpenLayers source pattern")
});

static ETE_URL_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"(?is)<url>(?P<page>.*?)</url>").expect("constant ETE URL pattern")
});

static BROKER_IMAGE_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?is)<imagefile[^>]*\bformat\s*=\s*["']zoomify["'][^>]*>(?P<image>[^<]*)"#)
        .expect("constant XML broker image pattern")
});
static TILE_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)TileGroup\d+/\d+-\d+-\d+\.jpe?g(?:[?#].*)?$")
        .expect("constant Zoomify tile URL pattern")
});

fn is_tile_url(uri: &str) -> bool {
    TILE_URL_RE.is_match(uri)
}

fn extract_image_properties_url(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let image_path = extract_image_path(resource.bytes()).ok_or_else(|| {
        DiscoveryError::InvalidMetadata("Zoomify viewer page does not declare an image path".into())
    })?;
    let page_base_uri = crate::web_page::page_base(resource.bytes(), resource.final_uri());
    let image_uri = resolve_relative(&page_base_uri, &image_path);
    Ok(ParsedResource::Follow(Request::new(append_path_component(
        &image_uri,
        "ImageProperties.xml",
    ))))
}

/// Whether a script block declares an inline source *with* geometry.
/// Path-only declarations (`Z.showImage`, bare `tilesUrl`) keep the
/// `ImageProperties.xml` route below; only full configurations qualify here.
fn has_inline_tile_service(bytes: &[u8]) -> bool {
    inline_tile_services(bytes, "", "").next().is_some()
}

struct InlineService {
    width: u32,
    height: u32,
    tile_size: u32,
    tiles_url: String,
}

fn inline_tile_services<'a>(
    html: &'a [u8],
    final_uri: &str,
    base_href: &str,
) -> impl Iterator<Item = InlineService> + 'a {
    let page_base_uri = if base_href.is_empty() {
        final_uri.to_owned()
    } else {
        resolve_relative(final_uri, base_href)
    };
    script_blocks(html)
        .into_iter()
        .flat_map(|(_, script)| all_json::<RawInlineTileService>(script).collect::<Vec<_>>())
        .filter_map(move |raw| {
            if !raw
                .service_type
                .as_deref()
                .is_some_and(|kind| kind.eq_ignore_ascii_case("zoomifytileservice"))
            {
                return None;
            }
            let (width, height) = (raw.width?, raw.height?);
            let tiles_url = raw.tiles_url?;
            if width == 0 || height == 0 || tiles_url.trim().is_empty() {
                return None;
            }
            let tile_size = raw.tile_size.unwrap_or(256);
            if tile_size == 0 {
                return None;
            }
            let tiles_url = resolve_relative(&page_base_uri, tiles_url.trim())
                .trim_end_matches('/')
                .to_owned();
            Some(InlineService {
                width,
                height,
                tile_size,
                tiles_url,
            })
        })
        .take(MAX_INLINE_SERVICES)
}

/// OpenSeadragon includes the smallest single-tile level and floors each
/// halving. Inline services have no XML NUMTILES compatibility hint.
fn inline_levels(width: u32, height: u32, tile_size: u32) -> Vec<ZoomLevelInfo> {
    let tile_size = Vec2d::square(tile_size);
    let mut size = Vec2d {
        x: width,
        y: height,
    };
    let mut levels = Vec::new();
    loop {
        levels.push(ZoomLevelInfo {
            size,
            tile_size,
            tiles_before: 0,
        });
        if size.x <= tile_size.x && size.y <= tile_size.y {
            break;
        }
        size = Vec2d {
            x: (size.x / 2).max(1),
            y: (size.y / 2).max(1),
        };
    }
    levels.reverse();
    let mut tiles_before = 0_u32;
    for level in &mut levels {
        level.tiles_before = tiles_before;
        tiles_before = tiles_before.saturating_add(
            u32::try_from(level.size.ceil_div(tile_size).area()).unwrap_or(u32::MAX),
        );
    }
    levels
}

fn inline_catalog(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let (uri, bytes) = (resource.final_uri(), resource.bytes());
    let base_href = crate::web_page::page_base(bytes, uri);
    let services: Vec<InlineService> = inline_tile_services(bytes, uri, &base_href).collect();
    if services.is_empty() {
        return Err(DiscoveryError::InvalidMetadata(
            "Zoomify viewer page declares no inline image geometry".into(),
        ));
    }
    let mut images = Vec::with_capacity(services.len());
    for service in &services {
        images.push(
            plan_from_levels(
                &service.tiles_url,
                inline_levels(service.width, service.height, service.tile_size),
                false,
                Vec::new(),
            )
            .map_err(|_| {
                DiscoveryError::InvalidMetadata("invalid inline Zoomify geometry".into())
            })?,
        );
    }
    Ok(ParsedResource::Catalog(CatalogPlan::images(images)))
}

fn has_fluid_access_number(bytes: &[u8]) -> bool {
    FLUID_ACCESS_RE.is_match(bytes)
}

fn extract_fluid_catalog(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    // Fluid Engage pages name an image collection; collection metadata comes
    // from the site-root XML broker.
    let access = FLUID_ACCESS_RE
        .captures(resource.bytes())
        .and_then(|captures| capture_text(&captures, "access"))
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Zoomify page has no Fluid access number".into())
        })?;
    let broker = format!(
        "{}/scripts/XMLBroker.new.php?Lang=2&contentType=IMAGES&contentID={access}",
        origin_of(resource.final_uri())
    );
    Ok(ParsedResource::Follow(Request::new(broker)))
}

fn is_broker_url(uri: &str) -> bool {
    uri.contains("/scripts/XMLBroker.new.php")
}

fn broker_catalog_step(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    broker_catalog(resource.bytes())
}

fn broker_catalog(bytes: &[u8]) -> Result<ParsedResource, DiscoveryError> {
    let path = BROKER_IMAGE_RE
        .captures(bytes)
        .and_then(|captures| capture_text(&captures, "image"))
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Fluid broker response has no zoomify image".into())
        })?;
    Ok(ParsedResource::Follow(Request::new(append_path_component(
        &path,
        "ImageProperties.xml",
    ))))
}

fn is_unibe_page(uri: &str) -> bool {
    uri.contains("biblio.unibe.ch/web-apps/maps/zoomify.php")
}

fn extract_unibe_catalog(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let path = UNIBE_URL_RE
        .captures(resource.bytes())
        .and_then(|captures| capture_text(&captures, "path"))
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("Unibe page declares no image URL".into())
        })?;
    let image_uri = resolve_relative(resource.final_uri(), &path);
    Ok(ParsedResource::Follow(Request::new(append_path_component(
        &image_uri,
        "ImageProperties.xml",
    ))))
}

fn has_openlayers_source(bytes: &[u8]) -> bool {
    OPENLAYERS_RE.is_match(bytes)
}

fn extract_openlayers_catalog(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let path = OPENLAYERS_RE
        .captures(resource.bytes())
        .and_then(|captures| capture_text(&captures, "source"))
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("OpenLayers page declares no image path".into())
        })?;
    let image_uri = resolve_relative(resource.final_uri(), &path);
    Ok(ParsedResource::Follow(Request::new(append_path_component(
        &image_uri,
        "ImageProperties.xml",
    ))))
}

fn has_ete_url(bytes: &[u8]) -> bool {
    ETE_URL_RE.is_match(bytes)
}

fn extract_ete_catalog(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let path = ETE_URL_RE
        .captures(resource.bytes())
        .and_then(|captures| capture_text(&captures, "page"))
        .ok_or_else(|| DiscoveryError::InvalidMetadata("page declares no ETE image URL".into()))?;
    Ok(ParsedResource::Follow(Request::new(append_path_component(
        &path,
        "ImageProperties.xml",
    ))))
}

/// Scheme + authority of a URI for site-root service URLs.
fn origin_of(uri: &str) -> String {
    Url::parse(uri)
        .ok()
        .filter(Url::has_host)
        .map_or_else(|| uri.to_owned(), |url| url.origin().ascii_serialization())
}

mod ngv;

fn contains_zoomify_declaration(contents: &[u8]) -> bool {
    SHOW_IMAGE_RE.is_match(contents)
        || IMAGE_PATH_RE.is_match(contents)
        || script_blocks(contents)
            .iter()
            .any(|(_, script)| TILE_SERVICE_RE.is_match(script))
}

fn append_path_component(uri: &str, component: &str) -> String {
    let suffix_start = uri.find(['?', '#']).unwrap_or(uri.len());
    let (path, suffix) = uri.split_at(suffix_start);
    format!("{}/{component}{suffix}", path.trim_end_matches('/'))
}

fn extract_image_path(html: &[u8]) -> Option<String> {
    // Earliest match wins across the page-level declaration forms.
    let image_path = IMAGE_PATH_RE
        .captures_iter(html)
        .find_map(|captures| Some((captures.get(0)?.start(), capture_text(&captures, "image")?)));
    let show_image = SHOW_IMAGE_RE
        .captures_iter(html)
        .find_map(|captures| Some((captures.get(0)?.start(), capture_text(&captures, "image")?)));
    let tile_service = script_blocks(html).into_iter().find_map(|(start, script)| {
        let captures = TILE_SERVICE_RE.captures(script)?;
        let offset = start + captures.get(0)?.start();
        Some((offset, capture_text(&captures, "image")?))
    });
    [image_path, show_image, tile_service]
        .into_iter()
        .flatten()
        .min_by_key(|(offset, _)| *offset)
        .map(|(_, path)| path)
}

/// Byte ranges of `<script>…</script>` contents with their document offsets.
///
/// Tile-service configurations are only meaningful inside script code;
/// matching outside would pick up documentation snippets.
fn script_blocks(html: &[u8]) -> Vec<(usize, &[u8])> {
    crate::web_page::script_bodies(html)
        .into_iter()
        .map(|body| {
            let offset = body.as_ptr() as usize - html.as_ptr() as usize;
            (offset, body)
        })
        .collect()
}

fn capture_text(captures: &regex::bytes::Captures<'_>, name: &str) -> Option<String> {
    captures
        .name(name)
        .map(|capture| String::from_utf8_lossy(capture.as_bytes()).replace("&amp;", "&"))
}

#[allow(clippy::unnecessary_wraps)]
fn tile_metadata(input: &str) -> Result<Request, DiscoveryError> {
    let uri = TILE_URL_RE.find(input).map_or_else(
        || input.to_owned(),
        |tile| {
            let prefix_end = if input.as_bytes()[tile.start()] == b'/' {
                tile.start() + 1
            } else {
                tile.start()
            };
            let prefix = &input[..prefix_end];
            let metadata = if prefix.is_empty() || prefix.ends_with('/') {
                format!("{prefix}ImageProperties.xml")
            } else {
                format!("{prefix}/ImageProperties.xml")
            };
            let suffix = tile
                .as_str()
                .find(['?', '#'])
                .map_or("", |index| &tile.as_str()[index..]);
            format!("{metadata}{suffix}")
        },
    );
    Ok(Request::new(uri))
}

fn image_properties(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let (url, contents) = (resource.uri(), resource.bytes());
    let properties: ImageProperties = serde_xml_rs::from_reader(contents).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("unable to parse Zoomify XML: {error}"))
    })?;
    if properties.width == 0 || properties.height == 0 || properties.tile_size == 0 {
        return Err(DiscoveryError::InvalidMetadata(
            "Zoomify XML must declare positive WIDTH, HEIGHT, and TILESIZE values".into(),
        ));
    }
    plan_from_properties(
        url.split("/ImageProperties.xml").next().unwrap_or(url),
        &properties,
    )
    .map(ParsedResource::Image)
}

fn plan_from_properties(
    base_url: &str,
    properties: &ImageProperties,
) -> Result<ImagePlan, DiscoveryError> {
    let (levels, warnings) = properties.levels_with_warnings();
    plan_from_levels(
        base_url,
        levels,
        properties.is_full_resolution_only(),
        warnings,
    )
}

fn plan_from_levels(
    base_url: &str,
    level_info: Vec<ZoomLevelInfo>,
    full_resolution_only: bool,
    warnings: Vec<String>,
) -> Result<ImagePlan, DiscoveryError> {
    let base_url: Arc<str> = base_url.into();
    let base_name = base_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty());
    let levels = level_info
        .into_iter()
        .enumerate()
        .map(|(index, info)| {
            let size = info.size;
            let tile_size = info.tile_size;
            let base_url = Arc::clone(&base_url);
            let level = ResolvedLevel::grid(size, tile_size, move |tile| {
                let cell: Vec2d = tile.coord.into();
                // Some producers declare only the full-resolution tile
                // count and consequently store every level in TileGroup0.
                let tile_group = if full_resolution_only {
                    0
                } else {
                    (u64::from(info.tiles_before) + tile.row_major_ordinal) / 256
                };
                Request::new(format!(
                    "{base_url}/TileGroup{tile_group}/{index}-{}-{}.jpg",
                    cell.x, cell.y
                ))
            })?;
            Ok(level.with_title(Some(match base_name {
                Some(base_name) => format!("{base_name} Zoomify level {index}"),
                None => format!("Zoomify level {index}"),
            })))
        })
        .collect::<Result<Vec<_>, DiscoveryError>>()?;
    let title = base_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    Ok(ImagePlan::new(title, levels).with_warnings(warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{DiscoveredEntry, ResolvedImage, TileSource};

    const XML: &[u8] = br#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="256" NUMTILES="2" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#;

    #[test]
    fn broker_origin_excludes_page_credentials_and_query() {
        assert_eq!(
            origin_of("https://user:password@fixtures.test:8443/viewer?token=secret"),
            "https://fixtures.test:8443"
        );
    }

    fn first_tile(catalog: crate::core::DiscoveryCatalog) -> String {
        let DiscoveredEntry::Ready(image) = &catalog.entries()[0] else {
            panic!("Zoomify metadata must produce a ready image")
        };
        let TileSource::Grid(plan) = &image.levels[0].source else {
            panic!("Zoomify levels must be grids")
        };
        plan.tiles_row_major().next().unwrap().unwrap().request.uri
    }

    #[test]
    fn specialized_viewers_follow_their_metadata_routes() {
        let (catalog, requests) = crate::test_support::discover(
            SPEC,
            "https://museum.example/viewer/page",
            &[
                (br#"<script>accessnumber='object42';</script>"#, None),
                (br#"<imagefile format="zoomify">https://museum.example/images/object42</imagefile>"#, None),
                (XML, None),
            ],
        );
        assert_eq!(
            requests[1].uri,
            "https://museum.example/scripts/XMLBroker.new.php?Lang=2&contentType=IMAGES&contentID=object42"
        );
        assert_eq!(
            requests[2].uri,
            "https://museum.example/images/object42/ImageProperties.xml"
        );
        assert_eq!(
            first_tile(catalog.unwrap()),
            "https://museum.example/images/object42/TileGroup0/0-0-0.jpg"
        );

        let (catalog, requests) = crate::test_support::discover(
            SPEC,
            "https://museum.example/viewer/page",
            &[
                (
                    br#"<div class="ete-openlayers-src">../images/map</div>"#,
                    None,
                ),
                (XML, None),
            ],
        );
        assert_eq!(
            requests[1].uri,
            "https://museum.example/images/map/ImageProperties.xml"
        );
        assert_eq!(
            first_tile(catalog.unwrap()),
            "https://museum.example/images/map/TileGroup0/0-0-0.jpg"
        );
    }

    #[test]
    fn tile_urls_request_sibling_metadata() {
        let (catalog, requests) = crate::test_support::discover(
            SPEC,
            "https://example.com/images/book/TileGroup0/3-0-0.jpg?token=secret",
            &[(XML, None)],
        );
        assert_eq!(
            requests[0].uri,
            "https://example.com/images/book/ImageProperties.xml?token=secret"
        );
        assert_eq!(
            first_tile(catalog.unwrap()),
            "https://example.com/images/book/TileGroup0/0-0-0.jpg"
        );
    }

    #[test]
    fn viewer_pages_resolve_metadata_and_tile_bases() {
        let cases: &[(&str, &[u8], &str, &str)] = &[
            (
                "https://fixtures.test/zoomify-base-href/product.html",
                br#"<base href="https://fixtures.test/zoomify-base-href/assets/"><script>Z.showImage("viewer", "maps/sample"); Z.showImage("viewer", "maps/missing");</script>"#,
                "https://fixtures.test/zoomify-base-href/assets/maps/sample/ImageProperties.xml",
                "https://fixtures.test/zoomify-base-href/assets/maps/sample/TileGroup0/0-0-0.jpg",
            ),
            (
                "https://museum.example/viewer/object",
                br#"<script>Z.showImage("viewer", "https://museum.example/proxy/OBJECT_ID/");</script>"#,
                "https://museum.example/proxy/OBJECT_ID/ImageProperties.xml",
                "https://museum.example/proxy/OBJECT_ID/TileGroup0/0-0-0.jpg",
            ),
        ];
        for (input, page, metadata, tile) in cases {
            let (catalog, requests) =
                crate::test_support::discover(SPEC, input, &[(page, None), (XML, None)]);
            let catalog = catalog.unwrap_or_else(|error| panic!("{input}: {error}"));
            assert_eq!(requests[1].uri, *metadata, "{input}");
            assert_eq!(first_tile(catalog), *tile, "{input}");
        }
    }

    #[test]
    fn redirected_pages_and_metadata_keep_the_right_tile_bases() {
        // A redirected viewer page resolves showImage paths against the final
        // page URL, while redirected metadata keeps the requested tile base.
        let (catalog, requests) = crate::test_support::discover(
            SPEC,
            "https://museum.example/object/12",
            &[
                (
                    br#"<script>Z.showImage("viewer", "tiles");</script>"#,
                    Some("https://cdn.example/viewer/12/index.html"),
                ),
                (XML, None),
            ],
        );
        catalog.unwrap();
        assert_eq!(
            requests[1].uri,
            "https://cdn.example/viewer/12/tiles/ImageProperties.xml"
        );

        let (catalog, _) = crate::test_support::discover(
            SPEC,
            "https://origin.example/book/ImageProperties.xml",
            &[(XML, Some("https://cdn.example/metadata/content.xml"))],
        );
        assert_eq!(
            first_tile(catalog.unwrap()),
            "https://origin.example/book/TileGroup0/0-0-0.jpg"
        );
    }

    #[test]
    fn extracts_general_zoomify_declarations() {
        for (page, expected) in [
            (r#"showImage("viewer", "/zoomify");"#, "/zoomify"),
            (r#"showImage(viewer, "/zoomify");"#, "/zoomify"),
            (
                r#"Z.showImage("viewer", "https://example.com/proxy/IMAGE_ID/");"#,
                "https://example.com/proxy/IMAGE_ID/",
            ),
        ] {
            assert_eq!(
                extract_image_path(page.as_bytes()).as_deref(),
                Some(expected)
            );
        }
        assert_eq!(extract_image_path(br#"<script>var config = {"type": "zoomifytileservice", "tilesUrl": "/zoomify"};</script>"#).as_deref(), Some("/zoomify"));
        // Configuration snippets displayed outside scripts are ignored.
        assert_eq!(extract_image_path(br#"<pre>{"type": "zoomifytileservice", "tilesUrl": "/displayed-not-executed"}</pre>"#), None);
    }

    #[test]
    fn unrelated_pages_are_rejected() {
        for page in [
            br#"<html><body>ordinary page</body></html>"#.as_slice(),
            br#"<script>var url = '/zoomify';</script>"#,
        ] {
            let (result, _) =
                crate::test_support::discover(SPEC, "https://example.com/page", &[(page, None)]);
            assert!(matches!(
                result,
                Err(DiscoveryError::NoCandidateAccepted { .. })
            ));
        }
    }

    #[test]
    fn inline_pyramid_includes_single_tile_and_floors_odd_dimensions() {
        for (width, height, expected) in [
            (200, 100, &[(200, 100, 0)][..]),
            (513, 513, &[(256, 256, 0), (513, 513, 1)]),
            (
                1027,
                1027,
                &[(256, 256, 0), (513, 513, 1), (1027, 1027, 10)],
            ),
        ] {
            let actual: Vec<_> = inline_levels(width, height, 256)
                .into_iter()
                .map(|level| (level.size.x, level.size.y, level.tiles_before))
                .collect();
            assert_eq!(actual, expected);
        }
    }

    fn assert_inline_page(name: &str, page: &[u8], base: &str) {
        let (catalog, requests) = crate::test_support::discover(
            SPEC,
            "https://www.geographicus.com/P/AntiqueMap/example",
            &[(page, None)],
        );
        let catalog = catalog.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(requests.len(), 1, "{name}");
        assert_eq!(catalog.len(), 2, "{name}");
        let DiscoveredEntry::Ready(first) = &catalog.entries()[0] else {
            panic!("inline Zoomify sources must be ready");
        };
        let DiscoveredEntry::Ready(second) = &catalog.entries()[1] else {
            panic!("inline Zoomify sources must be ready");
        };
        assert!(first.warnings.is_empty(), "{name}");
        assert_eq!(
            first.title.as_deref(),
            Some("Cowboys-mora-1941-3"),
            "{name}"
        );
        assert_eq!(
            second.title.as_deref(),
            Some("Cowboys-mora-1941-3-image2"),
            "{name}"
        );
        assert_eq!(first.levels.len(), 7, "{name}");
        for (image, title) in [
            (first, "Cowboys-mora-1941-3"),
            (second, "Cowboys-mora-1941-3-image2"),
        ] {
            let TileSource::Grid(plan) = &image.levels[0].source else {
                panic!("inline Zoomify levels must be grids");
            };
            let first_tile = plan.tiles_row_major().next().unwrap().unwrap();
            assert_eq!(
                first_tile.request.uri,
                format!("{base}{title}/TileGroup0/0-0-0.jpg"),
                "{name}"
            );
        }
    }

    #[test]
    fn inline_tile_services_complete_without_metadata_fetch() {
        // Regression: the service cap must count matched services, never the
        // unrelated JSON objects that real pages carry ahead of the viewer
        // (geographicus.com ships dozens of analytics/bootstrap objects before
        // its OpenSeadragon `tileSources` block).
        let mut noisy = String::from("<html><body>");
        noisy.extend((0..12).map(|index| {
            format!("<script>var config{index} = {{type: \"other\", width: {index}, height: 1}};</script>")
        }));
        noisy.push_str(r#"<script>viewer = OpenSeadragon({ tileSources: [ { type: "zoomifytileservice", width: 7066, height: 9380, tilesUrl: "/mm5/graphics/zoomify/Cowboys-mora-1941-3/", tileSize: 256 }, { type: "zoomifytileservice", width: 3020, height: 5000, tilesUrl: "/mm5/graphics/zoomify/Cowboys-mora-1941-3-image2/", tileSize: 256 } ] });</script></body></html>"#);
        assert_inline_page(
            "unrelated JSON objects before the viewer",
            noisy.as_bytes(),
            "https://www.geographicus.com/mm5/graphics/zoomify/",
        );
        assert_inline_page("inline tileSources", br#"<html><head><base href="https://www.geographicus.com/mm5/" /></head><body><script>viewer = OpenSeadragon({ tileSources: [ { type: "zoomifytileservice", width: 7066, height: 9380, tilesUrl: "/mm5/graphics/00000001/zoomify/Cowboys-mora-1941-3/", tileSize: 256, fileFormat: 'jpg' }, { type: "zoomifytileservice", width: 3020, height: 5000, tilesUrl: "/mm5/graphics/00000001/zoomify/Cowboys-mora-1941-3-image2/", tileSize: 256, fileFormat: 'jpg' } ] });</script></body></html>"#, "https://www.geographicus.com/mm5/graphics/00000001/zoomify/");
    }

    #[test]
    fn inline_service_accepts_string_dimensions_and_any_case() {
        let services: Vec<InlineService> = inline_tile_services(
            br#"Server warning <script type="application/json">{type: 'ZoomifyTileService', width: "1024",
                height: '768', tilesUrl: "/z/", tileSize: "64",};</script>"#,
            "https://example.com/page",
            "",
        )
        .collect();
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].width, 1024);
        assert_eq!(services[0].height, 768);
        assert_eq!(services[0].tile_size, 64);
        assert_eq!(services[0].tiles_url, "https://example.com/z");
    }

    #[test]
    fn inline_config_without_geometry_falls_back_to_xml() {
        let (catalog,requests)=crate::test_support::discover(SPEC,"https://example.com/page",&[(br#"<script>var config = {"type": "zoomifytileservice", "tilesUrl": "/zoomify"};</script>"#,None),(XML,None)]);
        catalog.unwrap();
        assert_eq!(
            requests[1].uri,
            "https://example.com/zoomify/ImageProperties.xml"
        );
    }

    fn ready_image(url: &str, contents: &[u8]) -> ResolvedImage {
        match image_properties(crate::core::DiscoveryResource::new(url, contents))
            .and_then(|step| step.compile("zoomify"))
            .unwrap()
            .into_entries()
            .pop()
            .unwrap()
        {
            DiscoveredEntry::Ready(image) => image,
            DiscoveredEntry::Deferred(_) => panic!("Zoomify is resolved"),
        }
    }

    fn levels(url: &str, contents: &[u8]) -> Vec<ResolvedLevel> {
        ready_image(url, contents).levels
    }

    #[test]
    fn panorama_preserves_tile_order_and_normalized_levels() {
        let contents = br#"<IMAGE_PROPERTIES WIDTH="174550" HEIGHT="16991" NUMTILES="61284" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#;
        let levels = levels("http://x.fr/y/ImageProperties.xml?t", contents);
        assert_eq!(levels.len(), 11);
        let areas: Vec<_> = levels
            .iter()
            .map(|level| level.source.image_size().unwrap().area())
            .collect();
        assert!(areas.windows(2).all(|pair| pair[0] <= pair[1]));
        let TileSource::Grid(plan) = &levels[3].source else {
            unreachable!()
        };
        let urls: Vec<_> = plan
            .tiles_row_major()
            .take(2)
            .map(Result::unwrap)
            .map(|tile| tile.request.uri)
            .collect();
        assert_eq!(
            urls.join(","),
            "http://x.fr/y/TileGroup0/3-0-0.jpg,http://x.fr/y/TileGroup0/3-1-0.jpg"
        );
    }

    #[test]
    fn titles_and_warnings_are_retained() {
        let image = ready_image("http://example.com/images/manuscript123/ImageProperties.xml", br#"<IMAGE_PROPERTIES WIDTH="12000" HEIGHT="9788" NUMTILES="2477" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#);
        assert_eq!(image.title.as_deref(), Some("manuscript123"));
        let image = ready_image("http://example.com/ImageProperties.xml", br#"<IMAGE_PROPERTIES WIDTH="500" HEIGHT="500" NUMTILES="9" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#);
        assert_eq!(image.title.as_deref(), Some("example.com"));
        assert_eq!(
            image.warnings,
            ["Zoomify tile count mismatch: computed 5, metadata declares 9"]
        );
    }

    #[test]
    fn full_resolution_only_numtiles_uses_the_full_level() {
        let image = ready_image(
            "https://fixtures.test/zoomify-full-numtiles/ImageProperties.xml",
            br#"<IMAGE_PROPERTIES WIDTH="10240" HEIGHT="1792" NUMTILES="280" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>"#,
        );
        let TileSource::Grid(plan) = &image.levels.last().unwrap().source else {
            unreachable!()
        };
        assert_eq!(plan.count(), 280);
        let urls: Vec<_> = plan
            .tiles_row_major()
            .map(Result::unwrap)
            .map(|tile| tile.request.uri)
            .collect();
        assert!(urls.iter().all(|url| url.contains("/TileGroup0/")));
        assert!(urls.iter().any(|url| url.ends_with("/6-16-6.jpg")));
    }
}
