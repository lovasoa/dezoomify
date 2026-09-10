//! Stable native errors with redacted context.
//!
//! Single boundary mapping: every host failure maps once here to
//! `{code, phase, retryable, message, recovery}` by stable code, never by
//! display text. Callers construct [`NativeError`] with a stable namespaced
//! code at the failure site; [`error_phase`]/[`error_retryable`]/
//! [`error_recovery`]/[`error_transport`]/[`error_resource_kind`] derive the
//! typed projection from that code alone. Messages are redacted and never
//! branched on.

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

    /// Stable job phase for this error (never derived from the message).
    #[must_use]
    pub fn phase(&self) -> &'static str {
        error_phase(&self.code)
    }

    /// Whether a plain retry without user edits may succeed (transient
    /// transport/service only; never auth, invalid metadata, or
    /// deterministic decode).
    #[must_use]
    pub fn retryable(&self) -> bool {
        error_retryable(&self.code)
    }

    /// Typed recovery hint for this error (never a weakening recovery for
    /// security failures).
    #[must_use]
    pub fn recovery(&self) -> &'static str {
        error_recovery(&self.code)
    }

    /// Attempted transport for this error (`native` on this runtime).
    #[must_use]
    pub fn transport(&self) -> &'static str {
        error_transport(&self.code)
    }

    /// Affected resource kind for this error, when safe to name.
    #[must_use]
    pub fn resource_kind(&self) -> Option<&'static str> {
        error_resource_kind(&self.code)
    }

    /// Canvas allocation failure caused by insufficient current available
    /// memory.
    #[must_use]
    pub fn canvas_memory_unavailable(
        width: u32,
        height: u32,
        required: &str,
        available: &str,
    ) -> Self {
        Self::new(
            "output.canvas-limit",
            format!(
                "composed image {width}x{height} needs {required} of canvas memory, but only {available} is currently available; save a smaller level with --max-width"
            ),
        )
    }

    /// JPEG side-limit failure with the PNG fallback. Sides beyond 65535 px
    /// cannot be addressed by JPEG.
    #[must_use]
    pub fn jpeg_limit(width: u32, height: u32) -> Self {
        Self::new(
            "output.encode-failed",
            format!(
                "jpeg output {width}x{height} exceeds the 65535px per-side jpeg limit; save as png, tiff, or iiif-dir"
            ),
        )
    }

    /// Existing destination refused without overwrite confirmation.
    #[must_use]
    pub fn output_exists() -> Self {
        Self::new(
            "output.exists",
            "output exists (refusing overwrite); choose a different destination or confirm overwrite",
        )
    }

    /// Destination refused before any work (traversal, directory/file or
    /// extension mismatch, escaping tile path). Never carries the path text.
    #[must_use]
    pub fn destination_denied(detail: impl Into<String>) -> Self {
        Self::new("output.destination-denied", detail.into())
    }

    /// Unknown output extension. The message lists the supported extensions;
    /// never the full destination path.
    #[must_use]
    pub fn unsupported_extension(detail: impl Into<String>) -> Self {
        Self::new("output.unsupported-extension", detail.into())
    }

    /// Output write failure (atomic rename, directory creation, tile write).
    /// The message carries only the OS message, never the path text.
    #[must_use]
    pub fn write_failed(detail: impl Into<String>) -> Self {
        Self::new("output.write-failed", detail.into())
    }

    /// Protocol version mismatch detected before any work.
    #[must_use]
    pub fn protocol_incompatible(detail: impl Into<String>) -> Self {
        Self::new("protocol.incompatible", detail.into())
    }

    /// Rejected untrusted handoff input (never carries secrets or paths).
    #[must_use]
    pub fn handoff_rejected(detail: impl Into<String>) -> Self {
        Self::new("handoff.rejected", detail.into())
    }
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NativeError {}

impl From<String> for NativeError {
    fn from(message: String) -> Self {
        Self::new("native.internal", message)
    }
}

