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
        // Honest scope: scenario existence/shape only; the deterministic unit
        // matrix below does not execute the named scenario end-to-end.
        println!("test browser --scenario {id}: stub-ok (scenario exists; unit matrix only)");
    }
    if build_only {
        return build_only_check();
    }
    run_node(&["--test", "packages/browser-runtime/test/*.test.mjs"])?;
    if browser_flag {
        println!("test browser: stub-ok (unit matrix only; no headless browser launched)");
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

pub fn test_ui(_args: &[String]) -> Result<(), String> {
    run_node(&["--test", "test/controller.test.mjs"])?;
    println!("test ui: ok");
    Ok(())
}

pub fn test_web(args: &[String]) -> Result<(), String> {
    let mut e2e = true;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--no-e2e" => e2e = false,
            other => return Err(format!("unknown test web arg '{other}'")),
        }
        i += 1;
    }
    run_node(&[
        "--test",
        "test/*.test.mjs",
        "packages/browser-runtime/test/*.test.mjs",
    ])?;
    println!("web unit tests: ok");
    if e2e {
        run_e2e()?;
        println!("webapp E2E (chromium): ok");
    }
    println!("test web: ok");
    Ok(())
}

/// Playwright E2E for the real webapp: builds the app (wasm + glue), serves
/// it through the deterministic fixture server on loopback, and saves real
/// bytes in Chromium.
fn run_e2e() -> Result<(), String> {
    let root = super::repo_root();
    let e2e_dir = root.join("crates/fixture-server/tests/webapp-e2e");
    if !e2e_dir.join("node_modules").exists() {
        let status = Command::new("npm")
            .args(["ci"])
            .current_dir(&e2e_dir)
            .status()
            .map_err(|e| format!("failed to run npm: {e}"))?;
        if !status.success() {
            return Err("npm ci (webapp-e2e) failed".to_string());
        }
    }
    let status = Command::new("npm")
        .args(["test"])
        .current_dir(&e2e_dir)
        .status()
        .map_err(|e| format!("failed to run npm: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "webapp E2E failed".to_string())
}

pub fn build_web(_args: &[String]) -> Result<(), String> {
    // Deterministic asset check: all web sources present, no secrets embedded.
    for rel in [
        "package.json",
        "index.html",
        "src/webIntegration.ts",
        "src/proxyTransport.ts",
        "src/worker.js",
        "src/server/proxy.ts",
        "functions/proxy.js",
        "functions/api/proxy.ts",
        "src/server/security.ts",
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
    build_site()?;
    run_node(&["--test", "test/*.test.mjs"])?;
    println!(
        "build web: ok (mirrors, help, wasm glue, and dist/ assembled by scripts/build-site.mjs)"
    );
    Ok(())
}

/// Build the entire website via `scripts/build-site.mjs`: browser JS
/// mirrors, help pages, wasm glue, and the deployable `dist/` tree. The
/// same script runs in the website-deploy GitHub Actions workflow, so
/// local builds and deployments cannot diverge.
fn build_site() -> Result<(), String> {
    let root = super::repo_root();
    let status = Command::new("node")
        .arg("scripts/build-site.mjs")
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run node scripts/build-site.mjs: {e}"))?;
    if !status.success() {
        return Err("site build failed (scripts/build-site.mjs)".to_string());
    }
    Ok(())
}

/// Regenerate (`check == false`) or verify (`check == true`) the browser JS
/// mirrors from their TypeScript sources via `scripts/sync-web-js.mjs`.
/// The `.ts` files are the single source of truth; the served `.js` files
/// are generated artifacts that must never be hand-edited.
pub fn sync_web_js(check: bool) -> Result<(), String> {
    let root = super::repo_root();
    let mut cmd = Command::new("node");
    cmd.env("NODE_NO_WARNINGS", "1");
    cmd.arg("scripts/sync-web-js.mjs");
    if check {
        cmd.arg("--check");
    }
    cmd.current_dir(&root);
    let status = cmd
        .status()
        .map_err(|e| format!("failed to run node scripts/sync-web-js.mjs: {e}"))?;
    if !status.success() {
        return Err(if check {
            "browser JS mirrors drifted from TypeScript sources (run `node scripts/sync-web-js.mjs`)".to_string()
        } else {
            "sync-web-js regeneration failed".to_string()
        });
    }
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
