//! Purity gate: WASM adapter owns no browser I/O (no fetch/DOM/canvas/
//! storage/worker/decoder capabilities in Rust source).

use std::path::Path;
use std::process::Command;

const BANNED_DEPS: &[&str] = &[
    "reqwest", "tokio", "web-sys", "js-sys", "image", "png", "clap",
];
const BANNED_SOURCE: &[&str] = &[
    "fetch(",
    "Window",
    "Document",
    "HtmlCanvas",
    "localStorage",
    "Worker(",
    "std::fs",
    "std::net",
];

#[test]
fn direct_dependencies_stay_adapter_only() {
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

#[test]
fn lib_source_has_no_browser_capability() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bad = Vec::new();
    visit(&src, &mut bad);
    assert!(
        bad.is_empty(),
        "browser capability in wasm src:\n{}",
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
                for pattern in BANNED_SOURCE {
                    if code.contains(pattern) {
                        bad.push(format!("{}:{}: {pattern}", path.display(), n + 1));
                    }
                }
            }
        }
    }
}
