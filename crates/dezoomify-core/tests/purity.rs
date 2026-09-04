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
/// `#[cfg(test)]` modules and bare `#[test]` functions may use `std::fs` to
/// load scenario payloads; the scan strips those regions before matching.
/// Allowed pure utilities (`Arc`, `LazyLock`, `Cursor`, `include_str!`,
/// `include_bytes!`, pure collections) are intentionally absent from this
/// list; threading, locking, clocks, randomness, TLS, and stdio are not.
const FORBIDDEN_PATTERNS: &[&str] = &[
    "std::fs",
    "std::net",
    "std::process",
    "std::env",
    "std::thread",
    "std::time",
    "std::io::stdin",
    "std::io::stdout",
    "std::io::stderr",
    "SystemTime",
    "Instant::now",
    "UNIX_EPOCH",
    "tokio",
    "async_std",
    "smol",
    "reqwest",
    "hyper",
    "wasm_bindgen",
    "web_sys",
    "js_sys",
    "image::",
    "png::",
    "tiff::",
    "image_hasher::",
    "clap::",
    "indicatif::",
    "env_logger::",
    "tempfile::",
    "futures::",
    "rand",
    "getrandom",
    "OsRng",
    "thread_rng",
    "SmallRng",
    "rustls",
    "native_tls",
    "native-tls",
    "openssl",
    "chrono::",
    "time::",
    "spawn",
    "Mutex",
    "RwLock",
    "stdin",
    "stdout",
    "stderr",
    "fs::",
    "File::open",
    "OpenOptions",
    "read_to_string",
    "env!",
    "option_env!",
    "env::var",
    "var_os",
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
/// `iipimage::` do not trip the `image::` rule. Patterns ending in `:` (path
/// rules like `fs::`) or `!` (macros like `env!`) check the leading boundary
/// only: the trailing sigil is itself the boundary, and requiring a trailing
/// non-ident char would make `fs::read` and `env!("X")` invisible.
fn contains_ident(line: &str, pattern: &str) -> bool {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let trailing_sigil = pattern.ends_with(':') || pattern.ends_with('!');
    let mut start = 0;
    while let Some(pos) = line[start..].find(pattern) {
        let s = start + pos;
        let e = s + pattern.len();
        let before = line[..s].chars().next_back().is_some_and(is_ident);
        if trailing_sigil {
            if !before {
                return true;
            }
        } else {
            let after = line[e..].chars().next().is_some_and(is_ident);
            if !before && !after {
                return true;
            }
        }
        start = e;
    }
    false
}

/// Remove `#[cfg(test)] mod ... { ... }` regions and bare `#[test] fn`
/// regions via brace matching so test helpers (which load scenario payloads
/// from disk) do not trip the scan. Annotations without a following item
/// body (e.g. `#[cfg(test)]` on a single `use` line) skip exactly one line
/// so surrounding library code is never swallowed.
fn strip_test_modules(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim_start();
        if trimmed.starts_with("#[cfg(test)]") || trimmed.starts_with("#[test]") {
            // Look at the annotated item on this or the next non-empty line.
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim().is_empty() {
                j += 1;
            }
            let item = lines.get(j).map(|l| l.trim_start()).unwrap_or("");
            let is_block_item = item.starts_with("mod ")
                || item.starts_with("fn ")
                || item.starts_with("impl ")
                || item.starts_with("struct ")
                || item.starts_with("enum ")
                || item.starts_with("trait ");
            // `#[cfg(test)]` requires an explicit `mod` (never strip a lone
            // `use` or other single-line item plus its followers).
            if trimmed.starts_with("#[cfg(test)]") && !item.starts_with("mod ") {
                out.push(lines[i]);
                i += 1;
                continue;
            }
            if !is_block_item {
                // Single-line item (e.g. `use ...;`): skip the annotation and
                // the item line only.
                i = j + 1;
                continue;
            }
            // Skip to the opening brace of the module/function, then to its match.
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

#[test]
fn sigil_patterns_match_path_calls() {
    // Regression: `fs::read` and `image::open` must trip their rules even
    // though the patterns end in `:`; `iipimage::` must not trip `image::`.
    assert!(contains_ident("let b = fs::read(p).unwrap();", "fs::"));
    assert!(contains_ident("std::fs::read_to_string(p)", "std::fs"));
    assert!(contains_ident("image::open(p)", "image::"));
    assert!(!contains_ident("iipimage::open(p)", "image::"));
    assert!(contains_ident("let p = env!(\"X\");", "env!"));
}

#[test]
fn stripper_keeps_code_after_lone_use() {
    // Regression: `#[cfg(test)]` on a single `use` must not swallow the
    // following library function.
    let text = "#[cfg(test)]\nuse std::fs;\nfn evil() { std::fs::read(\"x\"); }";
    let stripped = strip_test_modules(text);
    assert!(stripped.contains("evil"), "stripper swallowed library code");
}
