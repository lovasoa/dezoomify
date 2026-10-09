use std::sync::Arc;

use regex::bytes::Regex as BytesRegex;
use std::sync::LazyLock;
use tile_info::ImageInfo;
use url::Url;

use crate::Vec2d;
use crate::core::discovery::{
    content_matches, image_url, metadata, url_matches, url_suffix, viewer,
};
use crate::core::{
    AdaptiveSource, CatalogPlan, DeferredResource, DiscoveryCatalog, DiscoveryError,
    DiscoveryResource, DiscoveryRoute, FormatSpec, Grid, GridRequests, GridTile, ImagePlan,
    ObservationResult, ParsedResource, Request, ResolvedGrid, ResolvedLevel, TileRole, TileSpec,
    resolve_relative,
};
use crate::iiif::tile_info::TileSizeFormat;
use crate::json_utils::all_json;

#[cfg(test)]
use crate::core::DiscoveredEntry;

mod contentdm;
pub mod manifest_types;
mod micrio;
mod national_gallery;
mod onb;
mod philadelphia;
pub mod tile_info;

#[cfg(test)]
mod title_tests;

static METADATA_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    // Keep escaped keys and embedded JSON/JSON5 services eligible.
    BytesRegex::new(r"(?s-u)\{.*(?:width|items|sequences|\\)|(?:width|items|sequences|\\).*\{")
        .expect("constant IIIF metadata pattern")
});

const ROUTES: &[DiscoveryRoute] = &[
    image_url(|uri| image_request_info(uri).is_some()).resolve_metadata(|uri| {
        Ok(image_request_info(uri).expect("route matched IIIF image request"))
    }),
    viewer(url_matches(has_manifest_parameter)).resolve_metadata(manifest_parameter),
    onb::ROUTE,
    contentdm::RECORD_ROUTE,
    contentdm::METADATA_ROUTE,
    micrio::ROUTE,
    national_gallery::ROUTES[0],
    national_gallery::ROUTES[1],
    philadelphia::ROUTE,
    viewer(content_matches(&ABS_INFO_JSON_RE)).decode(follow_info_json_url),
    viewer(content_matches(&REL_INFO_JSON_RE)).decode(follow_info_json_url),
    metadata(url_suffix("/info.json")).decode(decode),
    metadata(url_suffix("/manifest.json")).decode(decode),
    metadata(content_matches(&METADATA_RE)).decode(decode),
];

/// IIIF format. See <https://iiif.io/>.
pub const SPEC: FormatSpec = FormatSpec::new("iiif", ROUTES).with_display_name("IIIF");

fn decode(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    catalog(resource.final_uri(), resource.bytes()).map(ParsedResource::Complete)
}

/// Determines the best title for an image from IIIF manifest metadata
#[must_use]
pub fn determine_title(image_info: &manifest_types::ExtractedImageInfo) -> Option<String> {
    let mut parts = Vec::new();

    if let Some(manifest_label) = &image_info.manifest_label {
        parts.push(manifest_label.as_str());
    }

    if let Some(metadata_title) = &image_info.metadata_title
        && !parts.contains(&metadata_title.as_str())
    {
        parts.push(metadata_title.as_str());
    }

    if let Some(canvas_label) = &image_info.canvas_label
        && !parts.contains(&canvas_label.as_str())
    {
        parts.push(canvas_label.as_str());
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" - "))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IIIFError {
    #[error("Invalid IIIF info.json file: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("Could not parse IIIF manifest: {description}")]
    ManifestParseError { description: String },
    #[error("Invalid IIIF tile grid: {description}")]
    GeometryError { description: String },
}

impl From<IIIFError> for DiscoveryError {
    fn from(err: IIIFError) -> Self {
        Self::InvalidMetadata(err.to_string())
    }
}

fn has_manifest_parameter(uri: &str) -> bool {
    manifest_parameter_value(uri).is_some()
}

fn manifest_parameter(uri: &str) -> Result<Request, DiscoveryError> {
    manifest_parameter_value(uri)
        .map(Request::new)
        .ok_or_else(|| DiscoveryError::InvalidMetadata("missing IIIF manifest parameter".into()))
}

fn manifest_parameter_value(uri: &str) -> Option<String> {
    let url = url::Url::parse(uri).ok()?;
    url.query_pairs()
        .find_map(|(name, value)| (name == "manifest").then(|| value.into_owned()))
        .or_else(|| {
            url.fragment().and_then(|fragment| {
                url::form_urlencoded::parse(fragment.trim_start_matches('?').as_bytes())
                    .find_map(|(name, value)| (name == "manifest").then(|| value.into_owned()))
            })
        })
        .filter(|value| !value.is_empty())
}

/// Absolute, protocol-relative, and path-relative `info.json` references,
/// e.g. `data-image-url="//img.example/iiif/item/info.json"`. Matches are
/// candidates only: the fetched payload must still parse as IIIF.
static ABS_INFO_JSON_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(
        r#"(?i)(?:https?:)?//[^\s"'<>()\[\]\\]+?/info\.json(?:[?#][^\s"'<>()\[\]\\]*)?"#,
    )
    .expect("constant absolute info.json pattern")
});
static REL_INFO_JSON_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    BytesRegex::new(r#"(?i)["'=\s(](?P<url>/?(?:[\w.-]+/)+info\.json(?:[?#][^\s"'<>()\[\]\\]*)?)"#)
        .expect("constant relative info.json pattern")
});
static IMAGE_REQUEST_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
    r"(?i)^(?P<base>https?://[^/?#]+/[^?#]+)/(?:full|square|\d+(?:,\d+){3}|pct:[\d.]+(?:,[\d.]+){3})/(?:\^?(?:max|full|\d+,\d+|\d+,|,\d+|pct:[\d.]+)|\^!?\d+,\d+)/!?\d+(?:\.\d+)?/[\w-]+\.(?:jpe?g|png|tiff?|webp|jp2|gif)(?P<query>\?[^#]*)?(?:#.*)?$",
).expect("constant IIIF image request pattern")
});

