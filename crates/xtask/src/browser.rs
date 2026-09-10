//! `cargo xtask test browser [--build-only]`, `test ui`, `test web`,
//! `build web`, `dev ui`, `dev web`: browser-runtime and website gates.
//! Unit coverage is Node-based with injected fakes (no Playwright browsers
//! required). Real Chromium/Firefox/WebKit E2E is an explicit exception:
//! only the chromium engine is installed in this environment.

use std::process::Command;

pub fn test_browser(args: &[String]) -> Result<(), String> {
    let mut build_only = false;
    let mut browser: Option<String> = None;
    let mut scenario: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--build-only" => build_only = true,
            "--browser" => {
                i += 1;
                browser = Some(args.get(i).ok_or("missing --browser <name>")?.clone());
            }
            "--scenario" => {
                i += 1;
                scenario = Some(args.get(i).ok_or("missing --scenario <id>")?.clone());
            }
            other => return Err(format!("unknown test browser arg '{other}'")),
        }
        i += 1;
    }
    let browser_flag = browser.is_some();
    if let Some(name) = browser {
        if name != "chrome" && name != "chromium" {
            return Err(format!(
                "browser '{name}' unavailable (only chromium engine coverage; firefox/webkit deferred)"
            ));
        }
    }
    if let Some(id) = scenario {
        // Scenario focus: the scenario must exist with a parsed expected
        // result; the deterministic unit matrix then runs as usual.
        let candidates = [
            format!("testdata/scenarios/website/{id}/expected/result.json"),
            format!("testdata/scenarios/browser-runtime/{id}/expected/result.json"),
        ];
        let mut ok = false;
        for rel in &candidates {
            if let Ok(text) = std::fs::read_to_string(super::repo_root().join(rel)) {
                let _: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| format!("bad scenario {id}: {e}"))?;
                ok = true;
            }
        }
        if !ok {
            return Err(format!("unknown scenario '{id}'"));
        }
        // Scenario focus: website and browser-runtime scenarios are
        // expectation contracts without executable inputs; their described
        // flows run end-to-end in the real Chromium E2E below (explicit via
        // --browser, or in test web).
        println!("test browser --scenario {id}: ok (expectation validated; unit matrix)");
    }
    if build_only {
        return build_only_check();
    }
    run_node(&["--test", "packages/browser-runtime/test/*.test.mjs"])?;
    if browser_flag {
        // Real headless browser run: the webapp E2E drives the compiled wasm
        // adapter, browser-runtime workers, decoding, canvas assembly, and
        // real save inside actual Chromium over the deterministic fixture
        // server. Unknown engines failed closed above.
        run_e2e()?;
        println!("test browser: ok (headless chromium executed the browser-runtime E2E)");
    } else {
        println!("test browser: ok");
    }
    Ok(())
}

fn build_only_check() -> Result<(), String> {
    // Type-stripped import check: every runtime source must load under node.
    run_node(&["--test", "packages/browser-runtime/test/types.test.mjs"])?;
    println!("test browser --build-only: ok");
    Ok(())
}

pub fn test_ui(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test ui", args)?;
    // Documented ui gate (docs/testing.md): controller, view rendering,
    // accessibility, i18n, and mobile suites.
    generate_web_artifacts()?;
    for suite in [
        "test/controller.test.mjs",
        "test/view-rendering.test.mjs",
        "test/ui-i18n.test.mjs",
        "test/ui-a11y.test.mjs",
        "test/ui-mobile.test.mjs",
    ] {
        run_node(&["--test", suite])?;
    }
    println!("test ui: ok");
    Ok(())
}

pub fn test_web(args: &[String]) -> Result<(), String> {
    let mut e2e = false;
    let mut skip_browser_matrix = false;
    let mut no_unit = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--e2e" => e2e = true,
            "--no-e2e" => e2e = false,
            "--skip-browser-matrix" => skip_browser_matrix = true,
            "--no-unit" => no_unit = true,
            other => return Err(format!("unknown test web arg '{other}'")),
        }
        i += 1;
    }
    generate_web_artifacts()?;
    if no_unit {
        println!("web unit tests: skipped (--no-unit)");
    } else if skip_browser_matrix {
        // Aggregate dedupe: the browser-runtime matrix already ran under
        // `test browser` in the same aggregate, so only the website suite
        // runs here. Standalone `test web` omits the flag and runs both.
        run_node(&["--test", "test/*.test.mjs"])?;
        println!("web unit tests: ok (browser-runtime matrix skipped; covered by test browser)");
    } else {
        run_node(&[
            "--test",
            "test/*.test.mjs",
            "packages/browser-runtime/test/*.test.mjs",
        ])?;
        println!("web unit tests: ok");
    }
    if e2e {
        run_e2e()?;
        println!("webapp E2E (chromium): ok");
    }
    println!("test web: ok");
    Ok(())
}

