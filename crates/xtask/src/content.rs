//! Content guards: stale limits, banned vocab, timeout spread, encoder drift,
//! contract tense, staleness markers, and tracked size budgets.
//!
//! Size budgets (todo 6.3) pin the shipped bytes that prose guards cannot
//! see: the wasm adapter (`wasm/dezoomify-wasm_bg.wasm`, 5 MB warn / 6 MB
//! fail), the extension store ZIPs (`target/extension/*.zip`, 3 MB warn /
//! 4 MB fail), the served `dist/beta` JavaScript (750 kB warn / 1 MB fail),
//! and the shared-UI theme (`packages/shared-ui/src/styles/theme.css`,
//! 2000-line warn / 2500-line fail). Build outputs are gitignored, so a
//! missing artifact skips with a rebuild note instead of failing a fresh
//! checkout; tracked sources fail closed.
use regex::RegexBuilder;
use std::path::Path;
const ALLOW: &[&str] = &[
    "--dezoomer",
    "supportedDezoomers",
    "ALL_DEZOOMERS",
    "const dezoomers",
    "dezoomers.forEach",
    "dezoomer?:",
    "Generic dezoomer",
];
pub fn verify(a: &[String]) -> Result<(), String> {
    if !a.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    let r = super::repo_root();
    f(
        &r,
        &["1 GiB", "docs/user/start-here.md"],
        "stale 1 GiB in start-here.md (canonical is 8 GiB)",
    )?;
    f(
        &r,
        &["2 GB per tab"],
        "stale 2 GB per tab (use 8 GiB canvas limit)",
    )?;
    f(
        &r,
        &["268435456|16384", "docs/user/"],
        "raw canvas constant in docs/user/ (state limits in GiB)",
    )?;
    let o = g(
        &r,
        &[
            "-n",
            "-i",
            "dezoomer|readable tile bytes|tainted|blob allocation|multi[ -]?core",
            "docs/user/",
            "packages/shared-ui/src/view.ts",
            "packages/shared-ui/src/components.ts",
        ],
    )?;
    let v: Vec<&str> = o
        .lines()
        .filter(|l| !ALLOW.iter().any(|x| l.contains(x)))
        .collect();
    if !v.is_empty() {
        return Err(format!("banned vocab outside allowlist:\n{}", v.join("\n")));
    }
    if g(
        &r,
        &[
            "-o",
            "-N",
            "250 ?ms",
            "docs/user/",
            "packages/shared-ui/src/view.ts",
            "packages/shared-ui/src/components.ts",
        ],
    )?
    .lines()
    .count()
        > 2
    {
        return Err("250 ms appears >2x outside canonical transport docs".to_string());
    }
    let (p, q, d) = (
        std::fs::read_to_string(r.join("docs/product.md"))
            .map_err(|e| format!("read product.md: {e}"))?,
        std::fs::read_to_string(r.join("docs/protocol.md"))
            .map_err(|e| format!("read protocol.md: {e}"))?,
        std::fs::read_to_string(r.join("crates/dezoomify-protocol/src/dto.rs"))
            .map_err(|e| format!("read dto.rs: {e}"))?,
    );
    let b = |t: &str| {
        t.find("encoders `[")
            .and_then(|i| t[i..].find(']').map(|j| t[i..i + j + 1].to_string()))
    };
    if b(&p) != b(&q)
        || !["png", "jpeg", "tiff"]
            .iter()
            .all(|e| d.contains(&format!("\"{e}\"")))
    {
        return Err(format!(
            "encoder-list drift: product.md {:?} vs protocol.md {:?} vs dto.rs [png, jpeg, tiff]",
            b(&p),
            b(&q)
        ));
    }
    // Stale direct-first window: the shipped code waits 1500 ms (dto.rs
    // METADATA_WINDOW_MS with its generated TypeScript projection, plus the
    // browser-runtime fetch and policy modules). Contract docs and the root
    // README agree with that window; older 250 ms notes survive only in code
    // comments describing the history.
    f(
        &r,
        &["250 ?ms", "docs", "README.md"],
        "stale 250 ms window (canonical is the 1500 ms metadata window)",
    )?;
    // Stale branch: `master` is the single branch (website-deploy.yml
    // triggers on it); no contract doc still points pushes at `ng`.
    f(
        &r,
        &["to `ng`", "docs"],
        "stale ng branch (canonical is master)",
    )?;
    // Encoder truth: native ships six output formats (commands.rs
    // SUPPORTED_FORMATS: PNG, JPEG, TIFF, ZIF, WebP, iiif-dir); no app or
    // contract doc still promises single-PNG output.
    f(
        &r,
        &["single-PNG", "apps/README.md", "docs", "README.md"],
        "stale single-PNG claim (native ships PNG, JPEG, TIFF, ZIF, WebP, iiif-dir)",
    )?;
    // Staleness markers: contract docs carry no TBD, TODO, or FIXME. Open
    // work lives in plans/, never as a marker in a contract.
    f(
        &r,
        &[
            "TBD|TODO|FIXME",
            "docs",
            "README.md",
            "AGENTS.md",
            "apps/README.md",
        ],
        "staleness marker in contract docs (resolve it or move it to plans/)",
    )?;
    // Present tense: top-level contract pages state invariants, so the
    // lowercase future marker has no business there. User guides under
    // docs/user/ keep their own register and stay out of this glob.
    let tense = g(&r, &["-n", "-w", "will", "--glob", "docs/*.md", "docs"])?;
    if !tense.trim().is_empty() {
        return Err(format!(
            "future tense in contract docs (use present tense):\n{tense}"
        ));
    }
    verify_sizes(&r)?;
    println!("content: ok");
    Ok(())
}
fn f(r: &Path, a: &[&str], m: &str) -> Result<(), String> {
    let o = g(r, &[&["-n"], a].concat())?;
    if o.trim().is_empty() {
        Ok(())
    } else {
        Err(format!("{m}:\n{o}"))
    }
}

