use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::Vec2d;
use crate::core::resolve_relative;

#[derive(Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageInfo {
    #[serde(rename = "@context", skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Value>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    #[serde(alias = "@type")]
    pub iiif_type: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<Profile>,
    #[serde(rename = "@id", alias = "id", skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    // Image API 1.0 uses an unencoded identifier, not a service URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    pub width: u32,
    pub height: u32,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualities: Option<Vec<String>>,

    #[serde(alias = "preferredFormats", skip_serializing_if = "Option::is_none")]
    pub formats: Option<Vec<String>>,

    // Used in IIIF version 3:
    #[serde(rename = "extraFeatures", skip_serializing_if = "Option::is_none")]
    pub extra_features: Option<Vec<String>>,

    // Used in IIIF version 2 :
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tiles: Option<Vec<TileInfo>>,

    // Used in IIIF version 1 :
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_factors: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_height: Option<u32>,
}

// Image qualities, from least favorite to favorite
static QUALITY_ORDER: [&str; 5] = ["bitonal", "gray", "color", "native", "default"];

static TEST_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^https?://(?:(www\.)?example\.|localhost(?::\d+)?(?:[/?#]|$)|10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(?:[/?#]|$)|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?::\d+)?(?:[/?#]|$)|192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?(?:[/?#]|$))",
    )
    .unwrap()
});
static EXPLICIT_PORT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https?://(?:\[[^\]]+\]|[^/?#:]+):(\d+)(?:[/?#]|$)").unwrap());

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TileSizeFormat {
    WidthHeight,
    Width,
}

impl ImageInfo {
    #[must_use]
    pub fn size(&self) -> Vec2d {
        Vec2d {
            x: self.width,
            y: self.height,
        }
    }

    fn profile_info(&self) -> Cow<'_, ProfileInfo> {
        self.profile
            .as_ref()
            .map(|p| p.profile_info())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn best_quality(&self) -> String {
        let pinfo = self.profile_info();
        self.qualities
            .iter()
            .flat_map(|v| v.iter())
            .chain(pinfo.qualities.iter().flat_map(|x| x.iter()))
            .max_by_key(|&s| QUALITY_ORDER.iter().position(|&x| x == s))
            .cloned()
            .unwrap_or_else(|| {
                if self.iiif_type.as_ref().is_some_and(|value| {
                    json_ld_matches(value, |value| image_service_version(value) == Some(1))
                }) || (self.identifier.is_some()
                    && self.iiif_type.is_none()
                    && self.context.is_none()
                    && self.protocol.is_none())
                    || self.context.as_ref().is_some_and(|context| {
                        json_ld_matches(context, |value| {
                            matches!(
                                without_scheme(value),
                                "library.stanford.edu/iiif/image-api/1.1/context.json"
                                    | "iiif.io/api/image/1/context.json"
                            )
                        })
                    })
                {
                    "native".into()
                } else {
                    "default".into()
                }
            })
    }

    /// Best tile format, matching the deployed web behavior: prefer `png`
    /// when the metadata declares it, else the first declared format, else
    /// `jpg`. Profile-advertised formats are not consulted.
    #[must_use]
    pub fn best_format(&self) -> String {
        match self.formats.as_deref().unwrap_or(&[]) {
            [] => "jpg".into(),
            declared if declared.iter().any(|f| f == "png") => "png".into(),
            declared => declared[0].clone(),
        }
    }

    #[must_use]
    pub fn preferred_size_format(&self) -> TileSizeFormat {
        let pinfo = self.profile_info();
        let s: HashSet<&str> = pinfo
            .supports
            .iter()
            .flat_map(|x| x.iter())
            .map(std::string::String::as_str)
            .collect();
        if s.contains("sizeByW") && !s.contains("sizeByWh") {
            TileSizeFormat::Width
        } else {
            TileSizeFormat::WidthHeight
        }
    }

