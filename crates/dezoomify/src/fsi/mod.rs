//! Pure discovery for FSI Server (Neptune Labs) images.

use std::sync::LazyLock;

use regex::{Regex, bytes::Regex as BytesRegex};

use crate::Vec2d;
use crate::core::discovery::{css, metadata, url_matches, viewer};
use crate::core::{
    DiscoveryError, DiscoveryResource, DiscoveryRoute, FormatSpec, ImagePlan, ParsedResource,
    Request, ResolvedLevel, image_title,
};

static SOURCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[?&])source=([^&#]+)").expect("constant FSI source pattern")
});
static SERVER_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?i)(?P<server>[^\s\"']*/server[^\s\"']*[?&](?:amp;)?source=[^&#\s\"']+[^\s\"']*)"#,
    )
    .expect("constant FSI server pattern")
});
const ROUTES: &[DiscoveryRoute] = &[
    metadata(url_matches(is_server_url)).resolve_metadata(metadata_url),
    viewer(css("[src*=\"/server\"][src*=\"source=\" i]")).follow_attribute("src"),
    viewer(css("[href*=\"/server\"][href*=\"source=\" i]")).follow_attribute("href"),
    DiscoveryRoute::regex_link(&SERVER_RE, "$server"),
    metadata(url_matches(|uri| SOURCE_RE.is_match(uri))).decode(decode),
];

pub const SPEC: FormatSpec = FormatSpec::new("fsi", ROUTES)
    .with_display_name("FSI")
    .html_queries(&["property[width][value]", "property[height][value]"]);

fn is_server_url(uri: &str) -> bool {
    uri.split_once('?').is_some_and(|(path, query)| {
        path.trim_end_matches('/').ends_with("/server") && SOURCE_RE.is_match(query)
    })
}

fn metadata_url(uri: &str) -> Result<Request, DiscoveryError> {
    let source = SOURCE_RE
        .captures(uri)
        .and_then(|captures| captures.get(1))
        .ok_or_else(|| DiscoveryError::InvalidMetadata("FSI URL has no source parameter".into()))?;
    let origin = uri.split_once('?').map_or(uri, |(origin, _)| origin);
    Ok(Request::new(format!(
        "{origin}?type=info&source={}",
        source.as_str()
    )))
}

fn decode(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let url = resource.final_uri();
    let dimension = |selector| {
        resource
            .select(selector)
            .next()
            .ok_or_else(|| {
                DiscoveryError::InvalidMetadata(format!("FSI metadata has no {selector}"))
            })?
            .positive_u32("value")
    };
    let width = dimension("property[width][value]")?;
    let height = dimension("property[height][value]")?;
    let source = SOURCE_RE
        .captures(url)
        .and_then(|captures| captures.get(1))
        .ok_or_else(|| DiscoveryError::InvalidMetadata("FSI metadata URL has no source".into()))?
        .as_str()
        .to_owned();
    let origin = url
        .split_once('?')
        .map_or(url, |(origin, _)| origin)
        .to_owned();
    let title = image_title(&source);
    let level = ResolvedLevel::grid(
        Vec2d {
            x: width,
            y: height,
        },
        Vec2d::square(512),
        move |tile| {
            let position = Vec2d {
                x: tile.coord.column * 512,
                y: tile.coord.row * 512,
            };
            let size = Vec2d {
                x: 512.min(width - position.x),
                y: 512.min(height - position.y),
            };
            Request::new(format!(
                "{origin}?type=image&source={source}&width={}&height={}&rect={},{},{},{}",
                size.x,
                size.y,
                ratio(position.x, width),
                ratio(position.y, height),
                ratio(size.x, width),
                ratio(size.y, height),
            ))
        },
    )?;
    Ok(ParsedResource::Image(ImagePlan::new(title, vec![level])))
}

fn ratio(numerator: u32, denominator: u32) -> f64 {
    f64::from(numerator) / f64::from(denominator)
}
