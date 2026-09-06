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

pub fn test_ui(_args: &[String]) -> Result<(), String> {
    run_node(&["--test", "test/controller.test.mjs"])?;
    println!("test ui: ok");
    Ok(())
}

pub fn test_web(args: &[String]) -> Result<(), String> {
    let mut e2e = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--e2e" => e2e = true,
            other => return Err(format!("unknown test web arg '{other}'")),
        }
        i += 1;
    }
    generate_web_artifacts()?;
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

/// Regenerate the untracked web artifacts (browser JS mirrors, help pages)
/// the node test suites read. The generated files are never committed:
/// deployments build them via `scripts/build-site.mjs`.
fn generate_web_artifacts() -> Result<(), String> {
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
        for needle in [
            "sk-",
            "AKIA",
            "BEGIN PRIVATE KEY",
            "BEGIN OPENSSH PRIVATE KEY",
            "password=",
            "apiKey=",
            "apikey=",
            "api_key=",
            "access_token",
            "x-api-key",
            "aws_secret_access_key",
        ] {
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

pub fn dev(target: &str, args: &[String]) -> Result<(), String> {
    match target {
        "web" => dev_web(),
        "ui" => dev_ui(),
        "extension" => dev_extension(args),
        "desktop" => dev_desktop(),
        _ => Err(format!("unknown dev target '{target}'")),
    }
}

/// Shared-UI and website development: build the full site (mirrors, wasm
/// glue, dist tree) and serve it on loopback through the deterministic
/// fixture server, exactly as deployed.
fn dev_web() -> Result<(), String> {
    build_site()?;
    serve_dist(8080, "dev web")
}

/// Isolated shared-UI development: same served tree, beta app origin. The
/// shared UI renders inside the new app at /beta; iterate there, then run
/// `cargo xtask test ui` plus the affected integration lane.
fn dev_ui() -> Result<(), String> {
    build_site()?;
    serve_dist(8081, "dev ui")
}

fn serve_dist(port: u16, label: &str) -> Result<(), String> {
    let root = super::repo_root();
    let bin = root.join("target/debug/dezoomify-fixture-server");
    if !bin.exists() {
        let status = Command::new("cargo")
            .args(["build", "-p", "dezoomify-fixture-server"])
            .current_dir(&root)
            .status()
            .map_err(|e| format!("failed to run cargo: {e}"))?;
        if !status.success() {
            return Err("fixture server build failed".to_string());
        }
    }
    let dist = root.join("dist");
    if !dist.exists() {
        return Err("dist/ missing after the site build".to_string());
    }
    let mut child = Command::new(&bin)
        .args([
            "--port",
            &port.to_string(),
            "--static-dir",
            &dist.display().to_string(),
            "--scenarios-dir",
            &root.join("testdata/scenarios").display().to_string(),
        ])
        .current_dir(&root)
        .spawn()
        .map_err(|e| format!("failed to start the fixture server: {e}"))?;
    println!("{label}: serving http://127.0.0.1:{port}/ (Ctrl-C to stop; the server exits with the task)");
    let status = child
        .wait()
        .map_err(|e| format!("server wait failed: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("{label}: dev server exited with {status}"))
}

/// Extension development: stage an unpacked load (manifest + .ts sources
/// mirrored to .js, syntax-checked) for the named engine, then launch the
/// browser with an isolated throwaway profile. Chrome/Chromium engine only;
/// other engines fail closed when their binary is not installed.
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
    let staging = root.join("target/extension-unpacked");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| format!("clear {}: {e}", staging.display()))?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| format!("create staging: {e}"))?;
    let src = root.join("apps/extension/src");
    let manifest = root.join("apps/extension/generated/manifest.chromium.json");
    std::fs::copy(&manifest, staging.join("manifest.json"))
        .map_err(|e| format!("stage manifest: {e}"))?;
    for dir in ["icons", "background", "app", "content"] {
        let from = src.join(dir);
        let to = staging.join(dir);
        std::fs::create_dir_all(&to).map_err(|e| format!("create {dir}: {e}"))?;
        for entry in std::fs::read_dir(&from).map_err(|e| format!("read {dir}: {e}"))? {
            let path = entry.map_err(|e| format!("{dir} entry: {e}"))?.path();
            let name = path
                .file_name()
                .expect("file name")
                .to_string_lossy()
                .into_owned();
            let dest = if name.ends_with(".ts") {
                to.join(format!("{}.js", &name[..name.len() - 3]))
            } else {
                to.join(&name)
            };
            std::fs::copy(&path, &dest).map_err(|e| format!("stage {name}: {e}"))?;
            if dest.extension().and_then(|e| e.to_str()) == Some("js") {
                let status = Command::new("node")
                    .arg("--check")
                    .arg(&dest)
                    .status()
                    .map_err(|e| format!("failed to run node --check: {e}"))?;
                if !status.success() {
                    return Err(format!(
                        "staged file failed syntax check: {}",
                        dest.display()
                    ));
                }
            }
        }
    }
    let profile = std::env::temp_dir().join(format!("dz-dev-extension-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&profile);
    let binary = ["chromium", "google-chrome", "chromium-browser"]
        .iter()
        .find(|name| {
            Command::new(name)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .copied()
        .ok_or(
            "no chromium-engine browser binary found (chromium, google-chrome, chromium-browser)",
        )?;
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