    pub(super) fn supports_custom_size(&self) -> bool {
        self.profile_info()
            .supports
            .iter()
            .flatten()
            .any(|feature| matches!(feature.as_str(), "sizeByW" | "sizeByWh"))
    }

    #[must_use]
    pub fn supports_v3_size_upscaling(&self) -> bool {
        self.iiif_type.as_ref().is_some_and(|value| {
            json_ld_matches(value, |value| image_service_version(value) == Some(3))
        }) && self
            .extra_features
            .as_ref()
            .is_some_and(|features| features.iter().any(|feature| feature == "sizeUpscaling"))
    }

    #[must_use]
    pub fn tiles(&self) -> Vec<TileInfo> {
        let profile_info = self.profile_info();
        let mut tiles: Vec<_> = self
            .tiles
            .as_ref()
            .map(|v| {
                v.iter()
                    .filter_map(|info| {
                        if profile_info.tile_size_fits(info.size()) {
                            Some(info.clone())
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        // If no preset tile size covers the full-resolution image, add a new one
        if !tiles.iter().any(|t| t.scale_factors.contains(&1)) {
            let mut info = TileInfo::default();
            // Some services report the full image dimensions as their tile size.
            if let Some(width) = self
                .tile_width
                .filter(|&width| width > 0 && width < self.width)
            {
                info.width = width;
            }
            if let Some(height) = self
                .tile_height
                .filter(|&height| height > 0 && height < self.height)
            {
                info.height = Some(height);
            }
            let cropped_size = profile_info.crop_tile_size(info.size());
            info.width = cropped_size.x;
            info.height = Some(cropped_size.y);
            if let Some(scale_factors) = &self.scale_factors {
                info.scale_factors.clone_from(scale_factors);
            }
            tiles.push(info);
        }
        tiles
    }

    pub(super) fn has_presentation_signature(&self) -> bool {
        self.iiif_type.as_ref().is_some_and(|value| {
            json_ld_matches(value, |value| {
                matches!(value, "Manifest" | "sc:Manifest" | "Canvas" | "sc:Canvas")
            })
        }) || self.context.as_ref().is_some_and(|value| {
            json_ld_matches(value, |value| {
                matches!(
                    without_scheme(value),
                    "iiif.io/api/presentation/2/context.json"
                        | "iiif.io/api/presentation/3/context.json"
                        | "www.shared-canvas.org/ns/context.json"
                        | "shared-canvas.org/ns/context.json"
                )
            })
        })
    }

    /// Minimal Image API 1.0 documents have no required IIIF marker. Only use
    /// this compatibility check at an explicitly requested `info.json` URL.
    pub(super) fn is_legacy_v1_info(&self) -> bool {
        self.identifier
            .as_ref()
            .is_some_and(|identifier| !identifier.trim().is_empty())
            && self.width > 0
            && self.height > 0
            && self.id.is_none()
            && self.iiif_type.is_none()
            && self.context.is_none()
            && self.protocol.is_none()
            && self.profile.is_none()
            && self.tiles.is_none()
    }

    /// Embedded objects require evidence of an Image API service. An identifier,
    /// dimensions or image formats also commonly describe ordinary web images.
    #[must_use]
    pub fn has_distinctive_iiif_properties(&self) -> bool {
        if self.width == 0
            || self.height == 0
            || self.has_presentation_signature()
            || self.iiif_type.as_ref().is_some_and(|value| {
                json_ld_matches(value, |value| {
                    matches!(value, "ImageProfile" | "iiif:ImageProfile")
                        || matches!(
                            without_scheme(value),
                            "iiif.io/api/image/2#ImageProfile" | "iiif.io/api/image/3#ImageProfile"
                        )
                })
            })
        {
            return false;
        }
        let explicit_signature = self
            .protocol
            .as_deref()
            .is_some_and(|value| without_scheme(value) == "iiif.io/api/image")
            || self.context.as_ref().is_some_and(image_context)
            || self.iiif_type.as_ref().is_some_and(|value| {
                json_ld_matches(value, |value| {
                    image_service_version(value).is_some() || value == "iiif:Image"
                })
            })
            || self.profile.as_ref().is_some_and(Profile::is_image_profile);
        if explicit_signature {
            return true;
        }
        self.iiif_type.is_none()
            && self.protocol.is_none()
            && self.context.is_none()
            && (self.tiles.as_ref().is_some_and(|tiles| {
                tiles.iter().any(|tile| {
                    tile.width > 0
                        && tile.height != Some(0)
                        && !tile.scale_factors.is_empty()
                        && tile.scale_factors.iter().all(|&scale| scale > 0)
                })
            }) || (self.tile_width.is_some_and(|width| width > 0)
                && self.tile_height != Some(0)
                && self.scale_factors.as_ref().is_some_and(|scales| {
                    !scales.is_empty() && scales.iter().all(|&scale| scale > 0)
                })))
    }

    /// Some info.json files contain a an invalid value for "@id",
    /// such as "localhost" or "example.com"
    pub fn remove_test_id(&mut self) -> bool {
        if let Some(id) = &self.id
            && TEST_ID_RE.is_match(id)
        {
            self.id = None;
            return true;
        }
        false
    }

    pub fn resolve_relative_urls(&mut self, base: &str) {
        if let Some(id) = &self.id {
            let resolved = resolve_relative(base, id);
            self.id = Some(rewrite_default_port_origin(&resolved, base, id));
        }
    }

    pub(crate) fn warnings(&self) -> Vec<String> {
        self.profile
            .as_ref()
            .map_or_else(Vec::new, Profile::warnings)
    }
}

pub(super) fn image_service_version(value: &str) -> Option<u8> {
    match value {
        "ImageService1" => Some(1),
        "ImageService2" => Some(2),
        "ImageService3" => Some(3),
        value => match without_scheme(value) {
            "iiif.io/api/image/1#ImageService" => Some(1),
            "iiif.io/api/image/2#ImageService" => Some(2),
            "iiif.io/api/image/3#ImageService" => Some(3),
            _ => None,
        },
    }
}

pub(super) fn image_context(value: &serde_json::Value) -> bool {
    json_ld_matches(value, |value| {
        matches!(
            without_scheme(value),
            "iiif.io/api/image/1/context.json"
                | "iiif.io/api/image/2/context.json"
                | "iiif.io/api/image/3/context.json"
                | "library.stanford.edu/iiif/image-api/1.1/context.json"
        )
    })
}

pub(super) fn image_profile(value: &serde_json::Value) -> bool {
    json_ld_matches(value, image_profile_reference)
}

fn image_profile_reference(reference: &str) -> bool {
    !without_scheme(reference).is_empty() && profile_reference_info(reference).is_some()
}

fn without_scheme(value: &str) -> &str {
    value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .unwrap_or("")
}

fn json_ld_matches(value: &serde_json::Value, predicate: impl Fn(&str) -> bool) -> bool {
    match value {
        serde_json::Value::String(value) => predicate(value),
        serde_json::Value::Array(values) => values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .any(predicate),
        _ => false,
    }
}

fn rewrite_default_port_origin(resolved: &str, info_uri: &str, raw_id: &str) -> String {
    let Ok(mut service) = url::Url::parse(resolved) else {
        return resolved.to_owned();
    };
    let Ok(info) = url::Url::parse(info_uri) else {
        return resolved.to_owned();
    };
    if service.host_str() != info.host_str()
        || (service.scheme() == info.scheme()
            && service.port_or_known_default() == info.port_or_known_default())
    {
        return resolved.to_owned();
    }
    let explicit_port = EXPLICIT_PORT_RE
        .captures(raw_id)
        .and_then(|captures| captures.get(1))
        .and_then(|port| port.as_str().parse::<u16>().ok());
    let is_default_port = matches!(explicit_port, Some(80 | 443))
        || (service.scheme() == "http" && info.scheme() == "https" && service.port().is_none());
    if !is_default_port {
        return resolved.to_owned();
    }
    let _ = service.set_scheme(info.scheme());
    let _ = service.set_host(info.host_str());
    let _ = service.set_port(info.port());
    service.to_string()
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct TileInfo {
    pub width: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(rename = "scaleFactors")]
    pub scale_factors: Vec<u32>,
}

impl TileInfo {
    #[must_use]
    pub fn size(&self) -> Vec2d {
        Vec2d {
            x: self.width,
            y: self.height.unwrap_or(self.width),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(untagged)]
pub enum Profile {
    Reference(String),
    Info(ProfileInfo),
    Multiple(Option<Vec<Profile>>),
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone, Default)]
pub struct ProfileInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "extraFormats")]
    formats: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "extraQualities")]
    qualities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "extraFeatures")]
    supports: Option<Vec<String>>,
    #[serde(rename = "maxWidth")]
    max_width: Option<u32>,
    #[serde(rename = "maxHeight")]
    max_height: Option<u32>,
    #[serde(rename = "maxArea")]
    max_area: Option<u64>,
}

