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

pub fn test_desktop(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--e2e-window") {
        if args.len() != 1 {
            return Err("usage: cargo xtask test desktop [--e2e-window]".to_string());
        }
        return test_desktop_e2e_window();
    }
    if !args.is_empty() {
        return Err(format!(
            "unknown test desktop argument(s): {}; usage: cargo xtask test desktop [--e2e-window]",
            args.join(" ")
        ));
    }
    // Lean shell unit tests: handoff execution, registration, deep links,
    // commands, updater (workspace member, always builds offline).
    run_cargo(&["test", "-p", DESKTOP_PKG])?;
    run_node(&["apps/desktop/tests/deep-link.test.mjs"])?;
    run_node(&["apps/desktop/tests/capabilities.test.mjs"])?;
    run_node(&["apps/desktop/tests/queue.test.mjs"])?;
    // Versioned icon generator (scripts/gen-desktop-icons.py, stdlib-only,
    // deterministic): re-runs the script and asserts byte-identical PNG/ICO/
    // ICNS output plus container magic. Runs before the hermetic E2E so a
    // nondeterministic generator fails fast.
    run_node(&["apps/desktop/tests/icons.test.mjs"])?;
    // Hermetic E2E: loopback fixtures plus the lean driver and frontend
    // harness (submit -> choose -> request_destination -> save with PNG
    // verification, deep-link confirm, cancel). No public network, no
    // webview needed; the real-window path is the opt-in `--e2e-window`
    // lane below.
    run_node(&["apps/desktop/tests/e2e.test.mjs"])?;
    println!("test desktop: ok");
    Ok(())
}

/// Real-window E2E: the window shell under tauri-driver plus the platform
/// native driver (Linux WebKitWebDriver, macOS safaridriver, Windows
/// msedgedriver), hermetic loopback fixtures, byte-exact save verification.
/// Owns the full lifecycle through the node harness (preflight,
/// window-shell build, fixture server, frontend server, tauri-driver, app
/// launches, isolated profiles with cleanup). Opt-in only: bare
/// `test desktop` (plus `test`, `test all`, and `ci`) stays lean and
/// display-free.
fn test_desktop_e2e_window() -> Result<(), String> {
    // Display: Linux needs Xvfb (the lane fails closed without DISPLAY);
    // macOS and Windows CI runners provide a GUI session, so no DISPLAY
    // gate applies there.
    if cfg!(target_os = "linux") && std::env::var_os("DISPLAY").is_none() {
        return Err(
            "test desktop --e2e-window needs a display (DISPLAY is unset); rerun under `xvfb-run -a`"
                .to_string(),
        );
    }
    // Fail-closed driver discovery, mirroring the harness rules.
    if resolve_tauri_driver().is_none() {
        return Err(
            "test desktop --e2e-window needs tauri-driver 2.x (or TAURI_DRIVER_BIN=...); install with `cargo install tauri-driver --version \"=2.0.6\"`"
                .to_string(),
        );
    }
    check_native_driver()?;
    ensure_window_e2e_deps()?;
    // The harness launches this exact binary, so build it first: lean
    // shell, frontend, and window shell with no bundle. `build_desktop`
    // skips the window shell silently without the webview system packages,
    // so fail closed up front instead.
    if !tauri_system_ready() {
        return Err(format!(
            "test desktop --e2e-window needs the webview system packages ({WEBKIT_SYSTEM_PACKAGES})"
        ));
    }
    build_desktop(&["--unsigned-test".to_string()])?;
    // Lane-private copies: the window and lean shells share one binary
    // path (and the frontend one dist directory), so snapshot both before
    // the spec runs. A concurrent lean or frontend rebuild in the same
    // checkout then cannot swap the app mid-run; on CI runners the copies
    // are simply identical content.
    let e2e_dir = super::repo_root().join("target/e2e-window");
    // Windows builds `dezoomify-desktop.exe`; accept the extensionless
    // lane value when the suffixed binary is the one on disk, and keep
    // the suffix on the staged copy so the harness env points at a real
    // file.
    let app_src = window_shell_bin(&super::repo_root().join("target/debug/dezoomify-desktop"));
    let app_dst_name = if app_src.extension().is_some_and(|e| e == "exe") {
        "dezoomify-desktop.exe"
    } else {
        "dezoomify-desktop"
    };
    let app_copy = stage_e2e_artifact(&app_src, &e2e_dir.join(app_dst_name))?;
    let dist_copy = stage_e2e_artifact(
        &super::repo_root().join("apps/desktop/dist"),
        &e2e_dir.join("dist"),
    )?;
    // Sequential runs: each spec owns the fixed frontend port (1420) in
    // its own process, so a second lane file cannot collide with the
    // first. `window.spec.mjs` covers the native-feature flows;
    // `formats.spec.mjs` covers the data-driven full-download matrix: the
    // 17 PNG cases share one window session (one launch, back-to-back
    // saves via the product reset path), JPEG/TIFF/iiif-dir keep one
    // single launch each, so the matrix pays 4 lifecycles, not 20.
    // Each spec runs under a hard deadline: a leaked child holding node's
    // pipes or the frontend server open would otherwise hang this lane
    // forever (observed as a 55-minute CI zombie after launch failures).
    // 30 minutes is far above the longest green spec (~15) but bounds any
    // pathological run, and the killed process fails the lane with the
    // evidence already on the log.
    run_node_with_deadline(
        std::time::Duration::from_secs(30 * 60),
        &["--test", "apps/desktop/tests/window-e2e/window.spec.mjs"],
        &[
            (
                "DEZOOMIFY_WINDOW_E2E_APP_BIN",
                app_copy.to_str().unwrap_or(""),
            ),
            (
                "DEZOOMIFY_WINDOW_E2E_DIST",
                dist_copy.to_str().unwrap_or(""),
            ),
        ],
        "window.spec.mjs",
    )?;
    run_node_with_deadline(
        std::time::Duration::from_secs(30 * 60),
        &["--test", "apps/desktop/tests/window-e2e/formats.spec.mjs"],
        &[
            (
                "DEZOOMIFY_WINDOW_E2E_APP_BIN",
                app_copy.to_str().unwrap_or(""),
            ),
            (
                "DEZOOMIFY_WINDOW_E2E_DIST",
                dist_copy.to_str().unwrap_or(""),
            ),
        ],
        "formats.spec.mjs",
    )?;
    println!("test desktop --e2e-window: ok (real window, hermetic loopback)");
    Ok(())
}