/// Help pages render through the markdown-it workspace dependency, so the
/// workspace must be installed first (`pnpm install --frozen-lockfile`).
/// Fail closed here instead of surfacing a bare module-not-found from
/// node; the install itself stays an explicit workflow step, never an
/// implicit network fetch inside the deterministic test.
fn ensure_help_deps() -> Result<(), String> {
    if !super::repo_root()
        .join("node_modules/markdown-it/package.json")
        .is_file()
    {
        return Err(
            "workspace dependencies missing (node_modules/markdown-it): run `pnpm install --frozen-lockfile` first"
                .to_string(),
        );
    }
    Ok(())
}

/// Regenerate the untracked web artifacts (browser JS mirrors, help pages)
/// the node test suites read. The generated files are never committed:
/// deployments build them via `scripts/build-site.mjs`.
fn generate_web_artifacts() -> Result<(), String> {
    ensure_help_deps()?;
    let root = super::repo_root();
    for script in ["scripts/sync-web-js.mjs", "scripts/build-help.mjs"] {
        let status = Command::new("node")
            .env("NODE_NO_WARNINGS", "1")
            .arg(script)
            .current_dir(&root)
            .status()
            .map_err(|e| format!("failed to run node {script}: {e}"))?;
        if !status.success() {
            return Err(format!("{script} failed"));
        }
    }
    Ok(())
}

/// Playwright E2E for the real webapp: builds the app (wasm + glue), serves
/// it through the deterministic fixture server on loopback, and saves real
/// bytes in Chromium. Also the real-headless-browser leg for
/// `test browser --browser` and `test wasm --browser`.
pub(crate) fn run_e2e() -> Result<(), String> {
    let root = super::repo_root();
    let status = super::desktop::pnpm_command()?
        .args(["--filter", "webapp-e2e", "test"])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run pnpm: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "webapp E2E failed (run `cargo xtask setup` first)".to_string())
}

pub fn build_web(_args: &[String]) -> Result<(), String> {
    // Deterministic asset check: all web sources present.
    for rel in [
        "package.json",
        "index.html",
        "packages/browser-runtime/src/web-integration.ts",
        "src/proxyTransport.ts",
        "src/worker.js",
        "src/server/proxy.ts",
        "src/server/proxy-node.ts",
        "functions/proxy.js",
        "functions/api/proxy.ts",
        "src/server/security.ts",
        "scripts/dev-server.mjs",
        "packages/shared-ui/src/controller.ts",
    ] {
        if !super::repo_root().join(rel).is_file() {
            return Err(format!("missing web source {rel}"));
        }
    }
    build_site(false)?;
    check_dist_budget()?;
    run_node(&["--test", "test/*.test.mjs"])?;
    println!(
        "build web: ok (mirrors, help, wasm glue, and dist/ assembled by scripts/build-site.mjs)"
    );
    Ok(())
}

/// Deployable-tree size budget (bytes): `dist/` is exactly what the
/// website-deploy workflow uploads, so unbounded growth ships to users. This
/// is the coarse whole-tree backstop; the fine-grained lines (served JS,
/// wasm binary, theme) live in `super::content::verify_sizes` and run under
/// `check`. Generous multiple of the current ~5 MiB tree; a breach means
/// generated assets grew unexpectedly and must be reviewed before deploying.
const DIST_BUDGET_BYTES: u64 = 32 * 1024 * 1024;

fn check_dist_budget() -> Result<(), String> {
    let dist = super::repo_root().join("dist");
    let size = dir_size(&dist)?;
    if size > DIST_BUDGET_BYTES {
        return Err(format!(
            "dist/ is {size} bytes, over the {DIST_BUDGET_BYTES}-byte budget; review generated assets before deploying"
        ));
    }
    println!("build web: dist/ {size} bytes (budget {DIST_BUDGET_BYTES})");
    Ok(())
}

fn dir_size(dir: &std::path::Path) -> Result<u64, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut total = 0u64;
    for entry in entries {
        let path = entry.map_err(|e| format!("dir entry: {e}"))?.path();
        if path.is_dir() {
            total += dir_size(&path)?;
        } else {
            total += std::fs::metadata(&path)
                .map_err(|e| format!("cannot stat {}: {e}", path.display()))?
                .len();
        }
    }
    Ok(total)
}

/// Build the entire website via `scripts/build-site.mjs`: browser JS
/// mirrors, help pages, wasm glue, and the deployable `dist/` tree. The
/// same script runs in the website-deploy GitHub Actions workflow, so
/// local builds and deployments cannot diverge.
fn build_site(no_wasm: bool) -> Result<(), String> {
    ensure_help_deps()?;
    let root = super::repo_root();
    let mut cmd = Command::new("node");
    cmd.arg("scripts/build-site.mjs");
    if no_wasm {
        cmd.arg("--no-wasm");
    }
    let status = cmd
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run node scripts/build-site.mjs: {e}"))?;
    if !status.success() {
        return Err("site build failed (scripts/build-site.mjs)".to_string());
    }
    Ok(())
}