impl ProfileInfo {
    /// Takes a proposed `tile_size` as input and returns a potentially smaller tile size
    /// that fits the tile size limits defined in the profile information
    fn crop_tile_size(&self, mut size: Vec2d) -> Vec2d {
        if let Some(max_width) = self.max_width {
            size.x = size.x.min(max_width);
            let max_height = self.max_height.unwrap_or(max_width);
            size.y = size.y.min(max_height);
        }
        if let Some(max_area) = self.max_area
            && size.area() > max_area
        {
            let sqrt = u32::try_from(max_area.isqrt())
                .expect("the square root of a u64 always fits in a u32");
            size.y = sqrt.min(size.y);
            size.x = sqrt.min(size.x);
        }
        size
    }
    /// Whether the given tile size fits the maximum size constraints in the profile
    fn tile_size_fits(&self, size: Vec2d) -> bool {
        self.crop_tile_size(size) == size
    }
}

static PROFILE_REFERENCES: LazyLock<std::collections::HashMap<String, ProfileInfo>> =
    LazyLock::new(|| {
        let json_str = include_str!("./levels.json");
        serde_json::from_str(json_str).unwrap()
    });

fn update_max<T: Ord + Copy>(target: &mut Option<T>, new: Option<T>) {
    if let Some(new) = new {
        *target = Some(if let Some(old) = target {
            new.min(*old)
        } else {
            new
        });
    }
}

