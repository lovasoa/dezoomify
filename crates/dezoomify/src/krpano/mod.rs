//! Pure, resumable discovery for krpano panoramas.

use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, LazyLock};

use itertools::Itertools;
use memchr::memmem;
use regex::{Regex, bytes::Regex as BytesRegex};
use url::Url;

use krpano_decrypt::{decrypt_xml, is_encrypted_xml};
use krpano_metadata::{KrpanoMetadata, XY, all_sides};

use crate::Vec2d;
use crate::core::discovery::{
    any, html_matches, js_matches, metadata, url_matches, url_suffix, viewer,
};
use crate::core::resolve_relative;
use crate::core::{
    CatalogPlan, DiscoveryCatalog, DiscoveryContext, DiscoveryError, DiscoveryResource,
    DiscoveryRoute, FormatSpec, Grid, GridRequests, GridTile, ImagePlan, ParsedResource,
    RejectionKind, Request, ResolvedLevel,
};
use crate::krpano::krpano_metadata::{ImageInfo, LevelDesc};
use crate::template::Template;

mod krpano_metadata;

static VIEWER_JS_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"(?s-u)\A(?:\xEF\xBB\xBF)?(?:/\*.*krpano|function .*(?:krpano|embedpano|createPanoViewer))")
        .expect("constant krpano JavaScript pattern")
});
static HTML_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"(?s-u)embedpano\(|createPanoViewer\(|<script.*(?:krpano|tour\.js)|(?:krpano|tour\.js).*<script")
        .expect("constant krpano HTML pattern")
});

const ROUTES: &[DiscoveryRoute] = &[
    metadata(url_suffix("/tiles.xml")).decode(handle_xml),
    metadata(url_suffix("/tour.xml")).decode(handle_xml),
    metadata(any()).try_decode(try_xml),
    viewer(html_matches(&HTML_RE)).decode(handle_html),
    viewer(js_matches(&VIEWER_JS_RE)).decode(handle_viewer_js),
    viewer(url_matches(is_javascript_uri)).decode(handle_viewer_js),
    metadata(any()).child_metadata(handle_xml),
];

pub const SPEC: FormatSpec = FormatSpec::new("krpano", ROUTES)
    .with_display_name("krpano")
    .on_failure(handle_failure);

fn handle_html(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let context = resource.context();
    if find_xml(context).is_some() {
        return handle_viewer_js(resource);
    }
    let xml_uri = extract_xml_from_query(resource.final_uri())
        .map(|reference| resolve_relative(resource.final_uri(), &reference))
        .or_else(|| extract_xml_from_embedpano(resource))
        .unwrap_or_else(|| sibling_uri(resource.final_uri(), "tour.xml"));
    Ok(ParsedResource::Follow(Request::new(xml_uri)))
}

fn handle_xml(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let context = resource.context();
    let contents = resource.bytes();
    if !is_encrypted_xml(contents) {
        return complete(resource.final_uri(), contents);
    }

    let viewer_js = context
        .resources()
        .filter(|candidate| candidate.uri() != resource.uri())
        .filter(|candidate| is_javascript_resource(*candidate))
        .filter_map(|candidate| extract_viewer_js(candidate.bytes()))
        .next_back();
    match decrypt_xml(contents, viewer_js.as_deref()) {
        Ok(decrypted) => complete(resource.final_uri(), &decrypted),
        Err(error) => next_viewer(context, resource, resource.final_uri()).map_or_else(
            || {
                Err(DiscoveryError::InvalidMetadata(format!(
                    "unable to decrypt krpano XML: {error}"
                )))
            },
            |uri| Ok(ParsedResource::Follow(Request::new(uri))),
        ),
    }
}

fn try_xml(resource: DiscoveryResource<'_>) -> Option<Result<ParsedResource, DiscoveryError>> {
    if is_encrypted_xml(resource.bytes()) && resource.is_html() {
        return Some(handle_xml(resource));
    }
    let metadata = KrpanoMetadata::from_bytes(resource.bytes()).ok()?;
    if !metadata.has_images() {
        return None;
    }
    Some(catalog_from_metadata(resource.final_uri(), metadata).map(ParsedResource::Catalog))
}