/// Copy one build output (file or directory) into the lane-private tree,
/// replacing any previous copy. Fails closed naming the missing source.
/// Pure-Rust copy (no `cp` dependency) so the lane works on Windows too;
/// executable bits are preserved on Unix.
fn stage_e2e_artifact(
    src: &std::path::Path,
    dst: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if !src.exists() {
        return Err(format!("e2e-window artifact missing: {}", src.display()));
    }
    if dst.exists() {
        std::fs::remove_dir_all(dst)
            .or_else(|_| std::fs::remove_file(dst))
            .map_err(|e| format!("cannot clear {}: {e}", dst.display()))?;
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    copy_e2e_tree(src, dst)?;
    if !dst.exists() {
        return Err(format!(
            "failed to stage e2e-window artifact {}",
            dst.display()
        ));
    }
    Ok(dst.to_path_buf())
}

/// Resolve the window-shell binary, accepting the `.exe` suffix on
/// Windows when the extensionless path is absent.
fn window_shell_bin(base: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let exe = base.with_extension("exe");
        if !base.exists() && exe.exists() {
            return exe;
        }
    }
    base.to_path_buf()
}

fn copy_e2e_tree(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let meta = std::fs::metadata(src)
        .map_err(|e| format!("cannot stat {}: {e}", src.display()))?;
    if meta.is_file() {
        std::fs::copy(src, dst)
            .map_err(|e| format!("cannot copy {}: {e}", src.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode();
            std::fs::set_permissions(dst, std::fs::Permissions::from_mode(mode))
                .map_err(|e| format!("cannot chmod {}: {e}", dst.display()))?;
        }
        return Ok(());
    }
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("cannot create {}: {e}", dst.display()))?;
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("cannot list {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot list {}: {e}", src.display()))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        copy_e2e_tree(&from, &to)?;
    }
    Ok(())
}

