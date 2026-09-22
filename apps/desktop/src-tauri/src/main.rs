// Desktop entry point.
//
// The default build is a lean offline shell for version and per-user
// `dezoomify://` protocol-handler registration. With the `tauri` feature the
// real desktop window runs and registers the protocol handler best-effort.

#![deny(clippy::unwrap_used)]

#[cfg(feature = "tauri")]
fn main() {
    best_effort_register_protocol();
    dezoomify_desktop::tauri_shell::run();
}

#[cfg(feature = "tauri")]
fn best_effort_register_protocol() {
    let executable = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let home = home_dir().unwrap_or_default();
    if home.is_empty() || executable.is_empty() {
        return;
    }
    if let Err(error) =
        dezoomify_desktop::install_integration::install_protocol_handler(&home, &executable)
    {
        eprintln!("dezoomify-desktop: best-effort protocol registration failed: {error}");
    }
}

#[cfg(not(feature = "tauri"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        println!("dezoomify-desktop {}", dezoomify_desktop::APP_VERSION);
        return;
    }
    match args.first().map(String::as_str) {
        Some("--help" | "-h") => {
            println!(
                "usage: dezoomify-desktop [--register-protocol-handler [--home HOME] | --unregister-protocol-handler [--home HOME]]"
            );
        }
        Some("--register-protocol-handler") => {
            let home =
                flag_value(&args, "--home").unwrap_or_else(|| home_dir().unwrap_or_default());
            let executable = std::env::current_exe()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            if home.is_empty() || executable.is_empty() {
                eprintln!("error: cannot determine home directory or executable path");
                std::process::exit(1);
            }
            match dezoomify_desktop::install_integration::install_protocol_handler(
                &home,
                &executable,
            ) {
                Ok(destination) => println!("registered: {destination}"),
                Err(error) => {
                    eprintln!("protocol registration failed: {error}");
                    std::process::exit(1);
                }
            }
        }
        Some("--unregister-protocol-handler") => {
            let home =
                flag_value(&args, "--home").unwrap_or_else(|| home_dir().unwrap_or_default());
            if home.is_empty() {
                eprintln!("error: cannot determine home directory (pass --home HOME)");
                std::process::exit(1);
            }
            match dezoomify_desktop::install_integration::uninstall_protocol_handler(&home) {
                Ok(Some(destination)) => println!("removed: {destination}"),
                Ok(None) => println!("nothing registered"),
                Err(error) => {
                    eprintln!("failed to unregister protocol handler: {error}");
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
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

fn home_dir() -> Option<String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| home.to_string_lossy().into_owned())
}
