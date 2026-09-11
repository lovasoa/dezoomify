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

use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const DESKTOP_PKG: &str = "dezoomify-desktop";
const DESKTOP_DEV_HOST: &str = "localhost";
const DESKTOP_DEV_PORT: u16 = 1420;
const DESKTOP_DEV_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
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
    run_node(&["apps/desktop/tests/diagnostics.test.mjs"])?;
    // Development-surface smoke: starts the real Vite entrypoint on the
    // Tauri dev URL and verifies the shared theme resolves through Vite's
    // module graph. No webview or display is needed.
    run_node(&["apps/desktop/tests/dev-smoke.test.mjs"])?;
    // Versioned icon generator (scripts/gen-desktop-icons.py, stdlib-only,
    // deterministic): re-runs the script and asserts byte-identical PNG/ICO/
    // ICNS output plus container magic.
    run_node(&["apps/desktop/tests/icons.test.mjs"])?;
    println!("test desktop: ok");
    Ok(())
}

/// Real-window E2E: selenium-webdriver drives the shipped window shell through
/// the embedded W3C WebDriver server against hermetic loopback fixtures, then
/// verifies byte-exact saved output.
///
/// The embedded server runs inside the app (`tauri-plugin-wdio-webdriver`,
/// compiled behind the test-only `testing-webdriver` cargo feature), so the
/// lane needs no external tauri-driver or platform driver and runs on Linux,
/// macOS, and Windows. `specs/desktop.e2e.mjs` owns the full lifecycle:
/// fixture server, frontend server, isolated profile, app launch, and teardown.
/// Opt-in only: bare `test desktop` (plus `test`, `test all`, and `ci`) stays
/// lean and display-free.
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
    ensure_window_e2e_deps()?;
    // The harness launches this exact binary, so build it first: frontend,
    // fixture server, and window shell with the embedded WebDriver server.
    // Skip the lean `build_desktop` path: the spec binary needs
    // `testing-webdriver`.
    if !tauri_system_ready() {
        return Err(format!(
            "test desktop --e2e-window needs the webview system packages ({WEBKIT_SYSTEM_PACKAGES})"
        ));
    }
    run_cargo(&[
        "test",
        "-p",
        DESKTOP_PKG,
        "--features",
        "tauri",
        "--lib",
        "output_tests",
    ])?;
    // The harness starts this binary from Cargo's target directory. Always
    // ask Cargo to build it so source changes are rebuilt and no lane relies
    // on a binary left by an unrelated command.
    run_cargo(&["build", "-p", "dezoomify-fixture-server"])?;
    build_frontend()?;
    run_cargo(&[
        "build",
        "-p",
        DESKTOP_PKG,
        "--features",
        "tauri,testing-webdriver",
        "--bin",
        "dezoomify-desktop",
    ])?;
    // Lane-private copies: the window and lean shells share one binary
    // path (and the frontend one dist directory), so snapshot both before
    // the spec runs. A concurrent lean or frontend rebuild in the same
    // checkout then cannot swap the app mid-run; on CI runners the copies
    // are simply identical content.
    let target_dir = super::cargo_target_directory()?;
    let e2e_dir = target_dir.join("e2e-window");
    let app_src = window_shell_bin(&target_dir.join("debug/dezoomify-desktop"));
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
    // One compact spec owns the fixed frontend port. Its deadline bounds a
    // leaked app or frontend server without inflating normal runs.
    run_node_with_deadline(
        std::time::Duration::from_secs(20 * 60),
        &[
            "--test",
            "apps/desktop/tests/window-e2e/specs/desktop.e2e.mjs",
        ],
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
        "desktop.e2e.mjs",
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
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot stat {}: {e}", src.display()))?;
    if meta.is_file() {
        std::fs::copy(src, dst).map_err(|e| format!("cannot copy {}: {e}", src.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode();
            std::fs::set_permissions(dst, std::fs::Permissions::from_mode(mode))
                .map_err(|e| format!("cannot chmod {}: {e}", dst.display()))?;
        }
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("cannot create {}: {e}", dst.display()))?;
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

/// selenium-webdriver for the window harness, installed by the root pnpm
/// workspace during `cargo xtask setup`.
fn ensure_window_e2e_deps() -> Result<(), String> {
    let root = super::repo_root();
    let marker =
        root.join("apps/desktop/tests/window-e2e/node_modules/selenium-webdriver/package.json");
    if marker.is_file() {
        return Ok(());
    }
    Err("window E2E workspace dependencies missing; run `cargo xtask setup` first".to_string())
}

/// Desktop development: run the real Tauri development application together
/// with the Vite server it loads from `tauri.conf.json`. Needs the webview
/// system packages; fails closed with the exact prerequisite list when they
/// are missing.
pub fn dev_desktop() -> Result<(), String> {
    if !tauri_system_ready() {
        return Err(format!(
            "dev desktop needs the webview system packages ({WEBKIT_SYSTEM_PACKAGES}); the lean shell has no window to develop against"
        ));
    }
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
    let bin = window_shell_bin(&super::cargo_debug_binary("dezoomify-desktop")?);
    if !bin.exists() {
        return Err(format!(
            "desktop binary missing after build: {}",
            bin.display()
        ));
    }

    let _frontend = start_desktop_frontend()?;
    println!("dev desktop: frontend ready at http://{DESKTOP_DEV_HOST}:{DESKTOP_DEV_PORT}/");
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

/// The Tauri binary embeds `devUrl`, but launching that binary directly does
/// not run Tauri's `beforeDevCommand`. Keep the xtask workflow independent of
/// the optional `cargo-tauri` CLI by starting the same frontend command here.
fn start_desktop_frontend() -> Result<DesktopFrontend, String> {
    let root = super::repo_root();
    let mut command = pnpm_command()?;
    command
        .args([
            "--filter",
            "./apps/desktop",
            "dev",
            "--host",
            DESKTOP_DEV_HOST,
        ])
        .current_dir(&root);
    configure_owned_process_tree(&mut command);
    let child = command
        .spawn()
        .map_err(|e| format!("failed to start the desktop frontend: {e}"))?;
    let mut frontend = DesktopFrontend { child };

    wait_for_desktop_frontend(&mut frontend.child)?;
    // A pre-existing server can answer the probe before this Vite child has
    // reported its strict-port collision. Give the child one short turn to
    // fail so the desktop shell never attaches to stale frontend assets.
    std::thread::sleep(Duration::from_secs(1));
    if let Some(status) = frontend
        .child
        .try_wait()
        .map_err(|e| format!("cannot inspect the desktop frontend: {e}"))?
    {
        return Err(format!(
            "desktop frontend exited after startup on http://{DESKTOP_DEV_HOST}:{DESKTOP_DEV_PORT}/ ({status}); another Vite server may already own that port"
        ));
    }
    Ok(frontend)
}

/// An owned process is never an interactive terminal peer. A private process
/// group lets deadline cleanup include descendants (Vite, Node, or a window
/// driver), while closed stdin prevents a child from waiting on the terminal.
fn configure_owned_process_tree(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    command.process_group(0);
}

/// Wait until Vite accepts connections, while surfacing an early child exit
/// (most commonly a port collision or missing workspace dependencies).
fn wait_for_desktop_frontend(child: &mut Child) -> Result<(), String> {
    let address = format!("{DESKTOP_DEV_HOST}:{DESKTOP_DEV_PORT}");
    let deadline = Instant::now() + DESKTOP_DEV_STARTUP_TIMEOUT;
    let socket_addresses = address
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve desktop frontend address {address}: {e}"))?
        .collect::<Vec<_>>();

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("cannot inspect the desktop frontend: {e}"))?
        {
            return Err(format!(
                "desktop frontend exited before listening on http://{address}/ ({status})"
            ));
        }

        if socket_addresses
            .iter()
            .any(|socket| TcpStream::connect_timeout(socket, Duration::from_millis(200)).is_ok())
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "desktop frontend did not listen on http://{address}/ within {} seconds",
                DESKTOP_DEV_STARTUP_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Own the Vite child for the duration of the desktop process. This also
/// covers startup failures and Ctrl-C paths where the shell never reaches its
/// normal exit status handling.
struct DesktopFrontend {
    child: Child,
}

impl Drop for DesktopFrontend {
    fn drop(&mut self) {
        terminate_owned_process_tree(&mut self.child);
    }
}

/// Stop an owned process tree. The leader is created in its own Unix process
/// group; Windows requires taskkill's `/T` traversal instead.
fn terminate_owned_process_tree(child: &mut Child) {
    #[cfg(unix)]
    signal_process_group(child.id(), libc::SIGTERM);

    #[cfg(windows)]
    if child.try_wait().ok().flatten().is_none() {
        let taskkill = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut taskkill) = taskkill {
            let taskkill_deadline = Instant::now() + Duration::from_secs(5);
            while taskkill.try_wait().ok().flatten().is_none() && Instant::now() < taskkill_deadline
            {
                std::thread::sleep(Duration::from_millis(25));
            }
            if taskkill.try_wait().ok().flatten().is_none() {
                let _ = taskkill.kill();
            }
            let _ = taskkill.wait();
        }
    }

    let deadline = Instant::now() + Duration::from_secs(2);
    while child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if child.try_wait().ok().flatten().is_none() {
        #[cfg(unix)]
        signal_process_group(child.id(), libc::SIGKILL);
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(unix)]
fn signal_process_group(leader: u32, signal: libc::c_int) {
    if let Ok(leader) = libc::pid_t::try_from(leader) {
        // SAFETY: `leader` is the id returned for the child placed in its own
        // process group above. A negative pid targets that group only.
        unsafe {
            libc::kill(-leader, signal);
        }
    }
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

/// Build the pnpm invocation for any workspace task.
///
/// A `pnpm` already on PATH wins. Otherwise fall back to Corepack, which ships
/// with Node and runs the version pinned in `package.json`'s
/// `packageManager` field, so a fresh checkout needs no separate global pnpm
/// install. On Windows, Rust's `Command` (CreateProcess) only resolves `.exe`
/// on PATH, not the `.cmd` shims a pnpm/Corepack install leaves behind, so
/// resolve explicitly: a real `.exe` runs directly, otherwise the resolved
/// PATHEXT shim runs via `cmd /c`. When neither program exists the caller
/// fails closed naming both.
pub(crate) fn pnpm_command() -> Result<Command, String> {
    #[cfg(windows)]
    {
        pnpm_command_windows()
    }
    #[cfg(not(windows))]
    {
        pnpm_command_unix()
    }
}

const MISSING_PNPM: &str =
    "neither pnpm nor corepack is on PATH (Node bundles Corepack; install Node or run `corepack enable`)";

/// Install Corepack's pnpm shim into a repo-local, gitignored directory and
/// return it. Corepack ships with Node, so a fresh checkout gets the version
/// pinned in `package.json` without any global pnpm install. The shim lives
/// under `target/`, so `cargo clean` only makes the next call reinstall it.
fn corepack_shims() -> Result<std::path::PathBuf, String> {
    let dir = super::repo_root().join("target").join("corepack-shims");
    let shim = dir.join(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" });
    if shim.is_file() {
        return Ok(dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "cannot create corepack shim directory {}: {e}",
            dir.display()
        )
    })?;
    let status = Command::new("corepack")
        .args(["enable", "--install-directory"])
        .arg(&dir)
        .status()
        .map_err(|e| format!("cannot run corepack: {e}"))?;
    if !status.success() || !shim.is_file() {
        return Err(format!(
            "corepack could not install pnpm shims under {}; install pnpm globally",
            dir.display()
        ));
    }
    Ok(dir)
}

/// `PATH` with `dir` first, so a spawned pnpm and the scripts it recursively
/// runs both resolve the Corepack shim.
fn path_with_prepended(dir: &std::path::Path) -> Result<std::ffi::OsString, String> {
    let old = std::env::var_os("PATH").unwrap_or_default();
    let paths = std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&old));
    std::env::join_paths(paths).map_err(|e| format!("cannot build PATH for pnpm: {e}"))
}

/// Whether `name` is directly runnable from PATH on this host.
fn program_available(name: &str) -> bool {
    #[cfg(unix)]
    {
        program_on_path(name)
    }
    #[cfg(windows)]
    {
        let dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        resolve_windows_program(name, &dirs, &pathext).is_some()
    }
}

/// PATH for a child that may shell out to `pnpm` (for example the desktop dev
/// smoke test). `None` keeps the inherited environment when a runnable pnpm
/// already exists or Corepack is unavailable.
fn node_path() -> Result<Option<std::ffi::OsString>, String> {
    if program_available("pnpm") || !program_available("corepack") {
        return Ok(None);
    }
    let shims = corepack_shims()?;
    Ok(Some(path_with_prepended(&shims)?))
}

#[cfg(unix)]
fn pnpm_command_unix() -> Result<Command, String> {
    if program_on_path("pnpm") {
        return Ok(Command::new("pnpm"));
    }
    if !program_on_path("corepack") {
        return Err(MISSING_PNPM.to_string());
    }
    let shims = corepack_shims()?;
    let mut cmd = Command::new(shims.join("pnpm"));
    cmd.env("PATH", path_with_prepended(&shims)?);
    Ok(cmd)
}

#[cfg(unix)]
fn program_on_path(name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| {
            std::fs::metadata(dir.join(name))
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
    })
}

#[cfg(windows)]
fn pnpm_command_windows() -> Result<Command, String> {
    let dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    if let Some((program, needs_shell)) = resolve_windows_program("pnpm", &dirs, &pathext) {
        return Ok(windows_launch(program, needs_shell));
    }
    if resolve_windows_program("corepack", &dirs, &pathext).is_some() {
        let shims = corepack_shims()?;
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg(shims.join("pnpm.cmd"));
        cmd.env("PATH", path_with_prepended(&shims)?);
        return Ok(cmd);
    }
    Err(MISSING_PNPM.to_string())
}

#[cfg(windows)]
fn windows_launch(program: std::path::PathBuf, needs_shell: bool) -> Command {
    if needs_shell {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg(program);
        cmd
    } else {
        Command::new(program)
    }
}

/// Resolve `stem` against `dirs` honoring `pathext`, preferring a real
/// `.exe` (CreateProcess runs it directly) over shell shims. Returns the
/// resolved path plus whether it needs a shell (`cmd /c`): batch shims
/// such as `pnpm.cmd` cannot run directly. `.exe` wins even from a later
/// directory so a directly-runnable binary is never routed through a
/// shell. Extension case follows the `pathext` entry as written; the
/// Windows filesystem matches it case-insensitively.
#[cfg(any(windows, test))]
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
    // Lean desktop suites normally finish in seconds. Preserve headroom for
    // cold Cargo work in the deep-link test, while failing a leaked Node or
    // Vite descendant with the owning spec named instead of letting CI hang.
    let label = args.join(" ");
    run_node_with_deadline(std::time::Duration::from_secs(6 * 60), args, &[], &label)
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
    let mut command = Command::new("node");
    command
        .args(args)
        .envs(env.iter().copied())
        .current_dir(super::repo_root());
    if let Some(path) = node_path()? {
        command.env("PATH", path);
    }
    configure_owned_process_tree(&mut command);
    let mut child = command
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
                    terminate_owned_process_tree(&mut child);
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
        assert!(super::resolve_windows_program(
            "pnpm",
            std::slice::from_ref(&empty),
            ".COM;.EXE;.BAT;.CMD"
        )
        .is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn path_with_prepended_puts_dir_first() {
        let dir = std::env::temp_dir().join("dezoomify-path-prepend");
        let joined = super::path_with_prepended(&dir).expect("join PATH");
        assert_eq!(std::env::split_paths(&joined).next(), Some(dir));
    }

    #[test]
    #[cfg(unix)]
    fn desktop_frontend_drop_kills_descendants() {
        let root =
            std::env::temp_dir().join(format!("dezoomify-frontend-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create cleanup fixture");
        let pid_file = root.join("descendant.pid");
        let mut command = std::process::Command::new("sh");
        command.args([
            "-c",
            "sleep 30 & descendant=$!; echo \"$descendant\" > \"$1\"; wait",
            "sh",
            pid_file.to_str().expect("utf-8 temp path"),
        ]);
        super::configure_owned_process_tree(&mut command);
        let frontend = super::DesktopFrontend {
            child: command.spawn().expect("spawn process tree"),
        };

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !pid_file.is_file() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let descendant: libc::pid_t = loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = contents.trim().parse() {
                    break pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "descendant pid file was not populated"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };

        drop(frontend);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            // SAFETY: signal 0 only checks the process id written by the test
            // child and does not alter that process.
            let exists = unsafe { libc::kill(descendant, 0) } == 0;
            if !exists || std::time::Instant::now() >= deadline {
                assert!(!exists, "frontend descendant survived owner cleanup");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
