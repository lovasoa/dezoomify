//! Pure discovery for Picturae Memorix/TopViewer images.

use std::sync::{Arc, LazyLock};

use regex::{Regex, bytes::Regex as BytesRegex};
use serde_json::Value;
use url::Url;

use crate::Vec2d;
use crate::core::discovery::{content_matches, css, metadata, url_matches, viewer};
use crate::core::{
    DiscoveryError, DiscoveryResource, DiscoveryRoute, FormatSpec, ImagePlan, ParsedResource,
    Request, ResolvedLevel, resolve_url_template,
};

static THUMBNAIL_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r"(?i)images\.memorix\.nl/(?P<server>[^/]+)/thumb/[^/]+/(?P<image>.*?)\.jpg")
        .expect("constant TopViewer thumbnail pattern")
});
static DETAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/detail/([a-z0-9-]+)/media/([a-z0-9-]+)")
        .expect("constant TopViewer detail pattern")
});
static METADATA_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#""topviews""#).expect("constant TopViewer metadata pattern")
});

const ROUTES: &[DiscoveryRoute] = &[
    viewer(url_matches(is_known_detail_url)).resolve_metadata(known_detail_url),
    viewer(css("pic-mediabank")).decode(follow_mediabank),
    DiscoveryRoute::regex_link(
        &THUMBNAIL_RE,
        "https://images.memorix.nl/$server/topviewjson/memorix/$image",
    ),
    metadata(url_matches(is_media_api)).decode(follow_media),
    metadata(content_matches(&METADATA_RE)).decode(decode),
];

/// Institution URL prefixes and their Memorix image servers. Institution
/// mapping adapted from VDK/Dememorixer's beeldbanken.json (GPL-2.0-or-later
/// data, compatible with this crate's GPL-3.0-only grant via its or-later
/// clause): <https://github.com/VDK/Dememorixer/blob/master/beeldbanken.json>
const MEMORIX_SITES: &[(&str, &str)] = &[
    ("beeldbankgroningen.nl/beelden/", "gra"),
    ("salha.nl/bronnen/fotos-en-films/foto-s/", "sha"),
    ("archief.zaanstad.nl/mediabank/zoek-in-de-beeldbank/", "zaa"),
    ("erfgoedcentrumzutphen.nl/onderzoeken/beeldbank/", "szu"),
    ("noord-hollandsarchief.nl/beelden/beeldbank/", "ranh"),
];

fn known_detail_target(uri: &str) -> Option<String> {
    let lower = uri.to_lowercase();
    let server = MEMORIX_SITES
        .iter()
        .find(|(prefix, _)| lower.contains(prefix))
        .map(|(_, server)| server)?;
    let captures = DETAIL_RE.captures(uri)?;
    let record = captures.get(1)?.as_str();
    let media = captures.get(2)?.as_str();
    (record.len() >= 32 && record.len() <= 36 && media.len() == 36)
        .then(|| format!("https://images.memorix.nl/{server}/topviewjson/memorix/{media}"))
}

fn is_known_detail_url(uri: &str) -> bool {
    known_detail_target(uri).is_some()
}

fn known_detail_url(uri: &str) -> Result<Request, DiscoveryError> {
    known_detail_target(uri)
        .map(Request::new)
        .ok_or_else(|| DiscoveryError::InvalidMetadata("not a known Memorix detail URL".into()))
}

pub const SPEC: FormatSpec = FormatSpec::new("topviewer", ROUTES).with_display_name("TopViewer");