/// Tracked size budgets in bytes (lines for the theme). Warn prints and
/// passes; fail returns an error. The fail lines are shared with the
/// build-time gates (`build extension` reuses `WASM_FAIL_BYTES` and
/// `EXT_ZIP_FAIL_BYTES`) so a build never produces what `check` rejects.
const WASM_WARN_BYTES: u64 = 5_000_000;
pub(crate) const WASM_FAIL_BYTES: u64 = 6_000_000;
const EXT_ZIP_WARN_BYTES: u64 = 3_000_000;
pub(crate) const EXT_ZIP_FAIL_BYTES: u64 = 4_000_000;
const DIST_JS_WARN_BYTES: u64 = 750_000;
const DIST_JS_FAIL_BYTES: u64 = 1_000_000;
const THEME_WARN_LINES: u64 = 2_000;
const THEME_FAIL_LINES: u64 = 2_500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Pass,
    Warn,
    Fail,
}

fn verdict(actual: u64, warn: u64, fail: u64) -> Verdict {
    if actual > fail {
        Verdict::Fail
    } else if actual > warn {
        Verdict::Warn
    } else {
        Verdict::Pass
    }
}

/// One gitignored build output against its budget. A missing file skips
/// with the rebuild note; a present file warns or fails by the verdict.
fn budget_file(
    r: &Path,
    rel: &str,
    warn: u64,
    fail: u64,
    unit: &str,
    hint: &str,
) -> Result<(), String> {
    let path = r.join(rel);
    let Ok(meta) = std::fs::metadata(&path) else {
        println!("sizes: {rel} missing ({hint}); skipped");
        return Ok(());
    };
    let actual = meta.len();
    match verdict(actual, warn, fail) {
        Verdict::Pass => {
            println!("sizes: {rel} {actual} {unit} ok");
            Ok(())
        }
        Verdict::Warn => {
            println!("sizes: WARNING {rel} {actual} {unit} exceeds warn {warn} (fail {fail})");
            Ok(())
        }
        Verdict::Fail => Err(format!(
            "sizes: {rel} {actual} {unit} exceeds fail budget {fail} (warn {warn})"
        )),
    }
}

/// Total bytes of served `dist/beta` JavaScript (`*.js` only, so the wasm
/// binary never counts). `None` when the tree was never built.
fn dist_js_bytes(r: &Path) -> Result<Option<u64>, String> {
    let dir = r.join("dist/beta");
    if !dir.is_dir() {
        return Ok(None);
    }
    sum_js_bytes(&dir).map(Some)
}

