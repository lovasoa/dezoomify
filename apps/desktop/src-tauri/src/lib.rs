// Desktop shell library root: shared constants and module wiring.
//
// Lean offline shell: pure Rust only (std + serde/serde_json for wire JSON +
// ed25519 for updater); no Tauri SDK, no network, no filesystem effects in
// this module. See docs/native-apps.md for the runtime split.

// 6.1 unwrap policy: shipped shell code maps failures to typed
// `handoff.rejected`/`protocol.*`/job errors instead of panicking. Unit
// tests are exempt via `allow-unwrap-in-tests` in the workspace
// `clippy.toml`; integration `tests/` targets never inherit this attribute.
#![deny(clippy::unwrap_used)]

include!(concat!(env!("CARGO_MANIFEST_DIR"), "/desktop_commands.rs"));

pub mod commands;
pub mod deep_link;
pub mod install_integration;
pub mod jobs;
pub mod native_host;
pub mod settings;
pub mod updater;

// The real window shell is behind the `tauri` feature; the default build
// stays pure standard-library logic with no SDK or webview requirements.
#[cfg(feature = "tauri")]
pub mod tauri_shell;

/// Native Messaging host name shared by manifests and capabilities.
pub const NATIVE_HOST_NAME: &str = "dev.ophir.dezoomify.native_host";
/// Deep-link protocol scheme.
pub const PROTOCOL_SCHEME: &str = "dezoomify";