fn handle_viewer_js(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let context = resource.context();
    let Some(xml) = find_xml(context) else {
        if extract_viewer_js(resource.bytes()).is_none() {
            return Err(DiscoveryError::rejected(
                RejectionKind::DidNotMatchContent,
                "not krpano viewer JavaScript",
            ));
        }
        return Ok(ParsedResource::Follow(Request::new(sibling_uri(
            resource.final_uri(),
            "tour.xml",
        ))));
    };
    let viewer_js =
        extract_viewer_js(resource.bytes()).unwrap_or_else(|| resource.bytes().to_vec());
    match decrypt_xml(xml.bytes(), Some(&viewer_js)) {
        Ok(decrypted) => complete(xml.final_uri(), &decrypted),
        Err(error) => next_viewer(context, resource, xml.final_uri()).map_or_else(
            || {
                Err(DiscoveryError::InvalidMetadata(format!(
                    "unable to decrypt krpano XML: {error}"
                )))
            },
            |uri| Ok(ParsedResource::Follow(Request::new(uri))),
        ),
    }
}

fn handle_failure(
    context: &DiscoveryContext<'_>,
    request: &Request,
    failure: &crate::model::Error,
) -> Result<ParsedResource, DiscoveryError> {
    if let Some(xml) = find_xml(context)
        && let Some(uri) = next_viewer_after_failure(context, request.uri.as_str(), xml.final_uri())
    {
        return Ok(ParsedResource::Follow(Request::new(uri)));
    }
    Err(DiscoveryError::fetch_failed(failure.clone()))
}

fn find_xml<'a>(context: &DiscoveryContext<'a>) -> Option<DiscoveryResource<'a>> {
    context
        .resources()
        .rev()
        .find(|resource| is_encrypted_xml(resource.bytes()))
}

fn next_viewer(
    context: &DiscoveryContext<'_>,
    current: DiscoveryResource<'_>,
    xml_uri: &str,
) -> Option<String> {
    let initial = context.resources().next().unwrap_or(current);
    next_viewer_from_initial(context, initial, current.uri(), xml_uri)
}

fn next_viewer_after_failure(
    context: &DiscoveryContext<'_>,
    current_uri: &str,
    xml_uri: &str,
) -> Option<String> {
    let initial = context.resources().next()?;
    next_viewer_from_initial(context, initial, current_uri, xml_uri)
}

fn next_viewer_from_initial(
    context: &DiscoveryContext<'_>,
    initial: DiscoveryResource<'_>,
    current_uri: &str,
    xml_uri: &str,
) -> Option<String> {
    let mut candidates = if HTML_RE.is_match(initial.bytes()) {
        extract_js_candidates_from_html(initial)
    } else if is_javascript_resource(initial) {
        Vec::new()
    } else {
        viewer_js_candidates_for_xml(xml_uri)
    };
    candidates.retain(|candidate| candidate != current_uri && !context.has_visited(candidate));
    candidates.into_iter().next()
}

fn is_javascript_resource(resource: DiscoveryResource<'_>) -> bool {
    is_javascript_uri(resource.final_uri()) || contains_viewer_js(resource.bytes())
}

fn is_javascript_uri(uri: &str) -> bool {
    is_javascript_src(uri)
}

fn contains_viewer_js(contents: &[u8]) -> bool {
    extract_viewer_js(contents).is_some()
}

fn complete(uri: &str, bytes: &[u8]) -> Result<ParsedResource, DiscoveryError> {
    load_catalog(uri, bytes).map(ParsedResource::Complete)
}

/// Extract and rank viewer JavaScript candidates from a krpano HTML page.
fn extract_js_candidates_from_html(resource: DiscoveryResource<'_>) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for (index, script) in crate::web_page::scripts(resource).into_iter().enumerate() {
        let Some(src) = script.source else {
            continue;
        };
        if !is_javascript_src(&src) {
            continue;
        }
        let uri = resolve_relative(&script.fetch_base, &src);
        if seen.insert(uri.clone()) {
            candidates.push(ScriptCandidate {
                uri,
                score: viewer_script_score(&src),
                index,
            });
        }
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.index.cmp(&right.index))
    });
    candidates
        .into_iter()
        .map(|candidate| candidate.uri)
        .collect()
}