fn image_request_info(uri: &str) -> Option<Request> {
    if uri.to_ascii_lowercase().contains("?iiif=")
        && let Some((service, _)) = uri.rsplit_once("/full/")
    {
        return Some(Request::new(format!("{service}/info.json")));
    }
    let c = IMAGE_REQUEST_RE.captures(uri)?;
    Some(Request::new(format!(
        "{}/info.json{}",
        &c["base"],
        c.name("query").map_or("", |q| q.as_str())
    )))
}

#[test]
fn direct_image_request_url_maps_to_info_json() {
    let uri = "https://img.example/iiif/item.tif/0,0,256,256/256,256/0/default.jpg?v=1";
    let (_, requests) = crate::test_support::discover(SPEC, uri, &[]);
    assert_eq!(
        requests[0].uri,
        "https://img.example/iiif/item.tif/info.json?v=1"
    );
    assert!(image_request_info("https://img.example/photo.jpg").is_none());
}

/// At most this many harvested references are ranked; only the best is followed.
const MAX_HARVESTED_INFO_JSON_URLS: usize = 8;
/// Upper bound scanned before ranking, so ranking prefers `iiif` URLs even
/// on pages that mention many `info.json` references.
const MAX_SCANNED_INFO_JSON_URLS: usize = 32;

fn harvest_info_json_urls(bytes: &[u8]) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let references = ABS_INFO_JSON_RE.find_iter(bytes).chain(
        REL_INFO_JSON_RE
            .captures_iter(bytes)
            .filter_map(|captures| captures.name("url")),
    );
    for reference in references {
        let text = String::from_utf8_lossy(reference.as_bytes()).into_owned();
        if !urls.contains(&text) {
            urls.push(text);
        }
        if urls.len() >= MAX_SCANNED_INFO_JSON_URLS {
            break;
        }
    }
    urls.sort_by_key(|url| !url.to_lowercase().contains("iiif"));
    urls.truncate(MAX_HARVESTED_INFO_JSON_URLS);
    urls
}

fn follow_info_json_url(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    // Payloads that already parse as IIIF (info.json bodies, manifests)
    // keep the standard extractor; harvesting is for embedder pages.
    if let Ok(found) = catalog(resource.final_uri(), resource.bytes()) {
        return Ok(ParsedResource::Complete(found));
    }
    let base = crate::web_page::page_base(resource);
    let target = harvest_info_json_urls(resource.bytes())
        .into_iter()
        .map(|url| resolve_relative(&base, url.trim()))
        .find(|url| *url != resource.final_uri())
        .ok_or_else(|| {
            DiscoveryError::InvalidMetadata("page declares no IIIF info.json URL".into())
        })?;
    Ok(ParsedResource::Follow(Request::new(target)))
}

