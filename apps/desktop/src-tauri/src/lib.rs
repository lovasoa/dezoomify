// Desktop shell library root: shared constants and module wiring.
//
// Pure standard-library logic only; no Tauri SDK, no network, no filesystem
// effects in this module. See docs/native-apps.md for the runtime split.

pub mod commands;
pub mod deep_link;
pub mod install_integration;
pub mod jobs;
pub mod updater;

/// Native Messaging host name shared by manifests and capabilities.
pub const NATIVE_HOST_NAME: &str = "dev.ophir.dezoomify.native_host";
/// Deep-link protocol scheme.
pub const PROTOCOL_SCHEME: &str = "dezoomify";
