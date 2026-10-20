use serde::Deserialize;
use std::collections::HashMap;

use super::tile_info::{Context, Profile, StringOrArray};
use crate::core::resolve_relative;

// Helper for potentially multilingual labels
#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
#[serde(untagged)]
#[derive(Default)]
pub enum IiifLabel {
    String(String),
    LanguageValue {
        #[serde(rename = "@value")]
        value: String,
        #[serde(default, rename = "@language")]
        language: Option<String>,
    },
    Values(Vec<IiifLabel>),
    Map(HashMap<String, Vec<String>>),
    #[default]
    None, // Represents JSON null or a deliberately empty label
}

impl IiifLabel {
    /// Returns the English label if present, otherwise the first label found for any language,
    /// or the string itself if it's a simple string label. Returns None if the label is empty or explicitly None.
    #[must_use]
    pub fn get_english_or_first(&self) -> Option<String> {
        match self {
            IiifLabel::String(s) => (!s.is_empty()).then(|| s.clone()),
            IiifLabel::LanguageValue { value, .. } => (!value.is_empty()).then(|| value.clone()),
            IiifLabel::Values(values) => values
                .iter()
                .find(|value| matches!(value, Self::LanguageValue { language: Some(language), .. } if language == "en" || language.starts_with("en-")))
                .and_then(Self::get_english_or_first)
                .or_else(|| values.iter().find_map(Self::get_english_or_first)),
            IiifLabel::Map(map) => {
                if let Some(en_labels) = map.get("en")
                    && let Some(first_en) = en_labels.iter().find(|s| !s.is_empty())
                {
                    return Some(first_en.clone());
                }
                // Fallback to the first non-empty label in the first language found
                map.values()
                    .find_map(|labels| labels.iter().find(|s| !s.is_empty()).cloned())
            }
            IiifLabel::None => None,
        }
    }
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq, Default)]
pub struct MetadataEntry {
    #[serde(default)]
    pub label: IiifLabel,
    #[serde(default)]
    pub value: IiifLabel,
}

impl MetadataEntry {
    /// Get the metadata title if this entry is a title field
    #[must_use]
    pub fn get_title(&self) -> Option<String> {
        if let Some(label) = self.label.get_english_or_first()
            && label.to_lowercase() == "title"
        {
            return self.value.get_english_or_first();
        }
        None
    }
}

// Default implementation to handle missing labels gracefully via #[serde(default)]

// 6.1: field names follow the IIIF Presentation 3 wire vocabulary
// (`id`/`type`/`label`/`items`); renaming them would break serde
// mapping, so the shared-prefix lint stays allowed here.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct Manifest {
    #[serde(default, rename = "@context", skip_deserializing)]
    pub context: Option<String>, // Can be string or array of strings
    #[serde(default)] // If ID is missing, we might use the fetch URL as a fallback later
    pub id: String,
    #[serde(
        default,
        rename = "type",
        alias = "@type",
        deserialize_with = "manifest_type"
    )]
    pub manifest_type: String,
    #[serde(default)]
    pub label: IiifLabel,
    pub items: Vec<Canvas>,
    #[serde(default)]
    pub metadata: Option<Vec<MetadataEntry>>,
    // Other potentially useful fields:
    // pub summary: Option<IiifLabel>,
    // pub thumbnail: Option<Vec<Thumbnail>>,
}

// 6.1: field names follow the IIIF Presentation 3 wire vocabulary
// (`id`/`type`/`label`/`items`); renaming them would break serde
// mapping, so the shared-prefix lint stays allowed here.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct Canvas {
    #[serde(default, alias = "@id")]
    pub id: String,
    #[serde(default, rename = "type", alias = "@type")]
    pub canvas_type: String, // Should be "Canvas"
    #[serde(default)]
    pub label: IiifLabel,
    #[serde(default)]
    pub items: Vec<AnnotationPage>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

// 6.1: field names follow the IIIF Presentation 3 wire vocabulary
// (`id`/`type`/`label`/`items`); renaming them would break serde
// mapping, so the shared-prefix lint stays allowed here.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct AnnotationPage {
    #[serde(default, alias = "@id")]
    pub id: String,
    #[serde(default, rename = "type", alias = "@type")]
    pub annotation_page_type: String, // Should be "AnnotationPage"
    #[serde(default)]
    pub items: Vec<Annotation>,
}

// 6.1: field names follow the IIIF Presentation 3 wire vocabulary
// (`id`/`type`/`label`/`items`); renaming them would break serde
// mapping, so the shared-prefix lint stays allowed here.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct Annotation {
    #[serde(alias = "@id")]
    pub id: Option<String>,
    #[serde(
        default,
        rename = "type",
        alias = "@type",
        deserialize_with = "resource_type"
    )]
    pub annotation_type: String, // Should be "Annotation"
    pub motivation: Option<StringOrArray>, // Web Annotation permits multiple motivations.
    #[serde(default)] // Body could be missing or not an image
    pub body: AnnotationBody,
    // target: Option<Target>, // Target is usually the canvas; can be string or object
}

