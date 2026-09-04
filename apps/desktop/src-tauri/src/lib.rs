// Desktop shell library root: shared constants and module wiring.
//
// Pure standard-library logic only; no Tauri SDK, no network, no filesystem
// effects in this module. See docs/native-apps.md for the runtime split.

pub mod commands;
pub mod deep_link;
pub mod install_integration;
pub mod jobs;
pub mod updater;

/// Canonical protocol range served by the desktop app.
pub const PROTOCOL_MIN: &str = "1.0";
/// Canonical protocol range served by the desktop app.
pub const PROTOCOL_MAX: &str = "1.0";
/// Exact protocol version marker.
pub const PROTOCOL_VERSION: &str = "1.0";
/// Deterministic fingerprint of the canonical protocol DTO source.
pub const DTO_FINGERPRINT: &str = "b4bad92b24615c58";
/// Native Messaging host name shared by manifests and capabilities.
pub const NATIVE_HOST_NAME: &str = "com.dezoomify.native_host";
/// Application bundle identifier.
pub const APP_IDENTIFIER: &str = "com.dezoomify.app";
/// Desktop app version.
pub const APP_VERSION: &str = "0.1.0";
/// Deep-link protocol scheme.
pub const PROTOCOL_SCHEME: &str = "dezoomify";
/// Native encoder set (matches dezoomify-protocol native baseline).
pub const ENCODERS: &[&str] = &["png", "jpeg", "tiff"];
/// Native decoder set.
pub const DECODERS: &[&str] = &["png", "jpeg", "tiff"];