fn catalog(uri: &str, contents: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
    // First, try to determine what type of IIIF content this is by doing a quick parse
    // to check the "type" field without generating warnings
    if let Ok(quick_check) = serde_json::from_slice::<serde_json::Value>(contents)
        && let Some(type_value) = quick_check.get("type").or_else(|| quick_check.get("@type"))
        && let Some(type_str) = type_value.as_str()
    {
        match type_str {
            "ImageService2" | "ImageService3" | "iiif:ImageProfile" => {
                // This is clearly an Image Service info.json, try parsing it directly
                return catalog_from_info(uri, contents);
            }
            "Manifest" | "sc:Manifest" => {
                // This is clearly a manifest, try parsing it as such
                match parse_iiif_manifest_from_bytes(contents, uri) {
                    Ok(image_infos) if !image_infos.is_empty() => {
                        return catalog_from_manifest_info(image_infos, None).compile("iiif");
                    }
                    Ok(_) => {
                        // Empty image_infos, fall through to heuristic approach
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            _ => {
                // Unknown type, fall through to heuristic detection below
            }
        }
    }

    // If type detection didn't work or type is unknown, use heuristic approach
    // Check if URL suggests it's an info.json file
    if uri.ends_with("/info.json") {
        // Likely an Image Service, try parsing as info.json first
        if let Ok(catalog) = catalog_from_info(uri, contents) {
            return Ok(catalog);
        }
        // Fall through to try as manifest
    }

    // Try to parse as IIIF manifest
    let manifest_warning = manifest_type_warning(contents);
    match parse_iiif_manifest_from_bytes(contents, uri) {
        Ok(image_infos) if !image_infos.is_empty() => {
            // Successfully parsed as manifest with images
            catalog_from_manifest_info(image_infos, manifest_warning).compile("iiif")
        }
        _ => {
            // Not a manifest or failed to parse as manifest, try as info.json
            match catalog_from_info(uri, contents) {
                Ok(catalog) => Ok(catalog),
                Err(e) => Err(e),
            }
        }
    }
}

fn catalog_from_manifest_info(
    image_infos: Vec<manifest_types::ExtractedImageInfo>,
    warning: Option<String>,
) -> CatalogPlan {
    let warnings: Vec<String> = warning.into_iter().collect();
    let resources = image_infos.into_iter().map(|image_info| {
        let title = determine_title(&image_info);
        DeferredResource {
            uri: image_info.image_uri,
            title,
            warnings: warnings.clone(),
        }
    });
    CatalogPlan::deferred(resources)
}

fn catalog_from_info(url: &str, raw_info: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
    let mut levels = levels(url, raw_info)?;
    let mut warnings = Vec::new();
    for level in &mut levels {
        for warning in level.warnings.drain(..) {
            if !warnings.contains(&warning) {
                warnings.push(warning);
            }
        }
    }
    ImagePlan::new(None, levels)
        .with_warnings(warnings)
        .compile("iiif")
}

fn manifest_type_warning(contents: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<serde_json::Value>(contents).ok()?;
    let type_value = value.get("type").or_else(|| value.get("@type"))?;
    let type_name = type_value.as_str()?;
    (!matches!(
        type_name,
        "Manifest" | "sc:Manifest" | "ImageService2" | "ImageService3" | "iiif:ImageProfile"
    ))
    .then(|| format!("IIIF manifest has unexpected type '{type_name}'; attempting lenient parsing"))
}

fn levels(url: &str, raw_info: &[u8]) -> Result<Vec<ResolvedLevel>, IIIFError> {
    match serde_json::from_slice(raw_info) {
        Ok(info) => levels_from_info(url, info),
        Err(e) => {
            // Due to the very fault-tolerant way we parse iiif manifests, a single javascript
            // object with a 'width' and a 'height' field is enough to be detected as an IIIF level
            // See https://github.com/lovasoa/dezoomify-rs/issues/80
            let levels: Vec<ResolvedLevel> = all_json::<ImageInfo>(raw_info)
                .filter(ImageInfo::has_distinctive_iiif_properties)
                .map(|info| levels_from_info(url, info))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect();
            if levels.is_empty() {
                Err(e.into())
            } else {
                Ok(levels)
            }
        }
    }
}

fn levels_from_info(url: &str, mut image_info: ImageInfo) -> Result<Vec<ResolvedLevel>, IIIFError> {
    let removed_test_id = image_info.remove_test_id();
    image_info.resolve_relative_urls(url);
    let mut warnings = image_info.warnings();
    if removed_test_id {
        warnings.push("Removed probably invalid IIIF image identifier".into());
    }
    let img = Arc::new(image_info);
    let image_size = img.size();
    let tiles = img.tiles();
    let base_url: Arc<str> = service_base_url(url).into();

    let levels: Vec<_> = tiles
        .iter()
        .enumerate()
        .flat_map(|(tile_ordinal, tile_info)| {
            let tile_size = tile_info.size();
            let base_url = Arc::clone(&base_url);
            let quality = Arc::from(img.best_quality());
            let format = Arc::from(img.best_format());
            let size_format = img.preferred_size_format();
            let supports_size_upscaling = img.supports_v3_size_upscaling();
            let page_info = Arc::clone(&img);
            let warnings = warnings.clone();
            tile_info.scale_factors.iter().map(move |&scale_factor| {
                if scale_factor == 0 {
                    return Err(IIIFError::GeometryError {
                        description: "scale factor must be greater than zero".into(),
                    });
                }
                if tile_size.x == 0 || tile_size.y == 0 {
                    return Err(IIIFError::GeometryError {
                        description: "IIIF tile dimensions must be greater than zero".into(),
                    });
                }
                let scaled_tile_size = tile_size
                    .checked_mul(Vec2d::square(scale_factor))
                    .ok_or_else(|| IIIFError::GeometryError {
                        description: "scaled IIIF tile dimensions overflow u32".into(),
                    })?;
                let level_size = image_size.ceil_div(scale_factor);
                let shape = level_size.ceil_div(tile_size);
                let last_coord = Vec2d {
                    x: shape.x.saturating_sub(1),
                    y: shape.y.saturating_sub(1),
                };
                if last_coord.checked_mul(scaled_tile_size).is_none() {
                    return Err(IIIFError::GeometryError {
                        description: "scaled IIIF tile positions overflow u32".into(),
                    });
                }
                let requests = IIIFLevel {
                    scale_factor,
                    page_info: Arc::clone(&page_info),
                    base_url: Arc::clone(&base_url),
                    quality: Arc::clone(&quality),
                    format: Arc::clone(&format),
                    size_format,
                    use_size_upscaling: supports_size_upscaling && scale_factor == 1,
                    force_width_only: false,
                };
                let source = Grid::new(
                    requests.image_size(),
                    tile_size,
                    Vec2d::default(),
                    requests.clone(),
                )
                .map_err(|error| IIIFError::GeometryError {
                    description: error.to_string(),
                })?;
                let adaptive = AdaptiveSource::Iiif(IiifProbe {
                    declared: source.clone(),
                    requests,
                });
                Ok(ResolvedLevel::new(adaptive)
                    .with_title(Some(format!("IIIF level {tile_ordinal}")))
                    .with_scale_factor(Some(scale_factor))
                    .with_warnings(warnings.clone()))
            })
        })
        .collect::<Result<Vec<_>, IIIFError>>()?;
    Ok(levels)
}

#[derive(Clone)]
struct IIIFLevel {
    scale_factor: u32,
    page_info: Arc<ImageInfo>,
    base_url: Arc<str>,
    quality: Arc<str>,
    format: Arc<str>,
    size_format: TileSizeFormat,
    use_size_upscaling: bool,
    force_width_only: bool,
}

impl IIIFLevel {
    fn image_size(&self) -> Vec2d {
        self.page_info.size().ceil_div(self.scale_factor)
    }
}

impl GridRequests for IIIFLevel {
    fn request(&self, tile: GridTile) -> Request {
        let col_and_row_pos: Vec2d = tile.coord.into();
        let scaled_tile_size = tile
            .cell_size
            .checked_mul(Vec2d::square(self.scale_factor))
            .expect("IIIF scaled tile dimensions were validated");
        let xy_pos = col_and_row_pos
            .checked_mul(scaled_tile_size)
            .expect("IIIF scaled tile positions were validated");
        let scaled_tile_size = scaled_tile_size.min(self.page_info.size() - xy_pos);
        let tile_size = scaled_tile_size.ceil_div(self.scale_factor);
        let base = self
            .page_info
            .id
            .as_deref()
            .unwrap_or_else(|| self.base_url.as_ref());
        let path = format!(
            "{x},{y},{img_w},{img_h}/{tile_size}/{rotation}/{quality}.{format}",
            x = xy_pos.x,
            y = xy_pos.y,
            img_w = scaled_tile_size.x,
            img_h = scaled_tile_size.y,
            tile_size = TileSizeFormatter {
                w: tile_size.x,
                h: tile_size.y,
                format: self.size_format,
                use_size_upscaling: self.use_size_upscaling,
                force_width_only: self.force_width_only,
            },
            rotation = 0,
            quality = self.quality,
            format = self.format,
        );
        Request::new(append_tile_path(base, &path))
    }
}

#[derive(Clone, Debug)]
pub struct IiifProbe {
    pub(crate) declared: Grid,
    requests: IIIFLevel,
}

impl IiifProbe {
    #[allow(clippy::result_large_err)]
    pub(crate) async fn resolve(
        self,
        host: &impl crate::Host,
        mut remaining_probes: u32,
    ) -> Result<Option<ResolvedGrid>, crate::model::Error> {
        let tries = if self.requests.use_size_upscaling {
            2
        } else {
            1
        };
        for attempt in 0..tries {
            let mut requests = self.requests.clone();
            requests.force_width_only = attempt > 0;
            let tile = Grid::new(
                requests.image_size(),
                self.declared.tile_size(),
                Vec2d::default(),
                requests.clone(),
            )?
            .tiles_row_major()
            .next()
            .expect("IIIF grids have tiles")?;
            let result = crate::run::probe(
                host,
                TileSpec {
                    role: TileRole::probe_and_output(),
                    ..tile
                },
                &mut remaining_probes,
            )
            .await?;
            if let ObservationResult::Available { size } = result
                && size.x > 0
                && size.y > 0
            {
                return Ok(Some(ResolvedGrid {
                    grid: Grid::new(requests.image_size(), size, Vec2d::default(), requests)?,
                    previously_output: vec![Vec2d::default()],
                }));
            }
        }
        Ok(Some(ResolvedGrid {
            grid: self.declared,
            previously_output: Vec::new(),
        }))
    }
}

fn service_base_url(uri: &str) -> String {
    let Ok(mut parsed) = Url::parse(uri) else {
        return uri.replace("/info.json", "");
    };
    let path = parsed
        .path()
        .strip_suffix("/info.json")
        .unwrap_or(parsed.path())
        .to_owned();
    parsed.set_path(&path);
    parsed.to_string()
}

fn append_tile_path(uri: &str, suffix: &str) -> String {
    if let Some(uri) = append_to_iiif_query(uri, suffix) {
        return uri;
    }
    let Ok(mut parsed) = Url::parse(uri) else {
        return format!("{}/{}", uri.trim_end_matches('/'), suffix);
    };
    let path = parsed.path().trim_end_matches('/');
    parsed.set_path(&format!("{path}/{suffix}"));
    parsed.to_string()
}

fn append_to_iiif_query(uri: &str, suffix: &str) -> Option<String> {
    let query_start = uri.find('?')?;
    let fragment_start = uri[query_start..]
        .find('#')
        .map(|offset| query_start + offset);
    let query_end = fragment_start.unwrap_or(uri.len());
    let query = &uri[query_start + 1..query_end];
    let mut found = false;
    let query = query
        .split('&')
        .map(|part| {
            let Some((name, value)) = part.split_once('=') else {
                return Some(part.to_owned());
            };
            let decoded_name = url::form_urlencoded::parse(name.as_bytes())
                .next()
                .map(|(name, _)| name.into_owned())?;
            if !decoded_name.eq_ignore_ascii_case("IIIF") {
                return Some(part.to_owned());
            }
            found = true;
            let value = value
                .strip_suffix("/info.json")
                .unwrap_or(value)
                .trim_end_matches('/');
            Some(format!("{name}={value}/{suffix}"))
        })
        .collect::<Option<Vec<_>>>()?;
    found.then(|| {
        let fragment = fragment_start.map_or("", |start| &uri[start..]);
        format!("{}?{}{}", &uri[..query_start], query.join("&"), fragment)
    })
}

struct TileSizeFormatter {
    w: u32,
    h: u32,
    format: TileSizeFormat,
    use_size_upscaling: bool,
    force_width_only: bool,
}

impl std::fmt::Display for TileSizeFormatter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.use_size_upscaling && self.force_width_only {
            write!(f, "^")?;
        }
        if self.force_width_only {
            return write!(f, "{},", self.w);
        }
        match self.format {
            TileSizeFormat::WidthHeight => write!(f, "{},{}", self.w, self.h),
            TileSizeFormat::Width => write!(f, "{},", self.w),
        }
    }
}

impl std::fmt::Debug for IIIFLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let name = self
            .page_info
            .id
            .as_deref()
            .unwrap_or_else(|| self.base_url.as_ref())
            .split('/')
            .next_back()
            .and_then(|s: &str| {
                let s = s.trim();
                if s.is_empty() { None } else { Some(s) }
            })
            .unwrap_or("IIIF Image");
        write!(f, "{name}")
    }
}