impl Profile {
    fn is_image_profile(&self) -> bool {
        match self {
            Self::Reference(reference) => image_profile_reference(reference),
            Self::Info(_) => false,
            Self::Multiple(profiles) => profiles.iter().flatten().any(Self::is_image_profile),
        }
    }

    fn warnings(&self) -> Vec<String> {
        match self {
            Self::Reference(reference) if profile_reference_info(reference).is_none() => {
                vec![format!(
                    "Unknown IIIF profile reference '{reference}'; using default capabilities"
                )]
            }
            Self::Reference(_) | Self::Info(_) => Vec::new(),
            Self::Multiple(profiles) => profiles
                .iter()
                .flat_map(|profiles| profiles.iter().flat_map(Profile::warnings))
                .collect(),
        }
    }

    fn profile_info(&self) -> Cow<'_, ProfileInfo> {
        match self {
            Profile::Reference(s) => profile_reference_info(s)
                .map_or_else(|| Cow::Owned(ProfileInfo::default()), Cow::Borrowed),
            Profile::Info(info) => Cow::Borrowed(info),
            Profile::Multiple(profiles) => {
                let mut formats = vec![];
                let mut qualities = vec![];
                let mut supports = vec![];
                let mut max_width = None;
                let mut max_height = None;
                let mut max_area = None;
                for profile in profiles.iter().flat_map(|x| x.iter()) {
                    let p = profile.profile_info();
                    if let Some(x) = &p.formats {
                        formats.extend_from_slice(x);
                    }
                    if let Some(x) = &p.qualities {
                        qualities.extend_from_slice(x);
                    }
                    if let Some(x) = &p.supports {
                        supports.extend_from_slice(x);
                    }
                    update_max(&mut max_width, p.max_width);
                    update_max(&mut max_height, p.max_height);
                    update_max(&mut max_area, p.max_area);
                }
                Cow::Owned(ProfileInfo {
                    formats: Some(formats),
                    qualities: Some(qualities),
                    supports: Some(supports),
                    max_width,
                    max_height,
                    max_area,
                })
            }
        }
    }
}

