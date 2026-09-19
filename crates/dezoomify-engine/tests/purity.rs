//! Purity gate: job stays host-independent (core/protocol/serde only).

use std::path::Path;
use std::process::Command;

const BANNED: &[&str] = &[
    "reqwest",
    "tokio",
    "async-std",
    "smol",
    "image",
    "png",
    "clap",
    "wasm-bindgen",
    "web-sys",
    "js-sys",
];

#[test]
fn direct_dependencies_stay_pure() {
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
        .filter(|n| BANNED.contains(n))
        .collect();
    assert!(
        violations.is_empty(),
        "host deps: {}",
        violations.join(", ")
    );
}

#[test]
fn lib_source_performs_no_io_or_clock() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bad = Vec::new();
    visit(&src, &mut bad);
    assert!(
        bad.is_empty(),
        "host capability in job lib:\n{}",
        bad.join("\n")
    );
}

fn visit(dir: &Path, bad: &mut Vec<String>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .expect("list src")
        .map(|e| e.expect("entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            visit(&path, bad);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let text = std::fs::read_to_string(&path).expect("read");
            for (n, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                if code.contains("std::fs")
                    || code.contains("std::net")
                    || code.contains("std::time")
                    || code.contains("tokio")
                    || code.contains("reqwest")
                {
                    bad.push(format!("{}:{}: {}", path.display(), n + 1, code.trim()));
                }
            }
        }
    }
}