/// Parses a IIIF Presentation API Manifest from byte content.
///
/// # Arguments
/// * `bytes` - The raw byte content of the manifest file.
/// * `manifest_url` - The original URL from which the manifest was fetched. This is crucial
///   for resolving any relative URLs found within the manifest.
///
/// # Returns
/// A `Result` containing a vector of `ExtractedImageInfo` if successful,
/// or an `IIIFError` if parsing fails or the content is not a valid manifest.
///
/// # Errors
///
/// Returns an error when the input is not valid JSON or cannot be parsed as a supported manifest.
pub fn parse_iiif_manifest_from_bytes(
    bytes: &[u8],
    manifest_url: &str,
) -> Result<Vec<manifest_types::ExtractedImageInfo>, IIIFError> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(IIIFError::JsonError)?;

    if is_legacy_presentation_manifest(&value) {
        parse_legacy_presentation_manifest(bytes, manifest_url)
    } else if is_presentation3_manifest(&value) {
        parse_presentation3_manifest(bytes, manifest_url)
    } else {
        parse_unknown_manifest(bytes, manifest_url)
    }
}

fn is_presentation3_manifest(value: &serde_json::Value) -> bool {
    manifest_type(value) == Some("Manifest")
        || json_context_contains(value, "iiif.io/api/presentation/3")
}

