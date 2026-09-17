//! Pure support for browser-host tile byte-processing recipes. Discovery and
//! planning live in the job-engine session.

use dezoomify_core::core::model::ProcessingRecipe as CoreProcessingRecipe;
use dezoomify_protocol::dto::ProcessingRecipe;

use crate::error::{AdapterError, AdapterErrorCode};

fn malformed(message: impl Into<String>) -> AdapterError {
    AdapterError::new(AdapterErrorCode::Malformed, message.into())
}

/// Apply one core processing recipe to fetched tile bytes.
///
/// # Errors
///
/// `malformed` when the selected recipe cannot process the bytes.
pub fn apply_processing_recipe(
    recipe: ProcessingRecipe,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, AdapterError> {
    let recipe = match recipe {
        ProcessingRecipe::None => CoreProcessingRecipe::None,
        ProcessingRecipe::GoogleArtsDecrypt => CoreProcessingRecipe::GoogleArtsDecrypt,
    };
    recipe.apply(bytes).map_err(|e| malformed(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_processing_none_is_identity() {
        assert_eq!(
            apply_processing_recipe(ProcessingRecipe::None, vec![1, 2, 3]).expect("identity"),
            vec![1, 2, 3]
        );
    }
}
