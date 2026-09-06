//! `cargo xtask build desktop [--unsigned-test]` / `test desktop` /
//! `dev desktop`: the real desktop pipeline. The lean shell (default
//! features, pure Rust) always compiles; the Tauri window shell (feature
//! `tauri`) additionally needs the platform webview system packages and is
//! compiled when they are present. Bundling runs only without
//! `--unsigned-test` and only when the bundler prerequisites exist.

use std::process::Command;

const DESKTOP_MANIFEST: &str = "apps/desktop/src-tauri/Cargo.toml";
const WEBKIT_SYSTEM_PACKAGES: &str =
    "libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential";

pub fn build_desktop(args: &[String]) -> Result<(), String> {
    let unsigned_test = args.iter().any(|a| a == "--unsigned-test");
    for rel in [
        "apps/desktop/src-tauri/tauri.conf.json",
        "apps/desktop/src-tauri/capabilities/generated.json",
        "generated/desktop-capabilities.json",
    ] {
        let path = super::repo_root().join(rel);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("missing desktop file {rel}: {e}"))?;
        let _: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("bad json {rel}: {e}"))?;
    }
    // The lean shell always compiles: it is the deterministic gate.
    run_cargo(&["build", "--manifest-path", DESKTOP_MANIFEST])?;
    println!("build desktop: lean shell compiled (apps/desktop/src-tauri/target/debug/dezoomify-desktop)");
    if tauri_system_ready() {
        build_frontend()?;
        run_cargo(&[
            "build",
            "--manifest-path",
            DESKTOP_MANIFEST,
            "--features",
            "tauri",
            "--bin",
            "dezoomify-desktop",
        ])?;
        println!("build desktop: window shell compiled (tauri feature)");
        if unsigned_test {
            println!("build desktop --unsigned-test: ok (no bundle produced)");
            return Ok(());
        }
        bundle()
    } else {
        println!(
            "build desktop: window shell skipped; install the webview system packages to enable it ({WEBKIT_SYSTEM_PACKAGES})"
        );
        println!("build desktop: ok (lean shell; no bundle)");
        Ok(())
    }
}

pub fn test_desktop(_args: &[String]) -> Result<(), String> {
    run_node(&["apps/desktop/tests/deep-link.test.mjs"])?;
    run_node(&["apps/desktop/tests/capabilities.test.mjs"])?;
    println!("test desktop: ok");
    Ok(())
}

/// Desktop development: run the real Tauri development application. Needs
/// the webview system packages; fails closed with the exact prerequisite
/// list when they are missing.
pub fn dev_desktop() -> Result<(), String> {
    if !tauri_system_ready() {
        return Err(format!(
            "dev desktop needs the webview system packages ({WEBKIT_SYSTEM_PACKAGES}); the lean shell has no window to develop against"
        ));
    }
    build_frontend()?;
    run_cargo(&[
        "build",
        "--manifest-path",
        DESKTOP_MANIFEST,
        "--features",
        "tauri",
        "--bin",
        "dezoomify-desktop",
    ])?;
    let root = super::repo_root();
    let bin = root.join("apps/desktop/src-tauri/target/debug/dezoomify-desktop");
    if !bin.exists() {
        return Err(format!(
            "desktop binary missing after build: {}",
            bin.display()
        ));
    }
    println!("dev desktop: launching {}", bin.display());
    let status = Command::new(&bin)
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to launch the desktop shell: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("desktop shell exited with {status}"))
}

/// Whether the platform webview development packages are available. Only
/// Linux needs an explicit check; macOS/Windows ship their webviews.
fn tauri_system_ready() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    Command::new("pkg-config")
        .args(["--exists", "webkit2gtk-4.1"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether the Linux bundler prerequisites (dpkg for a .deb) are present.
fn bundler_ready() -> bool {
    if cfg!(target_os = "linux") {
        Command::new("dpkg-deb")
            .arg("--version")
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        true
    }
}

fn build_frontend() -> Result<(), String> {
    let status = Command::new("pnpm")
        .args(["--filter", "./apps/desktop", "build"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run pnpm: {e}"))?;
    status.success().then_some(()).ok_or_else(|| {
        "desktop frontend build failed (pnpm --filter ./apps/desktop build)".to_string()
    })
}

fn bundle() -> Result<(), String> {
    if !bundler_ready() {
        return Err(
            "desktop bundling needs dpkg-deb (install the dpkg tools or pass --unsigned-test)"
                .to_string(),
        );
    }
    // The icons must exist before the bundler runs.
    let status = Command::new("python3")
        .arg("scripts/gen-desktop-icons.py")
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run python3: {e}"))?;
    if !status.success() {
        return Err("icon generation failed".to_string());
    }
    let status = Command::new("cargo")
        .args(["tauri", "build", "--features", "tauri", "--bundles", "deb"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo tauri: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "desktop bundling failed (cargo tauri build)".to_string())?;
    println!("build desktop: ok (deb bundle produced)");
    Ok(())
}

fn run_cargo(args: &[&str]) -> Result<(), String> {
    let status = Command::new("cargo")
        .args(args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("cargo {} failed", args.join(" ")))
}

fn run_node(args: &[&str]) -> Result<(), String> {
    let status = Command::new("node")
        .args(args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run node: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "desktop node tests failed".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_logic() {
        assert!(super::test_desktop(&[]).is_ok());
    }
}
