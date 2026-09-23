//! Guards the consolidated crate's dependency and host-capability policy.
//!
//! Dependency checks consume Cargo's structured metadata. Host capabilities
//! are enforced semantically by Clippy's `disallowed_methods` and
//! `disallowed_types` lints, enabled only for non-test builds of this crate.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::Path;
use std::process::Command;

/// Runtime crates that must never be direct dependencies of the pure crate.
/// Optional TypeScript projection dependencies are checked separately by the
/// no-default-features WASM portability lane and are allowed here.
const BANNED: &[&str] = &[
    "reqwest",
    "tokio",
    "async-std",
    "smol",
    "image",
    "image_hasher",
    "clap",
    "indicatif",
    "env_logger",
    "human-panic",
    "colour",
    "png",
    "zif-tiff",
    "futures",
    "tempfile",
    "criterion",
    "sanitize-filename-reader-friendly",
    "web-sys",
    "js-sys",
    "rand",
    "getrandom",
    "rustls",
    "native-tls",
    "openssl",
    "chrono",
    "time",
];

#[test]
fn direct_dependencies_contain_no_runtime_crates() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--manifest-path",
            manifest.to_str().expect("UTF-8 manifest path"),
        ])
        .output()
        .expect("run `cargo metadata`");
    assert!(
        output.status.success(),
        "cargo metadata failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("parse cargo metadata JSON");
    let package = metadata["packages"]
        .as_array()
        .expect("metadata packages array")
        .iter()
        .find(|package| package["name"] == "dezoomify")
        .expect("dezoomify package in metadata");
    let violations = package["dependencies"]
        .as_array()
        .expect("package dependencies array")
        .iter()
        .filter_map(|dependency| dependency["name"].as_str())
        .filter(|name| BANNED.contains(name))
        .collect::<Vec<_>>();
    assert!(
        violations.is_empty(),
        "dezoomify declares forbidden runtime dependencies: {}",
        violations.join(", ")
    );
}
