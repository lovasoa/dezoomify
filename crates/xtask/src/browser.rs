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
        "src/config.ts",
        "src/webIntegration.ts",
        "src/proxyTransport.ts",
        "src/worker.js",
        "functions/proxy.ts",
        "functions/api/proxy.ts",
        "functions/security.ts",
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
    build_wasm_glue()?;
    run_node(&["--test", "test/*.test.mjs"])?;
    println!("build web: ok (wasm + browser glue emitted under wasm/)");
    Ok(())
}

/// Build the wasm adapter and generate the browser glue into `wasm/`.
fn build_wasm_glue() -> Result<(), String> {
    let root = super::repo_root();
    let status = Command::new("cargo")
        .args([
            "build",
            "-p",
            "dezoomify-wasm",
            "--target",
            "wasm32-unknown-unknown",
        ])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    if !status.success() {
        return Err("cargo build dezoomify-wasm (wasm32) failed".to_string());
    }
    let wasm = root.join("target/wasm32-unknown-unknown/debug/dezoomify_wasm.wasm");
    if !wasm.exists() {
        return Err("wasm artifact missing after build".to_string());
    }
    let out_dir = root.join("wasm");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir wasm/: {e}"))?;
    let status = Command::new("wasm-bindgen")
        .args([
            "--target",
            "web",
            "--out-dir",
            out_dir.to_str().expect("utf8 root"),
            "--out-name",
            "dezoomify-wasm",
            wasm.to_str().expect("utf8 wasm"),
        ])
        .current_dir(&root)
        .status()
        .map_err(|_| {
            "wasm-bindgen not found; install wasm-bindgen-cli matching the \
             crates/dezoomify-wasm wasm-bindgen version (see docs/development.md)"
                .to_string()
        })?;
    if !status.success() {
        return Err("wasm-bindgen glue generation failed".to_string());
    }
    for file in ["dezoomify-wasm.js", "dezoomify-wasm_bg.wasm"] {
        if !out_dir.join(file).exists() {
            return Err(format!("wasm glue missing {file}"));
        }
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
