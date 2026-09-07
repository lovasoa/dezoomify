//! IIIF Presentation API manifest parsing.
//!
//! Split from `iiif/mod.rs` (todo 4.1): this module owns v2/v3 manifest
//! detection and `info.json` extraction, including Mirador 3 / Universal
//! Viewer `items` variants (see [`crate::iiif::manifest_types`]). Discovery
//! orchestration and tile levels live in `super` / `levels`.

use crate::iiif::IIIFError;
use crate::iiif::manifest_types;

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

pub(crate) fn manifest_type_warning(contents: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<serde_json::Value>(contents).ok()?;
    let type_value = value.get("type").or_else(|| value.get("@type"))?;
    let type_name = type_value.as_str()?;
    (!matches!(
        type_name,
        "Manifest" | "sc:Manifest" | "ImageService2" | "ImageService3" | "iiif:ImageProfile"
    ))
    .then(|| format!("IIIF manifest has unexpected type '{type_name}'; attempting lenient parsing"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{CatalogEntry, ImageCatalog};
    use crate::iiif::{catalog_for_tests, determine_title};

    fn legacy_manifest_data() -> &'static [u8] {
        r#"{
          "@context":"http://iiif.io/api/presentation/2/context.json","@type":"sc:Manifest",
          "label":"Legacy Book","sequences":[{"canvases":[{"label":"Page 1","images":[{"resource":{
            "@type":"dctypes:Image","@id":"https://example.com/iiif/page1/full/843,/0/default.jpg",
            "service":{"@id":"https://example.com/iiif/page1"}
          }}]}]}]
        }"#
        .as_bytes()
    }

    #[test]
    fn test_parse_simple_manifest_from_bytes() {
        let manifest_url = "https://example.com/manifest.json";
        let json_data = r#"
        {
          "@context": "http://iiif.io/api/presentation/3/context.json",
          "id": "https://example.org/iiif/book1/manifest",
          "type": "Manifest",
          "label": { "en": [ "Book Example" ] },
          "items": [
            {
              "id": "canvas1",
              "type": "Canvas",
              "label": { "en": [ "Page 1" ] },
              "items": [
                {
                  "id": "anno_page1",
                  "type": "AnnotationPage",
                  "items": [
                    {
                      "id": "anno1",
                      "type": "Annotation",
                      "motivation": "painting",
                      "body": {
                        "id": "http://example.images/page1_img_direct.jpg",
                        "type": "Image",
                        "service": [
                          {
                            "id": "svc/page1_svc",
                            "type": "ImageService2"
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
        let infos = parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url).unwrap();
        assert_eq!(infos.len(), 1);
        assert_eq!(
            infos[0],
            manifest_types::ExtractedImageInfo {
                image_uri: "https://example.com/svc/page1_svc/info.json".to_string(),
                manifest_label: Some("Book Example".to_string()),
                metadata_title: None,
                canvas_label: Some("Page 1".to_string()),
                canvas_index: 0,
            }
        );
    }

    #[test]
    fn test_parse_manifest_with_relative_paths_from_bytes() {
        let manifest_url = "https://library.example.edu/collection/item123/manifest.json";
        let json_data = r#"
        {
          "id": "relative-manifest",
          "type": "Manifest",
          "label": { "en": ["RelPath Test"] },
          "items": [
            {
              "id": "c1", "type": "Canvas", "label": {"en": ["C1 Rel Svc"]},
              "items": [{"id": "ap1", "type": "AnnotationPage", "items": [{"id": "a1", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "../images/image1.jpg", "type": "Image", "service": [{"id": "../services/image1_svc", "type": "ImageService3"}]}
              }]}]
            },
            {
              "id": "c2", "type": "Canvas", "label": {"en": ["C2 Abs Path Svc"]},
              "items": [{"id": "ap2", "type": "AnnotationPage", "items": [{"id": "a2", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "/img/abs_image2.png", "type": "Image", "service": [{"id": "/iiif-services/abs_image2_svc", "type": "ImageService2"}]}
              }]}]
            },
            {
              "id": "c3", "type": "Canvas", "label": {"en": ["C3 Direct Rel Img"]},
              "items": [{"id": "ap3", "type": "AnnotationPage", "items": [{"id": "a3", "type": "Annotation", "motivation": "painting",
                  "body": { "id": "images/cover_art.jpeg", "type": "Image" }
              }]}]
            }
          ]
        }
        "#;

        let infos = parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url).unwrap();
        assert_eq!(infos.len(), 3);

        assert_eq!(
            infos[0].image_uri,
            "https://library.example.edu/collection/services/image1_svc/info.json"
        );
        assert_eq!(infos[0].manifest_label, Some("RelPath Test".to_string()));
        assert_eq!(infos[0].canvas_label, Some("C1 Rel Svc".to_string()));

        assert_eq!(
            infos[1].image_uri,
            "https://library.example.edu/iiif-services/abs_image2_svc/info.json"
        );
        assert_eq!(infos[1].canvas_label, Some("C2 Abs Path Svc".to_string()));

        assert_eq!(
            infos[2].image_uri,
            "https://library.example.edu/collection/item123/images/cover_art.jpeg"
        );
        assert_eq!(infos[2].canvas_label, Some("C3 Direct Rel Img".to_string()));
    }

    #[test]
    fn test_parse_legacy_manifest_from_bytes() {
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
    }

    #[test]
    fn test_parse_invalid_json_manifest() {
        let manifest_url = "https://example.com/invalid.json";
        let json_data = r#"{ "id": "test", "type": "Manifest", items: [ -- broken json -- ] }"#;
        assert!(matches!(
            parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url),
            Err(crate::iiif::IIIFError::JsonError(_))
        ));
    }

    #[test]
    fn test_parse_json_not_a_manifest_type() {
        let manifest_url = "https://example.com/not_a_manifest.json";
        let json_data = r#"{
          "id": "test", "type": "NotAManifest",
          "items": [{"id":"canvas","type":"Canvas","items":[{"items":[{
            "motivation":"painting","body":{"id":"image.jpg","type":"Image",
            "service":[{"id":"https://example.com/iiif/page1","type":"ImageService3"}]}
          }]}]}]
        }"#;
        let infos = parse_iiif_manifest_from_bytes(json_data.as_bytes(), manifest_url).unwrap();
        assert_eq!(infos.len(), 1);

        let catalog = catalog_for_tests(manifest_url, json_data.as_bytes()).unwrap();
        let [CatalogEntry::Deferred(image)] = catalog.entries() else {
            panic!("lenient manifest parsing should produce one deferred image");
        };
        assert_eq!(
            image.warnings,
            ["IIIF manifest has unexpected type 'NotAManifest'; attempting lenient parsing"]
        );
    }

    #[test]
    fn test_images_with_manifest() {
        let manifest_data = r#"
        {
          "@context": "http://iiif.io/api/presentation/3/context.json",
          "id": "https://example.org/iiif/book1/manifest",
          "type": "Manifest",
          "label": { "en": [ "Test Book" ] },
          "items": [
            {
              "id": "canvas1",
              "type": "Canvas",
              "label": { "en": [ "Page 1" ] },
              "items": [
                {
                  "id": "anno_page1",
                  "type": "AnnotationPage",
                  "items": [
                    {
                      "id": "anno1",
                      "type": "Annotation",
                      "motivation": "painting",
                      "body": {
                        "id": "image.jpg",
                        "type": "Image",
                        "service": [
                          {
                            "id": "https://example.com/iiif/page1",
                            "type": "ImageService3"
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
        "#
        .as_bytes();

        let catalog =
            catalog_for_tests("https://example.com/manifest.json", manifest_data).unwrap();
        let [CatalogEntry::Deferred(image)] = catalog.entries() else {
            panic!("manifest should produce one deferred image");
        };
        assert_eq!(image.uri, "https://example.com/iiif/page1/info.json");
        assert_eq!(image.title.as_deref(), Some("Test Book - Page 1"));
    }

    #[test]
    fn test_images_with_legacy_manifest() {
        let catalog =
            catalog_for_tests("https://example.com/manifest.json", legacy_manifest_data()).unwrap();
        let [CatalogEntry::Deferred(image)] = catalog.entries() else {
            panic!("manifest should produce one deferred image");
        };
        assert_eq!(image.uri, "https://example.com/iiif/page1/info.json");
        assert_eq!(image.title.as_deref(), Some("Legacy Book - Page 1"));
    }

    #[test]
    fn test_images_with_info_json() {
        let info_data = r#"{
          "@context" : "http://iiif.io/api/image/2/context.json",
          "@id" : "https://example.com/image",
          "protocol" : "http://iiif.io/api/image",
          "width" : 1000,
          "height" : 1500,
          "tiles" : [
             { "width" : 512, "height" : 512, "scaleFactors" : [ 1, 2, 4 ] }
          ]
        }"#
        .as_bytes();

        let catalog = catalog_for_tests("https://example.com/image/info.json", info_data).unwrap();
        let [CatalogEntry::Ready(image)] = catalog.entries() else {
            panic!("info.json should produce one ready image");
        };
        assert_eq!(image.title, None);
        assert_eq!(image.levels.len(), 3);
    }

    #[test]
    fn invalid_image_id_warning_is_attached_to_image() {
        let info_data = br#"{
          "@id": "https://www.example.org/image",
          "width": 1000,
          "height": 1500,
          "tiles": [{"width": 512, "scaleFactors": [1]}]
        }"#;
        let catalog = catalog_for_tests("https://example.com/image/info.json", info_data).unwrap();
        let [CatalogEntry::Ready(image)] = catalog.entries() else {
            panic!("info.json should produce one ready image");
        };
        assert_eq!(
            image.warnings,
            ["Removed probably invalid IIIF image identifier"]
        );
    }

    #[test]
    fn unknown_profile_warning_is_attached_to_image() {
        let info_data = br#"{
          "width": 1000,
          "height": 1500,
          "profile": ["https://example.com/unknown-profile"],
          "tiles": [{"width": 512, "scaleFactors": [1]}]
        }"#;
        let catalog = catalog_for_tests("https://example.com/image/info.json", info_data).unwrap();
        let [CatalogEntry::Ready(image)] = catalog.entries() else {
            panic!("info.json should produce one ready image");
        };
        assert_eq!(
            image.warnings,
            [
                "Unknown IIIF profile reference 'https://example.com/unknown-profile'; using default capabilities"
            ]
        );
    }

    #[test]
    fn mirador_and_uv_items_variants_resolve() {
        // Mirador 3 wraps the painting annotation body in an `items` array
        // variant already covered by Multiple bodies; UV emits a bare Image
        // body with an ImageService3 id. Both must resolve to info.json.
        for body in [
            r#"{"id": "img.jpg", "type": "Image", "service": [{"id": "https://example.com/iiif/uv", "type": "ImageService3"}]}"#,
            r#"[{"id": "https://example.com/iiif/m3a", "type": "Image"}, {"id": "img.jpg", "type": "Image", "service": [{"id": "https://example.com/iiif/m3b", "type": "ImageService3"}]}]"#,
        ] {
            let json_data = format!(
                r#"{{
                  "id": "variant", "type": "Manifest",
                  "items": [{{ "id": "c1", "type": "Canvas",
                    "items": [{{ "id": "ap1", "type": "AnnotationPage", "items": [
                      {{ "id": "a1", "type": "Annotation", "motivation": "painting", "body": {body} }}
                    ]}}]}}]
                }}"#
            );
            let infos =
                parse_iiif_manifest_from_bytes(json_data.as_bytes(), "https://example.com/m/")
                    .unwrap();
            assert!(!infos.is_empty(), "variant body must resolve: {body}");
            assert!(
                infos
                    .iter()
                    .all(|info| info.image_uri.starts_with("https://example.com/")),
                "unexpected uris: {:?}",
                infos.iter().map(|info| &info.image_uri).collect::<Vec<_>>()
            );
        }
        let _ = determine_title as fn(_) -> _;
        let _ = ImageCatalog::default();
    }
}