fn sum_js_bytes(dir: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut entries: Vec<_> = entries
        .map(|e| e.map_err(|e| format!("dir entry: {e}")))
        .collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            total += sum_js_bytes(&path)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("js") {
            total += std::fs::metadata(&path)
                .map_err(|e| format!("cannot stat {}: {e}", path.display()))?
                .len();
        }
    }
    Ok(total)
}

fn verify_sizes(r: &Path) -> Result<(), String> {
    budget_file(
        r,
        "wasm/dezoomify-wasm_bg.wasm",
        WASM_WARN_BYTES,
        WASM_FAIL_BYTES,
        "bytes",
        "run `cargo xtask build web`",
    )?;
    for name in ["dezoomify-chromium.zip", "dezoomify-firefox.zip"] {
        budget_file(
            r,
            &format!("target/extension/{name}"),
            EXT_ZIP_WARN_BYTES,
            EXT_ZIP_FAIL_BYTES,
            "bytes",
            "run `cargo xtask build extension`",
        )?;
    }
    match dist_js_bytes(r)? {
        None => println!("sizes: dist/beta missing (run `cargo xtask build web`); skipped"),
        Some(total) => match verdict(total, DIST_JS_WARN_BYTES, DIST_JS_FAIL_BYTES) {
            Verdict::Pass => println!("sizes: dist/beta JS {total} bytes ok"),
            Verdict::Warn => println!(
                "sizes: WARNING dist/beta JS {total} bytes exceeds warn {} (fail {})",
                DIST_JS_WARN_BYTES, DIST_JS_FAIL_BYTES
            ),
            Verdict::Fail => {
                return Err(format!(
                    "sizes: dist/beta JS {total} bytes exceeds fail budget {} (warn {})",
                    DIST_JS_FAIL_BYTES, DIST_JS_WARN_BYTES
                ));
            }
        },
    }
    let theme = r.join("packages/shared-ui/src/styles/theme.css");
    let text =
        std::fs::read_to_string(&theme).map_err(|e| format!("read {}: {e}", theme.display()))?;
    let lines = text.lines().count() as u64;
    match verdict(lines, THEME_WARN_LINES, THEME_FAIL_LINES) {
        Verdict::Pass => println!("sizes: theme.css {lines} lines ok"),
        Verdict::Warn => println!(
            "sizes: WARNING theme.css {lines} lines exceeds warn {} (fail {})",
            THEME_WARN_LINES, THEME_FAIL_LINES
        ),
        Verdict::Fail => {
            return Err(format!(
                "sizes: theme.css {lines} lines exceeds fail budget {} (warn {})",
                THEME_FAIL_LINES, THEME_WARN_LINES
            ));
        }
    }
    Ok(())
}
fn g(r: &Path, a: &[&str]) -> Result<String, String> {
    // Content guards are part of `cargo xtask check`, including hosted CI.
    // Keep them self-contained: GitHub's standard runners do not guarantee
    // ripgrep, and installing a host package just for static policy is slow
    // and platform-specific.
    let mut line_numbers = false;
    let mut ignore_case = false;
    let mut only_matches = false;
    let mut whole_word = false;
    let mut glob = None;
    let mut pattern = None;
    let mut paths = Vec::new();
    let mut index = 0;
    while index < a.len() {
        match a[index] {
            "-n" => line_numbers = true,
            "-N" => line_numbers = false,
            "-i" => ignore_case = true,
            "-o" => only_matches = true,
            "-w" => whole_word = true,
            "--glob" => {
                index += 1;
                glob = Some(*a.get(index).ok_or("missing --glob value")?);
            }
            value if value.starts_with('-') => {
                return Err(format!("unsupported content search flag {value}"));
            }
            value if pattern.is_none() => pattern = Some(value),
            value => paths.push(value),
        }
        index += 1;
    }
    let pattern = pattern.ok_or("missing content search pattern")?;
    let pattern = if whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern.to_string()
    };
    let regex = RegexBuilder::new(&pattern)
        .case_insensitive(ignore_case)
        .build()
        .map_err(|e| format!("invalid content search pattern {pattern:?}: {e}"))?;
    if paths.is_empty() {
        paths.push(".");
    }
    let mut files = Vec::new();
    for path in paths {
        collect_content_files(r, &r.join(path), &mut files)?;
    }
    files.sort();
    files.dedup();
    let mut output = String::new();
    for file in files {
        let relative = file
            .strip_prefix(r)
            .map_err(|e| format!("content path outside repository: {e}"))?;
        let relative_text = relative.to_string_lossy();
        if relative_text == "crates/xtask/src/content.rs"
            || glob.is_some_and(|glob| !content_glob_matches(glob, &relative_text))
        {
            continue;
        }
        // Match ripgrep's default binary handling: policy searches apply to
        // text contracts, while image/icon bytes are neither parseable text
        // nor a meaningful place for prose markers.
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => continue,
            Err(error) => return Err(format!("read {}: {error}", file.display())),
        };
        for (number, line) in text.lines().enumerate() {
            if only_matches {
                for found in regex.find_iter(line) {
                    output.push_str(found.as_str());
                    output.push('\n');
                }
            } else if regex.is_match(line) {
                if line_numbers {
                    output.push_str(&format!("{}:{}:{line}\n", relative.display(), number + 1));
                } else {
                    output.push_str(line);
                    output.push('\n');
                }
            }
        }
    }
    Ok(output)
}

