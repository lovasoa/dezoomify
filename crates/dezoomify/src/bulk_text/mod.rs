//! Pure discovery for text files containing deferred image URLs.

use crate::core::discovery::{Specificity::Low, metadata, url_matches};
use crate::core::{CatalogPlan, DeferredResource, DiscoveryError, FormatSpec, ParsedResource};

pub const SPEC: FormatSpec = FormatSpec::new(
    "bulk_text",
    &[metadata(url_matches(is_bulk_file).specificity(Low)).decode(decode_catalog)],
)
.with_display_name("Bulk text");

fn decode_catalog(
    resource: crate::core::DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let (uri, bytes) = (resource.final_uri(), resource.bytes());
    let text = std::str::from_utf8(bytes).map_err(|error| {
        DiscoveryError::InvalidMetadata(format!("failed to parse bulk list as UTF-8: {error}"))
    })?;
    let images = parse_text_urls_with_base(text, uri)?;
    if images.is_empty() {
        return Err(DiscoveryError::InvalidMetadata(
            "no valid URLs found in text file".into(),
        ));
    }
    Ok(ParsedResource::Catalog(CatalogPlan::deferred(
        images.into_iter().map(|image| DeferredResource {
            uri: image.uri,
            title: image.title,
            size: None,
            preview: None,
            warnings: Vec::new(),
        }),
    )))
}

#[cfg(test)]
fn catalog(uri: &str, bytes: &[u8]) -> Result<crate::core::DiscoveryCatalog, DiscoveryError> {
    decode_catalog(crate::core::DiscoveryResource::new(uri, bytes))?.compile("bulk_text")
}

fn is_bulk_file(uri: &str) -> bool {
    crate::core::uri::parse_uri(uri).is_ok_and(|url| {
        url.path().rsplit_once('.').is_some_and(|(_, extension)| {
            extension.eq_ignore_ascii_case("txt") || extension.eq_ignore_ascii_case("urls")
        })
    }) && !uri.contains("{{")
        && !uri.contains("}}")
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ListedImage {
    uri: String,
    title: Option<String>,
}

#[cfg(test)]
fn parse_text_urls(content: &str) -> Result<Vec<ListedImage>, DiscoveryError> {
    parse_text_urls_with_base(content, "")
}

fn parse_text_urls_with_base(
    content: &str,
    base_uri: &str,
) -> Result<Vec<ListedImage>, DiscoveryError> {
    content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let line = line.trim();
            (!line.is_empty() && !line.starts_with('#')).then(|| (index + 1, line))
        })
        .map(|(line_number, line)| {
            let mut parts = line.splitn(2, char::is_whitespace);
            let raw_uri = parts.next().unwrap_or_default();
            validate_uri(raw_uri, line_number)?;
            let uri = crate::core::resolve_relative(base_uri, raw_uri);
            let title = parts
                .next()
                .filter(|title| !title.is_empty())
                .map(str::to_owned);
            Ok(ListedImage { uri, title })
        })
        .collect()
}

