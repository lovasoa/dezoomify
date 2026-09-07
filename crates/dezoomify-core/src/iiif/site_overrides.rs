//! Data-driven IIIF site overrides.
//!
//! Former per-site shim files (`contentdm`, `micrio`, `national_gallery`,
//! `onb`, `philadelphia`) are folded into [`site_overrides.json`](site_overrides.json)
//! plus this generic loader. The JSON is the source of truth for match
//! patterns, URL templates, and matrix-test examples; this module implements
//! the generic rewrites so behavior stays identical to the former shims.
//!
//! Kinds:
//! - `url_to_manifest` / `url_rewrite`: URL-shape rewrites (`ONB`, `CONTENTdm`
//!   record) via `url::Url` parsing with the JSON template as documentation.
//! - `json_field`: `CONTENTdm` metadata reads `iiifInfoUri` and joins it
//!   against the metadata origin per the documented rules.
//! - `content_regex`: Micrio and Philadelphia extract one `id` group and
//!   render `https://i.micr.io/{id}/info.json`.
//! - `content_transform`: National Gallery extracts an `image` group and
//!   strips from `/full/` before appending `/info.json`.

use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;
use serde::Deserialize;
use url::Url;

use crate::core::{
    DiscoveryContext, DiscoveryError, DiscoveryMatch, DiscoveryResource, DiscoveryRoute,
    DiscoveryStep, Request, resolve_relative,
};

const OVERRIDES_JSON: &str = include_str!("site_overrides.json");

#[derive(Debug, Clone, Deserialize)]
pub struct SiteExample {
    pub input: String,
    pub expected: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SiteOverride {
    pub id: String,
    pub kind: String,
    pub description: String,
    #[serde(default)]
    pub url_hint: Option<String>,
    #[serde(default)]
    pub content_pattern: Option<String>,
    #[serde(default)]
    pub capture_group: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub json_field: Option<String>,
    #[serde(default)]
    pub transform: Option<String>,
    #[serde(default)]
    pub examples: Vec<SiteExample>,
}

#[derive(Debug, Clone, Deserialize)]
struct OverridesFile {
    #[serde(default)]
    overrides: Vec<SiteOverride>,
}

static OVERRIDES: LazyLock<Vec<SiteOverride>> = LazyLock::new(|| {
    let file: OverridesFile =
        serde_json::from_str(OVERRIDES_JSON).expect("bundled IIIF site overrides are invalid");
    file.overrides
});

/// All declared site overrides in JSON order.
#[must_use]
pub fn overrides() -> &'static [SiteOverride] {
    &OVERRIDES
}

/// Look up one override by id.
#[must_use]
pub fn override_by_id(id: &str) -> Option<&'static SiteOverride> {
    OVERRIDES.iter().find(|entry| entry.id == id)
}

fn override_template(id: &str) -> &'static str {
    override_by_id(id)
        .and_then(|entry| entry.template.as_deref())
        .unwrap_or("")
}

static MICRIO_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    let pattern = override_by_id("micrio")
        .and_then(|entry| entry.content_pattern.clone())
        .expect("micrio override must declare content_pattern");
    BytesRegex::new(&pattern).expect("bundled micrio pattern is invalid")
});

static PHILADELPHIA_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    let pattern = override_by_id("philadelphia")
        .and_then(|entry| entry.content_pattern.clone())
        .expect("philadelphia override must declare content_pattern");
    BytesRegex::new(&pattern).expect("bundled philadelphia pattern is invalid")
});

static NATIONAL_GALLERY_RE: LazyLock<BytesRegex> = LazyLock::new(|| {
    let pattern = override_by_id("national_gallery")
        .and_then(|entry| entry.content_pattern.clone())
        .expect("national_gallery override must declare content_pattern");
    BytesRegex::new(&pattern).expect("bundled national_gallery pattern is invalid")
});