fn extract_xml_from_embedpano(resource: DiscoveryResource<'_>) -> Option<String> {
    crate::web_page::scripts(resource)
        .into_iter()
        .filter(|script| script.source.is_none())
        .map(|script| (script.body, script.base))
        .find_map(|(script, base)| {
            let source = crate::javascript::mask(&script);
            crate::javascript::captures(&EMBEDPANO_RE, &source).find_map(|call| {
                let body = crate::javascript::body_at(&source, call.get(0)?.end())?;
                crate::javascript::property(body, "xml")
                    .map(|reference| resolve_relative(&base, &reference))
            })
        })
}

fn extract_xml_from_query(uri: &str) -> Option<String> {
    Url::parse(uri)
        .ok()?
        .query_pairs()
        .find_map(|(name, value)| (name == "xml" && !value.is_empty()).then(|| value.into_owned()))
}

fn extract_viewer_js(contents: &[u8]) -> Option<Vec<u8>> {
    if VIEWER_JS_RE.is_match(contents) {
        return Some(contents.to_vec());
    }
    let start = memmem::find(contents, b"<script>")?;
    let body = &contents[start + 8..];
    let end = memmem::find(body, b"</script>")?;
    let script = body[..end].trim_ascii();
    VIEWER_JS_RE.is_match(script).then(|| script.to_vec())
}

fn viewer_js_candidates_for_xml(xml_uri: &str) -> Vec<String> {
    let path = xml_uri
        .split_once(['?', '#'])
        .map_or(xml_uri, |(path, _)| path);
    let stem = path
        .rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(stem, _)| stem))
        .filter(|stem| !stem.is_empty())
        .unwrap_or("tour");
    let mut candidates = vec![sibling_uri(xml_uri, &format!("{stem}.js"))];
    for fallback in ["tour.js", "krpano.js"] {
        let candidate = sibling_uri(xml_uri, fallback);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn sibling_uri(uri: &str, filename: &str) -> String {
    let uri = uri.split_once(['?', '#']).map_or(uri, |(path, _)| path);
    let search_start = uri.find("://").map_or(0, |index| index + 3);
    match uri[search_start..].rfind(['/', '\\']) {
        Some(relative_index) => {
            let index = search_start + relative_index;
            format!("{}{}{filename}", &uri[..index], &uri[index..=index])
        }
        None if search_start > 0 => format!("{uri}/{filename}"),
        None => filename.to_owned(),
    }
}

#[derive(Debug)]
struct ScriptCandidate {
    uri: String,
    score: i32,
    index: usize,
}

static EMBEDPANO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:window\.)?(?:embedpano|createPanoViewer)\s*\(\s*\{")
        .expect("constant embed pattern")
});

fn is_javascript_src(src: &str) -> bool {
    let path = src.split_once(['?', '#']).map_or(src, |(path, _)| path);
    path.rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("js"))
}

fn viewer_script_score(src: &str) -> i32 {
    let lower = src.to_ascii_lowercase();
    let path = lower
        .split_once(['?', '#'])
        .map_or(lower.as_str(), |(path, _)| path);
    let filename = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let mut score = match filename {
        "tour.js" => 1_000,
        "krpano.js" => 950,
        _ => 0,
    };
    if filename != "tour.js" && filename != "krpano.js" {
        if filename.contains("krpano") {
            score += 850;
        }
        if filename.contains("pano") {
            score += 450;
        }
        if filename.contains("tour") {
            score += 400;
        }
        if filename.contains("viewer") {
            score += 250;
        }
    }
    if is_common_non_viewer_script(filename) || is_common_non_viewer_script(path) {
        score -= 1_000;
    }
    score
}

fn is_common_non_viewer_script(value: &str) -> bool {
    [
        "jquery",
        "analytics",
        "gtag",
        "googletagmanager",
        "matomo",
        "piwik",
        "bootstrap",
        "modernizr",
        "polyfill",
        "underscore",
        "lodash",
        "react",
        "vue",
        "angular",
        "runtime",
        "vendor",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn load_catalog(url: &str, contents: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
    decode_catalog(url, contents)?.compile("krpano")
}

fn decode_catalog(url: &str, contents: &[u8]) -> Result<CatalogPlan, DiscoveryError> {
    let metadata = KrpanoMetadata::from_bytes(contents).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("unable to parse krpano XML: {error}"))
    })?;
    catalog_from_metadata(url, metadata)
}