pub fn dev(target: &str, args: &[String]) -> Result<(), String> {
    match target {
        "web" => dev_web(args),
        "ui" => dev_ui(args),
        "extension" => dev_extension(args),
        "desktop" => dev_desktop(),
        _ => Err(format!("unknown dev target '{target}'")),
    }
}

/// Only `--no-wasm` exists: reuse the existing wasm glue instead of
/// rebuilding it (passthrough to `scripts/build-site.mjs --no-wasm`).
fn parse_dev_site_args(label: &str, args: &[String]) -> Result<bool, String> {
    let mut no_wasm = false;
    for arg in args {
        match arg.as_str() {
            "--no-wasm" => no_wasm = true,
            other => {
                return Err(format!(
                    "unknown {label} arg '{other}' (only --no-wasm exists)"
                ));
            }
        }
    }
    Ok(no_wasm)
}

fn path_older_than(path: &std::path::Path, than: std::time::SystemTime) -> bool {
    // Missing inputs fail closed (rebuild).
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t <= than)
        .unwrap_or(false)
}

fn tree_older_than(dir: &std::path::Path, than: std::time::SystemTime) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !tree_older_than(&path, than) {
                return false;
            }
        } else if !path_older_than(&path, than) {
            return false;
        }
    }
    true
}

/// Skip the full site build when `dist/` is newer than every watched
/// source. The builder recreates `dist/` from scratch, so the `dist/`
/// directory mtime marks the last build.
fn dist_fresh() -> bool {
    let root = super::repo_root();
    let dist = root.join("dist");
    if !dist.exists() {
        return false;
    }
    let Ok(dist_mtime) = std::fs::metadata(&dist).and_then(|m| m.modified()) else {
        return false;
    };
    for rel in [
        "scripts/build-site.mjs",
        "scripts/sync-web-js.mjs",
        "scripts/build-help.mjs",
        "index.html",
        "privacy.html",
        "terms.html",
    ] {
        if !path_older_than(&root.join(rel), dist_mtime) {
            return false;
        }
    }
    for dir in [
        "src",
        "packages/shared-ui/src",
        "packages/browser-runtime/src",
        "docs/user",
    ] {
        if !tree_older_than(&root.join(dir), dist_mtime) {
            return false;
        }
    }
    true
}

/// Shared-UI and website development: build the full site (mirrors, wasm
/// glue, dist tree) and serve it on loopback through the Node dev server
/// (static files plus the same /api/proxy relay as production), exactly as
/// deployed.
fn dev_web(args: &[String]) -> Result<(), String> {
    let no_wasm = parse_dev_site_args("dev web", args)?;
    if dist_fresh() {
        println!(
            "dev web: dist/ is newer than sources; skipping site build (remove dist/ to force)"
        );
    } else {
        build_site(no_wasm)?;
    }
    serve_dist(8080, "dev web")
}

/// Isolated shared-UI development: same served tree, beta app origin. The
/// shared UI renders inside the new app at /beta; iterate there, then run
/// `cargo xtask test ui` plus the affected integration lane.
fn dev_ui(args: &[String]) -> Result<(), String> {
    let no_wasm = parse_dev_site_args("dev ui", args)?;
    if dist_fresh() {
        println!(
            "dev ui: dist/ is newer than sources; skipping site build (remove dist/ to force)"
        );
    } else {
        build_site(no_wasm)?;
    }
    serve_dist(8081, "dev ui")
}

