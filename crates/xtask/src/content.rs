//! Content guards for misleading user-facing claims and tracked size budgets.
//!
//! Size budgets pin the shipped bytes that prose guards cannot
//! see: the WASM binding (`wasm/dezoomify-wasm_bg.wasm`, 5 MB warn / 6 MB
//! fail), the extension store ZIPs (`target/extension/*.zip`, 3 MB warn /
//! 4 MB fail), the served `dist/beta` JavaScript (750 kB warn / 1 MB fail),
//! and the shared-UI theme (`packages/shared-ui/src/styles/theme.css`,
//! 2000-line warn / 2500-line fail). Build outputs are gitignored, so a
//! missing artifact skips with a rebuild note instead of failing a fresh
//! checkout; tracked sources fail closed.
use std::path::Path;
use std::process::Command;
pub fn verify(a: &[String]) -> Result<(), String> {
    if !a.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    let r = super::repo_root();
    let canvas = canvas_constants_pattern(&r)?;
    f(
        &r,
        &[canvas.as_str(), "docs/user/", "apps/desktop/desktop-app.md"],
        "raw canvas constant in docs/user/ (state limits in user units)",
    )?;
    let o = g(
        &r,
        &[
            "-n",
            "-i",
            "dezoomer|readable tile bytes|tainted|blob allocation|multi[ -]?core",
            "docs/user/",
            "apps/desktop/desktop-app.md",
            "packages/shared-ui/src/view.tsx",
            "packages/shared-ui/src/components.ts",
        ],
    )?;
    if !o.is_empty() {
        return Err(format!("banned user-facing vocabulary:\n{o}"));
    }
    if g(
        &r,
        &[
            "-o",
            "-N",
            "250 ?ms",
            "docs/user/",
            "apps/desktop/desktop-app.md",
            "packages/shared-ui/src/view.tsx",
            "packages/shared-ui/src/components.ts",
        ],
    )?
    .lines()
    .count()
        > 2
    {
        return Err("250 ms appears >2x outside canonical transport docs".to_string());
    }
    // Contract docs agree with DIRECT_METADATA_TIMEOUT_MS in browser-runtime/tile-policy.ts.
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
    // Native provides PNG, JPEG, TIFF, ZIF, WebP, and iiif-dir output.
    f(
        &r,
        &["single-PNG", "apps/README.md", "docs", "README.md"],
        "stale single-PNG claim (native ships PNG, JPEG, TIFF, ZIF, WebP, iiif-dir)",
    )?;
    // Release and store availability are live product facts. Keep the
    // website sources free of the obsolete Linux-only, signature, and
    // pending-Firefox copy that previously survived release changes.
    f(
        &r,
        &[
            "-i",
            "GPG|SHA256SUMS|only (the )?Linux|Linux only|no installer|on its way|coming soon|pending review|Firefox version|In Vorbereitung|En preparation|In arrivo",
            "README.md",
            "docs/user/",
            "apps/desktop/desktop-app.md",
            "packages/shared-ui/src/",
        ],
        "stale installer or browser-extension availability copy in website sources",
    )?;
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

/// Banned raw canvas constants, parsed from the real values in
/// `packages/browser-runtime/src/limits.ts` so this guard cannot drift from
/// them again. Every `export const *CANVAS* = <n>;` limit (desktop and
/// mobile area/side pairs) is included, with word boundaries so longer
/// unrelated numbers cannot collide. User-facing docs state limits in
/// rounded user units, never these raw constants.
fn canvas_constants_pattern(r: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(r.join("packages/browser-runtime/src/limits.ts"))
        .map_err(|e| format!("read limits.ts: {e}"))?;
    let mut values: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("export const ") else {
            continue;
        };
        let Some((name, tail)) = rest.split_once(" = ") else {
            continue;
        };
        if !name.contains("CANVAS") {
            continue;
        }
        let Some(value) = tail.strip_suffix(';') else {
            continue;
        };
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if !values.iter().any(|v| v == value) {
            values.push(value.to_string());
        }
    }
    if values.is_empty() {
        return Err("no canvas constants parsed from limits.ts".to_string());
    }
    Ok(format!("\\b({})\\b", values.join("|")))
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

/// One gitignored build output against its byte budget. A missing file
/// skips with the rebuild note; a present file warns or fails by verdict.
fn budget_file(r: &Path, rel: &str, warn: u64, fail: u64, hint: &str) -> Result<(), String> {
    let path = r.join(rel);
    let Ok(meta) = std::fs::metadata(&path) else {
        println!("sizes: {rel} missing ({hint}); skipped");
        return Ok(());
    };
    let actual = meta.len();
    match verdict(actual, warn, fail) {
        Verdict::Pass => {
            println!("sizes: {rel} {actual} bytes ok");
            Ok(())
        }
        Verdict::Warn => {
            println!("sizes: WARNING {rel} {actual} bytes exceeds warn {warn} (fail {fail})");
            Ok(())
        }
        Verdict::Fail => Err(format!(
            "sizes: {rel} {actual} bytes exceeds fail budget {fail} (warn {warn})"
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
        "run `cargo xtask build web`",
    )?;
    for name in ["dezoomify-chromium.zip", "dezoomify-firefox.zip"] {
        budget_file(
            r,
            &format!("target/extension/{name}"),
            EXT_ZIP_WARN_BYTES,
            EXT_ZIP_FAIL_BYTES,
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
    // Git is required to operate this repository and searches tracked
    // working-tree files only, so build outputs cannot affect content policy.
    let mut flags = Vec::new();
    let mut pathspecs = vec![":(exclude)crates/xtask/src/content.rs".to_string()];
    let mut pattern = None;
    let mut glob = None;
    let mut paths = Vec::new();
    let mut index = 0;
    while index < a.len() {
        match a[index] {
            "-n" | "-i" | "-o" | "-w" => flags.push(a[index].to_string()),
            "-N" => flags.push("--no-line-number".to_string()),
            "--glob" => {
                index += 1;
                glob = Some(*a.get(index).ok_or("missing --glob value")?);
            }
            value if value.starts_with('-') => {
                return Err(format!("unsupported content search flag {value}"));
            }
            value if pattern.is_none() => pattern = Some(value),
            value => paths.push(value.to_string()),
        }
        index += 1;
    }
    let pattern = pattern.ok_or("missing content search pattern")?;
    if let Some(glob) = glob {
        // Current policy uses a glob as its complete search scope. Unlike
        // ripgrep's filtering flag, Git pathspecs are additive, so retaining
        // the broad path argument here would silently widen the search.
        pathspecs.push(format!(":(top,glob){glob}"));
    } else {
        pathspecs.extend(paths);
    }
    let output = Command::new("git")
        .args(["grep", "-I", "-E"])
        .args(&flags)
        .arg(pattern)
        .arg("--")
        .args(&pathspecs)
        .current_dir(r)
        .output()
        .map_err(|e| format!("failed to run git grep: {e}"))?;
    match output.status.code() {
        Some(0) => Ok(String::from_utf8_lossy(&output.stdout).to_string()),
        Some(1) => Ok(String::new()),
        _ => Err(format!(
            "git grep failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )),
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
}
