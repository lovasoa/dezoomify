//! Bindings have no platform I/O, image codecs, or application dependencies.

use std::path::Path;
use std::process::Command;

/// Banned anywhere in the normal dependency tree (dev/build edges stay
/// excluded): platform I/O and runtimes, web platform APIs, image codecs,
/// and application frameworks. The whole tree is checked, not just direct
/// dependencies, so a transitive banned dependency cannot pass silently.
/// `js-sys` is deliberately absent: `wasm-bindgen-futures` and
/// `serde-wasm-bindgen` require it transitively as the JS value/future
/// conversion substrate these bindings exist to use, and it exposes no I/O.
const BANNED_DEPS: &[&str] = &["reqwest", "tokio", "web-sys", "image", "png", "clap"];

#[test]
fn normal_dependency_tree_only_converts_values_and_futures() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "--manifest-path",
            manifest.to_str().unwrap(),
            "--edges",
            "normal",
            "--prefix",
            "none",
        ])
        .output()
        .expect("cargo tree");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    assert!(lines.next().is_some());
    let violations: Vec<_> = lines
        .filter_map(|l| l.split_whitespace().next())
        .filter(|n| BANNED_DEPS.contains(n))
        .collect();
    assert!(
        violations.is_empty(),
        "host deps: {}",
        violations.join(", ")
    );
}
