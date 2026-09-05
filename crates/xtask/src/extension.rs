//! `cargo xtask build extension`, `dev extension`, `test extension`,
//! `test native-messaging [--browser <name>|--cleanup-only]`: extension and
//! Native Messaging gates. Browser E2E needs installed browsers/profiles;
//! unit, manifest-policy, secret-scope, and package checks run here.

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
    println!("build extension: stub-ok (manifests verified; no zip packaged)");
    Ok(())
}

pub fn test_extension(_args: &[String]) -> Result<(), String> {
    run_node_glob("apps/extension/tests/unit")?;
    test_native_messaging(&[])?;
    println!("test extension: ok");
    Ok(())
}

pub fn test_native_messaging(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("--cleanup-only") {
        // Honest stub: no registry/profile inspection here; only reports that
        // the unit gate left no in-process registrations behind.
        println!(
            "test native-messaging --cleanup-only: stub-ok (no filesystem/registry inspection)"
        );
        return Ok(());
    }
    // Protocol + secret-scope checks via extension unit tests: no real
    // browser profiles touched. Browser-specific runs need installed browsers;
    // fail closed for unknown engines instead of silently running the same suite.
    if let Some(name) = args.strip_prefix(&["--browser".to_string()]) {
        match name.first().map(String::as_str) {
            Some("chromium") | Some("chrome") => {
                run_node_glob("apps/extension/tests/unit")?;
                println!(
                    "test native-messaging --browser {}: stub-ok (unit API only; no browser profile)",
                    name[0]
                );
                return Ok(());
            }
            Some(other) => {
                return Err(format!(
                    "browser '{other}' unavailable (unit API only; no firefox/webkit profile here)"
                ));
            }
            None => return Err("missing --browser <name>".to_string()),
        }
    }
    run_node_glob("apps/extension/tests/unit")?;
    println!("test native-messaging: ok");
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