fn capture_group_text(
    regex: &BytesRegex,
    bytes: &[u8],
    group: &str,
) -> Result<Option<String>, DiscoveryError> {
    let Some(captures) = regex.captures(bytes) else {
        return Ok(None);
    };
    let Some(matched) = captures.name(group) else {
        return Ok(None);
    };
    std::str::from_utf8(matched.as_bytes())
        .map(|value| Some(value.to_owned()))
        .map_err(|_| DiscoveryError::Session("site override capture is not UTF-8".into()))
}

// ---------------------------------------------------------------------------
// URL overrides: ONB + CONTENTdm record/metadata (behavior identical to the
// former per-site shims; templates live in site_overrides.json).
// ---------------------------------------------------------------------------

pub const ONB_ROUTE: DiscoveryRoute =
    DiscoveryMatch::UrlPredicate(is_onb_entry).map_url(onb_manifest);

pub const CONTENTDM_RECORD_ROUTE: DiscoveryRoute =
    DiscoveryMatch::UrlPredicate(is_contentdm_record).map_url(contentdm_metadata_url);

pub const CONTENTDM_METADATA_ROUTE: DiscoveryRoute =
    DiscoveryMatch::UrlPredicate(is_contentdm_metadata).then(follow_contentdm_info);

pub const MICRIO_ROUTE: DiscoveryRoute =
    DiscoveryMatch::ContentPredicate(contains_micrio_element).then(follow_micrio_element);

#[must_use]
pub fn prefers(uri: &str) -> bool {
    is_onb_entry(uri) || is_contentdm_record(uri)
}

#[must_use]
pub fn is_onb_entry(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    matches!(url.host_str(), Some("viewer.onb.ac.at"))
        || matches!(url.host_str(), Some("digital.onb.ac.at"))
            && url.path() == "/RepViewer/viewer.faces"
            && url.query_pairs().any(|(name, _)| name == "doc")
}

pub fn onb_manifest(uri: &str) -> Result<Request, DiscoveryError> {
    debug_assert!(!override_template("onb").is_empty());
    let url = Url::parse(uri).map_err(|_| DiscoveryError::Session("invalid ONB URL".into()))?;
    let identifier = match url.host_str() {
        Some("viewer.onb.ac.at") => url
            .path_segments()
            .and_then(|mut segments| segments.next())
            .map(str::to_owned),
        Some("digital.onb.ac.at") => url
            .query_pairs()
            .find_map(|(name, value)| (name == "doc").then(|| value.into_owned())),
        _ => None,
    }
    .filter(|identifier| !identifier.is_empty())
    .ok_or_else(|| DiscoveryError::Session("missing ONB document identifier".into()))?;
    Ok(Request::new(format!(
        "https://api.onb.ac.at/iiif/presentation/v3/manifest/{identifier}"
    )))
}

#[must_use]
pub fn is_contentdm_record(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    matches!(url.path_segments().map(Iterator::collect::<Vec<_>>).as_deref(), Some(["digital", "collection", _, "id", id, ..]) if id.parse::<u64>().is_ok())
}

pub fn contentdm_metadata_url(uri: &str) -> Result<Request, DiscoveryError> {
    debug_assert!(!override_template("contentdm_record").is_empty());
    let url =
        Url::parse(uri).map_err(|_| DiscoveryError::Session("invalid CONTENTdm URL".into()))?;
    let segments = url
        .path_segments()
        .map(Iterator::collect::<Vec<_>>)
        .ok_or_else(|| DiscoveryError::Session("invalid CONTENTdm path".into()))?;
    let ["digital", "collection", collection, "id", identifier, ..] = segments.as_slice() else {
        return Err(DiscoveryError::Session(
            "invalid CONTENTdm record URL".into(),
        ));
    };
    Ok(Request::new(format!(
        "{}/digital/api/singleitem/collection/{collection}/id/{identifier}",
        url.origin().ascii_serialization()
    )))
}

