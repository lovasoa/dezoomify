//! Stable adapter errors convertible to canonical protocol [`Error`][error_value].
//!
//! [error_value]: dezoomify::model::Error
//!
//! Every failure in this crate returns [`AdapterError`] (never panics on
//! host input). Codes are stable strings:
//!
//! | code | meaning |
//! |---|---|
//! | `malformed` | an object is missing required typed data or has invalid geometry |
//! | `limit-exceeded` | quota, oversized length, out-of-bounds access, capacity mismatch, arithmetic overflow |
//! | `wrong-state` | valid message in the wrong lifecycle phase (dispatch vs job state) |
//! | `disposed` | any session use after [`Session::dispose`][crate::session::Session] |
//!
//! [`AdapterError::to_error`] maps these to protocol `Error` values
//! with code `adapter.{code}` so they cannot collide with core/protocol
//! codes.

use dezoomify::model::{Error, ErrorPhase};

/// Stable machine-readable adapter failure code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AdapterErrorCode {
    /// Missing typed data or invalid geometry.
    Malformed,
    /// Quota, oversized length, out-of-bounds access, capacity mismatch, overflow.
    LimitExceeded,
    /// Valid input in the wrong lifecycle phase.
    WrongState,
    /// Session use after dispose.
    Disposed,
}

impl AdapterErrorCode {
    /// Stable contract string for this code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::LimitExceeded => "limit-exceeded",
            Self::WrongState => "wrong-state",
            Self::Disposed => "disposed",
        }
    }
}

/// Typed adapter failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterError {
    code: AdapterErrorCode,
    message: String,
}

impl AdapterError {
    /// Build an error with its original message.
    #[must_use]
    pub fn new(code: AdapterErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Stable code enum.
    #[must_use]
    pub fn code(&self) -> AdapterErrorCode {
        self.code
    }

    /// Stable code string (`malformed`, `limit-exceeded`, ...).
    #[must_use]
    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    /// Human-readable detail.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Convert to a canonical protocol error (`adapter.{code}`, never retryable).
    #[must_use]
    pub fn to_error(&self) -> Error {
        let phase = match self.code {
            AdapterErrorCode::Disposed => ErrorPhase::Cleanup,
            AdapterErrorCode::Malformed
            | AdapterErrorCode::LimitExceeded
            | AdapterErrorCode::WrongState => ErrorPhase::Validation,
        };
        Error::new(
            format!("adapter.{}", self.code.as_str()),
            phase,
            self.message.clone(),
        )
    }
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for AdapterError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_strings() {
        assert_eq!(AdapterErrorCode::Malformed.as_str(), "malformed");
        assert_eq!(AdapterErrorCode::LimitExceeded.as_str(), "limit-exceeded");
        assert_eq!(AdapterErrorCode::WrongState.as_str(), "wrong-state");
        assert_eq!(AdapterErrorCode::Disposed.as_str(), "disposed");
    }

    #[test]
    fn messages_preserve_failure_details() {
        let error = AdapterError::new(
            AdapterErrorCode::Malformed,
            "fetch https://h/?apiKey=CANARY&x=1 and auth=TOPSECRET failed",
        );
        assert_eq!(
            error.message(),
            "fetch https://h/?apiKey=CANARY&x=1 and auth=TOPSECRET failed"
        );
    }

    #[test]
    fn converts_to_protocol_error() {
        let error = AdapterError::new(AdapterErrorCode::WrongState, "gone");
        let error_value = error.to_error();
        assert_eq!(error_value.code, "adapter.wrong-state");
        assert!(!error_value.retryable);
    }
}
