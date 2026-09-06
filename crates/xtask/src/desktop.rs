//! `cargo xtask build desktop [--unsigned-test]` / `test desktop` /
//! `dev desktop`: the real desktop pipeline. The lean shell (default
//! features, pure Rust) always compiles; the Tauri window shell (feature
//! `tauri`) additionally needs the platform webview system packages and is
//! compiled when they are present. Bundling runs only without
//! `--unsigned-test` and only when the bundler prerequisites exist.
//!
//! Bundle matrix (built on the matching host, `tauri.conf.json`
//! `bundle.targets` stays `all` and the CLI selects the host bundle):
//! Linux builds `deb` via `cargo tauri build --bundles deb` (needs
//! `dpkg-deb` plus the generated PNG icons); Windows builds `msi`/`nsis`
//! (needs WebView2 plus WiX for msi and NSIS for nsis plus `icon.ico`);
//! macOS builds `dmg` (needs the Xcode Command Line Tools plus `icon.icns`).
//! A target is available only when its recipe and host tools are present;
//! otherwise bundling fails closed naming the exact prerequisites.
//! `--unsigned-test` is the no-bundle CI path: lean shell, frontend, and
//! window shell compile, then it stops before the bundler.
//!
//! Order is fixed: lean shell, frontend, window shell, icons, bundler.
//!
//! `dezoomify-desktop` is a member of the root workspace and shares the root
//! `Cargo.lock`; the default features keep it offline-capable.

use std::process::Command;

const DESKTOP_PKG: &str = "dezoomify-desktop";
const WEBKIT_SYSTEM_PACKAGES: &str =
    "libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential";

pub fn build_desktop(args: &[String]) -> Result<(), String> {
    for arg in args {
        if arg != "--unsigned-test" {
            return Err(format!(
                "unknown build desktop argument '{arg}' (only --unsigned-test exists)"
            ));
        }
    }
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
    run_cargo(&["build", "-p", DESKTOP_PKG])?;
    println!("build desktop: lean shell compiled (target/debug/dezoomify-desktop)");
    if tauri_system_ready() {
        build_frontend()?;
        run_cargo(&[
            "build",
            "-p",
            DESKTOP_PKG,
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
    // Lean shell unit tests: handoff execution, registration, deep links,
    // commands, updater (workspace member, always builds offline).
    run_cargo(&["test", "-p", DESKTOP_PKG])?;
    run_node(&["apps/desktop/tests/deep-link.test.mjs"])?;
    run_node(&["apps/desktop/tests/capabilities.test.mjs"])?;
    // Hermetic E2E: loopback fixtures plus the lean driver and frontend
    // harness (submit -> choose -> request_destination -> save with PNG
    // verification, deep-link confirm, cancel). No public network, no
    // webview needed; the full Tauri WebDriver path stays manual (see
    // apps/desktop/README.md "End-to-end").
    run_node(&["apps/desktop/tests/e2e.test.mjs"])?;
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
        "-p",
        DESKTOP_PKG,
        "--features",
        "tauri",
        "--bin",
        "dezoomify-desktop",
    ])?;
    let root = super::repo_root();
    let bin = root.join("target/debug/dezoomify-desktop");
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

/// Whether the platform webview development packages are available. Linux
/// needs the explicit system packages; macOS ships WebKit and Windows ships
/// WebView2, so no pkg-config check applies there.
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

/// The bundler set for this host. Linux produces a real `deb`; Windows
/// documents `msi`/`nsis`; macOS documents `dmg`. Any other host has no
/// bundle recipe.
#[cfg(target_os = "linux")]
fn bundle_targets() -> &'static [&'static str] {
    &["deb"]
}

#[cfg(target_os = "windows")]
fn bundle_targets() -> &'static [&'static str] {
    &["msi", "nsis"]
}

#[cfg(target_os = "macos")]
fn bundle_targets() -> &'static [&'static str] {
    &["dmg"]
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn bundle_targets() -> &'static [&'static str] {
    &[]
}

