//! `cargo xtask build extension`, `dev extension`, `test extension`,
//! `test native-messaging [--browser <name>|--cleanup-only]`: extension and
//! Native Messaging gates. `test extension` runs the Node unit suites plus a
//! headless browser gate (real store packages loaded in headless Chromium and
//! Firefox; requires browsers, see apps/extension/tests/browser).

use std::process::Command;

pub fn build_extension(_args: &[String]) -> Result<(), String> {
    for rel in [
        "apps/extension/generated/manifest.chromium.json",
        "apps/extension/generated/manifest.firefox.json",
    ] {
        let path = super::repo_root().join(rel);
        let text =
            std::fs::read_to_string(&path).map_err(|e| format!("missing manifest {rel}: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("bad manifest {rel}: {e}"))?;
        if value.get("manifest_version").is_none() {
            return Err(format!("manifest {rel} lacks manifest_version"));
        }
    }
    ensure_wasm_glue()?;
    // Package real store-shaped ZIPs for both listings via the same script
    // the store-submission workflow uses, so local builds cannot diverge
    // from what is uploaded.
    let out_dir = super::repo_root().join("target/extension");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("create target/extension: {e}"))?;
    for browser in ["chromium", "firefox"] {
        let zip = out_dir.join(format!("dezoomify-{browser}.zip"));
        let status = Command::new("bash")
            .arg("apps/extension/scripts/package-store.sh")
            .arg(browser)
            .arg(&zip)
            .current_dir(super::repo_root())
            .status()
            .map_err(|e| format!("failed to run package-store.sh: {e}"))?;
        if !status.success() {
            return Err(format!("packaging {browser} extension failed"));
        }
        let size = std::fs::metadata(&zip)
            .map_err(|e| format!("missing package {}: {e}", zip.display()))?
            .len();
        println!(
            "build extension: packaged {} ({} bytes)",
            zip.display(),
            size
        );
    }
    Ok(())
}

/// The extension page runs the wasm discovery core inline, so the generated
/// glue (`wasm/dezoomify-wasm.js` + `dezoomify-wasm_bg.wasm`) must exist
/// before packaging. Generated the same way `scripts/build-site.mjs` does;
/// like all website generated artifacts it is never committed.
fn ensure_wasm_glue() -> Result<(), String> {
    let root = super::repo_root();
    let glue = root.join("wasm/dezoomify-wasm.js");
    let wasm = root.join("wasm/dezoomify-wasm_bg.wasm");
    if glue.exists() && wasm.exists() {
        return Ok(());
    }
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
            "target/wasm32-unknown-unknown/release/dezoomify_wasm.wasm",
        ])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run wasm-bindgen (is wasm-bindgen-cli installed?): {e}"))?;
    if !status.success() {
        return Err("wasm-bindgen failed".to_string());
    }
    Ok(())
}

pub fn test_extension(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test extension", args)?;
    run_node_glob("apps/extension/tests/unit")?;
    test_headless_browser()?;
    test_native_messaging(&[])?;
    println!("test extension: ok");
    Ok(())
}

/// Headless browser gate: load the real store-shaped packages in headless
/// Chromium and Firefox and assert the background starts. Node deps live in
/// `apps/extension/tests/browser` (npm-managed, like the webapp-e2e suite);
/// install them on first run. Firefox binary discovery is documented in the
/// test itself (`DEZOOMIFY_FIREFOX_BIN`, system paths, Playwright cache).
fn test_headless_browser() -> Result<(), String> {
    let dir = super::repo_root().join("apps/extension/tests/browser");
    if !dir.join("node_modules").exists() {
        let status = Command::new("npm")
            .args(["ci", "--no-audit", "--no-fund"])
            .current_dir(&dir)
            .status()
            .map_err(|e| format!("failed to run npm: {e}"))?;
        if !status.success() {
            return Err("npm ci (extension headless browser tests) failed".to_string());
        }
    }
    let mut files: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("read dir: {e}"))? {
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
        .ok_or_else(|| "extension headless browser tests failed".to_string())
}

pub fn test_native_messaging(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("--cleanup-only") {
        // Real cleanup: remove our per-user registrations (profile manifest
        // files and, on Windows, HKCU registry values). The unit gate never
        // registers anything in-process, so a clean report afterwards proves
        // no residual registration.
        if args.len() > 1 {
            return Err(format!(
                "unknown test native-messaging --cleanup-only argument(s): {}",
                args[1..].join(" ")
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
    if let Some(name) = args.strip_prefix(&["--browser".to_string()]) {
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
                run_node_glob("apps/extension/tests/unit")?;
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
    super::reject_unknown_args("test native-messaging", args)?;
    run_node_glob("apps/extension/tests/unit")?;
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