fn is_legacy_presentation_manifest(value: &serde_json::Value) -> bool {
    manifest_type(value) == Some("sc:Manifest")
        || json_context_contains(value, "iiif.io/api/presentation/2")
        || json_context_contains(value, "shared-canvas.org/ns/context")
}

fn manifest_type(value: &serde_json::Value) -> Option<&str> {
    value
        .get("type")
        .or_else(|| value.get("@type"))
        .and_then(|type_value| type_value.as_str())
}

fn json_context_contains(value: &serde_json::Value, needle: &str) -> bool {
    match value.get("@context") {
        Some(serde_json::Value::String(context)) => context.contains(needle),
        Some(serde_json::Value::Array(contexts)) => contexts.iter().any(|context| {
            context
                .as_str()
                .is_some_and(|context| context.contains(needle))
        }),
        _ => false,
    }
}

fn parse_presentation3_manifest(
    bytes: &[u8],
    manifest_url: &str,
) -> Result<Vec<manifest_types::ExtractedImageInfo>, IIIFError> {
    let manifest: manifest_types::Manifest =
        serde_json::from_slice(bytes).map_err(IIIFError::JsonError)?;

    Ok(manifest.extract_image_infos(manifest_url))
}

fn parse_legacy_presentation_manifest(
    bytes: &[u8],
    manifest_url: &str,
) -> Result<Vec<manifest_types::ExtractedImageInfo>, IIIFError> {
    let manifest: manifest_types::LegacyManifest =
        serde_json::from_slice(bytes).map_err(IIIFError::JsonError)?;

    Ok(manifest.extract_image_infos(manifest_url))
}

fn parse_unknown_manifest(
    bytes: &[u8],
    manifest_url: &str,
) -> Result<Vec<manifest_types::ExtractedImageInfo>, IIIFError> {
    match parse_presentation3_manifest(bytes, manifest_url) {
        Ok(image_infos) if !image_infos.is_empty() => Ok(image_infos),
        Ok(_) => match parse_legacy_presentation_manifest(bytes, manifest_url) {
            Ok(image_infos) if !image_infos.is_empty() => Ok(image_infos),
            _ => Ok(Vec::new()),
        },
        Err(v3_error) => match parse_legacy_presentation_manifest(bytes, manifest_url) {
            Ok(image_infos) if !image_infos.is_empty() => Ok(image_infos),
            _ => Err(v3_error),
        },
    }
}

#[test]
fn test_tiles() {
    let data = br#"{"@context": "http://iiif.io/api/image/2/context.json", "@id": "http://www.asmilano.it/fast/iipsrv.fcgi?IIIF=/opt/divenire/files/./tifs/05/36/536765.tif", "protocol": "http://iiif.io/api/image", "width": 15001, "height": 48002, "tiles": [{ "width": 512, "height": 512, "scaleFactors": [1, 2, 4, 8, 16, 32, 64, 128] }], "profile": ["http://iiif.io/api/image/2/level1.json", { "formats": ["jpg"], "qualities": ["native", "color", "gray"], "supports": ["regionByPct", "sizeByForcedWh", "sizeByWh", "sizeAboveFull", "rotationBy90s", "mirroring", "gray"] }]}"#;
    let levels = levels("test.com", data).unwrap();
    let tiles = tile_urls(level_with_scale(&levels, 64)).join(",");
    assert_eq!(
        tiles,
        "http://www.asmilano.it/fast/iipsrv.fcgi?IIIF=/opt/divenire/files/./tifs/05/36/536765.tif/0,0,15001,32768/235,512/0/default.jpg,http://www.asmilano.it/fast/iipsrv.fcgi?IIIF=/opt/divenire/files/./tifs/05/36/536765.tif/0,32768,15001,15234/235,239/0/default.jpg"
    );
}

#[test]
fn test_tiles_max_area_filter() {
    // Predefined tile size (1024x1024) is over maxArea (262144 = 512x512).
    // See https://github.com/lovasoa/dezoomify-rs/issues/107#issuecomment-862225501
    let data =
        br#"{"width": 1024, "height": 1024, "tiles": [{ "width": 1024, "scaleFactors": [1] }], "profile": [{ "maxArea": 262144 }]}"#;
    let levels = levels("http://ophir.dev/info.json", data).unwrap();
    let tiles = tile_urls(level_with_scale(&levels, 1)).join(",");
    assert_eq!(
        tiles,
        "http://ophir.dev/0,0,512,512/512,512/0/default.jpg,http://ophir.dev/512,0,512,512/512,512/0/default.jpg,http://ophir.dev/0,512,512,512/512,512/0/default.jpg,http://ophir.dev/512,512,512,512/512,512/0/default.jpg"
    );
}