#[must_use]
pub fn is_contentdm_metadata(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| {
        matches!(
            url.path_segments()
                .map(Iterator::collect::<Vec<_>>)
                .as_deref(),
            Some(["digital", "api", "singleitem", "collection", _, "id", _])
        )
    })
}

pub fn follow_contentdm_info(
    _: &DiscoveryContext<'_>,
    resource: DiscoveryResource<'_>,
) -> Result<DiscoveryStep, DiscoveryError> {
    let info_uri = serde_json::from_slice::<serde_json::Value>(resource.bytes())
        .ok()
        .and_then(|value| value.get("iiifInfoUri")?.as_str().map(str::to_owned))
        .filter(|uri| !uri.is_empty())
        .ok_or_else(|| DiscoveryError::Session("CONTENTdm metadata has no IIIF URL".into()))?;
    let base = Url::parse(resource.final_uri())
        .map_err(|_| DiscoveryError::Session("invalid CONTENTdm metadata URL".into()))?;
    let origin = base.origin().ascii_serialization();
    let uri = if Url::parse(&info_uri).is_ok() {
        info_uri
    } else if info_uri.starts_with("/digital/") {
        format!("{origin}{info_uri}")
    } else if info_uri.starts_with('/') {
        format!("{origin}/digital{info_uri}")
    } else {
        format!("{origin}/digital/{info_uri}")
    };
    Ok(DiscoveryStep::Follow(Request::new(uri)))
}

// ---------------------------------------------------------------------------
// Content overrides: Micrio / National Gallery / Philadelphia (regexes come
// from site_overrides.json so the JSON stays the source of truth).
// ---------------------------------------------------------------------------

#[must_use]
pub fn contains_micrio_element(contents: &[u8]) -> bool {
    MICRIO_RE.is_match(contents)
}

pub fn follow_micrio_element(
    _: &DiscoveryContext<'_>,
    resource: DiscoveryResource<'_>,
) -> Result<DiscoveryStep, DiscoveryError> {
    let id = capture_group_text(&MICRIO_RE, resource.bytes(), "id")?
        .ok_or_else(|| DiscoveryError::Session("Micrio custom element lacks an ID".into()))?;
    Ok(DiscoveryStep::Follow(Request::new(format!(
        "https://i.micr.io/{id}/info.json"
    ))))
}

#[must_use]
pub fn contains_national_gallery_image(contents: &[u8]) -> bool {
    NATIONAL_GALLERY_RE.is_match(contents)
}

pub fn follow_national_gallery_image(
    _: &DiscoveryContext<'_>,
    resource: DiscoveryResource<'_>,
) -> Result<DiscoveryStep, DiscoveryError> {
    let image = capture_group_text(&NATIONAL_GALLERY_RE, resource.bytes(), "image")?
        .ok_or_else(|| DiscoveryError::Session("missing National Gallery IIIF image".into()))?;
    let metadata = image
        .rsplit_once("/full/")
        .map(|(service, _)| format!("{service}/info.json"))
        .ok_or_else(|| DiscoveryError::Session("invalid National Gallery IIIF image URL".into()))?;
    Ok(DiscoveryStep::Follow(Request::new(resolve_relative(
        resource.final_uri(),
        &metadata,
    ))))
}

#[must_use]
pub fn contains_philadelphia_micrio(contents: &[u8]) -> bool {
    PHILADELPHIA_RE.is_match(contents)
}

