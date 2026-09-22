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
//! codes. All messages are redacted at construction: credential-bearing
//! query values (`apiKey=`, `token=`, `auth=`, `password=`, `secret=`,
//! `session=`, `cookie=`, `Authorization:`) are replaced with `REDACTED`,
//! extending [`dezoomify::model::redact_error_text`].

use dezoomify::model::{redact_error_text, Error, ErrorPhase};

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

/// Typed adapter failure. The message is always [`redact`]ed at construction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterError {
    code: AdapterErrorCode,
    message: String,
}

impl AdapterError {
    /// Build an error, redacting credential-bearing text from `message`.
    #[must_use]
    pub fn new(code: AdapterErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: redact(&message.into()),
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

    /// Redacted human-readable detail (safe for logs and protocol events).
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

/// Redact credential-bearing values from error text.
///
/// Extends [`redact_error_text`] with query/form keys the protocol helper
/// does not cover (`auth=`, `password=`, `secret=`, `access_token=`).
/// Values run to the next `&`, whitespace, quote, or end of string.
#[must_use]
pub fn redact(input: &str) -> String {
    let mut out = redact_error_text(input);
    for needle in ["auth=", "password=", "secret=", "access_token="] {
        let mut search_from = 0;
        while let Some(relative) = out[search_from..].find(needle) {
            let position = search_from + relative;
            let end = out[position..]
                .find(['&', ' ', '"', '\''])
                .map_or(out.len(), |offset| position + offset);
            out.replace_range(position + needle.len()..end, "REDACTED");
            search_from = position + needle.len() + "REDACTED".len();
        }
    }
    out
}

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
    fn messages_are_redacted_at_construction() {
        let error = AdapterError::new(
            AdapterErrorCode::Malformed,
            "fetch https://h/?apiKey=CANARY&x=1 and auth=TOPSECRET failed",
        );
        assert!(!error.message().contains("CANARY"));
        assert!(!error.message().contains("TOPSECRET"));
        assert!(error.message().contains("REDACTED"));
    }

    #[test]
    fn converts_to_protocol_error() {
        let error = AdapterError::new(AdapterErrorCode::WrongState, "gone");
        let error_value = error.to_error();
        assert_eq!(error_value.code, "adapter.wrong-state");
        assert!(!error_value.retryable);
    }
}
