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
    // Best-effort only: installer failures must not block the window.
    let _ = dezoomify_desktop::install_integration::install_native_manifests(
        &home,
        &sibling,
        dezoomify_desktop::install_integration::CHROMIUM_RELEASE_EXTENSION_ID,
        dezoomify_desktop::install_integration::FIREFOX_RELEASE_EXTENSION_ID,
    );
    let _ = dezoomify_desktop::install_integration::install_protocol_handler(&home, &exe);
}

#[cfg(not(feature = "tauri"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        println!("dezoomify-desktop 3.0.0");
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
            let home = home_dir().unwrap_or_default();
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
            if found == 0 {
                println!("not registered");
            }
        }
        Some("--unregister-native-host") => {
            let home = home_dir().unwrap_or_default();
            let mut removed = 0;
            for path in checked_manifest_paths(&home) {
                let ours = std::fs::read_to_string(&path)
                    .map(|text| dezoomify_desktop::install_integration::is_our_manifest_text(&text))
                    .unwrap_or(false)
                    || std::path::Path::new(&path).file_name().is_some_and(|n| {
                        n.to_string_lossy() == "dev.ophir.dezoomify.native_host.json"
                    });
                if !ours {
                    continue;
                }
                match std::fs::remove_file(&path) {
                    Ok(()) => {
                        println!("removed: {path}");
                        removed += 1;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        eprintln!("failed to remove {path}: {e}");
                        std::process::exit(1);
                    }
                }
            }
            if removed == 0 {
                println!("nothing registered");
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

#[cfg(not(feature = "tauri"))]
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
    use dezoomify_desktop::install_integration as install;
    if home.is_empty() {
        return Vec::new();
    }
    match std::env::consts::OS {
        "linux" => vec![
            install::linux_chromium_manifest_path(home),
            install::linux_chrome_manifest_path(home),
            install::linux_firefox_manifest_path(home),
        ],
        "macos" => vec![
            install::macos_chromium_manifest_path(home),
            install::macos_firefox_manifest_path(home),
        ],
        _ => Vec::new(),
    }
}