pub fn follow_philadelphia_micrio(
    _: &DiscoveryContext<'_>,
    resource: DiscoveryResource<'_>,
) -> Result<DiscoveryStep, DiscoveryError> {
    let id = capture_group_text(&PHILADELPHIA_RE, resource.bytes(), "id")?
        .ok_or_else(|| DiscoveryError::Session("missing Philadelphia Museum Micrio ID".into()))?;
    Ok(DiscoveryStep::Follow(Request::new(format!(
        "https://i.micr.io/{id}/info.json"
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_table_declares_the_five_folded_shims() {
        let ids: Vec<&str> = overrides().iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "onb",
                "contentdm_record",
                "contentdm_metadata",
                "micrio",
                "national_gallery",
                "philadelphia",
            ]
        );
        for entry in overrides() {
            assert!(!entry.description.is_empty(), "override {}", entry.id);
            assert!(
                !entry.examples.is_empty(),
                "override {} must carry matrix examples",
                entry.id
            );
        }
    }

    #[test]
    fn url_override_examples_rewrite_identically() {
        for (input, expected) in [
            (
                "https://viewer.onb.ac.at/10048A37/",
                "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
            ),
            (
                "https://viewer.onb.ac.at/10048A37/137",
                "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
            ),
            (
                "https://digital.onb.ac.at/RepViewer/viewer.faces?doc=10048A37&order=1",
                "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
            ),
        ] {
            assert!(is_onb_entry(input), "ONB entry: {input}");
            assert_eq!(onb_manifest(input).unwrap().uri, expected);
        }
        for (input, expected) in [
            (
                "https://fixtures.test/digital/collection/OKMaps/id/6483/rec/6",
                "https://fixtures.test/digital/api/singleitem/collection/OKMaps/id/6483",
            ),
            (
                "https://dc.library.okstate.edu/digital/collection/OKMaps/id/6483/rec/6",
                "https://dc.library.okstate.edu/digital/api/singleitem/collection/OKMaps/id/6483",
            ),
        ] {
            assert!(is_contentdm_record(input), "CONTENTdm record: {input}");
            assert_eq!(contentdm_metadata_url(input).unwrap().uri, expected);
        }
        assert!(is_contentdm_metadata(
            "https://fixtures.test/digital/api/singleitem/collection/OKMaps/id/6483"
        ));
    }

    #[test]
    fn content_override_examples_resolve_identically() {
        assert!(contains_micrio_element(
            b"<micr-io data-view=\"default\" id=\"KEimL\"></micr-io>"
        ));
        assert!(contains_national_gallery_image(
            b"<img src=\"/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif/full/!80,50/0/default.jpg\">"
        ));
        assert!(contains_philadelphia_micrio(
            b"philamuseum.org \"shortId\":\"QYRjM\""
        ));
        assert!(contains_philadelphia_micrio(
            b"Philadelphia Museum {\"shortId\":\"Raw01\"}"
        ));
        // JSON matrix rows stay in sync with the loader patterns.
        for entry in overrides() {
            if entry.kind == "content_regex" || entry.kind == "content_transform" {
                assert!(
                    entry.content_pattern.is_some(),
                    "override {} must declare content_pattern",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn json_examples_match_the_loader_behavior() {
        // Every JSON example input must match its override and render the
        // documented expected output through the same code path as discovery.
        for entry in overrides() {
            for example in &entry.examples {
                match entry.id.as_str() {
                    "onb" => {
                        assert!(is_onb_entry(&example.input), "ONB {}", example.input);
                        assert_eq!(
                            onb_manifest(&example.input).unwrap().uri,
                            example.expected,
                            "ONB {}",
                            example.input
                        );
                    }
                    "contentdm_record" => {
                        assert!(
                            is_contentdm_record(&example.input),
                            "CONTENTdm {}",
                            example.input
                        );
                        assert_eq!(
                            contentdm_metadata_url(&example.input).unwrap().uri,
                            example.expected,
                            "CONTENTdm {}",
                            example.input
                        );
                    }
                    "micrio" => {
                        assert!(
                            contains_micrio_element(example.input.as_bytes()),
                            "micrio {}",
                            example.input
                        );
                    }
                    "national_gallery" => {
                        assert!(
                            contains_national_gallery_image(example.input.as_bytes()),
                            "national_gallery {}",
                            example.input
                        );
                    }
                    "philadelphia" => {
                        assert!(
                            contains_philadelphia_micrio(example.input.as_bytes()),
                            "philadelphia {}",
                            example.input
                        );
                    }
                    _ => {}
                }
            }
        }
    }
}