#[test]
fn tile_paths_follow_the_iiif_image_identifier() {
    let plain =
        br#"{"type": "ImageService3", "width": 512, "height": 512, "tiles": [{ "width": 512, "scaleFactors": [1] }]}"#;
    let cases: &[(&str, &[u8], &str)] = &[
        (
            // A missing identifier falls back to the request URL.
            "http://test.com/info.json",
            br#"{"width": 600, "height": 350}"#,
            "http://test.com/0,0,512,350/512,350/0/default.jpg,http://test.com/512,0,88,350/88,350/0/default.jpg",
        ),
        (
            "https://example.com/image/info.json?token=secret",
            plain,
            "https://example.com/image/0,0,512,512/512,512/0/default.jpg?token=secret",
        ),
        (
            "https://example.com/info.json",
            br#"{"type": "ImageService3", "id": "https://images.example.test/iipsrv.fcgi?IIIF=/images/item.tif&download", "width": 512, "height": 512, "tiles": [{ "width": 512, "scaleFactors": [1] }]}"#,
            "https://images.example.test/iipsrv.fcgi?IIIF=/images/item.tif/0,0,512,512/512,512/0/default.jpg&download",
        ),
        (
            "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json",
            plain,
            "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/0,0,512,512/512,512/0/default.jpg",
        ),
    ];
    for (uri, data, expected) in cases {
        let levels = levels(uri, data).unwrap();
        assert_eq!(
            tile_urls(level_with_scale(&levels, 1)).join(","),
            *expected,
            "{uri}"
        );
    }
}

#[test]
fn overflowing_scaled_tile_geometry_is_rejected() {
    let data = format!(
        r#"{{
          "type": "ImageService3",
          "width": {},
          "height": {},
          "tiles": [{{ "width": {}, "scaleFactors": [{}] }}]
        }}"#,
        u32::MAX,
        u32::MAX,
        u32::MAX,
        u32::MAX
    );
    assert!(levels("https://example.com/info.json", data.as_bytes()).is_err());
}

#[test]
fn test_false_positive() {
    let data = br#"
    var mainImage={
        type:       "zoomifytileservice",
        width:      62596,
        height:     38467,
        tilesUrl:   "./ORIONFINAL/"
    };
    "#;
    let res = levels("https://orion2020v5b.spaceforeverybody.com/", data);
    assert!(
        res.is_err(),
        "openseadragon zoomify image should not be misdetected"
    );
}

#[test]
fn test_qualities() {
    let data = br#"{"@context": "http://library.stanford.edu/iiif/image-api/1.1/context.json", "@id": "https://images.britishart.yale.edu/iiif/fd470c3e-ead0-4878-ac97-d63295753f82", "tile_height": 1024, "tile_width": 1024, "width": 5156, "height": 3816, "profile": "http://library.stanford.edu/iiif/image-api/1.1/compliance.html#level0", "qualities": ["native", "color", "bitonal", "gray", "zorglub"], "formats": ["png", "zorglub"], "scale_factors": [10]}"#;
    let levels = levels("test.com", data).unwrap();
    let level = level_with_scale(&levels, 10);
    assert_eq!(level.source.image_size(), Some(Vec2d { x: 516, y: 382 })); // ceil(5156/10), ceil(3816/10)
    // tile_width and tile_height are not used from profile here but from image_info.tile_w/h
    assert_eq!(
        tile_urls(level).join(","),
        "https://images.britishart.yale.edu/iiif/fd470c3e-ead0-4878-ac97-d63295753f82/0,0,5156,3816/516,382/0/native.png"
    );
}

#[cfg(test)]
fn level_with_scale(levels: &[ResolvedLevel], scale_factor: u32) -> &ResolvedLevel {
    levels
        .iter()
        .find(|level| level.scale_factor == Some(scale_factor))
        .expect("expected IIIF scale factor")
}

#[cfg(test)]
fn tile_urls(level: &ResolvedLevel) -> Vec<String> {
    crate::test_support::tile_urls(level).expect("IIIF levels have declared grids")
}

#[test]
fn discovery_requests_metadata_then_returns_normalized_replayable_levels() {
    let (result, requests) = crate::test_support::discover(
        SPEC,
        "https://example.com/image/info.json",
        &[(
            br#"{"type":"ImageService3", "id":"https://images.example/item", "width":1000, "height":1500, "tiles":[{"width":512,"height":512,"scaleFactors":[1,2,4]}]}"#,
            None,
        )],
    );
    let catalog = result.unwrap();
    assert_eq!(requests.len(), 1);

    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("info.json must be ready, not deferred");
    };
    let areas: Vec<_> = image
        .levels
        .iter()
        .map(|level| level.source.image_size().unwrap().area())
        .collect();
    assert!(areas.windows(2).all(|pair| pair[0] <= pair[1]));
    let level = level_with_scale(&image.levels, 1);
    let crate::core::TileSource::Adaptive(source) = &level.source else {
        panic!("IIIF tile geometry is adaptive");
    };
    let plan = source.declared_grid().expect("declared IIIF grid");
    let first = plan.tiles_row_major().next().unwrap().unwrap();
    assert_eq!(
        (first.ordinal, first.request.header("Referer")),
        (
            0,
            Some("https://images.example/item/0,0,512,512/512,512/0/default.jpg")
        )
    );
}

