// Desktop entry point.
//
// The default build is a lean offline shell that reports its version. With
// the `tauri` feature the real desktop window runs.

#![deny(clippy::unwrap_used)]

#[cfg(feature = "tauri")]
fn main() {
    dezoomify_desktop::tauri_shell::run();
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
            println!("usage: dezoomify-desktop");
        }
        Some(other) => {
            eprintln!("error: unknown argument '{other}' (see --help)");
            std::process::exit(1);
        }
        None => {}
    }
}