fn has_cmd(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Fail closed unless the matching host's bundler recipe and tools are
/// present. Each branch names the exact prerequisites.
fn check_bundle_prereqs() -> Result<(), String> {
    if !has_cmd("cargo", &["tauri", "--version"]) {
        return Err(
            "desktop bundling needs the Tauri CLI (install with `cargo install tauri-cli --version \"^2\"` or pass --unsigned-test)"
                .to_string(),
        );
    }
    #[cfg(target_os = "linux")]
    if !has_cmd("dpkg-deb", &["--version"]) {
        return Err(
            "desktop bundling needs dpkg-deb (install the dpkg tools, e.g. `sudo apt install dpkg-dev`, or pass --unsigned-test)"
                .to_string(),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let wix = has_cmd("candle", &["-?"]);
        let nsis = has_cmd("makensis", &["-VERSION"]);
        let root = super::repo_root();
        let ico = root.join("apps/desktop/src-tauri/icons/icon.ico");
        let mut missing: Vec<&str> = Vec::new();
        if !wix {
            missing.push("WiX v3 (candle.exe/light.exe for the msi target)");
        }
        if !nsis {
            missing.push("NSIS (makensis for the nsis target)");
        }
        if !ico.is_file() {
            missing
                .push("apps/desktop/src-tauri/icons/icon.ico (generate with `cargo tauri icon`)");
        }
        if !missing.is_empty() {
            return Err(format!(
                "desktop bundling on Windows needs WebView2 plus {}; install them or pass --unsigned-test",
                missing.join(", ")
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let root = super::repo_root();
        let icns = root.join("apps/desktop/src-tauri/icons/icon.icns");
        if !has_cmd("xcrun", &["--version"]) {
            return Err(
                "desktop bundling on macOS needs the Xcode Command Line Tools (`xcode-select --install`) or pass --unsigned-test"
                    .to_string(),
            );
        }
        if !icns.is_file() {
            return Err(
                "desktop bundling on macOS needs apps/desktop/src-tauri/icons/icon.icns (generate with `cargo tauri icon`) or pass --unsigned-test"
                    .to_string(),
            );
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    return Err(
        "desktop bundling has no recipe for this host (Linux deb, Windows msi/nsis, macOS dmg only)"
            .to_string(),
    );
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    Ok(())
}

fn build_frontend() -> Result<(), String> {
    let status = Command::new("pnpm")
        .args(["--filter", "./apps/desktop", "build"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run pnpm: {e}"))?;
    if !status.success() {
        return Err(
            "desktop frontend build failed (pnpm --filter ./apps/desktop build)".to_string(),
        );
    }
    // The bundler reads this tree (`tauri.conf.json` frontendDist
    // `../dist`); fail closed here rather than inside `cargo tauri build`.
    let index = super::repo_root().join("apps/desktop/dist/index.html");
    if !index.is_file() {
        return Err(format!(
            "desktop frontend build produced no {}",
            index.display()
        ));
    }
    Ok(())
}

fn bundle() -> Result<(), String> {
    check_bundle_prereqs()?;
    let targets = bundle_targets();
    if targets.is_empty() {
        return Err(
            "desktop bundling has no recipe for this host (Linux deb, Windows msi/nsis, macOS dmg only)"
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
    for name in ["icons/32x32.png", "icons/128x128.png"] {
        let path = super::repo_root().join("apps/desktop/src-tauri").join(name);
        if !path.is_file() {
            return Err(format!("icon generation produced no {}", path.display()));
        }
    }
    let mut args = vec!["tauri", "build", "--features", "tauri", "--bundles"];
    args.extend(targets.iter().copied());
    let status = Command::new("cargo")
        .args(&args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo tauri: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "desktop bundling failed (cargo tauri build)".to_string())?;
    println!("build desktop: ok ({} bundle produced)", targets.join("/"));
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
