//! Pure support surface for browser hosts: scan-candidate ranking and tile
//! byte-processing recipes. Both are effect-free and delegate to
//! [`dezoomify_core`]; discovery and planning live in the job-engine session.

use dezoomify_core::core::model::ProcessingRecipe;

use crate::error::{AdapterError, AdapterErrorCode};

fn malformed(message: impl Into<String>) -> AdapterError {
    AdapterError::new(AdapterErrorCode::Malformed, message.into())
}

/// Apply one core processing recipe to fetched tile bytes.
///
/// # Errors
///
/// `malformed` for unknown recipes or processing failures.
pub fn apply_processing_recipe(recipe: &str, bytes: Vec<u8>) -> Result<Vec<u8>, AdapterError> {
    let parsed = match recipe {
        "none" => ProcessingRecipe::None,
        "google-arts-decrypt" => ProcessingRecipe::GoogleArtsDecrypt,
        other => return Err(malformed(format!("unknown processing recipe {other}"))),
    };
    parsed.apply(bytes).map_err(|e| malformed(e.to_string()))
}

/// One ranked scan candidate: the input URL plus the preferred core format
/// name, if any builtin prefers it. Unknowns carry `format: null` and rank
/// last; every input URL is returned exactly once.
#[derive(serde::Serialize)]
struct RankedCandidateDto<'a> {
    url: &'a str,
    format: Option<&'static str>,
}

/// Rank scan-candidate URLs in one batch using the core registry (URL text
/// only, no fetching, no bytes retained). `urls_json` is a JSON array of
/// strings; the result is a JSON array of `{url, format}` in try-order.
/// Unknown or invalid URLs rank last with `format: null`, never dropped.
///
/// # Errors
///
/// `malformed` when `urls_json` is not a JSON array of strings.
pub fn rank_candidates_json(urls_json: &str) -> Result<String, AdapterError> {
    let urls: Vec<String> = serde_json::from_str(urls_json).map_err(|error| {
        malformed(format!(
            "rankCandidates needs a JSON array of URLs: {error}"
        ))
    })?;
    let borrowed: Vec<&str> = urls.iter().map(String::as_str).collect();
    let ranked = dezoomify_core::core::registry::rank_candidate_urls(&borrowed);
    let dtos: Vec<RankedCandidateDto<'_>> = ranked
        .into_iter()
        .map(|candidate| RankedCandidateDto {
            url: candidate.url,
            format: candidate.format,
        })
        .collect();
    serde_json::to_string(&dtos)
        .map_err(|error| malformed(format!("rank projection failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_processing_none_is_identity_and_unknown_rejects() {
        assert_eq!(
            apply_processing_recipe("none", vec![1, 2, 3]).expect("identity"),
            vec![1, 2, 3]
        );
        assert_eq!(
            apply_processing_recipe("nope", vec![1]).unwrap_err().code(),
            AdapterErrorCode::Malformed
        );
    }

    #[test]
    fn rank_candidates_orders_known_before_unknown() {
        let ranked: serde_json::Value = serde_json::from_str(
            &rank_candidates_json(
                r#"["https://example.test/unknown-b","https://example.test/TileGroup0/0-0-0.jpg","https://example.test/unknown-a","https://example.test/info.json"]"#,
            )
            .expect("rank"),
        )
        .expect("rank parses");
        let urls: Vec<&str> = ranked
            .as_array()
            .expect("array")
            .iter()
            .map(|entry| entry["url"].as_str().expect("url"))
            .collect();
        assert_eq!(
            urls,
            [
                "https://example.test/TileGroup0/0-0-0.jpg",
                "https://example.test/info.json",
                "https://example.test/unknown-b",
                "https://example.test/unknown-a",
            ]
        );
        assert_eq!(ranked[0]["format"], "zoomify");
        assert_eq!(ranked[1]["format"], "iiif");
        assert!(ranked[2]["format"].is_null());
    }

    #[test]
    fn rank_candidates_rejects_non_array_json() {
        assert_eq!(
            rank_candidates_json(r#"{"not":"an array"}"#)
                .unwrap_err()
                .code(),
            AdapterErrorCode::Malformed
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rank_candidates_json("[]").expect("empty"))
                .expect("parses"),
            serde_json::json!([])
        );
    }
}