fn follow_mediabank(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let tag = resource.element()?;
    let api_key = tag.required("data-api-key")?.to_owned();
    let api_reference = tag.required("data-api-url")?;
    let entities = tag.attribute("data-entities").map(str::to_owned);
    let page = Url::parse(resource.final_uri())
        .map_err(|_| DiscoveryError::InvalidMetadata("invalid TopViewer page URL".into()))?;
    let detail = DETAIL_RE
        .captures(resource.final_uri())
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_owned());
    let mut api = page
        .join(api_reference)
        .map_err(|_| DiscoveryError::InvalidMetadata("invalid TopViewer API URL".into()))?;
    let mut path = api.path().trim_end_matches('/').to_owned();
    path.push_str("/media");
    if let Some(detail) = &detail {
        path.push('/');
        path.push_str(detail);
    }
    api.set_path(&path);

    let mut parameters: Vec<(String, String)> = api
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .filter(|(name, _)| !matches!(name.as_str(), "apiKey" | "entities[0]" | "rows"))
        .collect();
    if detail.is_none() {
        for name in ["q", "page", "fq[]", "sort"] {
            parameters.extend(
                page.query_pairs()
                    .filter(|(candidate, _)| candidate == name)
                    .map(|(name, value)| (name.into_owned(), value.into_owned())),
            );
        }
        parameters.push(("rows".into(), "1".into()));
    }
    parameters.push(("apiKey".into(), api_key));
    if let Some(entities) = entities {
        parameters.push(("entities[0]".into(), entities));
    }
    api.set_query(None);
    {
        let mut query = api.query_pairs_mut();
        for (name, value) in parameters {
            query.append_pair(&name, &value);
        }
    }
    Ok(ParsedResource::Follow(Request::new(api.to_string())))
}

fn is_media_api(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| {
        let path = url.path().trim_end_matches('/');
        path.ends_with("/media") || (path.contains("/media/") && url.query().is_some())
    })
}

fn follow_media(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let context = resource.context();
    let value: Value = serde_json::from_slice(resource.bytes()).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!(
            "unable to parse TopViewer media response: {error}"
        ))
    })?;
    let wanted = context.resources().rev().find_map(|page| {
        DETAIL_RE
            .captures(page.final_uri())
            .and_then(|captures| captures.get(2))
            .map(|value| value.as_str().to_owned())
    });
    let asset = value
        .get("media")
        .and_then(Value::as_array)
        .and_then(|media| media.first())
        .and_then(|media| media.get("asset"))
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|asset| {
                wanted
                    .as_deref()
                    .is_none_or(|wanted| asset.get("uuid").and_then(Value::as_str) == Some(wanted))
                    && asset.get("topview").and_then(Value::as_str).is_some()
            })
        })
        .and_then(|asset| asset.get("topview"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("no zoomable image found in TopViewer response".into())
        })?;
    Ok(resource.follow_relative(asset))
}

fn decode(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let (url, bytes) = (resource.final_uri(), resource.bytes());
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("unable to parse TopViewer metadata: {error}"))
    })?;
    let view = value
        .get("topviews")
        .and_then(Value::as_array)
        .and_then(|views| views.first())
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("TopViewer metadata has no topviews".into())
        })?;
    let config = value
        .get("config")
        .and_then(Value::as_object)
        .and_then(|config| config.get("tileurl_v2"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("TopViewer metadata has no tile URL template".into())
        })?;
    let width = number(view, "width")?;
    let height = number(view, "height")?;
    let tile_size = number(view, "tileWidth")?;
    let layers = view
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("TopViewer metadata has no layers".into())
        })?;
    let layer = layers
        .iter()
        .max_by_key(|layer| layer.get("width").and_then(Value::as_u64).unwrap_or(0))
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("TopViewer metadata has no usable layer".into())
        })?;
    let first_tile = number(layer, "starttile")?;
    let columns = number(layer, "cols")?;
    let filepath = view.get("filepath").and_then(Value::as_str);
    let template = resolve_url_template(url, config)
        .replace("{file}", filepath.unwrap_or("image"))
        .replace("{extension}", "jpg");
    let template: Arc<str> = template.into();
    let level = ResolvedLevel::grid(
        Vec2d {
            x: width,
            y: height,
        },
        Vec2d::square(tile_size),
        move |tile| {
            let tile_number = u64::from(first_tile)
                + u64::from(tile.coord.column)
                + u64::from(tile.coord.row) * u64::from(columns);
            Request::new(template.replace("{tile}", &tile_number.to_string()))
        },
    )?;
    Ok(ParsedResource::Image(ImagePlan::new(
        filepath.and_then(image_title),
        vec![level],
    )))
}

fn image_title(filepath: &str) -> Option<String> {
    let file = filepath.rsplit(['/', '\\']).next()?;
    (!file.is_empty()).then(|| file.to_owned())
}

fn number(value: &Value, name: &str) -> Result<u32, DiscoveryError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .filter(|number| *number > 0)
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata(format!("TopViewer metadata has invalid {name}"))
        })
}