fn validate_uri(input: &str, line: usize) -> Result<(), DiscoveryError> {
    if url::Url::parse(input).is_ok()
        || input.contains("{{X}}")
        || input.contains("{{Y}}")
        || input.starts_with(['/', '.', '\\'])
        || input.contains(['/', '\\'])
        || (input.len() >= 2
            && input.as_bytes()[1] == b':'
            && input.as_bytes()[0].is_ascii_alphabetic())
        || (input.contains('.') && !input.contains(' ') && !input.contains("://"))
    {
        return Ok(());
    }
    Err(DiscoveryError::InvalidMetadata(format!(
        "on line {line}: '{input}' is not a valid URL or file path"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{DiscoveredEntry, DiscoveryCatalog};

    fn complete(uri: &str, content: &str) -> Result<DiscoveryCatalog, DiscoveryError> {
        catalog(uri, content.as_bytes())
    }

    #[test]
    fn signed_list_files_remain_discoverable_without_filename_guesses() {
        const INPUT: &str = "https://images.test/batch.txt?token=exact%2Bvalue";
        let (catalog, requests) =
            crate::test_support::discover(SPEC, INPUT, &[(b"https://images.test/art.dzi", None)]);
        assert!(matches!(
            catalog.unwrap().entries(),
            [DiscoveredEntry::Deferred(image)] if image.uri == "https://images.test/art.dzi"
        ));
        assert_eq!(requests[0].uri, INPUT);
        for unrelated in [
            "https://images.test/playlist.js",
            "https://images.test/bulk.css",
        ] {
            let (result, requests) = crate::test_support::discover(SPEC, unrelated, &[]);
            assert!(result.is_err());
            assert!(requests.is_empty());
        }
    }

    #[test]
    fn parses_urls_titles_paths_and_invalid_content() {
        assert!(parse_text_urls("").unwrap().is_empty());
        assert!(
            parse_text_urls("# comment\n\n   \n# another")
                .unwrap()
                .is_empty()
        );
        let images = parse_text_urls(
            "# comment\nhttps://example.test/a.jpg A title\n./local.dzi\nhttps://example.org/manifest.json",
        )
        .unwrap();
        assert_eq!(
            images,
            vec![
                ListedImage {
                    uri: "https://example.test/a.jpg".into(),
                    title: Some("A title".into())
                },
                ListedImage {
                    uri: "./local.dzi".into(),
                    title: None
                },
                ListedImage {
                    uri: "https://example.org/manifest.json".into(),
                    title: None
                },
            ]
        );
        let error = parse_text_urls("not_a_valid_url").unwrap_err().to_string();
        assert!(error.contains("line 1") && error.contains("not_a_valid_url"));
    }

    #[test]
    fn relative_entries_use_the_list_directory_and_preserve_templates() {
        for (base, expected) in [
            (
                "/pictures/My collection/list.txt",
                "/pictures/My collection/./art/image.dzi",
            ),
            (r"C:\pictures\list.urls", r"C:\pictures/./art/image.dzi"),
            (
                "https://images.test/catalog/list.txt",
                "https://images.test/catalog/art/image.dzi",
            ),
        ] {
            let images = parse_text_urls_with_base("./art/image.dzi Painting", base).unwrap();
            assert_eq!(images[0].uri, expected);
            assert_eq!(images[0].title.as_deref(), Some("Painting"));
        }
        let images =
            parse_text_urls_with_base("tiles/{{X}}/{{Y}}.jpg", "/pictures/list.txt").unwrap();
        assert_eq!(images[0].uri, "/pictures/tiles/{{X}}/{{Y}}.jpg");
        let signed = "https://images.test/image.dzi?token=%7Bexact%7D";
        let images = parse_text_urls_with_base(
            &format!("image.dzi\n{signed}"),
            "/pictures/%7Bcollection%7D/list.txt",
        )
        .unwrap();
        assert_eq!(images[0].uri, "/pictures/%7Bcollection%7D/image.dzi");
        assert_eq!(images[1].uri, signed);
    }

    #[test]
    fn catalog_contains_deferred_entries_and_rejects_bad_lists() {
        let catalog = complete(
            "file://test.txt",
            "http://example.com/image1.jpg\nhttps://example.org/manifest.json",
        )
        .unwrap();
        assert_eq!(catalog.len(), 2);
        let entries = catalog.into_entries();
        assert!(
            matches!(entries[0], DiscoveredEntry::Deferred(DeferredResource { ref uri, title: None, .. }) if uri == "http://example.com/image1.jpg")
        );
        assert!(
            matches!(entries[1], DiscoveredEntry::Deferred(DeferredResource { ref uri, .. }) if uri == "https://example.org/manifest.json")
        );

        let error = complete("file://empty.txt", "# Only comments\n\n# Nothing else")
            .unwrap_err()
            .to_string();
        assert!(error.contains("No valid URLs found") || error.contains("no valid URLs found"));
        let error = complete("file://invalid.txt", "not_a_valid_url")
            .unwrap_err()
            .to_string();
        assert!(error.contains("line 1") && error.contains("not_a_valid_url"));
    }
}
