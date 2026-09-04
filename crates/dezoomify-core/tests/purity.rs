//! Guards the purity contract of this crate's dependency graph.
//!
//! Cargo already enforces the source-level guarantee: a crate absent from this
//! crate's `Cargo.toml` cannot be imported by its source.  Nothing, however,
//! prevents a future edit from adding a runtime crate to `Cargo.toml`.  This
//! test lists the *direct* dependencies that cargo resolved for this crate and
//! fails if any application-runtime crate is among them.
//!
//! Only direct dependencies are checked: pure libraries such as `serde-xml-rs`
//! may legitimately pull `log` into the transitive closure without making it
//! importable by this crate's source.

use std::path::Path;
use std::process::Command;

/// Runtime crates that must never appear in this crate's dependency graph.
/// `log` is a zero-dependency facade (no runtime, no I/O) and is explicitly allowed
/// so dezoomers can emit debug diagnostics when the host initializes a logger.
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
    "wasm-bindgen",
    "web-sys",
    "js-sys",
];

#[test]
fn direct_dependencies_contain_no_runtime_crates() {
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
        .expect("failed to run `cargo tree`");
    assert!(
        output.status.success(),
        "`cargo tree` failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // `cargo tree --depth 1` prints this crate itself first, then its direct
    // dependencies, one per line.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    assert!(lines.next().is_some(), "`cargo tree` printed nothing");
    let violations = lines
        .filter_map(|line| line.split_whitespace().next())
        .filter(|name| BANNED.contains(name))
        .collect::<Vec<_>>();
    assert!(
        violations.is_empty(),
        "dezoomify-core must not depend on runtime crates, but its declared \
         dependencies include: {}",
        violations.join(", ")
    );
}

/// Host capabilities that must never appear in non-test library source.
/// `#[cfg(test)]` modules may use `std::fs` to load scenario payloads; the
/// scan strips those regions before matching.
const FORBIDDEN_PATTERNS: &[&str] = &[
    "std::fs",
    "std::net",
    "std::process",
    "std::env",
    "std::thread",
    "SystemTime",
    "Instant::now",
    "tokio",
    "async_std",
    "smol",
    "reqwest",
    "hyper",
    "wasm_bindgen",
    "web_sys",
    "js_sys",
    "image::",
];

#[test]
fn library_source_uses_no_host_capability() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs(&src, &mut files);
    assert!(!files.is_empty(), "no source files found");
    let mut violations = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).expect("read source");
        let code = strip_test_modules(&text);
        for (n, line) in code.lines().enumerate() {
            let line = line.split("//").next().unwrap_or("");
            for pattern in FORBIDDEN_PATTERNS {
                if contains_ident(line, pattern) {
                    violations.push(format!(
                        "{}:{}: forbidden capability `{pattern}`",
                        file.display(),
                        n + 1
                    ));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "host capabilities in core library source:\n{}",
        violations.join("\n")
    );
}

fn collect_rs(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .expect("list src")
        .map(|e| e.expect("dir entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// Match `pattern` only on identifier boundaries so module paths such as
/// `iipimage::` do not trip the `image::` rule.
fn contains_ident(line: &str, pattern: &str) -> bool {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut start = 0;
    while let Some(pos) = line[start..].find(pattern) {
        let s = start + pos;
        let e = s + pattern.len();
        let before = line[..s].chars().next_back().is_some_and(is_ident);
        let after = line[e..].chars().next().is_some_and(is_ident);
        if !before && !after {
            return true;
        }
        start = e;
    }
    false
}

/// Remove `#[cfg(test)] mod ... { ... }` regions via brace matching so test
/// helpers (which load scenario payloads from disk) do not trip the scan.
fn strip_test_modules(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim_start().starts_with("#[cfg(test)]") {
            // Skip to the opening brace of the module, then to its match.
            let mut depth = 0usize;
            let mut opened = false;
            while i < lines.len() {
                depth += lines[i].chars().filter(|c| *c == '{').count();
                depth = depth.saturating_sub(lines[i].chars().filter(|c| *c == '}').count());
                i += 1;
                if depth > 0 {
                    opened = true;
                } else if opened {
                    break;
                }
            }
        } else {
            out.push(lines[i]);
            i += 1;
        }
    }
    out.join("\n")
}