fn profile_reference_info(reference: &str) -> Option<&'static ProfileInfo> {
    let canonical = match reference {
        "level0" => Cow::Borrowed("http://iiif.io/api/image/3/level0.json"),
        "level1" => Cow::Borrowed("http://iiif.io/api/image/3/level1.json"),
        reference if reference.starts_with("https://") => {
            Cow::Owned(reference.replacen("https://", "http://", 1))
        }
        reference => Cow::Borrowed(reference),
    };
    let canonical =
        if canonical.starts_with("http://library.stanford.edu/iiif/image-api/compliance.html#") {
            Cow::Owned(canonical.replace(
                "/image-api/compliance.html#",
                "/image-api/1.1/compliance.html#",
            ))
        } else {
            canonical
        };
    PROFILE_REFERENCES.get(canonical.as_ref())
}

impl Default for TileInfo {
    fn default() -> Self {
        TileInfo {
            width: 512,
            height: None,
            scale_factors: vec![1],
        }
    }
}

#[test]
fn test_deserialisation() {
    let _: ImageInfo = serde_json::from_str(
        r#"{
      "@context" : "http://iiif.io/api/image/2/context.json",
      "@id" : "http://www.example.org/image-service/abcd1234/1E34750D-38DB-4825-A38A-B60A345E591C",
      "protocol" : "http://iiif.io/api/image",
      "width" : 6000,
      "height" : 4000,
      "sizes" : [
        {"width" : 150, "height" : 100},
        {"width" : 600, "height" : 400},
        {"width" : 3000, "height": 2000}
      ],
      "tiles": [
        {"width" : 512, "scaleFactors" : [1,2,4,8,16]}
      ],
      "profile" : [ "http://iiif.io/api/image/2/level2.json" ]
    }"#,
    )
    .unwrap();
}

#[test]
fn schema_image_objects_need_an_explicit_iiif_signature() {
    let image = |iiif_type: &str, context: &str, protocol: Option<&str>| ImageInfo {
        context: Some(context.into()),
        iiif_type: Some(iiif_type.into()),
        protocol: protocol.map(str::to_owned),
        id: Some("https://example.org/page/#primaryimage".into()),
        width: 1785,
        height: 2560,
        ..ImageInfo::default()
    };
    for iiif_type in [
        "ImageObject",
        "schema:ImageObject",
        "http://schema.org/ImageObject",
        "https://schema.org/ImageObject",
    ] {
        assert!(!image(iiif_type, "https://schema.org", None).has_distinctive_iiif_properties());
    }
    assert!(
        image(
            "ImageObject",
            "https://schema.org",
            Some("http://iiif.io/api/image")
        )
        .has_distinctive_iiif_properties()
    );
    for context in [
        "http://library.stanford.edu/iiif/image-api/1.1/context.json",
        "http://iiif.io/api/image/3/context.json",
    ] {
        assert!(image("ImageObject", context, None).has_distinctive_iiif_properties());
    }

    // An untyped identifier and dimensions can equally describe a thumbnail.
    let legacy_service: ImageInfo = serde_json::from_str(
        r#"{"@id":"https://example.org/iiif/image","width":1785,"height":2560}"#,
    )
    .unwrap();
    assert!(!legacy_service.has_distinctive_iiif_properties());
}

