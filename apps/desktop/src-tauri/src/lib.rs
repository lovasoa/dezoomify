// Shipped shell code maps failures to typed errors instead of panicking. Unit
// tests are exempt via `allow-unwrap-in-tests` in the workspace
// `clippy.toml`; integration `tests/` targets never inherit this attribute.
#![deny(clippy::unwrap_used)]

include!(concat!(env!("CARGO_MANIFEST_DIR"), "/desktop_commands.rs"));

/// Version shared by every app built from this revision.
pub const APP_VERSION: &str = match option_env!("DEZOOMIFY_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

pub mod commands;
pub mod deep_link;
pub mod install_integration;
pub mod jobs;
pub mod settings;

// The real window shell is behind the `tauri` feature; the default build
// stays pure standard-library logic with no SDK or webview requirements.
#[cfg(feature = "tauri")]
pub mod tauri_shell;

/// Deep-link protocol scheme.
pub const PROTOCOL_SCHEME: &str = "dezoomify";
