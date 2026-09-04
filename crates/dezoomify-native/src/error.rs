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

fn redact(input: &str) -> String {
    dezoomify_protocol::dto::redact_error_text(input)
}