fn catalog_from_metadata(
    url: &str,
    metadata: KrpanoMetadata,
) -> Result<CatalogPlan, DiscoveryError> {
    let global_title = metadata.get_title().unwrap_or_default().to_owned();
    let mut images = Vec::new();

    for ImageInfo { image, name } in metadata.into_image_iter() {
        let root_tile_size = image.tilesize.map(Vec2d::square);
        let base_index = image.baseindex;
        let image_title = joined_nonempty([global_title.as_str(), name.as_ref()]);
        let mut levels = Vec::new();
        let mut warnings = Vec::new();

        for (source_index, source_level) in image.into_levels().enumerate() {
            for description in source_level.level_descriptions(None, source_index) {
                let LevelDesc {
                    name: shape_name,
                    size,
                    tilesize,
                    url: template,
                    level_index,
                } = match description {
                    Ok(description) => description,
                    Err(error) => {
                        warnings.push(format!("bad krpano level: {error}"));
                        continue;
                    }
                };
                let Some(tile_size) = tilesize.or(root_tile_size) else {
                    warnings.push("bad krpano level: missing tile size".into());
                    continue;
                };
                let level_number = level_index + base_index as usize;
                for (side_name, template) in all_sides(template, level_number) {
                    let face = face_label(shape_name, side_name);
                    let source = KrpanoLevel {
                        base_url: Arc::from(url),
                        base_index,
                        template,
                        label: format_level_label(shape_name, side_name, &name),
                    };
                    let source = match Grid::new(size, tile_size, Vec2d::default(), source) {
                        Ok(source) => source,
                        Err(error) => {
                            warnings.push(format!("bad krpano level: {error}"));
                            continue;
                        }
                    };
                    levels.push(ResolvedLevel::new(source).with_title(level_title(
                        &global_title,
                        &name,
                        &face,
                    )));
                }
            }
        }

        images.push(ImagePlan::new(image_title, levels).with_warnings(warnings));
    }
    if images.is_empty() {
        return Err(DiscoveryError::InvalidMetadata(
            "krpano XML contains no tiled images".into(),
        ));
    }
    Ok(CatalogPlan::images(images))
}

fn joined_nonempty<'a>(parts: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let title = parts.into_iter().filter(|part| !part.is_empty()).join(" ");
    (!title.is_empty()).then_some(title)
}

fn face_label(shape: &str, side: &str) -> String {
    [shape, side]
        .into_iter()
        .filter(|part| !part.is_empty())
        .join(" ")
}

fn level_title(global: &str, scene: &str, face: &str) -> Option<String> {
    let title = ["Krpano", global, scene, face]
        .into_iter()
        .filter(|part| !part.is_empty())
        .join(" ");
    (!title.is_empty()).then_some(title)
}

fn format_level_label(shape: &str, side: &str, scene: &str) -> String {
    ["Krpano", shape, side, scene]
        .into_iter()
        .filter(|part| !part.is_empty())
        .join(" ")
}

struct KrpanoLevel {
    base_url: Arc<str>,
    base_index: u32,
    template: Template<XY>,
    label: String,
}

impl fmt::Debug for KrpanoLevel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.label)
    }
}