impl From<dezoomify_core::core::discovery::DiscoveryError> for NativeError {
    fn from(error: dezoomify_core::core::discovery::DiscoveryError) -> Self {
        use dezoomify_core::core::discovery::DiscoveryError as E;
        match &error {
            E::NoCandidateAccepted { .. } => Self::new("discovery.no-image", error.to_string()),
            E::TransitionLimitExceeded | E::MetadataSizeLimitExceeded => {
                Self::new("tile.limit", error.to_string())
            }
            E::UnknownRequest(_) | E::RequestAlreadyProvided(_) | E::NotComplete => {
                Self::new("native.internal", error.to_string())
            }
            E::Session(_) => Self::new("discovery.failed", error.to_string()),
        }
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

/// Stable phase for a native error code. Branches only on the namespaced
/// code prefix/exact code, never on display strings.
#[must_use]
pub fn error_phase(code: &str) -> &'static str {
    if code == "protocol.incompatible" {
        "handshake"
    } else if code == "handoff.rejected" {
        "validation"
    } else if code.starts_with("discovery.")
        || code.starts_with("job.discovery")
        || code == "discovery.unknown-dezoomer"
        || code == "job.unknown-dezoomer"
        || code == "job.no-images"
        || code == "job.catalog-invalid"
        || code == "job.empty-resource"
    {
        "discovery"
    } else if code == "tile.decode-failed" || code.starts_with("decode.") {
        "decode"
    } else if code == "tile.processing-failed" {
        "processing"
    } else if code.starts_with("tile.")
        || code.starts_with("fetch.")
        || code.starts_with("transport.")
        || code.starts_with("auth.")
    {
        // `auth.*` surfaces during acquisition fetches; the phase stays
        // acquisition while retryability/recovery stay fail-closed.
        if code.starts_with("auth.") && is_validation_auth(code) {
            "validation"
        } else {
            "acquisition"
        }
    } else if code.starts_with("output.") {
        "output"
    } else if code == "job.cancelled" {
        "cleanup"
    } else if code.starts_with("job.resource")
        || code.starts_with("job.plan")
        || code.starts_with("job.probe")
        || code == "job.overflow"
    {
        "acquisition"
    } else if code.starts_with("command.")
        || code.starts_with("job.invalid")
        || code == "job.post-terminal"
        || code == "job.unknown"
        || code == "job.stale"
        || code == "job.wrong-job"
        || code == "job.invalid-state"
        || code == "job.invalid-id"
    {
        "validation"
    } else if code.starts_with("job.") {
        "discovery"
    } else {
        "acquisition"
    }
}

fn is_validation_auth(code: &str) -> bool {
    matches!(
        code,
        "auth.forbidden-header"
            | "auth.too-many-cookies"
            | "auth.cookie-too-large"
            | "auth.cookie-crlf"
            | "auth.scope-traversal"
    )
}

/// Whether a native error code is retryable without user edits. True only
/// for transient transport/service failures; never for auth,
/// invalid-metadata, deterministic decode, limits, output, validation,
/// security, or internal errors.
#[must_use]
pub fn error_retryable(code: &str) -> bool {
    matches!(
        code,
        "tile.http-error"
            | "tile.download-failed"
            | "transport.network-error"
            | "transport.timeout"
            | "fetch.network-failed"
            | "fetch.timeout"
            | "fetch.cors_blocked"
    )
}

/// Typed recovery hint for a native error code. The frontend surfaces typed
/// choices from this (never by parsing messages). Security failures never
/// offer a weakening recovery (`change-transport`, `grant-permission`, or
/// insecure retry are never returned here).
#[must_use]
pub fn error_recovery(code: &str) -> &'static str {
    if code.starts_with("output.") {
        "choose-output"
    } else if error_retryable(code) {
        "retry"
    } else if code.starts_with("discovery.")
        || code == "tile.limit"
        || code == "job.resource-limit"
        || code == "tile.decode-failed"
        || code == "tile.processing-failed"
        || code.starts_with("job.plan")
        || code.starts_with("job.probe")
        || code == "job.overflow"
        || code.starts_with("transport.bad-")
        || code == "transport.size-limit"
        || code == "transport.redirect-limit"
        || code == "job.invalid-input"
        || code == "job.invalid-id"
        || code == "job.invalid-state"
        || code == "job.wrong-job"
        || code == "job.post-terminal"
        || code == "job.unknown"
        || code == "job.stale"
        || code == "command.unknown"
        || code == "handoff.rejected"
    {
        "edit-input"
    } else {
        // Safe fallback for internal, auth, TLS, and protocol errors:
        // never a weakening recovery.
        "handoff-to-native"
    }
}

/// Attempted transport for a native error code. This runtime always fetches
/// natively; the value stays `native` so identical causes read identically.
#[must_use]
pub fn error_transport(_code: &str) -> &'static str {
    "native"
}

