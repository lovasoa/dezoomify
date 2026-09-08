// Desktop entry point.
//
// Default build: lean offline shell (version, per-user Native Messaging +
// protocol registration, handshake probe), so the default features stay
// checkable without webview system packages. With the `tauri` feature, the
// real Tauri window shell runs (single local window, strict navigation
// policy, the five capability commands, native save dialog). See
// tauri.conf.json and src/tauri_shell.rs.
//
// Initial registration (per-user only, never system-wide, never root):
//   dezoomify-desktop --register-native-host [--host-path PATH] [--home HOME]
//   dezoomify-desktop --check-native-host
//   dezoomify-desktop --unregister-native-host
// The installer and first-run path call `--register-native-host`; the host
// path defaults to `dezoomify-native-host` next to this executable.

// 6.1 unwrap policy: this binary maps failures to process exit codes and
// stderr diagnostics instead of panicking (see `lib.rs`).
#![deny(clippy::unwrap_used)]

#[cfg(feature = "tauri")]
fn main() {
    // The window shell performs best-effort per-user registration on startup
    // (logs to stderr, never blocks the window) before running.
    best_effort_register();
    dezoomify_desktop::tauri_shell::run();
}

#[cfg(feature = "tauri")]
fn best_effort_register() {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let sibling = sibling_host_path(&exe);
    let home = home_dir().unwrap_or_default();
    if home.is_empty() || sibling.is_empty() {
        return;
    }
    // Best-effort only: log to stderr, never block the window.
    if let Err(e) = dezoomify_desktop::install_integration::install_native_manifests(
        &home,
        &sibling,
        dezoomify_desktop::install_integration::CHROMIUM_RELEASE_EXTENSION_ID,
        dezoomify_desktop::install_integration::FIREFOX_RELEASE_EXTENSION_ID,
    ) {
        eprintln!("dezoomify-desktop: best-effort native manifest registration failed: {e}");
    }
    if let Err(e) = dezoomify_desktop::install_integration::install_protocol_handler(&home, &exe) {
        eprintln!("dezoomify-desktop: best-effort protocol registration failed: {e}");
    }
}

#[cfg(not(feature = "tauri"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        println!("dezoomify-desktop 3.0.1");
        return;
    }
    match args.first().map(String::as_str) {
        Some("--help" | "-h") => {
            println!("usage: dezoomify-desktop [--register-native-host [--host-path PATH] [--home HOME] | --check-native-host | --unregister-native-host]");
        }
        Some("--register-native-host") => {
            let host_path =
                flag_value(&args, "--host-path").unwrap_or_else(sibling_host_path_from_exe);
            let home =
                flag_value(&args, "--home").unwrap_or_else(|| home_dir().unwrap_or_default());
            if home.is_empty() {
                eprintln!("error: cannot determine home directory (pass --home HOME)");
                std::process::exit(1);
            }
            if host_path.is_empty() {
                eprintln!("error: cannot determine native host path (pass --host-path PATH)");
                std::process::exit(1);
            }
            match dezoomify_desktop::install_integration::install_native_manifests(
                &home,
                &host_path,
                dezoomify_desktop::install_integration::CHROMIUM_RELEASE_EXTENSION_ID,
                dezoomify_desktop::install_integration::FIREFOX_RELEASE_EXTENSION_ID,
            ) {
                Ok(written) => {
                    for path in &written {
                        println!("registered: {path}");
                    }
                    if written.is_empty() {
                        println!("registered: windows registry keys (see stderr on failure)");
                    }
                    match dezoomify_desktop::install_integration::install_protocol_handler(
                        &home,
                        &std::env::current_exe()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or(host_path.clone()),
                    ) {
                        Ok(dest) => println!("protocol: {dest}"),
                        Err(e) => {
                            eprintln!("protocol registration failed: {e}");
                            std::process::exit(1);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("registration failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        Some("--check-native-host") => {
            let home =
                flag_value(&args, "--home").unwrap_or_else(|| home_dir().unwrap_or_default());
            let mut found = 0;
            for path in checked_manifest_paths(&home) {
                match std::fs::read_to_string(&path) {
                    Ok(text)
                        if dezoomify_desktop::install_integration::is_our_manifest_text(&text) =>
                    {
                        println!("registered: {path}");
                        found += 1;
                    }
                    Ok(_) => println!("foreign: {path}"),
                    Err(_) => println!("absent: {path}"),
                }
            }
            #[cfg(windows)]
            {
                for key in dezoomify_desktop::install_integration::windows_managed_keys() {
                    let present = std::process::Command::new("reg")
                        .args(["query", &key, "/ve"])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    if present {
                        println!("registered: {key}");
                        found += 1;
                    } else {
                        println!("absent: {key}");
                    }
                }
            }
            if found == 0 {
                println!("not registered");
            }
        }
        Some("--unregister-native-host") => {
            let home =
                flag_value(&args, "--home").unwrap_or_else(|| home_dir().unwrap_or_default());
            // Safe removal lives in the library: parseable ours, or
            // unparseable with our exact file name (truncated write).
            // Parseable foreign is never deleted, even if the file name
            // matches ours (squatter survives uninstall).
            match dezoomify_desktop::install_integration::uninstall_native_manifests(&home) {
                Ok(removed) => {
                    for path in &removed {
                        println!("removed: {path}");
                    }
                    #[cfg(windows)]
                    let mut removed_count = removed.len();
                    #[cfg(not(windows))]
                    let removed_count = removed.len();
                    #[cfg(windows)]
                    {
                        match dezoomify_desktop::install_integration::uninstall_windows_registry() {
                            Ok(keys) => {
                                for key in &keys {
                                    println!("removed: {key}");
                                }
                                removed_count += keys.len();
                            }
                            Err(e) => {
                                eprintln!("failed to remove windows registry keys: {e}");
                                std::process::exit(1);
                            }
                        }
                    }
                    if removed_count == 0 {
                        println!("nothing registered");
                    }
                }
                Err(e) => {
                    eprintln!("failed to unregister: {e}");
                    std::process::exit(1);
                }
            }
        }
        Some(other) => {
            eprintln!("error: unknown argument '{other}' (see --help)");
            std::process::exit(1);
        }
        None => {}
    }
}

#[cfg(not(feature = "tauri"))]
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

// Shared by the lean shell and the Tauri window shell (best-effort
// per-user registration on startup); must build under both feature sets.
fn home_dir() -> Option<String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| h.to_string_lossy().into_owned())
}

#[cfg(not(feature = "tauri"))]
fn sibling_host_path_from_exe() -> String {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    sibling_host_path(&exe)
}

#[cfg(any(feature = "tauri", not(feature = "tauri")))]
fn sibling_host_path(exe: &str) -> String {
    if exe.is_empty() {
        return String::new();
    }
    let path = std::path::Path::new(exe);
    match path.parent() {
        Some(dir) => dir
            .join("dezoomify-native-host")
            .to_string_lossy()
            .into_owned(),
        None => String::new(),
    }
}

#[cfg(not(feature = "tauri"))]
fn checked_manifest_paths(home: &str) -> Vec<String> {
    // Single source of truth for per-user destinations (Linux
    // ~/.config/chromium + ~/.config/google-chrome + ~/.mozilla, macOS
    // ~/Library/..., Windows HKCU via reg.exe so no file paths there).
    dezoomify_desktop::install_integration::manifest_paths_for_home(home)
}
