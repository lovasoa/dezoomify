//! Bindings have no platform I/O, image codecs, or application dependencies.

use std::path::Path;
use std::process::Command;

const BANNED_DEPS: &[&str] = &[
    "reqwest", "tokio", "web-sys", "js-sys", "image", "png", "clap",
];
#[test]
fn direct_dependencies_only_convert_values_and_futures() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "--manifest-path",
            manifest.to_str().unwrap(),
            "--edges",
            "normal",
            "--depth",
            "1",
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