#[test]
fn page_with_embedded_info_json_url_is_followed() {
    let (result, requests) = crate::test_support::discover(
        SPEC,
        "https://viewer.example/lots/1/images/1",
        &[
            (
                br#"<div id="zoom-viewer" data-image-url="//img.viewer.example/iiif/Online/2510/br_item.tif/info.json"></div>"#,
                None,
            ),
            (
                br#"{"type":"ImageService3", "id":"https://img.viewer.example/iiif/Online/2510/br_item.tif", "width":1000, "height":1500, "tiles":[{"width":256,"height":256,"scaleFactors":[1,2]}]}"#,
                None,
            ),
        ],
    );
    let catalog = result.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].uri,
        "https://img.viewer.example/iiif/Online/2510/br_item.tif/info.json"
    );

    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("followed info.json must be ready");
    };
    assert_eq!(image.levels.len(), 2);
    let tiles = tile_urls(level_with_scale(&image.levels, 1));
    assert!(tiles[0].starts_with("https://img.viewer.example/iiif/Online/2510/br_item.tif/"));
}

#[test]
fn harvest_prefers_iiif_candidates_and_resolves_relative_urls() {
    let urls = harvest_info_json_urls(
        br"see /docs/info.json and //cdn.example/iiif/item/info.json and ./local/info.json",
    );
    assert_eq!(
        urls.join(","),
        "//cdn.example/iiif/item/info.json,/docs/info.json,./local/info.json"
    );
    assert_eq!(
        resolve_relative("https://museum.example/exhibit/page", "./local/info.json"),
        "https://museum.example/exhibit/local/info.json"
    );
}

#[test]
fn direct_info_json_bodies_are_not_harvested() {
    let (result, requests) = crate::test_support::discover(
        SPEC,
        "https://images.example/item/info.json",
        &[(
            br#"{"type":"ImageService3", "id":"https://images.example/item/info.json", "width":512, "height":512, "tiles":[{"width":256,"scaleFactors":[1]}]}"#,
            None,
        )],
    );
    let catalog = result.unwrap();
    assert_eq!(requests.len(), 1);

    assert_eq!(catalog.len(), 1);
}

#[cfg(test)]
mod manifest_parsing_tests {
    use super::*;

