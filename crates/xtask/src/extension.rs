//! `cargo xtask build extension`, `dev extension`, and `test extension`.
//! `test extension` runs the Node unit suites plus a
//! headless browser gate (real store packages loaded in headless Chromium and
//! Firefox; requires browsers, see apps/extension/tests/browser).

use super::content::{EXT_ZIP_FAIL_BYTES, WASM_FAIL_BYTES};
use std::process::Command;

/// Glue-JS size budget (bytes): the wasm glue has no `check` equivalent
/// (it ships inside the `dist/beta` JS budget there) so its build-time line
/// stays local. Zip and wasm-binary budgets reuse the `check` fail lines
/// above so a build never produces what `check` rejects (see
/// `check_size_budget` uses below).
const WASM_JS_BUDGET_BYTES: u64 = 512 * 1024;

fn check_size_budget(path: &std::path::Path, budget: u64, label: &str) -> Result<(), String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("missing {label} {}: {e}", path.display()))?
        .len();
    if size > budget {
        return Err(format!(
            "{label} {} is {size} bytes, over the {budget}-byte budget; review vendored bytes before shipping",
            path.display()
        ));
    }
    Ok(())
}

pub fn build_extension(_args: &[String]) -> Result<(), String> {
    build_wasm_glue()?;
    // WXT owns both the extension build and ZIP creation.
    let out_dir = super::repo_root().join("target/extension");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("create target/extension: {e}"))?;
    for (browser, wxt_browser) in [("chromium", "chrome"), ("firefox", "firefox")] {
        let source_zip = package_wxt(wxt_browser)?;
        let zip = out_dir.join(format!("dezoomify-{browser}.zip"));
        std::fs::copy(&source_zip, &zip).map_err(|e| {
            format!(
                "copy WXT package {} to {}: {e}",
                source_zip.display(),
                zip.display()
            )
        })?;
        let size = std::fs::metadata(&zip)
            .map_err(|e| format!("missing package {}: {e}", zip.display()))?
            .len();
        if size > EXT_ZIP_FAIL_BYTES {
            return Err(format!(
                "store package {} is {size} bytes, over the {EXT_ZIP_FAIL_BYTES}-byte budget; review vendored bytes before shipping",
                zip.display()
            ));
        }
        println!(
            "build extension: packaged {} ({} bytes)",
            zip.display(),
            size
        );
    }
    Ok(())
}

fn package_wxt(browser: &str) -> Result<std::path::PathBuf, String> {
    run_wxt(browser, "zip")?;
    let root = super::repo_root();
    if browser == "firefox" {
        let background = root.join("apps/extension/.output/firefox-mv3/background.js");
        let status = Command::new("node")
            .arg("--check")
            .arg(&background)
            .status()
            .map_err(|e| format!("failed to parse Firefox background: {e}"))?;
        if !status.success() {
            return Err("Firefox background must be a parseable classic script".to_string());
        }
    }
    Ok(root
        .join("apps/extension/.output")
        .join(format!("dezoomify-{browser}.zip")))
}

pub(crate) fn build_wxt(browser: &str) -> Result<(), String> {
    run_wxt(browser, "build")
}

fn run_wxt(browser: &str, command: &str) -> Result<(), String> {
    let root = super::repo_root();
    let output = super::desktop::pnpm_command()?
        .args([
            "--dir",
            "apps/extension",
            "exec",
            "wxt",
            command,
            "--browser",
            browser,
            "--level",
            "error",
        ])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to run WXT for {browser}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "WXT {command} failed for {browser}:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// The extension page runs the wasm discovery core inline, so regenerate the
/// glue (`wasm/dezoomify-wasm.js` + `dezoomify-wasm_bg.wasm`) from the current
/// Rust source before packaging or testing. These artifacts are gitignored:
/// existence alone says nothing about freshness.
pub(crate) fn build_wasm_glue() -> Result<(), String> {
    let root = super::repo_root();
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        })
        .unwrap_or_else(|| root.join("target"));
    let glue = root.join("wasm/dezoomify-wasm.js");
    let wasm = root.join("wasm/dezoomify-wasm_bg.wasm");
    let status = Command::new("cargo")
        .args([
            "build",
            "--quiet",
            "-p",
            "dezoomify-wasm",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
        ])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    if !status.success() {
        return Err("wasm core build failed".to_string());
    }
    let status = Command::new("wasm-bindgen")
        .args([
            "--target",
            "web",
            "--out-dir",
            "wasm",
            "--out-name",
            "dezoomify-wasm",
            &target_dir
                .join("wasm32-unknown-unknown/release/dezoomify_wasm.wasm")
                .display()
                .to_string(),
        ])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run wasm-bindgen (is wasm-bindgen-cli installed?): {e}"))?;
    if !status.success() {
        return Err("wasm-bindgen failed".to_string());
    }
    check_size_budget(&glue, WASM_JS_BUDGET_BYTES, "wasm glue JS")?;
    check_size_budget(&wasm, WASM_FAIL_BYTES, "wasm binary")?;
    Ok(())
}

pub fn test_extension(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test extension", args)?;
    prepare_extension_tests()?;
    super::command::node_test(&["apps/extension/tests/unit/*.test.mjs"], false)?;
    test_headless_browser()
}

pub(crate) fn test_extension_integration() -> Result<(), String> {
    prepare_extension_tests()?;
    super::command::node_test(
        &[
            "apps/extension/tests/unit/job-worker.test.mjs",
            "apps/extension/tests/unit/manifest-policy.test.mjs",
        ],
        false,
    )?;
    test_headless_browser()
}

fn prepare_extension_tests() -> Result<(), String> {
    // The unit suite imports and executes this exact generated boundary.
    // Build it first so a stale or absent local artifact cannot be mocked
    // away while the store package is broken.
    build_wasm_glue()?;
    for browser in ["chrome", "firefox"] {
        build_wxt(browser)?;
    }
    Ok(())
}

/// Headless browser gate: load the real store-shaped packages in headless
/// Chromium and Firefox and verify a pixel-correct saved PNG. Node deps live in
/// `apps/extension/tests/browser` workspace package. Dependencies are
/// installed by `cargo xtask setup`. Firefox binary discovery is documented in the
/// test itself (`DEZOOMIFY_FIREFOX_BIN`, system paths, Playwright cache).
fn test_headless_browser() -> Result<(), String> {
    // `test_extension` has just regenerated the gitignored WASM artifacts;
    // WXT copies those exact bytes through its build hook for both browser runs.
    let status = super::desktop::pnpm_command()?
        .args([
            "--reporter=silent",
            "--filter",
            "dezoomify-extension-headless",
            "test",
        ])
        .env("NODE_NO_WARNINGS", "1")
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run pnpm: {e}"))?;
    status.success().then_some(()).ok_or_else(|| {
        "extension headless browser tests failed (run `cargo xtask setup` first)".to_string()
    })
}