#[test]
fn json_ld_context_arrays_and_legacy_profiles_preserve_image_capabilities() {
    for context in [
        serde_json::json!([
            "https://example.test/extension.json",
            "http://iiif.io/api/image/3/context.json"
        ]),
        serde_json::json!([{"custom": "https://example.test/custom"}, "http://iiif.io/api/image/3/context.json"]),
    ] {
        let image: ImageInfo = serde_json::from_value(serde_json::json!({
            "@context": context,
            "id": "https://images.test/item",
            "type": "ImageService3",
            "protocol": "http://iiif.io/api/image",
            "width": 1000, "height": 800, "profile": "level1"
        }))
        .unwrap();
        assert!(image.has_distinctive_iiif_properties());
        assert!(image.supports_custom_size());
        assert!(image.warnings().is_empty());
    }

    for profile in [
        "http://library.stanford.edu/iiif/image-api/compliance.html#level1",
        "https://library.stanford.edu/iiif/image-api/1.1/compliance.html#level1",
    ] {
        let image: ImageInfo = serde_json::from_value(serde_json::json!({
            "identifier": "item", "width": 1000, "height": 800, "profile": profile
        }))
        .unwrap();
        assert!(image.has_distinctive_iiif_properties());
        assert_eq!(image.best_quality(), "native");
        assert_eq!(image.preferred_size_format(), TileSizeFormat::Width);
        assert!(image.warnings().is_empty());
    }
    let image: ImageInfo = serde_json::from_value(serde_json::json!({
        "@context": "http://library.stanford.edu/iiif/image-api/1.1/context.json",
        "@id": "https://images.test/item", "width": 1000, "height": 800
    }))
    .unwrap();
    assert_eq!(image.best_quality(), "native");
}

#[test]
fn ordinary_images_and_lookalike_contexts_are_not_image_services() {
    for fields in [
        serde_json::json!({"id": "https://images.test/thumbnail.jpg"}),
        serde_json::json!({"@context": "https://schema.org", "@type": ["ImageObject"]}),
        serde_json::json!({"formats": ["jpg", "png"]}),
        serde_json::json!({"protocol": "https://example.test/protocol"}),
        serde_json::json!({"@context": "https://evil.test/iiif.io/api/image/3/context.json"}),
        serde_json::json!({"@context": {"unrelated": "http://iiif.io/api/image/3/context.json"}}),
        serde_json::json!({"@type": "iiif:ImageProfile"}),
        serde_json::json!({"type": "ImageProfile", "@context": "http://iiif.io/api/image/3/context.json"}),
        serde_json::json!({"type": "Canvas"}),
        serde_json::json!({"tiles": []}),
        serde_json::json!({"tiles": [{"width": 256, "scaleFactors": [0]}]}),
        serde_json::json!({"type": "Product", "tiles": [{"width": 256, "scaleFactors": [1]}]}),
        serde_json::json!({"type": "ImageObject", "tiles": [{"width": 256, "scaleFactors": [1]}]}),
        serde_json::json!({"protocol": "dzi", "tiles": [{"width": 256, "scaleFactors": [1]}]}),
        serde_json::json!({"@context": "https://schema.org", "tiles": [{"width": 256, "scaleFactors": [1]}]}),
        serde_json::json!({"type": "Manifest", "tiles": [{"width": 256, "scaleFactors": [1]}]}),
    ] {
        let mut value = fields;
        value["width"] = 1000.into();
        value["height"] = 800.into();
        let image: ImageInfo = serde_json::from_value(value.clone()).unwrap();
        assert!(!image.has_distinctive_iiif_properties(), "{value}");
    }
}