fn collect_content_files(
    root: &Path,
    path: &Path,
    files: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    if !path.is_dir() {
        return Err(format!(
            "content search path does not exist: {}",
            path.display()
        ));
    }
    for entry in std::fs::read_dir(path).map_err(|e| format!("list {}: {e}", path.display()))? {
        let entry = entry.map_err(|e| format!("content directory entry: {e}"))?;
        let child = entry.path();
        let name = entry.file_name();
        if child.is_dir() {
            if matches!(
                name.to_str(),
                Some(".git" | "target" | "node_modules" | "dist" | "artifacts" | "testdata")
            ) {
                continue;
            }
            collect_content_files(root, &child, files)?;
        } else if child.is_file() {
            // A caller can pass a path outside the repository only by first
            // bypassing the task runner; reject it rather than scanning it.
            if child.starts_with(root) {
                files.push(child);
            }
        }
    }
    Ok(())
}

fn content_glob_matches(glob: &str, relative: &str) -> bool {
    match glob {
        "docs/*.md" => {
            let Some(name) = relative.strip_prefix("docs/") else {
                return false;
            };
            !name.contains('/') && name.ends_with(".md")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{sum_js_bytes, verdict, Verdict};

    #[test]
    fn budget_verdict_boundaries() {
        assert_eq!(verdict(0, 5, 6), Verdict::Pass);
        assert_eq!(verdict(5, 5, 6), Verdict::Pass);
        assert_eq!(verdict(6, 5, 6), Verdict::Warn);
        assert_eq!(verdict(7, 5, 6), Verdict::Fail);
    }

    #[test]
    fn current_budgets_cover_measured_artifacts() {
        // Measured 2026-09-07: wasm 3_816_463 bytes, extension ZIPs
        // ~1_254_000 bytes, dist/beta JS 288_441 bytes, theme.css 1859
        // lines. Budgets pass with headroom and fail on unbounded growth.
        assert_eq!(
            verdict(3_816_463, super::WASM_WARN_BYTES, super::WASM_FAIL_BYTES),
            Verdict::Pass
        );
        assert_eq!(
            verdict(
                1_254_259,
                super::EXT_ZIP_WARN_BYTES,
                super::EXT_ZIP_FAIL_BYTES
            ),
            Verdict::Pass
        );
        assert_eq!(
            verdict(
                288_441,
                super::DIST_JS_WARN_BYTES,
                super::DIST_JS_FAIL_BYTES
            ),
            Verdict::Pass
        );
        assert_eq!(
            verdict(1859, super::THEME_WARN_LINES, super::THEME_FAIL_LINES),
            Verdict::Pass
        );
    }

    #[test]
    fn js_sum_counts_only_js() {
        let base = std::env::temp_dir().join(format!("xtask-sizes-{}-js", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).expect("create temp tree");
        std::fs::write(base.join("a.js"), "12345").unwrap();
        std::fs::write(base.join("sub/b.js"), "123").unwrap();
        std::fs::write(base.join("sub/c.wasm"), "1234567890").unwrap();
        assert_eq!(sum_js_bytes(&base).unwrap(), 8);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn repo_passes_content_guards() {
        assert!(super::verify(&[]).is_ok());
    }
}
