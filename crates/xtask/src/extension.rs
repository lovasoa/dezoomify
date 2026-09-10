//! `cargo xtask build extension`, `dev extension`, `test extension`,
//! `test native-messaging [--browser <name>|--cleanup-only]`: extension and
//! Native Messaging gates. `test extension` runs the Node unit suites plus a
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
    println!("{label}: {size} bytes (budget {budget})");
    Ok(())
}

pub fn build_extension(_args: &[String]) -> Result<(), String> {
    build_wasm_glue()?;
    // WXT owns both the extension build and ZIP creation. Verify its output
    // before copying the store artifacts to their stable release locations.
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
    let root = super::repo_root();
    let status = super::desktop::pnpm_command()?
        .args([
            "--dir",
            "apps/extension",
            "exec",
            "wxt",
            "zip",
            "--browser",
            browser,
        ])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run WXT for {browser}: {e}"))?;
    if !status.success() {
        return Err(format!("WXT packaging failed for {browser}"));
    }
    let output = root
        .join("apps/extension/.output")
        .join(format!("{browser}-mv3"));
    let status = Command::new("node")
        .args([
            "apps/extension/scripts/verify-artifact.mjs",
            &output.display().to_string(),
            browser,
        ])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to verify WXT {browser} artifact: {e}"))?;
    if !status.success() {
        return Err(format!("WXT {browser} artifact verification failed"));
    }
    Ok(root
        .join("apps/extension/.output")
        .join(format!("dezoomify-{browser}.zip")))
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
    generate_vendor_mirrors()?;
    // The unit suite imports and executes this exact generated boundary.
    // Build it first so a stale or absent local artifact cannot be mocked
    // away while the store package is broken.
    build_wasm_glue()?;
    for browser in ["chrome", "firefox"] {
        let status = super::desktop::pnpm_command()?
            .args([
                "--dir",
                "apps/extension",
                "exec",
                "wxt",
                "build",
                "--browser",
                browser,
            ])
            .current_dir(super::repo_root())
            .status()
            .map_err(|e| format!("failed to build WXT {browser} artifact: {e}"))?;
        if !status.success() {
            return Err(format!("WXT {browser} artifact build failed"));
        }
        let output = super::repo_root()
            .join("apps/extension/.output")
            .join(format!("{browser}-mv3"));
        let status = Command::new("node")
            .args([
                "apps/extension/scripts/verify-artifact.mjs",
                &output.display().to_string(),
                browser,
            ])
            .current_dir(super::repo_root())
            .status()
            .map_err(|e| format!("failed to verify WXT {browser} artifact: {e}"))?;
        if !status.success() {
            return Err(format!("WXT {browser} artifact verification failed"));
        }
    }
    run_node_glob("apps/extension/tests/unit")?;
    test_headless_browser()?;
    // The unit glob already ran above; skip it inside the composed
    // native-messaging gate so the suite runs once per `test extension`.
    // Standalone `test native-messaging` omits the flag and stays full.
    test_native_messaging(&["--skip-unit".to_string()])?;
    println!("test extension: ok");
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
        .args(["--filter", "dezoomify-extension-headless", "test"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run pnpm: {e}"))?;
    status.success().then_some(()).ok_or_else(|| {
        "extension headless browser tests failed (run `cargo xtask setup` first)".to_string()
    })
}

pub fn test_native_messaging(args: &[String]) -> Result<(), String> {
    // Aggregate dedupe: `--skip-unit`/`--no-unit` skips the shared extension
    // unit glob when the caller already ran it (see `test_extension`).
    // Standalone invocations omit the flag and stay full.
    let mut skip_unit = false;
    let mut rest: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "--skip-unit" | "--no-unit" => skip_unit = true,
            _ => rest.push(arg.clone()),
        }
    }
    if rest.first().map(String::as_str) == Some("--cleanup-only") {
        // Real cleanup: remove our per-user registrations (profile manifest
        // files and, on Windows, HKCU registry values). The unit gate never
        // registers anything in-process, so a clean report afterwards proves
        // no residual registration.
        if rest.len() > 1 {
            return Err(format!(
                "unknown test native-messaging --cleanup-only argument(s): {}",
                rest[1..].join(" ")
            ));
        }
        let removed =
            super::native_messaging::cleanup(&super::native_messaging::known_registrations())?;
        if removed.is_empty() {
            println!("test native-messaging --cleanup-only: ok (no registrations present)");
        } else {
            for entry in &removed {
                println!("test native-messaging --cleanup-only: removed {entry}");
            }
        }
        return Ok(());
    }
    // Protocol + secret-scope checks via extension unit tests, then real
    // per-user registration inspection for the named engine. Browser-specific
    // handshakes need installed browsers; unknown engines fail closed.
    if let Some(name) = rest.strip_prefix(&["--browser".to_string()]) {
        match name
            .first()
            .and_then(|n| super::native_messaging::normalize_engine(n))
        {
            Some(engine) => {
                if name.len() > 1 {
                    return Err(format!(
                        "unknown test native-messaging argument(s): {}",
                        name[1..].join(" ")
                    ));
                }
                if skip_unit {
                    println!(
                        "test native-messaging --browser {engine}: unit skipped (--skip-unit)"
                    );
                } else {
                    run_node_glob("apps/extension/tests/unit")?;
                }
                let found = super::native_messaging::inspect_and_report(Some(engine))?;
                println!(
                    "test native-messaging --browser {engine}: ok ({} registration(s) found)",
                    found
                );
                return Ok(());
            }
            None => {
                let offered = name.first().map(String::as_str).unwrap_or("");
                return Err(format!(
                    "browser '{offered}' unavailable (engines: chromium, chrome, firefox)"
                ));
            }
        }
    }
    super::reject_unknown_args("test native-messaging", &rest)?;
    if skip_unit {
        println!("test native-messaging: unit skipped (--skip-unit; covered by test extension)");
    } else {
        run_node_glob("apps/extension/tests/unit")?;
    }
    test_install_round_trip()?;
    super::native_messaging::inspect_and_report(None)?;
    println!("test native-messaging: ok");
    Ok(())
}