#[test]
fn test_profile_info() {
    let profiles = Profile::Multiple(Some(vec![
        Profile::Reference("http://iiif.io/api/image/2/level0.json".into()),
        Profile::Info(ProfileInfo {
            supports: Some(vec!["sizeByWh".into()]),
            max_width: Some(56),
            ..Default::default()
        }),
        Profile::Info(ProfileInfo {
            max_width: Some(78),
            max_height: Some(94),
            ..Default::default()
        }),
    ]));
    assert_eq!(
        *profiles.profile_info(),
        ProfileInfo {
            formats: Some(vec!["jpg".into()]),       // from level0
            qualities: Some(vec!["default".into()]), // from level0
            supports: Some(vec![
                "sizeByWhListed".into(), // from level0
                "sizeByWh".into(),       // from the second profile
            ]),
            max_width: Some(56),
            max_height: Some(94),
            ..Default::default()
        }
    );
}

#[test]
fn test_best_quality() {
    let pairs = vec![
        (None, "default"),
        (Some(vec![]), "default"),
        (Some(vec!["color".into()]), "color"),
        (Some(vec!["grey".into()]), "grey"),
        (Some(vec!["zorglub".into()]), "zorglub"),
        (Some(vec!["zorglub".into(), "color".into()]), "color"),
        (Some(vec!["bitonal".into(), "gray".into()]), "gray"),
        (
            Some(vec!["bitonal".into(), "gray".into(), "color".into()]),
            "color",
        ),
        (
            Some(vec![
                "default".into(),
                "bitonal".into(),
                "gray".into(),
                "color".into(),
            ]),
            "default",
        ),
    ];
    for (qualities, expected_best_quality) in pairs {
        let info = ImageInfo {
            qualities,
            ..ImageInfo::default()
        };
        assert_eq!(info.best_quality(), expected_best_quality);
    }
}

#[test]
fn private_ids_are_removed_before_resolution() {
    let mut info: ImageInfo =
        serde_json::from_str(r#"{"@id":"http://10.0.0.42/iiif/private","width":1,"height":1}"#)
            .unwrap();
    assert!(info.remove_test_id());
    info.resolve_relative_urls("http://127.0.0.1:9877/fixtures/info.json");
    assert_eq!(info.id, None);
}

#[test]
fn explicit_default_ports_are_rewritten_to_the_info_origin() {
    let mut info: ImageInfo = serde_json::from_str(
        r#"{"@id":"http://127.0.0.1:80/iiif/default-port","width":1,"height":1}"#,
    )
    .unwrap();
    assert!(!info.remove_test_id());
    info.resolve_relative_urls("http://127.0.0.1:9877/fixtures/info.json");
    assert_eq!(
        info.id.as_deref(),
        Some("http://127.0.0.1:9877/iiif/default-port")
    );
}

#[cfg(test)]
mod best_format_tests {
    use super::*;

    fn info_with(json_formats: Option<&str>) -> ImageInfo {
        let formats_json = json_formats
            .map(|f| format!(r#""formats": {f},"#))
            .unwrap_or_default();
        let text = format!(
            r#"{{"@id":"https://iiif.test/img","width":100,"height":100,{formats_json}"qualities": ["default"]}}"#
        );
        serde_json::from_str(&text).expect("parse info.json")
    }

    #[test]
    fn best_format_pins_web_parity_policy() {
        // No declared formats -> jpg.
        assert_eq!(info_with(None).best_format(), "jpg");
        // png declared -> png, wherever it appears in the list.
        assert_eq!(
            info_with(Some(r#"["jpg","png","webp"]"#)).best_format(),
            "png"
        );
        assert_eq!(info_with(Some(r#"["png","jpg"]"#)).best_format(), "png");
        // Without png, the first declared format wins.
        assert_eq!(info_with(Some(r#"["webp","gif"]"#)).best_format(), "webp");
    }
}
