//! Stable native errors with redacted context.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeError {
    pub code: String,
    pub message: String,
}

impl NativeError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: redact(&message.into()),
        }
    }
}

impl From<String> for NativeError {
    fn from(message: String) -> Self {
        Self::new("native.internal", message)
    }
}

impl From<dezoomify_core::core::discovery::DiscoveryError> for NativeError {
    fn from(error: dezoomify_core::core::discovery::DiscoveryError) -> Self {
        Self::new("discovery.failed", error.to_string())
    }
}

impl From<dezoomify_core::core::tile_plan::TileSourceError> for NativeError {
    fn from(error: dezoomify_core::core::tile_plan::TileSourceError) -> Self {
        Self::new("discovery.tile-plan", error.to_string())
    }
}

impl From<dezoomify_core::core::processing::ProcessingError> for NativeError {
    fn from(error: dezoomify_core::core::processing::ProcessingError) -> Self {
        Self::new("tile.processing-failed", error.to_string())
    }
}

fn redact(input: &str) -> String {
    dezoomify_protocol::dto::redact_error_text(input)
}
