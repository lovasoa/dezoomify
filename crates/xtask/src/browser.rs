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
        // Honest scope: scenario existence/shape only; the deterministic unit
        // matrix below does not execute the named scenario end-to-end.
        println!("test browser --scenario {id}: stub-ok (scenario exists; unit matrix only)");
    }
    if build_only {
        return build_only_check();
    }
    run_node(&["--test", "packages/browser-runtime/test/*.test.mjs"])?;
    println!("test browser: ok");
    Ok(())
}

fn build_only_check() -> Result<(), String> {
    // Type-stripped import check: every runtime source must load under node.
    run_node(&["--test", "packages/browser-runtime/test/types.test.mjs"])?;
    println!("test browser --build-only: ok");
    Ok(())
}

pub fn test_ui(_args: &[String]) -> Result<(), String> {
    run_node(&["--test", "apps/web/test/controller.test.mjs"])?;
    println!("test ui: ok");
    Ok(())
}

pub fn test_web(_args: &[String]) -> Result<(), String> {
    run_node(&[
        "--test",
        "apps/web/test/*.test.mjs",
        "packages/browser-runtime/test/*.test.mjs",
    ])?;
    println!("test web: ok");
    Ok(())
}

pub fn build_web(_args: &[String]) -> Result<(), String> {
    // Deterministic asset check: all web sources present, no secrets embedded.
    for rel in [
        "apps/web/package.json",
        "apps/web/src/config.ts",
        "apps/web/src/webIntegration.ts",
        "apps/web/src/proxyTransport.ts",
        "apps/web/functions/proxy.ts",
        "apps/web/functions/api/proxy.ts",
        "apps/web/functions/security.ts",
        "packages/shared-ui/src/controller.ts",
    ] {
        let text = std::fs::read_to_string(super::repo_root().join(rel))
            .map_err(|e| format!("missing web source {rel}: {e}"))?;
        for needle in ["sk-", "AKIA", "BEGIN PRIVATE KEY", "password="] {
            if text.contains(needle) {
                return Err(format!("web source {rel} contains secret pattern"));
            }
        }
    }
    run_node(&["--test", "apps/web/test/*.test.mjs"])?;
    println!("build web: stub-ok (sources + tests only; no bundle emitted)");
    Ok(())
}

pub fn dev(target: &str) -> Result<(), String> {
    println!(
        "dev {target}: stub-ok (sources present; no dev server started; see docs/development.md)"
    );
    Ok(())
}

fn run_node(args: &[&str]) -> Result<(), String> {
    // Shell-expand globs (Command does not glob): expand *.test.mjs manually.
    let mut expanded: Vec<String> = Vec::new();
    for arg in args {
        if arg.contains('*') {
            let pattern = super::repo_root().join(arg);
            let dir = pattern.parent().expect("parent").to_path_buf();
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
}