#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
#[serde(untagged)]
pub enum AnnotationBody {
    Multiple(Vec<Self>),
    Resource(Box<BodyResource>),
    Ignored(serde::de::IgnoredAny),
    #[default]
    Empty,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct BodyResource {
    #[serde(flatten)]
    image: ImageBody,
    #[serde(default)]
    default: AnnotationBody,
    #[serde(default)]
    item: AnnotationBody,
    #[serde(default)]
    items: AnnotationBody,
    #[serde(default)]
    source: AnnotationBody,
    #[serde(default)]
    full: AnnotationBody,
}

impl AnnotationBody {
    /// The image content carried by this annotation, including alternatives and
    /// the source of a selected image region. Unrelated content is ignored.
    fn images(&self) -> Vec<&ImageBody> {
        let mut images = Vec::new();
        self.collect_images(&mut images);
        images
    }

    fn collect_images<'a>(&'a self, images: &mut Vec<&'a ImageBody>) {
        match self {
            Self::Multiple(bodies) => {
                for body in bodies {
                    body.collect_images(images);
                }
            }
            Self::Resource(body) => match body.image.image_type.as_str() {
                "Choice" | "oa:Choice" => {
                    for child in [&body.default, &body.item, &body.items] {
                        child.collect_images(images);
                    }
                }
                "SpecificResource" | "oa:SpecificResource" => {
                    for child in [&body.source, &body.full] {
                        child.collect_images(images);
                    }
                }
                "" | "Image" | "dctypes:Image" | "http://purl.org/dc/dcmitype/Image" => {
                    images.push(&body.image);
                }
                _ => {}
            },
            Self::Ignored(_) | Self::Empty => {}
        }
    }
}

fn type_is(value: &StringOrArray, names: &[&str]) -> bool {
    value.matches(|value| names.contains(&value))
}

fn painting(motivation: Option<&StringOrArray>) -> bool {
    motivation.is_none_or(|value| {
        type_is(
            value,
            &[
                "painting",
                "sc:painting",
                "http://iiif.io/api/presentation/2#painting",
            ],
        )
    })
}

fn resource_type<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    preferred_type(decoder, |value| {
        matches!(
            value,
            "Image"
                | "dctypes:Image"
                | "http://purl.org/dc/dcmitype/Image"
                | "Annotation"
                | "oa:Annotation"
                | "Choice"
                | "oa:Choice"
                | "SpecificResource"
                | "oa:SpecificResource"
        )
    })
}

fn service_type<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    preferred_type(decoder, |value| {
        super::tile_info::image_service_version(value).is_some()
    })
}

fn preferred_type<'de, D: serde::Deserializer<'de>>(
    decoder: D,
    preferred: impl Fn(&str) -> bool,
) -> Result<String, D::Error> {
    let types = StringOrArray::deserialize(decoder)?;
    Ok(types
        .strings()
        .iter()
        .find(|value| preferred(value))
        .or_else(|| types.strings().first())
        .cloned()
        .unwrap_or_default())
}

fn manifest_type<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    let types = StringOrArray::deserialize(decoder)?;
    if matches!(types, StringOrArray::None) {
        return Ok(String::new());
    }
    types
        .strings()
        .iter()
        .find(|value| matches!(value.as_str(), "Manifest" | "sc:Manifest"))
        .cloned()
        .ok_or_else(|| serde::de::Error::custom("not an IIIF presentation manifest"))
}