    fn legacy_manifest_data() -> &'static [u8] {
        r#"{"@context":"http://iiif.io/api/presentation/2/context.json","@type":"sc:Manifest","label":"Legacy Book","sequences":[{"canvases":[{"label":"Page 1","images":[{"resource":{"@type":"dctypes:Image","@id":"https://example.com/iiif/page1/full/843,/0/default.jpg","service":{"@id":"https://example.com/iiif/page1"}}}]}]}]}"#
            .as_bytes()
    }

    #[test]
    fn test_parse_simple_manifest_from_bytes() {
        let manifest_url = "https://example.com/manifest.json";
        let json_data = r#"{"@context": "http://iiif.io/api/presentation/3/context.json", "id": "https://example.org/iiif/book1/manifest", "type": "Manifest", "label": {"en": ["Book Example"]}, "items": [{"id": "canvas1", "type": "Canvas", "label": {"en": ["Page 1"]}, "items": [{"id": "anno_page1", "type": "AnnotationPage", "items": [{"id": "anno1", "type": "Annotation", "motivation": "painting", "body": {"id": "http://example.images/page1_img_direct.jpg", "type": "Image", "service": [{"id": "svc/page1_svc", "type": "ImageService2"}]}}]}]}]}"#;
        let infos = parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url).unwrap();
        assert_eq!(infos.len(), 1);
        let info = &infos[0];
        assert_eq!(
            info.image_uri,
            "https://example.com/svc/page1_svc/info.json"
        ); // Resolved
        assert_eq!(info.manifest_label.as_deref(), Some("Book Example"));
        assert_eq!(info.metadata_title, None);
        assert_eq!(info.canvas_label.as_deref(), Some("Page 1"));
        assert_eq!(info.canvas_index, 0);
    }

    #[test]
    fn test_parse_manifest_with_relative_paths_from_bytes() {
        let manifest_url = "https://library.example.edu/collection/item123/manifest.json";
        let json_data = r#"{"id": "relative-manifest", "type": "Manifest", "label": {"en": ["RelPath Test"]}, "items": [
          {"id": "c1", "type": "Canvas", "label": {"en": ["C1 Rel Svc"]}, "items": [{"id": "ap1", "type": "AnnotationPage", "items": [{"id": "a1", "type": "Annotation", "motivation": "painting", "body": {"id": "../images/image1.jpg", "type": "Image", "service": [{"id": "../services/image1_svc", "type": "ImageService3"}]}}]}]},
          {"id": "c2", "type": "Canvas", "label": {"en": ["C2 Abs Path Svc"]}, "items": [{"id": "ap2", "type": "AnnotationPage", "items": [{"id": "a2", "type": "Annotation", "motivation": "painting", "body": {"id": "/img/abs_image2.png", "type": "Image", "service": [{"id": "/iiif-services/abs_image2_svc", "type": "ImageService2"}]}}]}]},
          {"id": "c3", "type": "Canvas", "label": {"en": ["C3 Direct Rel Img"]}, "items": [{"id": "ap3", "type": "AnnotationPage", "items": [{"id": "a3", "type": "Annotation", "motivation": "painting", "body": {"id": "images/cover_art.jpeg", "type": "Image"}}]}]}
        ]}"#;

        let infos = parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url).unwrap();
        let uris: Vec<_> = infos.iter().map(|info| info.image_uri.as_str()).collect();
        assert_eq!(
            uris,
            [
                "https://library.example.edu/collection/services/image1_svc/info.json",
                "https://library.example.edu/iiif-services/abs_image2_svc/info.json",
                "https://library.example.edu/collection/item123/images/cover_art.jpeg",
            ]
        );
        assert_eq!(infos[0].manifest_label, Some("RelPath Test".to_string()));
        let canvases: Vec<_> = infos
            .iter()
            .map(|info| info.canvas_label.as_deref())
            .collect();
        assert_eq!(
            canvases,
            [
                Some("C1 Rel Svc"),
                Some("C2 Abs Path Svc"),
                Some("C3 Direct Rel Img")
            ]
        );
    }

    #[test]
    fn legacy_manifests_parse_and_label_images() {
        let infos = parse_iiif_manifest_from_bytes(
            legacy_manifest_data(),
            "https://api.artic.edu/api/v1/artworks/103887/manifest.json",
        )
        .unwrap();
        assert_eq!(infos.len(), 1);
        assert_eq!(
            infos[0].image_uri,
            "https://example.com/iiif/page1/info.json"
        );

        let catalog = catalog("https://example.com/manifest.json", legacy_manifest_data()).unwrap();
        let [DiscoveredEntry::Deferred(image)] = catalog.entries() else {
            panic!("manifest should produce one deferred image");
        };
        assert_eq!(
            (image.uri.as_str(), image.title.as_deref()),
            (
                "https://example.com/iiif/page1/info.json",
                Some("Legacy Book - Page 1")
            )
        );
    }

    #[test]
    fn test_parse_invalid_json_manifest() {
        let manifest_url = "https://example.com/invalid.json";
        let json_data = r#"{ "id": "test", "type": "Manifest", items: [ -- broken json -- ] }"#;
        assert!(matches!(
            parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url),
            Err(IIIFError::JsonError(_))
        ));
    }

    #[test]
    fn test_parse_json_not_a_manifest_type() {
        let manifest_url = "https://example.com/not_a_manifest.json";
        let json_data = r#"{"id": "test", "type": "NotAManifest", "items": [{"id":"canvas","type":"Canvas","items":[{"items":[{"motivation":"painting","body":{"id":"image.jpg","type":"Image","service":[{"id":"https://example.com/iiif/page1","type":"ImageService3"}]}}]}]}]}"#;
        // The parser remains lenient, while the application-facing catalog carries the warning.
        // The function itself should succeed if the structure is parsable into Manifest.
        let infos = parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url).unwrap();
        assert_eq!(infos.len(), 1);

        let catalog = catalog(manifest_url, json_data.as_bytes()).unwrap();
        let [DiscoveredEntry::Deferred(image)] = catalog.entries() else {
            panic!("lenient manifest parsing should produce one deferred image");
        };
        assert_eq!(
            image.warnings,
            ["IIIF manifest has unexpected type 'NotAManifest'; attempting lenient parsing"]
        );
    }

    #[test]
    fn test_images_with_manifest() {
        let manifest_data = r#"{"@context": "http://iiif.io/api/presentation/3/context.json", "id": "https://example.org/iiif/book1/manifest", "type": "Manifest", "label": {"en": ["Test Book"]}, "items": [{"id": "canvas1", "type": "Canvas", "label": {"en": ["Page 1"]}, "items": [{"id": "anno_page1", "type": "AnnotationPage", "items": [{"id": "anno1", "type": "Annotation", "motivation": "painting", "body": {"id": "image.jpg", "type": "Image", "service": [{"id": "https://example.com/iiif/page1", "type": "ImageService3"}]}}]}]}]}"#
            .as_bytes();

        let catalog = catalog("https://example.com/manifest.json", manifest_data).unwrap();
        let [DiscoveredEntry::Deferred(image)] = catalog.entries() else {
            panic!("manifest should produce one deferred image");
        };
        assert_eq!(image.uri, "https://example.com/iiif/page1/info.json");
        assert_eq!(image.title.as_deref(), Some("Test Book - Page 1"));
    }

    #[test]
    fn test_images_with_info_json() {
        let info_data = r#"{"@context": "http://iiif.io/api/image/2/context.json", "@id": "https://example.com/image", "protocol": "http://iiif.io/api/image", "width": 1000, "height": 1500, "tiles": [{"width": 512, "height": 512, "scaleFactors": [1, 2, 4]}]}"#
            .as_bytes();

        let catalog = catalog("https://example.com/image/info.json", info_data).unwrap();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("info.json should produce one ready image");
        };
        assert_eq!(image.title, None);
        assert_eq!(image.levels.len(), 3);
    }

    #[test]
    fn info_json_warnings_are_attached_to_the_image() {
        let cases: &[(&[u8], &str)] = &[
            (
                br#"{"@id": "https://www.example.org/image", "width": 1000, "height": 1500, "tiles": [{"width": 512, "scaleFactors": [1]}]}"#,
                "Removed probably invalid IIIF image identifier",
            ),
            (
                br#"{"width": 1000, "height": 1500, "profile": ["https://example.com/unknown-profile"], "tiles": [{"width": 512, "scaleFactors": [1]}]}"#,
                "Unknown IIIF profile reference 'https://example.com/unknown-profile'; using default capabilities",
            ),
        ];
        for (info_data, warning) in cases {
            let catalog = catalog("https://example.com/image/info.json", info_data).unwrap();
            let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
                panic!("info.json should produce one ready image");
            };
            assert_eq!(image.warnings, [*warning]);
        }
    }
}