/// Affected resource kind for a native error code, when safe to name.
/// Never carries URIs, paths, or secrets, only the coarse kind.
#[must_use]
pub fn error_resource_kind(code: &str) -> Option<&'static str> {
    if code.starts_with("discovery.") || code.starts_with("job.discovery") {
        Some("metadata")
    } else if code.starts_with("tile.") {
        Some("tile")
    } else if code.starts_with("transport.") || code.starts_with("fetch.") {
        Some("resource")
    } else if code.starts_with("output.") {
        Some("output")
    } else if code.starts_with("auth.") {
        Some("credential")
    } else if code.starts_with("handoff.") {
        Some("handoff")
    } else if code.starts_with("protocol.") {
        Some("protocol")
    } else {
        Some("job")
    }
}

fn redact(input: &str) -> String {
    dezoomify_protocol::dto::redact_error_text(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_remaps_stay_stable() {
        // Preserved from job_driver.rs:263-275 via map_failure_code; the
        // boundary mapping must agree on phase/recovery for each legacy code.
        for code in [
            "discovery.failed",
            "discovery.no-image",
            "tile.limit",
            "discovery.tile-plan",
            "discovery.no-level",
            "tile.download-failed",
        ] {
            let error = NativeError::new(code, "probe");
            assert!(!error.code.is_empty());
            assert!(!error.phase().is_empty());
            assert!(!error.recovery().is_empty());
            assert_eq!(error.transport(), "native");
            assert!(error.resource_kind().is_some());
        }
        assert_eq!(error_phase("discovery.failed"), "discovery");
        assert_eq!(error_phase("discovery.no-image"), "discovery");
        assert_eq!(error_phase("tile.limit"), "acquisition");
        assert_eq!(error_phase("discovery.tile-plan"), "discovery");
        assert_eq!(error_phase("discovery.no-level"), "discovery");
        assert_eq!(error_phase("tile.download-failed"), "acquisition");
    }

    #[test]
    fn canvas_memory_error_names_current_availability() {
        let error = NativeError::canvas_memory_unavailable(
            40000,
            40000,
            "6.0 GiB (6400000000 bytes)",
            "4.0 GiB (4294967296 bytes)",
        );
        assert_eq!(error.code, "output.canvas-limit");
        assert!(error.message.contains("only 4.0 GiB"));
        assert!(error.message.contains("--max-width"));
    }

    #[test]
    fn jpeg_limit_names_fallback() {
        let error = NativeError::jpeg_limit(70000, 10);
        assert_eq!(error.code, "output.encode-failed");
        assert_eq!(error.phase(), "output");
        assert!(!error.retryable());
        assert_eq!(error.recovery(), "choose-output");
        assert!(error.message.contains("65535"));
        assert!(error.message.contains("png"));
    }

    #[test]
    fn output_exists_and_destination_denied_choose_output() {
        let exists = NativeError::output_exists();
        assert_eq!(exists.code, "output.exists");
        assert_eq!(exists.phase(), "output");
        assert!(!exists.retryable());
        assert_eq!(exists.recovery(), "choose-output");
        assert_eq!(exists.resource_kind(), Some("output"));

        let denied = NativeError::destination_denied("extension does not match format");
        assert_eq!(denied.code, "output.destination-denied");
        assert_eq!(denied.phase(), "output");
        assert!(!denied.retryable());
        assert_eq!(denied.recovery(), "choose-output");

        let unsupported = NativeError::unsupported_extension("unsupported output extension .bmp");
        assert_eq!(unsupported.code, "output.unsupported-extension");
        assert_eq!(unsupported.phase(), "output");
        assert_eq!(unsupported.recovery(), "choose-output");

        let write = NativeError::write_failed("output write failed: permission denied");
        assert_eq!(write.code, "output.write-failed");
        assert_eq!(write.phase(), "output");
        assert!(!write.retryable());
        assert_eq!(write.recovery(), "choose-output");
    }

    #[test]
    fn protocol_and_handoff_map_once_by_code() {
        let incompatible = NativeError::protocol_incompatible("unsupported protocol version 9");
        assert_eq!(incompatible.code, "protocol.incompatible");
        assert_eq!(incompatible.phase(), "handshake");
        assert!(!incompatible.retryable());
        // Safe fallback, never a weakening recovery.
        assert_eq!(incompatible.recovery(), "handoff-to-native");

        let rejected = NativeError::handoff_rejected("handoff must not carry userinfo");
        assert_eq!(rejected.code, "handoff.rejected");
        assert_eq!(rejected.phase(), "validation");
        assert!(!rejected.retryable());
        assert_eq!(rejected.recovery(), "edit-input");
    }

    #[test]
    fn lifecycle_codes_map_to_validation_without_retry() {
        for code in [
            "job.post-terminal",
            "job.unknown",
            "job.stale",
            "job.wrong-job",
            "job.invalid-state",
            "command.unknown",
        ] {
            assert_eq!(error_phase(code), "validation", "phase for {code}");
            assert!(!error_retryable(code), "retryable for {code}");
            assert_eq!(error_recovery(code), "edit-input", "recovery for {code}");
        }
        assert_eq!(error_phase("job.cancelled"), "cleanup");
        assert!(!error_retryable("job.cancelled"));
    }

    #[test]
    fn retryable_only_for_transient_transport_service() {
        for code in [
            "transport.network-error",
            "transport.timeout",
            "tile.http-error",
            "tile.download-failed",
        ] {
            assert!(error_retryable(code), "{code} must be retryable");
            assert_eq!(error_recovery(code), "retry", "{code} recovers via retry");
        }
        // Never retryable: auth, invalid metadata, deterministic decode,
        // limits, output, validation, security, internal.
        for code in [
            "auth.too-many-cookies",
            "auth.cookie-too-large",
            "auth.cookie-crlf",
            "auth.scope-traversal",
            "auth.forbidden-header",
            "transport.bad-url",
            "transport.bad-redirect",
            "transport.size-limit",
            "transport.redirect-limit",
            "transport.tls",
            "discovery.failed",
            "discovery.no-image",
            "discovery.tile-plan",
            "discovery.no-level",
            "discovery.unknown-dezoomer",
            "tile.decode-failed",
            "tile.processing-failed",
            "tile.limit",
            "output.canvas-limit",
            "output.encode-failed",
            "output.exists",
            "output.destination-denied",
            "output.write-failed",
            "protocol.incompatible",
            "handoff.rejected",
            "job.invalid-input",
            "job.post-terminal",
            "native.internal",
        ] {
            assert!(!error_retryable(code), "{code} must not be retryable");
        }
    }

    #[test]
    fn security_failures_never_offer_weakening_recovery() {
        for code in [
            "auth.too-many-cookies",
            "auth.cookie-crlf",
            "auth.scope-traversal",
            "auth.forbidden-header",
            "transport.tls",
            "transport.bad-redirect",
            "handoff.rejected",
            "protocol.incompatible",
        ] {
            let recovery = error_recovery(code);
            assert!(
                recovery != "change-transport"
                    && recovery != "grant-permission"
                    && recovery != "retry",
                "{code} must not weaken policy via {recovery}"
            );
        }
    }

    #[test]
    fn discovery_error_variants_map_to_stable_codes() {
        use dezoomify_core::core::discovery::DiscoveryError as E;
        let no_image: NativeError = E::NoCandidateAccepted {
            diagnostics: Vec::new(),
        }
        .into();
        assert_eq!(no_image.code, "discovery.no-image");
        let limit: NativeError = E::TransitionLimitExceeded.into();
        assert_eq!(limit.code, "tile.limit");
        let failed: NativeError = E::Session("bad page".into()).into();
        assert_eq!(failed.code, "discovery.failed");
    }

    #[test]
    fn mapping_branches_on_code_never_message() {
        // Same message, different codes must map differently; same code with
        // different messages must map identically.
        let a = NativeError::new("transport.network-error", "same text");
        let b = NativeError::new("tile.decode-failed", "same text");
        assert_ne!(a.phase(), b.phase());
        assert_ne!(a.retryable(), b.retryable());
        let c = NativeError::new("transport.network-error", "first wording");
        let d = NativeError::new("transport.network-error", "second wording");
        assert_eq!(c.phase(), d.phase());
        assert_eq!(c.retryable(), d.retryable());
        assert_eq!(c.recovery(), d.recovery());
    }

    #[test]
    fn redaction_strips_credentials_from_messages() {
        let error = NativeError::new(
            "tile.http-error",
            "failed with token=SECRET123 and cookie=abc",
        );
        assert!(!error.message.contains("SECRET123"));
        assert!(error.message.contains("REDACTED"));
    }
}
