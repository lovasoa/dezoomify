// Desktop entry point.
//
// Default build: lean offline shell printing the version, so the standalone
// manifest stays checkable without webview system packages. With the
// `tauri` feature, the real Tauri window shell runs (single local window,
// strict navigation policy, the five capability commands, native save
// dialog). See tauri.conf.json and src/tauri_shell.rs.

#[cfg(feature = "tauri")]
fn main() {
    dezoomify_desktop::tauri_shell::run();
}

#[cfg(not(feature = "tauri"))]
fn main() {
    println!("dezoomify-desktop 3.0.0");
}