fn image_services<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Vec<ImageService>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Service {
        Image(Box<ImageService>),
        Other(serde::de::IgnoredAny),
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Services {
        Multiple(Vec<Service>),
        Single(Service),
    }
    let services = match Services::deserialize(decoder)? {
        Services::Multiple(services) => services,
        Services::Single(service) => vec![service],
    };
    Ok(services
        .into_iter()
        .filter_map(|service| match service {
            Service::Image(image) => Some(*image),
            Service::Other(_) => None,
        })
        .collect())
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq, Default)]
pub struct ImageBody {
    #[serde(default, alias = "@id")]
    pub id: String, // This can be the direct image URL or the base URI for an Image Service
    #[serde(
        default,
        rename = "type",
        alias = "@type",
        deserialize_with = "resource_type"
    )]
    pub image_type: String, // Should be "Image"
    #[serde(skip_deserializing)]
    pub format: Option<String>, // e.g., "image/jpeg"
    #[serde(default, deserialize_with = "image_services")]
    pub service: Vec<ImageService>, // Array of services, can be empty
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq, Default)]
pub struct ImageService {
    #[serde(default, rename = "@context")]
    pub context: Context,
    #[serde(alias = "@id")] // IIIF Image API 2 uses "@id"
    #[serde(default)]
    pub id: String, // IIIF Image API 3 uses "id"
    #[serde(alias = "@type")] // IIIF Image API 2 uses "@type"
    #[serde(default, rename = "type", deserialize_with = "service_type")]
    pub service_type: String, // e.g. "ImageService2", "ImageService3"
    pub profile: Option<Profile>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct LegacyManifest {
    #[serde(
        default,
        rename = "@type",
        alias = "type",
        deserialize_with = "manifest_type"
    )]
    pub manifest_type: String,
    #[serde(default)]
    pub label: IiifLabel,
    pub sequences: Vec<LegacySequence>,
    #[serde(default)]
    pub metadata: Option<Vec<MetadataEntry>>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct LegacySequence {
    #[serde(default, rename = "@type", alias = "type")]
    pub sequence_type: StringOrArray,
    #[serde(default)]
    pub canvases: Vec<LegacyCanvas>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct LegacyCanvas {
    #[serde(default, rename = "@type", alias = "type")]
    pub canvas_type: StringOrArray,
    #[serde(default)]
    pub label: IiifLabel,
    #[serde(default)]
    pub images: Vec<LegacyAnnotation>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
pub struct LegacyAnnotation {
    #[serde(default, rename = "@type", alias = "type")]
    pub annotation_type: StringOrArray,
    pub motivation: Option<StringOrArray>,
    #[serde(default)]
    pub resource: AnnotationBody,
}

/// Holds information extracted from a manifest for a single image to be dezoomified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedImageInfo {
    pub size: Option<crate::model::Size>,
    pub preview: Option<crate::model::Tile>,
    /// The URI to be dezoomified (either an `info.json` or a direct image link).
    pub image_uri: String,
    /// The label of the manifest, if available.
    pub manifest_label: Option<String>,
    /// The title from metadata, if available.
    pub metadata_title: Option<String>,
    /// The label of the canvas this image belongs to, if available.
    pub canvas_label: Option<String>,
    /// The 0-based index of the canvas in the manifest's `items` array.
    pub canvas_index: usize,
}

fn declared_size(width: Option<u32>, height: Option<u32>) -> Option<crate::model::Size> {
    let (width, height) = (width?, height?);
    (width > 0 && height > 0).then_some(crate::model::Size { width, height })
}

fn legacy_type(value: &StringOrArray, names: &[&str]) -> bool {
    matches!(value, StringOrArray::None) || type_is(value, names)
}

fn image_service_info_uri(manifest_url: &str, service_id: &str) -> String {
    let resolved_uri = resolve_relative(manifest_url, service_id);
    let Ok(mut url) = url::Url::parse(&resolved_uri) else {
        return resolved_uri;
    };
    if !url.path().ends_with("/info.json") {
        let path = format!("{}/info.json", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }
    url.into()
}

fn choose_image_service_uri(services: &[ImageService], manifest_url: &str) -> Option<String> {
    Some(image_service_info_uri(
        manifest_url,
        &choose_image_service(services)?.id,
    ))
}

fn choose_image_service(services: &[ImageService]) -> Option<&ImageService> {
    services
        .iter()
        .filter(|service| service.is_image_service())
        .min_by_key(|service| {
            std::cmp::Reverse(
                super::tile_info::image_service_version(&service.service_type).unwrap_or(1),
            )
        })
}

impl ImageService {
    fn is_image_service(&self) -> bool {
        if self.id.is_empty() {
            return false;
        }
        if super::tile_info::image_service_version(&self.service_type).is_some() {
            return true;
        }
        // Legacy image services lack a type; auth, search and extension services
        // can share this property and must not be inferred from their ID alone.
        self.service_type.is_empty()
            && (super::tile_info::image_context(&self.context)
                || self.profile.as_ref().is_some_and(Profile::is_image_profile))
    }
}

fn image_size(
    width: Option<u32>,
    height: Option<u32>,
    services: &[ImageService],
) -> Option<crate::model::Size> {
    declared_size(width, height).or_else(|| {
        let service = choose_image_service(services)?;
        declared_size(service.width, service.height)
    })
}

impl Canvas {
    fn painting_annotations(&self) -> impl Iterator<Item = &Annotation> {
        self.items
            .iter()
            .filter(|page| {
                page.annotation_page_type.is_empty()
                    || page.annotation_page_type == "AnnotationPage"
            })
            .flat_map(|page| page.items.iter())
            .filter(|annotation| {
                (annotation.annotation_type.is_empty()
                    || annotation.annotation_type == "Annotation")
                    && painting(annotation.motivation.as_ref())
            })
    }
}

impl Manifest {
    /// Get the title from metadata if available
    #[must_use]
    pub fn get_metadata_title(&self) -> Option<String> {
        self.metadata
            .as_ref()?
            .iter()
            .find_map(MetadataEntry::get_title)
    }

    /// Extracts all relevant image URIs (info.json or direct image links) from the manifest.
    ///
    /// It traverses Canvases, `AnnotationPages`, and Annotations to find "painting"
    /// motivations where the body is an Image. It prioritizes Image Services
    /// (`ImageService2` or `ImageService3`) and constructs `info.json` URIs.
    /// If no service is found, it uses the direct image `id` from the annotation body.
    /// All extracted URIs are resolved relative to `manifest_url`.
    #[must_use]
    pub fn extract_image_infos(&self, manifest_url: &str) -> Vec<ExtractedImageInfo> {
        let mut infos = Vec::new();
        let manifest_label = self.label.get_english_or_first();
        let metadata_title = self.get_metadata_title();

        for (canvas_index, canvas) in self.items.iter().enumerate() {
            if !canvas.canvas_type.is_empty() && canvas.canvas_type != "Canvas" {
                continue;
            }

            let canvas_label = canvas.label.get_english_or_first();

            for annotation in canvas.painting_annotations() {
                for image_body in annotation.body.images() {
                    let final_image_uri =
                        choose_image_service_uri(&image_body.service, manifest_url).or_else(|| {
                            if !image_body.id.is_empty()
                                && matches!(
                                    image_body.image_type.as_str(),
                                    "Image" | "dctypes:Image" | "http://purl.org/dc/dcmitype/Image"
                                )
                            {
                                Some(resolve_relative(manifest_url, &image_body.id))
                            } else {
                                None
                            }
                        });

                    if let Some(uri_to_add) = final_image_uri {
                        let size =
                            image_size(image_body.width, image_body.height, &image_body.service);
                        infos.push(ExtractedImageInfo {
                            preview: choose_image_service(&image_body.service).and_then(
                                |service| {
                                    super::manifest_preview(manifest_url, service, size.as_ref())
                                },
                            ),
                            size,
                            image_uri: uri_to_add,
                            manifest_label: manifest_label.clone(),
                            metadata_title: metadata_title.clone(),
                            canvas_label: canvas_label.clone(),
                            canvas_index,
                        });
                    }
                }
            }
        }
        infos
    }
}

impl LegacyManifest {
    /// Get the title from metadata if available
    #[must_use]
    pub fn get_metadata_title(&self) -> Option<String> {
        self.metadata
            .as_ref()?
            .iter()
            .find_map(MetadataEntry::get_title)
    }

    /// Extracts image URIs from IIIF Presentation v1/v2 manifests.
    #[must_use]
    pub fn extract_image_infos(&self, manifest_url: &str) -> Vec<ExtractedImageInfo> {
        let mut infos = Vec::new();
        let manifest_label = self.label.get_english_or_first();
        let metadata_title = self.get_metadata_title();

        for (canvas_index, canvas) in self
            .sequences
            .iter()
            .filter(|sequence| legacy_type(&sequence.sequence_type, &["Sequence", "sc:Sequence"]))
            .flat_map(|sequence| sequence.canvases.iter())
            .enumerate()
        {
            if !legacy_type(&canvas.canvas_type, &["Canvas", "sc:Canvas"]) {
                continue;
            }
            let canvas_label = canvas.label.get_english_or_first();

            for annotation in &canvas.images {
                if !legacy_type(
                    &annotation.annotation_type,
                    &["Annotation", "oa:Annotation"],
                ) || !painting(annotation.motivation.as_ref())
                {
                    continue;
                }
                for resource in annotation.resource.images() {
                    let final_image_uri = choose_image_service_uri(&resource.service, manifest_url)
                        .or_else(|| {
                            if !resource.id.is_empty()
                                && (resource.image_type.is_empty()
                                    || matches!(
                                        resource.image_type.as_str(),
                                        "Image"
                                            | "dctypes:Image"
                                            | "http://purl.org/dc/dcmitype/Image"
                                    ))
                            {
                                Some(resolve_relative(manifest_url, &resource.id))
                            } else {
                                None
                            }
                        });

                    if let Some(uri_to_add) = final_image_uri {
                        let size = image_size(resource.width, resource.height, &resource.service);
                        infos.push(ExtractedImageInfo {
                            preview: choose_image_service(&resource.service).and_then(|service| {
                                super::manifest_preview(manifest_url, service, size.as_ref())
                            }),
                            size,
                            image_uri: uri_to_add,
                            manifest_label: manifest_label.clone(),
                            metadata_title: metadata_title.clone(),
                            canvas_label: canvas_label.clone(),
                            canvas_index,
                        });
                    }
                }
            }
        }

        infos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_language_values_do_not_hide_the_image() {
        let manifest: LegacyManifest = serde_json::from_value(serde_json::json!({
            "@type": "sc:Manifest",
            "label": [
                {"@value": "Livre", "@language": "fr"},
                {"@value": "Book", "@language": "en"}
            ],
            "metadata": [{
                "label": {"@value": "Title", "@language": "en"},
                "value": ["", {"@value": "Image title", "@language": "en"}]
            }],
            "sequences": [{"canvases": [{
                "label": {"@value": "Page one", "@language": "en"},
                "images": [{"resource": {"@type": "dctypes:Image", "@id": "page.jpg"}}]
            }]}]
        }))
        .unwrap();
        let images = manifest.extract_image_infos("https://images.test/manifest");
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].image_uri, "https://images.test/page.jpg");
        assert_eq!(images[0].manifest_label.as_deref(), Some("Book"));
        assert_eq!(images[0].metadata_title.as_deref(), Some("Image title"));
        assert_eq!(images[0].canvas_label.as_deref(), Some("Page one"));
    }

    fn current_images(annotations: serde_json::Value) -> Vec<ExtractedImageInfo> {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "type": "Manifest", "items": [{"type": "Canvas", "items": [{
                "type": "AnnotationPage", "items": annotations
            }]}]
        }))
        .unwrap();
        manifest.extract_image_infos("https://images.test/manifest")
    }

    #[test]
    fn mixed_content_and_choices_keep_only_image_content() {
        let images = current_images(serde_json::json!([{
            "type": ["Annotation", "custom:Annotation"],
            "motivation": ["painting", "custom:motivation"],
            "body": [
                {"id": "sound.mp3", "type": "Sound", "format": ["audio/mpeg"]},
                {"id": "video.mp4", "type": "Video", "duration": 1.5},
                {"type": "TextualBody", "value": "Text"},
                {"type": "Choice", "items": [
                    {"id": "color.jpg", "type": "Image"},
                    {"type": "SpecificResource", "source": {
                        "id": "gray.jpg", "type": "Image",
                        "service": [{"id": "gray", "type": "ImageService3"}]
                    }, "selector": {"type": "FragmentSelector", "value": "xywh=0,0,100,100"}}
                ]}
            ]
        }]));
        assert_eq!(
            images
                .iter()
                .map(|image| image.image_uri.as_str())
                .collect::<Vec<_>>(),
            [
                "https://images.test/color.jpg",
                "https://images.test/gray/info.json"
            ]
        );
    }

    #[test]
    fn legacy_choice_and_selected_image_sources_are_downloadable() {
        let manifest: LegacyManifest = serde_json::from_value(serde_json::json!({
            "@type": "sc:Manifest", "sequences": [{"canvases": [{"images": [{
                "motivation": "sc:painting", "resource": {
                    "@type": "oa:Choice",
                    "default": {"@type": "dctypes:Image", "@id": "default.jpg"},
                    "item": [{"@type": "oa:SpecificResource", "full": {
                        "@type": "dctypes:Image", "@id": "alternative.jpg"
                    }}]
                }
            }]}]}]
        }))
        .unwrap();
        assert_eq!(
            manifest
                .extract_image_infos("https://images.test/manifest")
                .iter()
                .map(|image| image.image_uri.as_str())
                .collect::<Vec<_>>(),
            [
                "https://images.test/default.jpg",
                "https://images.test/alternative.jpg"
            ]
        );
    }

    #[test]
    fn nonpainting_images_and_unrelated_services_are_not_download_targets() {
        let images = current_images(serde_json::json!([
            {"motivation": "commenting", "body": {"id": "comment.jpg", "type": "Image"}},
            {"motivation": "painting", "body": {"type": "Video", "service": [
                {"id": "video", "type": "ImageService3"}
            ]}},
            {"motivation": "painting", "body": {"id": "actual.jpg", "type": "Image", "service": [
                {"id": "login", "type": "AuthCookieService1"},
                {"id": "search", "profile": "http://iiif.io/api/search/1/search"},
                {"id": "unknown", "type": "UnknownImageService"},
                {"id": "spoofed", "profile": "https://iiif.io.evil.test/api/image/2/level2.json"},
                {"id": "untyped"}
            ]}},
            {"motivation": "painting", "body": {"id": "preview.jpg", "type": "Image", "service": [
                {"id": "search", "type": "SearchService2"},
                {"@id": "full?version=2", "@context": ["https://extension.test/context", "http://iiif.io/api/image/2/context.json"]}
            ]}}
        ]));
        assert_eq!(
            images
                .iter()
                .map(|image| image.image_uri.as_str())
                .collect::<Vec<_>>(),
            [
                "https://images.test/actual.jpg",
                "https://images.test/full/info.json?version=2"
            ]
        );
    }

    #[test]
    fn test_label_extraction() {
        let label_str = IiifLabel::String("Hello".to_string());
        assert_eq!(label_str.get_english_or_first(), Some("Hello".to_string()));

        let label_empty_str = IiifLabel::String(String::new());
        assert_eq!(label_empty_str.get_english_or_first(), None);

        let repeated: IiifLabel = serde_json::from_str(r#"["", "First", "Second"]"#).unwrap();
        assert_eq!(repeated.get_english_or_first().as_deref(), Some("First"));
        let empty: IiifLabel = serde_json::from_str("[]").unwrap();
        assert_eq!(empty.get_english_or_first(), None);

        let mut map_en = HashMap::new();
        map_en.insert("en".to_string(), vec!["World".to_string()]);
        map_en.insert("fr".to_string(), vec!["Monde".to_string()]);
        let label_map_en = IiifLabel::Map(map_en);
        assert_eq!(
            label_map_en.get_english_or_first(),
            Some("World".to_string())
        );

        let mut map_en_empty_val = HashMap::new();
        map_en_empty_val.insert("en".to_string(), vec![String::new()]);
        map_en_empty_val.insert("fr".to_string(), vec!["Monde".to_string()]);
        let label_map_en_empty = IiifLabel::Map(map_en_empty_val);
        assert_eq!(
            label_map_en_empty.get_english_or_first(),
            Some("Monde".to_string())
        );

        let mut map_fr_only = HashMap::new();
        map_fr_only.insert("fr".to_string(), vec!["Monde".to_string()]);
        let label_map_fr_only = IiifLabel::Map(map_fr_only);
        assert_eq!(
            label_map_fr_only.get_english_or_first(),
            Some("Monde".to_string())
        );

        let label_none = IiifLabel::None;
        assert_eq!(label_none.get_english_or_first(), None);

        let empty_map = HashMap::new();
        let label_empty_map = IiifLabel::Map(empty_map);
        assert_eq!(label_empty_map.get_english_or_first(), None);
    }

    #[test]
    fn test_deserialize_basic_manifest_and_extract_infojson() {
        let json_data = r#"
        {
          "@context": "http://iiif.io/api/presentation/3/context.json",
          "id": "https://example.org/iiif/book1/manifest",
          "type": "Manifest",
          "label": { "en": [ "Book 1" ] },
          "items": [
            {
              "id": "https://example.org/iiif/book1/canvas/p1",
              "type": "Canvas",
              "label": { "en": [ "Page 1" ] },
              "width": 1000,
              "height": 1500,
              "items": [
                {
                  "id": "https://example.org/iiif/book1/canvas/p1/page",
                  "type": "AnnotationPage",
                  "items": [
                    {
                      "id": "https://example.org/iiif/book1/canvas/p1/page/image",
                      "type": "Annotation",
                      "motivation": "painting",
                      "body": {
                        "id": "https://example.org/iiif/book1/page1_img/full/max/0/default.jpg",
                        "type": "Image",
                        "width": 800,
                        "height": 1200,
                        "format": "image/jpeg",
                        "service": [
                          {
                            "id": "https://example.org/iiif/book1/page1_svc",
                            "type": "ImageService2",
                            "profile": "level1"
                          }
                        ]
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
        "#;
        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        assert_eq!(manifest.manifest_type, "Manifest");
        assert_eq!(
            manifest.label.get_english_or_first(),
            Some("Book 1".to_string())
        );
        assert_eq!(manifest.items.len(), 1);

        let infos = manifest.extract_image_infos("https://example.org/iiif/book1/manifest");
        assert_eq!(infos.len(), 1);
        let info = &infos[0];
        assert_eq!(
            info.image_uri,
            "https://example.org/iiif/book1/page1_svc/info.json"
        );
        assert_eq!(info.manifest_label, Some("Book 1".to_string()));
        assert_eq!(info.canvas_label, Some("Page 1".to_string()));
        assert_eq!(info.canvas_index, 0);
        assert_eq!(
            info.size,
            Some(crate::model::Size {
                width: 800,
                height: 1200
            })
        );
    }

    #[test]
    fn test_extract_direct_image_uri_no_service() {
        let json_data = r#"
        {
          "id": "https://example.org/manifest-no-service",
          "type": "Manifest",
          "items": [
            {
              "id": "https://example.org/canvas/c1",
              "type": "Canvas",
              "items": [
                {
                  "id": "ap1",
                  "type": "AnnotationPage",
                  "items": [
                    {
                      "id": "a1",
                      "type": "Annotation",
                      "motivation": "painting",
                      "body": {
                        "id": "https://example.org/images/direct_image.jpg",
                        "type": "Image",
                        "format": "image/jpeg"
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
        "#;

        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        let infos = manifest.extract_image_infos("https://example.org/manifest-no-service");
        assert_eq!(infos.len(), 1);
        assert_eq!(
            infos[0].image_uri,
            "https://example.org/images/direct_image.jpg"
        );
        assert_eq!(infos[0].manifest_label, None);
        assert_eq!(infos[0].canvas_label, None);
        assert_eq!(infos[0].canvas_index, 0);
    }

    #[test]
    fn test_prioritize_image_service_3_over_2() {
        let json_data = r#"
        {
          "id": "manifest-svc-priority", "type": "Manifest",
          "items": [{ "id": "c1", "type": "Canvas", "items": [{ "id": "ap1", "type": "AnnotationPage", "items": [
            { "id": "a1", "type": "Annotation", "motivation": "painting",
              "body": { "id": "img.jpg", "type": "Image",
                "service": [
                  { "id": "https://example.org/svc2", "type": "ImageService2", "width": 100, "height": 200 },
                  { "id": "https://example.org/svc3", "type": ["custom:Service", "http://iiif.io/api/image/3#ImageService"], "width": 800, "height": 1200 }
                ]
              }
            }]
          }]}]
        }
        "#;

        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        let infos = manifest.extract_image_infos("https://example.org/"); // Base URL for resolving "svc3"
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].image_uri, "https://example.org/svc3/info.json");
        assert_eq!(
            infos[0].size,
            Some(crate::model::Size {
                width: 800,
                height: 1200
            })
        );
    }

    #[test]
    fn test_service_id_already_has_info_json() {
        let json_data = r#"
        {
          "id": "manifest-info-json-in-id", "type": "Manifest",
          "items": [{ "id": "c1", "type": "Canvas", "items": [{ "id": "ap1", "type": "AnnotationPage", "items": [
            { "id": "a1", "type": "Annotation", "motivation": "painting",
              "body": { "id": "irrelevant.jpg", "type": "Image",
                "service": [ { "id": "https://example.org/iiif/img_already_info/info.json", "type": "ImageService3" } ]
              }
            }]
          }]}]
        }
        "#;

        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        // Base URL doesn't matter here as the service ID is absolute and complete
        let infos = manifest.extract_image_infos("https://unused.example.com/");
        assert_eq!(infos.len(), 1);
        assert_eq!(
            infos[0].image_uri,
            "https://example.org/iiif/img_already_info/info.json"
        );
    }

    #[test]
    fn test_multiple_canvases_and_images() {
        let json_data = r#"
        {
          "id": "multi-manifest", "type": "Manifest", "label": {"en": ["Multi"]},
          "items": [
            {
              "id": "c1", "type": "Canvas", "label": {"en": ["Canvas 1"]},
              "items": [{ "id": "ap1", "type": "AnnotationPage", "items": [{
                  "id": "a1", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "img1.jpg", "type": "Image", "service": [{"id": "svc1", "type": "ImageService2"}] }
              }]}]
            },
            {
              "id": "c2", "type": "Canvas", "label": {"en": ["Canvas 2"]},
              "items": [{ "id": "ap2", "type": "AnnotationPage", "items": [
                  { "id": "a2.1", "type": "Annotation", "motivation": "painting",
                    "body": { "id": "img2.1.jpg", "type": "Image", "service": [{"id": "svc2.1", "type": "ImageService3"}] }},
                  { "id": "a2.2", "type": "Annotation", "motivation": "painting",
                    "body": { "id": "img2.2.png", "type": "Image" }}
              ]}]
            }
          ]
        }
        "#;

        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        let manifest_base_url = "https://example.com/base/";
        let infos = manifest.extract_image_infos(manifest_base_url);
        assert_eq!(infos.len(), 3);

        assert_eq!(
            infos[0].image_uri,
            "https://example.com/base/svc1/info.json"
        );
        assert_eq!(infos[0].manifest_label, Some("Multi".to_string()));
        assert_eq!(infos[0].canvas_label, Some("Canvas 1".to_string()));
        assert_eq!(infos[0].canvas_index, 0);

        assert_eq!(
            infos[1].image_uri,
            "https://example.com/base/svc2.1/info.json"
        );
        assert_eq!(infos[1].manifest_label, Some("Multi".to_string()));
        assert_eq!(infos[1].canvas_label, Some("Canvas 2".to_string()));
        assert_eq!(infos[1].canvas_index, 1);

        assert_eq!(infos[2].image_uri, "https://example.com/base/img2.2.png");
        assert_eq!(infos[2].manifest_label, Some("Multi".to_string()));
        assert_eq!(infos[2].canvas_label, Some("Canvas 2".to_string()));
        assert_eq!(infos[2].canvas_index, 1);
    }

    #[test]
    fn test_real_world_example_bl_digirati_simplified() {
        let json_data = r#"
        {
            "@context": "http://iiif.io/api/presentation/3/context.json",
            "id": "https://bl.digirati.io/iiif/ark:/81055/man_10000006.0x000001",
            "type": "Manifest",
            "label": { "en": [ "Cotton MS Nero D IV" ] },
            "items": [ {
                "id": "...", "type": "Canvas", "label": { "en": [ "Front cover" ] },
                "items": [ {
                    "id": "...", "type": "AnnotationPage",
                    "items": [ {
                        "id": "...", "type": "Annotation", "motivation": "painting",
                        "body": {
                            "id": ".../default.jpg", "type": "Image",
                            "service": [
                                { "@id": "https://bl.digirati.io/images/ark:/81055/81055/man_10000006.0x000002", "@type": "ImageService2" },
                                { "id": "https://dlcs.bl.digirati.io/iiif-img/v3/.../man_10000006.0x000002", "type": "ImageService3" }
                            ]
                        }
                    } ]
                } ]
            } ]
        }
        "#;

        let manifest: Manifest = serde_json::from_str(json_data).expect("Failed to parse manifest");
        let infos = manifest
            .extract_image_infos("https://bl.digirati.io/iiif/ark:/81055/man_10000006.0x000001");
        assert_eq!(infos.len(), 1);
        // Should pick ImageService3
        assert_eq!(
            infos[0].image_uri,
            "https://dlcs.bl.digirati.io/iiif-img/v3/.../man_10000006.0x000002/info.json"
        );
        assert_eq!(
            infos[0].manifest_label,
            Some("Cotton MS Nero D IV".to_string())
        );
        assert_eq!(infos[0].canvas_label, Some("Front cover".to_string()));
    }

    #[test]
    fn test_legacy_manifest_prefers_service_and_handles_arrays() {
        let json_data = r#"{
          "@type":"sc:Manifest","label":"A Young Lady with a Parrot","sequences":[{"canvases":[
            {"label":"AIC canvas","images":[{"resource":{"@type":"dctypes:Image","@id":"https://www.artic.edu/iiif/2/2d9fb8b5-b9a3-3e41-270e-3c480f7b317b/full/843,/0/default.jpg","service":{"@id":"https://www.artic.edu/iiif/2/2d9fb8b5-b9a3-3e41-270e-3c480f7b317b","@context":"http://iiif.io/api/image/2/context.json"}}}]},
            {"label":"Array canvas","images":[{"resource":{"@id":"thumbnail.jpg","service":[{"@id":"svc2","@type":"ImageService2"},{"id":"svc3","type":"ImageService3"}]}}]}
          ]}]
        }"#;

        let manifest: LegacyManifest = serde_json::from_str(json_data).unwrap();
        let infos = manifest.extract_image_infos("https://example.org/manifest.json");

        assert_eq!(infos.len(), 2);
        assert_eq!(
            infos[0].image_uri,
            "https://www.artic.edu/iiif/2/2d9fb8b5-b9a3-3e41-270e-3c480f7b317b/info.json"
        );
        assert_eq!(infos[0].canvas_label, Some("AIC canvas".to_string()));
        assert_eq!(infos[0].canvas_index, 0);
        assert_eq!(infos[1].image_uri, "https://example.org/svc3/info.json");
        assert_eq!(infos[1].canvas_label, Some("Array canvas".to_string()));
        assert_eq!(infos[1].canvas_index, 1);
    }

    #[test]
    fn test_v1_metadata_manifest_uses_legacy_sequence_canvas_images_shape() {
        let json_data = r#"{
          "@context":"http://www.shared-canvas.org/ns/context.json","@type":"sc:Manifest",
          "label":"Book 1","sequences":[{"canvases":[{"label":"p. 1","images":[{"resource":{
            "@id":"http://www.example.org/iiif/book1/res/page1.jpg","@type":"dctypes:Image",
            "service":{"@id":"http://www.example.org/images/book1-page1","@context":"http://library.stanford.edu/iiif/image-api/1.1/context.json"}
          }}]}]}]
        }"#;

        let manifest: LegacyManifest = serde_json::from_str(json_data).unwrap();
        let infos = manifest.extract_image_infos("http://www.example.org/iiif/book1/manifest");

        assert_eq!(infos.len(), 1);
        assert_eq!(
            infos[0].image_uri,
            "http://www.example.org/images/book1-page1/info.json"
        );
        assert_eq!(infos[0].manifest_label, Some("Book 1".to_string()));
        assert_eq!(infos[0].canvas_label, Some("p. 1".to_string()));
        assert_eq!(infos[0].canvas_index, 0);
    }

    #[test]
    fn test_empty_annotation_body_or_unsupported() {
        let json_data = r#"
        {
          "id": "manifest-empty-body", "type": "Manifest",
          "items": [{ "id": "c1", "type": "Canvas", "items": [{ "id": "ap1", "type": "AnnotationPage", "items": [
            { "id": "a1", "type": "Annotation", "motivation": "painting", "body": {} },
            { "id": "a2", "type": "Annotation", "motivation": "painting" }
          ]}]}]
        }
        "#;
        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        let infos = manifest.extract_image_infos("https://example.org/");
        assert_eq!(
            infos.len(),
            0,
            "Expected no image infos from empty or unsupported bodies"
        );
    }

    #[test]
    fn test_array_annotation_bodies_extract_each_image() {
        let json_data = r#"
        {
          "id": "manifest-array-body", "type": "Manifest",
          "items": [{ "id": "c1", "type": "Canvas", "items": [{ "id": "ap1", "type": "AnnotationPage", "items": [
            { "id": "a1", "type": "Annotation", "motivation": "painting",
              "body": [
                { "id": "https://example.org/images/thumbnail.jpg", "type": "Image" },
                { "id": "img_full.jpg", "type": "Image", "service": [{ "id": "svc_full", "type": "ImageService3" }] }
              ]
            },
            { "id": "a2", "type": "Annotation", "motivation": "painting", "body": [] }
          ]}]}]
        }
        "#;
        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        let infos = manifest.extract_image_infos("https://example.org/manifest");
        assert_eq!(infos.len(), 2);
        assert_eq!(
            infos[0].image_uri,
            "https://example.org/images/thumbnail.jpg"
        );
        assert_eq!(infos[1].image_uri, "https://example.org/svc_full/info.json");
    }

    #[test]
    fn test_uri_resolution_in_extract_image_infos() {
        let manifest_url = "https://example.com/iiif/collection1/bookA/manifest.json";
        let json_data = r#"
        {
          "id": "relative-uri-manifest", "type": "Manifest", "label": {"en": ["Relative Test"]},
          "items": [
            {
              "id": "c1", "type": "Canvas", "label": {"en": ["Canvas 1 Rel Svc"]},
              "items": [{"id": "ap1", "type": "AnnotationPage", "items": [{
                  "id": "a1", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "img1.jpg", "type": "Image", "service": [{"id": "../images/page1_svc", "type": "ImageService2"}]}
              }]}]
            },
            {
              "id": "c2", "type": "Canvas", "label": {"en": ["Canvas 2 Abs Path Svc"]},
              "items": [{"id": "ap2", "type": "AnnotationPage", "items": [{
                  "id": "a2", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "img2.jpg", "type": "Image", "service": [{"id": "/abs/path/to/img_svc", "type": "ImageService3"}]}
              }]}]
            },
            {
              "id": "c3", "type": "Canvas", "label": {"en": ["Canvas 3 Rel Direct Img"]},
              "items": [{"id": "ap3", "type": "AnnotationPage", "items": [{
                  "id": "a3", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "images/cover.jpg", "type": "Image" }
              }]}]
            },
            {
              "id": "c4", "type": "Canvas", "label": {"en": ["Canvas 4 Full URL Svc"]},
              "items": [{"id": "ap4", "type": "AnnotationPage", "items": [{
                  "id": "a4", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "img4.jpg", "type": "Image", "service": [{"id": "https://other.example.net/iiif/itemQ/svc", "type": "ImageService2"}]}
              }]}]
            },
            {
              "id": "c5", "type": "Canvas", "label": {"en": ["Canvas 5 Rel Svc No Slash"]},
              "items": [{"id": "ap5", "type": "AnnotationPage", "items": [{
                  "id": "a5", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "img5.jpg", "type": "Image", "service": [{"id": "images_rel_noslash_svc", "type": "ImageService2"}]}
              }]}]
            }
          ]
        }
        "#;
        let manifest: Manifest = serde_json::from_str(json_data).unwrap();
        let infos = manifest.extract_image_infos(manifest_url);

        assert_eq!(infos.len(), 5);

        assert_eq!(
            infos[0].image_uri,
            "https://example.com/iiif/collection1/images/page1_svc/info.json"
        );
        assert_eq!(infos[0].canvas_label, Some("Canvas 1 Rel Svc".to_string()));

        assert_eq!(
            infos[1].image_uri,
            "https://example.com/abs/path/to/img_svc/info.json"
        );
        assert_eq!(
            infos[1].canvas_label,
            Some("Canvas 2 Abs Path Svc".to_string())
        );

        assert_eq!(
            infos[2].image_uri,
            "https://example.com/iiif/collection1/bookA/images/cover.jpg"
        );
        assert_eq!(
            infos[2].canvas_label,
            Some("Canvas 3 Rel Direct Img".to_string())
        );

        assert_eq!(
            infos[3].image_uri,
            "https://other.example.net/iiif/itemQ/svc/info.json"
        );
        assert_eq!(
            infos[3].canvas_label,
            Some("Canvas 4 Full URL Svc".to_string())
        );

        assert_eq!(
            infos[4].image_uri,
            "https://example.com/iiif/collection1/bookA/images_rel_noslash_svc/info.json"
        );
        assert_eq!(
            infos[4].canvas_label,
            Some("Canvas 5 Rel Svc No Slash".to_string())
        );
    }
}