/// Selenium client for the window harness, installed once via the pinned
/// lockfile (extension-browser precedent: auto-install on first run).
fn ensure_window_e2e_deps() -> Result<(), String> {
    let root = super::repo_root();
    let marker =
        root.join("apps/desktop/tests/window-e2e/node_modules/selenium-webdriver/package.json");
    if marker.is_file() {
        return Ok(());
    }
    println!("test desktop --e2e-window: installing harness dependencies (npm ci)");
    let status = npm_command()?
        .args(["ci", "--no-audit", "--no-fund"])
        .current_dir(root.join("apps/desktop/tests/window-e2e"))
        .status()
        .map_err(|e| format!("failed to run npm ci: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "window harness dependency install failed (npm ci)".to_string())?;
    if !marker.is_file() {
        return Err("window harness dependencies still missing after npm ci".to_string());
    }
    Ok(())
}

fn path_on_path(name: &str) -> Option<std::path::PathBuf> {
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
        // Windows: CreateProcess resolves `.exe` but a bare stem lookup
        // does not, so probe the suffixed binary too (mirrors the harness
        // resolveOnPath behavior on win32).
        if cfg!(windows) {
            let exe = dir.join(format!("{name}.exe"));
            if exe.exists() {
                return Some(exe);
            }
        }
    }
    None
}

/// tauri-driver discovery shared by all OSes: TAURI_DRIVER_BIN override,
/// else `tauri-driver` (or `tauri-driver.exe` on Windows) on PATH.
fn resolve_tauri_driver() -> Option<String> {
    std::env::var("TAURI_DRIVER_BIN")
        .ok()
        .filter(|p| std::path::Path::new(p).exists())
        .or_else(|| path_on_path("tauri-driver").map(|p| p.to_string_lossy().into_owned()))
}

/// Platform native-driver gate, mirroring the harness
/// `resolveNativeDriver` slots. Linux keeps its exact prior message;
/// macOS expects safaridriver (enabled via `sudo safaridriver --enable`);
/// Windows expects msedgedriver exact-matched to the runner Edge version
/// (the workflow installs it fail-closed naming both versions).
fn check_native_driver() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DRIVER_BIN")
            .ok()
            .filter(|p| std::path::Path::new(p).exists())
            .or_else(|| path_on_path("WebKitWebDriver").map(|p| p.to_string_lossy().into_owned()))
            .is_none()
        {
            return Err(
                "test desktop --e2e-window needs WebKitWebDriver on PATH (or WEBKIT_DRIVER_BIN=...)"
                    .to_string(),
            );
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        // SAFARI_DRIVER_BIN is the canonical override; WEBKIT_DRIVER_BIN
        // stays accepted so a shared CI env keeps working.
        let found = std::env::var("SAFARI_DRIVER_BIN")
            .ok()
            .filter(|p| std::path::Path::new(p).exists())
            .or_else(|| {
                std::env::var("WEBKIT_DRIVER_BIN")
                    .ok()
                    .filter(|p| std::path::Path::new(p).exists())
            })
            .or_else(|| {
                let builtin = std::path::PathBuf::from("/usr/bin/safaridriver");
                builtin
                    .exists()
                    .then(|| builtin.to_string_lossy().into_owned())
            })
            .or_else(|| path_on_path("safaridriver").map(|p| p.to_string_lossy().into_owned()));
        if found.is_none() {
            return Err(
                "test desktop --e2e-window needs safaridriver (or SAFARI_DRIVER_BIN=...); enable with `sudo safaridriver --enable`"
                    .to_string(),
            );
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // EDGE_DRIVER_BIN is the canonical override; WEBKIT_DRIVER_BIN
        // stays accepted so a shared CI env keeps working.
        let found = std::env::var("EDGE_DRIVER_BIN")
            .ok()
            .filter(|p| std::path::Path::new(p).exists())
            .or_else(|| {
                std::env::var("WEBKIT_DRIVER_BIN")
                    .ok()
                    .filter(|p| std::path::Path::new(p).exists())
            })
            .or_else(|| path_on_path("msedgedriver").map(|p| p.to_string_lossy().into_owned()));
        if found.is_none() {
            return Err(
                "test desktop --e2e-window needs msedgedriver on PATH (or EDGE_DRIVER_BIN=...) exact-matched to the runner Edge version (install from https://msedgedriver.microsoft.com/<edge-version>/edgedriver_win64.zip)"
                    .to_string(),
            );
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Err("test desktop --e2e-window runs on Linux, macOS, or Windows only".to_string())
    }
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
    let status = pnpm_command()?
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

/// Build the pnpm invocation for the desktop frontend.
///
/// On Linux/macOS this is `pnpm` exactly as before. On Windows, Rust's
/// `Command` (CreateProcess) only resolves `.exe` on PATH, not the
/// `.cmd` shims a pnpm install leaves behind, so resolve explicitly: a
/// real `pnpm.exe` runs directly, otherwise the resolved PATHEXT shim runs
/// via `cmd /c` (batch files need the command interpreter). A truly absent
/// pnpm fails closed naming the program and the fix.
fn pnpm_command() -> Result<Command, String> {
    if cfg!(windows) {
        pnpm_command_windows()
    } else {
        Ok(Command::new("pnpm"))
    }
}

fn pnpm_command_windows() -> Result<Command, String> {
    let dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    match resolve_windows_program("pnpm", &dirs, &pathext) {
        Some((exe, false)) => Ok(Command::new(exe)),
        Some((shim, true)) => {
            let mut cmd = Command::new("cmd");
            cmd.arg("/c").arg(shim);
            Ok(cmd)
        }
        None => Err("pnpm not found on PATH (install the pnpm version pinned in the packageManager field of package.json and ensure it is on PATH)".to_string()),
    }
}

/// The npm invocation for the window-harness dependency install. Same
/// Windows `.cmd`-shim rule as pnpm above: Node ships `npm.cmd`, not
/// `npm.exe`, so a bare `Command::new("npm")` fails with "program not
/// found" on Windows (observed as the Windows e2e leg failing before any
/// spec ran). Unix stays a bare `npm` lookup.
fn npm_command() -> Result<Command, String> {
    if cfg!(windows) {
        let dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        match resolve_windows_program("npm", &dirs, &pathext) {
            Some((exe, false)) => Ok(Command::new(exe)),
            Some((shim, true)) => {
                let mut cmd = Command::new("cmd");
                cmd.arg("/c").arg(shim);
                Ok(cmd)
            }
            None => Err(
                "npm not found on PATH (install the Node version pinned in .node-version and ensure npm is on PATH)"
                    .to_string(),
            ),
        }
    } else {
        Ok(Command::new("npm"))
    }
}

/// Resolve `stem` against `dirs` honoring `pathext`, preferring a real
/// `.exe` (CreateProcess runs it directly) over shell shims. Returns the
/// resolved path plus whether it needs a shell (`cmd /c`): batch shims
/// such as `pnpm.cmd` cannot run directly. `.exe` wins even from a later
/// directory so a directly-runnable binary is never routed through a
/// shell. Extension case follows the `pathext` entry as written; the
/// Windows filesystem matches it case-insensitively.
fn resolve_windows_program(
    stem: &str,
    dirs: &[std::path::PathBuf],
    pathext: &str,
) -> Option<(std::path::PathBuf, bool)> {
    for dir in dirs {
        let exe = dir.join(format!("{stem}.exe"));
        if exe.is_file() {
            return Some((exe, false));
        }
    }
    for ext in pathext
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
    {
        if ext.eq_ignore_ascii_case(".exe") {
            continue;
        }
        let ext = ext.strip_prefix('.').unwrap_or(ext);
        for dir in dirs {
            let candidate = dir.join(format!("{stem}.{ext}"));
            if candidate.is_file() {
                return Some((candidate, true));
            }
        }
    }
    None
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
    run_node_with_env(args, &[])
}

/// Run node under a hard deadline: when the child outlives it, the process
/// is killed and the lane fails naming the spec. Guards the real-window
/// specs against leaked children (a dead app instance can keep node's pipes
/// or the frontend server open indefinitely), which would otherwise hang CI
/// until the job timeout instead of failing with the log as evidence.
fn run_node_with_deadline(
    deadline: std::time::Duration,
    args: &[&str],
    env: &[(&str, &str)],
    label: &str,
) -> Result<(), String> {
    let mut child = Command::new("node")
        .args(args)
        .envs(env.iter().copied())
        .current_dir(super::repo_root())
        .spawn()
        .map_err(|e| format!("failed to run node: {e}"))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                return Err(format!("desktop node tests failed ({label})"));
            }
            Ok(None) => {
                if start.elapsed() > deadline {
                    child.kill().ok();
                    let _ = child.wait();
                    return Err(format!(
                        "desktop node tests killed after {:.0} s ({label}): the spec process did not exit; \
                         a leaked child is holding its pipes or the frontend server open",
                        deadline.as_secs_f32()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Err(e) => return Err(format!("failed to wait for node ({label}): {e}")),
        }
    }
}

fn run_node_with_env(args: &[&str], env: &[(&str, &str)]) -> Result<(), String> {
    let status = Command::new("node")
        .args(args)
        .envs(env.iter().copied())
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

    #[test]
    fn desktop_test_args() {
        // Unknown flags fail fast without running any suite; the window
        // lane takes exactly one flag.
        assert!(super::test_desktop(&["--bogus".to_string()]).is_err());
        assert!(super::test_desktop(&["--e2e-window".to_string(), "--bogus".to_string()]).is_err());
    }

    #[test]
    fn desktop_icons_script_versioned() {
        // The icon generator stays a versioned scripts/ artifact with test
        // coverage (apps/desktop/tests/icons.test.mjs, run above); it must
        // not drift into an ad-hoc untracked helper.
        let root = super::super::repo_root();
        let script = root.join("scripts/gen-desktop-icons.py");
        let text = std::fs::read_to_string(&script).expect("read gen-desktop-icons.py");
        assert!(
            text.contains("byte-identical"),
            "script must promise determinism"
        );
        assert!(
            text.contains("cargo xtask build desktop"),
            "script must name its xtask entry"
        );
        for name in [
            "apps/desktop/src-tauri/icons/32x32.png",
            "apps/desktop/src-tauri/icons/128x128.png",
            "apps/desktop/src-tauri/icons/icon.ico",
            "apps/desktop/src-tauri/icons/icon.icns",
        ] {
            assert!(root.join(name).is_file(), "missing generated icon {name}");
        }
    }

    /// Scratch PATH tree for the Windows pnpm resolver tests: `files` are
    /// `(subdir, filename)` pairs. Filenames use the exact case the test's
    /// PATHEXT entry produces (Windows matches case-insensitively; the
    /// Linux/macOS test runner does not).
    fn pnpm_resolve_fixture(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "dezoomify-pnpm-resolve-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        for (dir, file) in files {
            let dir = root.join(dir);
            std::fs::create_dir_all(&dir).expect("create fixture dir");
            std::fs::write(dir.join(file), "fixture").expect("write fixture file");
        }
        root
    }

    #[test]
    fn pnpm_resolve_prefers_exe() {
        // A real pnpm.exe wins over a .CMD shim even from a later PATH
        // directory, and runs directly (no shell).
        let root = pnpm_resolve_fixture("exe", &[("bin", "pnpm.CMD"), ("tools", "pnpm.exe")]);
        let dirs = vec![root.join("bin"), root.join("tools")];
        let found = super::resolve_windows_program("pnpm", &dirs, ".COM;.EXE;.BAT;.CMD")
            .expect("pnpm must resolve");
        assert_eq!(found.0, root.join("tools").join("pnpm.exe"));
        assert!(!found.1, "pnpm.exe must run directly, not via a shell");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pnpm_resolve_falls_back_to_cmd_shim() {
        // Shim-only install (the failing Windows CI layout): resolves the
        // .CMD shim and marks it as needing `cmd /c`.
        let root = pnpm_resolve_fixture("cmd", &[("bin", "pnpm.CMD")]);
        let dirs = vec![root.join("bin")];
        let found = super::resolve_windows_program("pnpm", &dirs, ".COM;.EXE;.BAT;.CMD")
            .expect("pnpm.CMD must resolve");
        assert_eq!(found.0, root.join("bin").join("pnpm.CMD"));
        assert!(found.1, "pnpm.CMD needs cmd /c");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pnpm_resolve_honors_pathext_and_reports_missing() {
        // PATHEXT without .CMD skips pnpm.CMD and takes pnpm.BAT instead.
        let root = pnpm_resolve_fixture("pathext", &[("bin", "pnpm.CMD"), ("bin", "pnpm.BAT")]);
        let dirs = vec![root.join("bin")];
        let found = super::resolve_windows_program("pnpm", &dirs, ".COM;.EXE;.BAT")
            .expect("pnpm.BAT must resolve");
        assert_eq!(found.0, root.join("bin").join("pnpm.BAT"));
        assert!(found.1, "pnpm.BAT needs cmd /c");
        // Nothing installed: no resolution, so the caller fails closed.
        let empty = pnpm_resolve_fixture("empty", &[]);
        assert!(
            super::resolve_windows_program(
                "pnpm",
                std::slice::from_ref(&empty),
                ".COM;.EXE;.BAT;.CMD"
            )
            .is_none()
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    #[cfg(not(windows))]
    fn pnpm_command_unix_is_bare_pnpm() {
        // Linux/macOS behavior stays byte-identical: a bare `pnpm` lookup.
        let cmd = super::pnpm_command().expect("pnpm command builds");
        assert_eq!(cmd.get_program(), "pnpm");
    }
}