impl GridRequests for KrpanoLevel {
    fn request(&self, tile: GridTile) -> Request {
        let cell: Vec2d = tile.coord.into();
        let relative = self.template.render(|variable| {
            self.base_index
                + match variable {
                    XY::X => cell.x,
                    XY::Y => cell.y,
                }
        });
        Request::new(resolve_relative(&self.base_url, &relative))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::discovery::{DiscoveryError, RejectionKind};
    use crate::core::{DiscoveredEntry, TileSource};
    use crate::test_support::ready_image as image;

    fn tile_requests(level: &ResolvedLevel, count: usize) -> Vec<(String, Vec2d)> {
        let TileSource::Grid(plan) = &level.source else {
            panic!("krpano levels are grids");
        };
        plan.tiles_row_major()
            .take(count)
            .map(Result::unwrap)
            .map(|tile| (tile.request.uri, tile.destination))
            .collect()
    }

    fn catalog_from_xml(uri: &str, contents: &[u8]) -> DiscoveryCatalog {
        load_catalog(uri, contents).unwrap()
    }

    fn discover_single_resource(uri: &str, bytes: Vec<u8>) -> DiscoveryCatalog {
        let (catalog, requests) = crate::test_support::discover(SPEC, uri, &[(&bytes, None)]);
        assert_eq!(requests[0].uri, uri);
        catalog.unwrap()
    }

    #[test]
    fn proxied_krpano_without_redirect_keeps_the_site_tile_base() {
        // Regression: https://krpano.com/panos/andreabiffi/galleria_04.xml
        // fetched through the metadata proxy arrived with an empty final URI,
        // so relative galleria_04.tiles/* URLs resolved against the app page
        // (/beta/) and every tile 404'd. The core must fall back to the
        // request URI, keeping tiles on krpano.com.
        let xml = br#"<krpano version="1.16"><image type="CUBE" multires="true" tilesize="512" progressive="false"><level tiledimagewidth="955" tiledimageheight="955"><cube url="galleria_04.tiles/mres_%s/l2/%v/l2_%s_%v_%h.jpg" /></level></image></krpano>"#;
        for with_empty in [false, true] {
            let uri = "https://krpano.com/panos/andreabiffi/galleria_04.xml";
            let (catalog, _) =
                crate::test_support::discover(SPEC, uri, &[(xml, with_empty.then_some(""))]);
            let catalog = catalog.unwrap();
            let image = self::image(catalog);
            let (tile_uri, _) = tile_requests(&image.levels[0], 1).pop().unwrap();
            assert!(
                tile_uri.starts_with("https://krpano.com/panos/andreabiffi/galleria_04.tiles/"),
                "tile base must stay on the site, got {tile_uri}"
            );
        }
    }

    #[test]
    fn inline_preview_does_not_trigger_an_include_request() {
        let xml = br#"<krpano><include url="%VIEWER%/plugins/minimap_zoomrect.xml"/><layer name="minimap" url="minimap.jpg"/><image><preview url="https://krpano.com/panos/eiffeltower/eiffeltower.tiles/preview.jpg"/><flat url="https://krpano.com/panos/eiffeltower/eiffeltower.tiles/l%l/%00v/l%l_%00v_%00h.jpg" multires="512,512x844,1152x1898,2176x3586,4352x7172,8832x14554,17664x29110,35328x58220"/></image></krpano>"#;
        let image = image(discover_single_resource(
            "https://krpano.com/releases/1.24/viewer/examples/minimap/eiffeltower_minimap.xml",
            xml.to_vec(),
        ));
        let (tile_uri, _) = tile_requests(&image.levels[0], 1).pop().unwrap();
        assert_eq!(
            tile_uri,
            "https://krpano.com/panos/eiffeltower/eiffeltower.tiles/l1/001/l1_001_001.jpg"
        );
    }

    #[test]
    fn test_cube() {
        let image = image(catalog_from_xml("http://test.com", br#"<krpano showerrors="false" logkey="false"><image type="cube" multires="true" tilesize="512" progressive="false" multiresthreshold="-0.3"><level download="view" decode="view" tiledimagewidth="1000" tiledimageheight="100"><cube url="http://example.com/%s/%r/%c.jpg"/></level></image></krpano>"#));
        assert_eq!(image.levels.len(), 6);
        assert_eq!(
            image.levels[0].source.image_size(),
            Some(Vec2d { x: 1000, y: 100 })
        );
        // Cube faces must remain distinguishable in interactive level pickers.
        let labels: Vec<String> = image
            .levels
            .iter()
            .enumerate()
            .map(|(position, level)| level.display_label(position))
            .collect();
        assert!(labels[0].contains("Cube forward"));
        assert!(labels.iter().all(|l| l.contains(" 1000 x   100 pixels")));
        let unique: std::collections::HashSet<&String> = labels.iter().collect();
        assert_eq!(unique.len(), labels.len(), "labels: {labels:?}");
        assert_eq!(
            format_level_label("Cube", "forward", ""),
            "Krpano Cube forward"
        );
        let requests = tile_requests(&image.levels[0], 2);
        assert_eq!(
            requests
                .iter()
                .map(|(uri, _)| uri.as_str())
                .collect::<Vec<_>>()
                .join(","),
            "http://example.com/f/1/1.jpg,http://example.com/f/1/2.jpg"
        );
        assert_eq!(
            requests
                .iter()
                .map(|(_, at)| (at.x, at.y))
                .collect::<Vec<_>>(),
            [(0, 0), (512, 0)]
        );
    }

    #[test]
    fn test_flat_multires() {
        let image = image(catalog_from_xml(
            "http://test.com",
            br#"<krpano><image><flat url="level=%l x=%0x y=%0y" multires="1,2x3,3x4x3"/></image></krpano>"#,
        ));
        assert_eq!(image.title, None);
        assert_eq!(image.levels.len(), 2);
        assert_eq!(
            image.levels[1].source.image_size(),
            Some(Vec2d { x: 3, y: 4 })
        );
        assert_eq!(format_level_label("Flat", "", ""), "Krpano Flat");
        let requests = tile_requests(&image.levels[1], 2);
        assert_eq!(
            requests
                .iter()
                .map(|(uri, _)| uri.as_str())
                .collect::<Vec<_>>()
                .join(","),
            "http://test.com/level=2%20x=01%20y=01,http://test.com/level=2%20x=01%20y=02"
        );
        assert_eq!(
            requests
                .iter()
                .map(|(_, at)| (at.x, at.y))
                .collect::<Vec<_>>(),
            [(0, 0), (0, 3)]
        );
    }

    const BELLEGAMBE_XML_URL: &str =
        "https://pba.lille.fr/gigapixels/Gigapixelweb/gigapixels_1515_bellegambe/gigapixels.xml";

    fn assert_bellegambe_levels(levels: &[ResolvedLevel]) {
        let expected_sizes = [
            (512, 342),
            (768, 514),
            (1536, 1026),
            (3072, 2052),
            (5888, 3930),
            (11904, 7946),
            (23808, 15892),
            (47616, 31782),
            (94976, 63392),
        ];
        assert_eq!(levels.len(), expected_sizes.len());
        let sizes: Vec<_> = levels
            .iter()
            .map(|level| level.source.image_size())
            .collect();
        let expected: Vec<_> = expected_sizes
            .into_iter()
            .map(|(x, y)| Some(Vec2d { x, y }))
            .collect();
        assert_eq!(sizes, expected);
        let TileSource::Grid(plan) = &levels[7].source else {
            unreachable!()
        };
        assert_eq!(plan.count(), 5859);
        let first = plan.tiles_row_major().next().unwrap().unwrap();
        assert_eq!(
            first.request.header("Referer"),
            Some(
                "https://pba.lille.fr/gigapixels/Gigapixelweb/gigapixels_1515_bellegambe/gigapixels.tiles/l8/001/l8_001_001.jpg"
            )
        );
    }

    #[test]
    fn explicit_levels_expand_level_placeholder() {
        let data =
            std::fs::read("../../testdata/scenarios/rs-core/formats/payloads/krpano/pba_lille_gigapixels_1515_bellegambe.xml").unwrap();
        assert_bellegambe_levels(&image(catalog_from_xml(BELLEGAMBE_XML_URL, &data)).levels);
        assert_bellegambe_levels(&image(discover_single_resource(BELLEGAMBE_XML_URL, data)).levels);
    }

    #[test]
    fn test_cube_faces_form_one_image() {
        let image = image(catalog_from_xml("http://test.com", br#"<krpano><image tilesize="512"><level tiledimagewidth="1000" tiledimageheight="100"><cube url="http://example.com/%s/%r/%c.jpg"/></level></image></krpano>"#));
        assert_eq!(image.title, None);
        assert_eq!(image.levels.len(), 6);
        let titles: Vec<_> = image.levels.iter().map(|l| l.title.clone()).collect();
        assert!(!titles.iter().any(Option::is_none));
        let unique: std::collections::HashSet<&Option<String>> = titles.iter().collect();
        assert_eq!(unique.len(), titles.len(), "titles: {titles:?}");
    }

    #[test]
    fn test_multiple_scenes_remain_separate() {
        let data = std::fs::read(
            "../../testdata/scenarios/rs-core/formats/payloads/krpano/krpano_scenes.xml",
        )
        .unwrap();
        let titles = catalog_from_xml("http://test.com/scenes.xml", &data)
            .into_entries()
            .into_iter()
            .map(|entry| match entry {
                DiscoveredEntry::Ready(image) => image.title,
                DiscoveredEntry::Deferred(_) => unreachable!(),
            })
            .collect::<Vec<_>>();
        assert_eq!(titles, [Some(" Saint Thomas (1618 - 1620) - Diego Velazquez - Museum of Fine Arts, Orleans ( France) scene_Color".into()), Some(" Saint Thomas (1618 - 1620) - Diego Velazquez - Museum of Fine Arts, Orleans ( France) scene_3D".into()), Some(" Saint Thomas (1618 - 1620) - Diego Velazquez - Museum of Fine Arts, Orleans ( France) scene_3Dcolor".into())]);
    }

    #[test]
    fn encrypted_xml_decrypted_without_js() {
        let xml = std::fs::read("../../testdata/scenarios/rs-core/formats/payloads/krpano/encrypted/2013-08-09-B/tour.xml").unwrap();
        let expected = std::fs::read_to_string("../../testdata/scenarios/rs-core/formats/payloads/krpano/encrypted/2013-08-09-B/plaintext.xml").unwrap().replace("\r\n", "\n");
        let plaintext = String::from_utf8(decrypt_xml(&xml, None).unwrap()).unwrap();
        assert_eq!(
            plaintext, expected,
            "decrypted plaintext does not match expected plaintext.xml"
        );
    }

    #[test]
    fn html_script_candidates_prefer_krpano_viewer() {
        let html = r#"<html><head><script src="/assets/jquery.min.js"></script><script src='https://www.googletagmanager.com/gtag/js?id=G-TEST'></script><script data-src="ignored.js" src = "assets/tour.js?cache=1"></script></head></html>"#;
        assert_eq!(
            crate::test_support::resource(
                "http://example.com/pano/index.html",
                html.as_bytes(),
                extract_js_candidates_from_html
            )
            .first()
            .map(String::as_str),
            Some("http://example.com/pano/assets/tour.js?cache=1")
        );
    }

    #[test]
    fn sibling_uri_handles_url_and_local_paths() {
        for (base, sibling, expected) in [
            (
                "http://example.com/pano/tour.js",
                "tour.xml",
                "http://example.com/pano/tour.xml",
            ),
            (
                "http://example.com/pano/",
                "tour.xml",
                "http://example.com/pano/tour.xml",
            ),
            ("/home/user/tour.js", "tour.xml", "/home/user/tour.xml"),
            (
                "C:\\foo\\bar\\tour.js",
                "tour.xml",
                "C:\\foo\\bar\\tour.xml",
            ),
            (
                "\\\\server\\share\\tour.js",
                "tour.xml",
                "\\\\server\\share\\tour.xml",
            ),
            ("tour.js", "tour.xml", "tour.xml"),
            (
                "https://example.com",
                "tour.xml",
                "https://example.com/tour.xml",
            ),
            (
                "http://example.com",
                "tour.js",
                "http://example.com/tour.js",
            ),
            (
                "https://example.com?scene=1",
                "tour.xml",
                "https://example.com/tour.xml",
            ),
            (
                "https://example.com#section",
                "tour.xml",
                "https://example.com/tour.xml",
            ),
            (
                "https://example.com/pano/tour.js?cache=1",
                "tour.xml",
                "https://example.com/pano/tour.xml",
            ),
        ] {
            assert_eq!(sibling_uri(base, sibling), expected, "{base}");
        }
    }

    #[test]
    fn viewer_js_candidates_derived_from_xml_filename() {
        for (xml, expected) in [
            (
                "https://example.com/panos/map_core.xml",
                "https://example.com/panos/map_core.js,https://example.com/panos/tour.js,https://example.com/panos/krpano.js",
            ),
            (
                "https://example.com/tour.xml",
                "https://example.com/tour.js,https://example.com/krpano.js",
            ),
            (
                "https://example.com/panos/map_core.xml?v=1.2",
                "https://example.com/panos/map_core.js,https://example.com/panos/tour.js,https://example.com/panos/krpano.js",
            ),
        ] {
            assert_eq!(
                viewer_js_candidates_for_xml(xml).join(","),
                expected,
                "{xml}"
            );
        }
    }

    #[test]
    fn query_xml_overrides_the_viewer_default() {
        assert_eq!(
            extract_xml_from_query(
                "https://example.com/viewer/krpano.html?xml=examples%2Ftour.xml&skin=default"
            ),
            Some("examples/tour.xml".into())
        );
        assert_eq!(
            extract_xml_from_query("https://example.com/viewer/krpano.html?skin=default"),
            None
        );
    }

    #[test]
    fn viewer_pages_follow_their_declared_krpano_sources() {
        let cases: &[(&str, &[u8], &str)] = &[
            ("https://example.com/viewer/krpano.html?xml=examples/tour.xml", br#"<html><script src="krpano.js"></script><script>embedpano({xml:"krpano.xml", passQueryParameters:"xml"});</script></html>"#, "https://example.com/viewer/examples/tour.xml"),
            ("https://example.com/krpano.js", b"function embedpano(opts) { /* krpano viewer */ }", "https://example.com/tour.xml"),
            ("https://example.com/pano/index.html", br#"<base href='../viewer/'><body onload="embedpano({xml:'scenes/custom.xml'})">"#, "https://example.com/viewer/scenes/custom.xml"),
            ("https://example.com/pano/index.html", br#"<body onclick="embedpano({xml:'wrong.xml'})"><script>createPanoViewer({ xml : 'scenes/custom.xml' });</script>"#, "https://example.com/pano/scenes/custom.xml"),
            ("https://example.com/viewer.js", b"function createPanoViewer(opts) { return buildViewer(opts); }", "https://example.com/tour.xml"),
        ];
        for (input, page, next) in cases {
            let (_, requests) = crate::test_support::discover(SPEC, input, &[(page, None)]);
            assert_eq!(requests[1].uri, *next, "{input}");
        }
    }

    #[test]
    fn failed_viewer_attempts_advance_to_the_next_candidate() {
        for http_failure in [false, true] {
            let (result, requests) = viewer_failures(http_failure);
            assert!(result.is_err());
            let uris: Vec<_> = requests
                .iter()
                .map(|request| request.uri.as_str())
                .collect();
            assert!(uris.contains(&"https://example.com/pano/first.js"));
            assert!(uris.contains(&"https://example.com/pano/second.js"));
        }
    }
    fn viewer_failures(
        http_failure: bool,
    ) -> (Result<DiscoveryCatalog, DiscoveryError>, Vec<Request>) {
        use crate::model::{Error, ErrorTransport, Failure};
        crate::test_support::discover_with_responses(
            crate::core::registry_for("krpano").unwrap(),
            "https://example.com/pano/index.html",
            |uri| {
                let bytes: &[u8] = if uri.ends_with("index.html") {
                    br#"<html><script src="first.js"></script><script src="second.js"></script><script>embedpano({xml:"tour.xml"});</script></html>"#
                } else if uri.ends_with("tour.xml") {
                    b"<encrypted>not-valid-krpano-data</encrypted>"
                } else if !http_failure {
                    b"invalid viewer JavaScript"
                } else {
                    return Some(Err(Error::HttpError {
                        status: 403,
                        retry_after_ms: None,
                        preview: None,
                        transport: ErrorTransport::Direct,
                        failure: Failure::default(),
                    }));
                };
                Some(Ok((bytes.to_vec(), None)))
            },
        )
    }

    #[test]
    fn exhausted_viewer_failures_report_the_typed_cause() {
        let (result, _) = viewer_failures(true);
        let error = result.unwrap_err();
        let DiscoveryError::NoCandidateAccepted { diagnostics } = &error else {
            panic!("expected candidate diagnostics")
        };
        let diagnostic = diagnostics.iter().find(|d| d.format == "krpano").unwrap();
        assert_eq!(diagnostic.kind, RejectionKind::FetchFailed);
        let cause = diagnostic.cause.as_ref().unwrap();
        assert_eq!(
            **cause,
            crate::model::Error::HttpError {
                status: 403,
                retry_after_ms: None,
                preview: None,
                transport: crate::model::ErrorTransport::Direct,
                failure: crate::model::Failure::default(),
            }
        );
    }

    #[test]
    fn html_routes_require_format_evidence() {
        for html in [
            b"<html><script>embedpano({xml:'tour.xml'})</script></html>".as_slice(),
            b"<script>createPanoViewer({xml:'tour.xml'});</script>".as_slice(),
            b"<html><script src='krpano.js'></script></html>".as_slice(),
            b"<html><script src='tour.js'></script></html>".as_slice(),
        ] {
            assert!(HTML_RE.is_match(html));
        }
        for html in [
            b"<html><script src='jquery.min.js'></script></html>".as_slice(),
            b"<HTML><SCRIPT src='analytics.js'></SCRIPT></HTML>".as_slice(),
            b"<html><body>Hello</body></html>".as_slice(),
        ] {
            assert!(!HTML_RE.is_match(html));
        }
    }
}
