//! Pure support for browser-host tile byte-processing recipes. Discovery and
//! planning live in the job-engine session.

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
}