fn serve_dist(port: u16, label: &str) -> Result<(), String> {
    let root = super::repo_root();
    let dist = root.join("dist");
    if !dist.exists() {
        return Err("dist/ missing after the site build".to_string());
    }
    let mut child = Command::new("node")
        .args([
            "scripts/dev-server.mjs",
            "--port",
            &port.to_string(),
            "--static-dir",
            &dist.display().to_string(),
        ])
        .current_dir(&root)
        .spawn()
        .map_err(|e| format!("failed to start the dev server: {e}"))?;
    println!(
        "{label}: serving http://127.0.0.1:{port}/ (Ctrl-C to stop; the server exits with the task)"
    );
    let status = child
        .wait()
        .map_err(|e| format!("server wait failed: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("{label}: dev server exited with {status}"))
}

/// Extension development: regenerate the canonical JS mirrors, build WXT's
/// unpacked artifact, then launch the browser with an isolated throwaway profile.
/// Unbranded Chromium only; Google Chrome rejects the command-line loading
/// switches, and other engines fail closed when their binary is not installed.
fn dev_extension(args: &[String]) -> Result<(), String> {
    let mut browser = String::from("chromium");
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--browser" => {
                i += 1;
                browser = args.get(i).ok_or("missing --browser <name>")?.clone();
            }
            other => return Err(format!("unknown dev extension arg '{other}'")),
        }
        i += 1;
    }
    if browser != "chromium" && browser != "chrome" {
        return Err(format!(
            "browser '{browser}' unavailable (only chromium engine dev profiles; firefox/webkit deferred)"
        ));
    }
    let root = super::repo_root();
    // Regenerate the canonical browser JS mirrors with the single
    // generator (type-strip plus `.ts` -> `.js` import rewrite) before the
    // extension entrypoint graph is compiled.
    let status = Command::new("node")
        .arg("scripts/sync-web-js.mjs")
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run node scripts/sync-web-js.mjs: {e}"))?;
    if !status.success() {
        return Err("sync-web-js failed (scripts/sync-web-js.mjs)".to_string());
    }
    // Development must load bindings generated from the current Rust tree;
    // a previous gitignored website build is not a valid extension input.
    super::extension::build_wasm_glue()?;
    super::extension::build_wxt("chrome")?;
    let staging = root.join("apps/extension/.output/chrome-mv3");
    let profile = std::env::temp_dir().join(format!("dz-dev-extension-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&profile);
    // Google Chrome 137+ deliberately rejects both command-line extension
    // switches. Use an unbranded Chromium binary for unpacked development;
    // silently falling back to google-chrome makes the browser open while
    // ignoring the extension entirely.
    let binary = ["chromium", "chromium-browser"]
        .iter()
        .find(|name| {
            Command::new(name)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .copied()
        .ok_or_else(|| {
            let chrome_installed = ["google-chrome", "google-chrome-stable"]
                .iter()
                .any(|name| {
                    Command::new(name)
                        .arg("--version")
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                });
            if chrome_installed {
                "Google Chrome is installed, but it rejects --load-extension for unpacked development; install/use an unbranded Chromium binary (chromium or chromium-browser)"
                    .to_string()
            } else {
                "no Chromium browser binary found (chromium, chromium-browser); Google Chrome is not supported for unpacked extension development"
                    .to_string()
            }
        })?;
    println!(
        "dev extension: unpacked package staged at {}",
        staging.display()
    );
    println!(
        "dev extension: launching {binary} with isolated profile {} (Ctrl-C to stop; delete the profile directory afterwards)",
        profile.display()
    );
    let status = Command::new(binary)
        .args([
            &format!("--user-data-dir={}", profile.display()),
            // Keep the development profile's extension set deterministic.
            // Chromium can otherwise retain an extension-disabled startup
            // state for a fresh profile and silently omit --load-extension.
            &format!("--disable-extensions-except={}", staging.display()),
            &format!("--load-extension={}", staging.display()),
            "--no-first-run",
            "--no-default-browser-check",
        ])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to launch {binary}: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("{binary} exited with {status}"))
}

fn dev_desktop() -> Result<(), String> {
    super::desktop::dev_desktop()
}

fn run_node(args: &[&str]) -> Result<(), String> {
    // Shell-expand globs (Command does not glob): expand *.test.mjs manually.
    let mut expanded: Vec<String> = Vec::new();
    for arg in args {
        if arg.contains('*') {
            let pattern = super::repo_root().join(arg);
            // `repo_root()` is absolute, so a parent always exists; a
            // missing one is a usage error, not a panic (6.1 unwrap policy).
            let Some(dir) = pattern.parent() else {
                return Err(format!("bad glob pattern '{arg}'"));
            };
            let dir = dir.to_path_buf();
            for entry in std::fs::read_dir(&dir).map_err(|e| format!("read dir: {e}"))? {
                let path = entry.map_err(|e| format!("dir entry: {e}"))?.path();
                if path.extension().and_then(|e| e.to_str()) == Some("mjs") {
                    expanded.push(path.to_string_lossy().into_owned());
                }
            }
        } else {
            expanded.push(arg.to_string());
        }
    }
    // First arg is the node flag when present.
    let status = Command::new("node")
        .args(&expanded)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run node: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "node tests failed".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn browser_build_only() {
        assert!(super::build_only_check().is_ok());
    }

    #[test]
    fn dev_site_no_wasm_flag() {
        assert_eq!(super::parse_dev_site_args("dev web", &[]), Ok(false));
        assert_eq!(
            super::parse_dev_site_args("dev web", &["--no-wasm".to_string()]),
            Ok(true)
        );
        assert!(super::parse_dev_site_args("dev web", &["--bogus".to_string()]).is_err());
        assert!(super::parse_dev_site_args("dev ui", &["--bogus".to_string()]).is_err());
    }
}