/// Deterministic registration proof: install the reviewed templates into a
/// temp home, verify exact IDs with no wildcards, then clean up. Never
/// touches the real profile; the `--cleanup-only` gate covers real-profile
/// hygiene separately.
fn test_install_round_trip() -> Result<(), String> {
    let home = std::env::temp_dir().join(format!(
        "dz-nm-xtask-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&home).map_err(|e| format!("create temp home: {e}"))?;
    let written = super::native_messaging::install_to(
        &home,
        "/opt/dezoomify/dezoomify-native-host",
        "abcdefghijklmnopqrstuvwxyzabcdef",
        "dezoomify@dezoomify.example",
    )?;
    if written.is_empty() {
        return Err("install round trip wrote no manifests".to_string());
    }
    for path in &written {
        let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
        if !super::native_messaging::is_our_manifest(&text) {
            return Err(format!("installed manifest does not name our host: {path}"));
        }
        if text.contains('*') {
            return Err(format!("installed manifest contains wildcard: {path}"));
        }
    }
    let regs: Vec<super::native_messaging::Registration> = written
        .iter()
        .map(|p| super::native_messaging::Registration::File {
            engine: "chromium",
            path: std::path::PathBuf::from(p),
        })
        .collect();
    super::native_messaging::cleanup(&regs)?;
    std::fs::remove_dir_all(&home).map_err(|e| format!("remove temp home: {e}"))?;
    println!(
        "test native-messaging: install round trip ok ({} manifest(s))",
        written.len()
    );
    Ok(())
}

/// Regenerate the canonical browser JS mirrors plus the no-bundler
/// extension vendor copies before the unit glob, so the parity gates read
/// fresh output. Same generator the `web` lane runs; generated trees are
/// never committed.
fn generate_vendor_mirrors() -> Result<(), String> {
    let status = Command::new("node")
        .arg("scripts/sync-web-js.mjs")
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run node scripts/sync-web-js.mjs: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "sync-web-js failed (scripts/sync-web-js.mjs)".to_string())
}

fn run_node_glob(dir: &str) -> Result<(), String> {
    let full = super::repo_root().join(dir);
    let mut files: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&full).map_err(|e| format!("read dir {dir}: {e}"))? {
        let path = entry.map_err(|e| format!("dir entry: {e}"))?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("mjs") {
            files.push(path.to_string_lossy().into_owned());
        }
    }
    files.sort();
    let mut args = vec!["--test".to_string()];
    args.extend(files);
    let status = Command::new("node")
        .args(&args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run node: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "extension node tests failed".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn extension_manifests() {
        assert!(super::build_extension(&[]).is_ok());
    }
}
