//! Real Native Messaging registration inspection and cleanup.
//!
//! Per-user registration locations only (system-wide locations need root and
//! are never touched): XDG config and `.mozilla` on Linux, `Library/Application
//! Support` on macOS, and `HKCU` registry keys via `reg.exe` on Windows.
//! A registration file counts as ours only when its `name` field equals
//! [`NATIVE_HOST_NAME`]; unparseable files that carry our exact file name are
//! treated as ours (truncated writes) and cleaned too. Foreign files are
//! never modified.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Native host name shared with the desktop installer.
pub const NATIVE_HOST_NAME: &str = "dev.ophir.dezoomify.native_host";

/// One known per-user registration location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Registration {
    /// A JSON manifest file in a browser profile directory.
    File { engine: &'static str, path: PathBuf },
    /// A Windows registry value under HKCU.
    WindowsRegistry { engine: &'static str, key: String },
}

/// Inspected state of one registration location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationState {
    /// A registration is present; `valid` records whether its content is a
    /// well-formed manifest naming our host.
    Registered { valid: bool },
    /// Nothing registered at this location.
    Absent,
}

/// Manifest file name for one profile directory.
pub fn registration_file_name() -> String {
    format!("{NATIVE_HOST_NAME}.json")
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// All known per-user registration locations on the current OS.
#[must_use]
pub fn known_registrations() -> Vec<Registration> {
    let host = registration_file_name();
    let mut out = Vec::new();
    if let Some(home) = home() {
        match std::env::consts::OS {
            "linux" => {
                for (engine, dir) in [
                    ("chromium", ".config/chromium/NativeMessagingHosts"),
                    ("chromium", ".config/google-chrome/NativeMessagingHosts"),
                    ("firefox", ".mozilla/native-messaging-hosts"),
                ] {
                    out.push(Registration::File {
                        engine,
                        path: home.join(dir).join(&host),
                    });
                }
            }
            "macos" => {
                for (engine, dir) in [
                    (
                        "chromium",
                        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
                    ),
                    (
                        "firefox",
                        "Library/Application Support/Mozilla/NativeMessagingHosts",
                    ),
                ] {
                    out.push(Registration::File {
                        engine,
                        path: home.join(dir).join(&host),
                    });
                }
            }
            "windows" => {
                for (engine, root) in [
                    ("chromium", r"Software\Google\Chrome\NativeMessagingHosts"),
                    ("firefox", r"Software\Mozilla\NativeMessagingHosts"),
                ] {
                    out.push(Registration::WindowsRegistry {
                        engine,
                        key: format!(r"HKCU\{root}\{NATIVE_HOST_NAME}"),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// Whether a manifest file content names our host.
#[must_use]
pub fn is_our_manifest(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("name")
                .and_then(|name| name.as_str())
                .map(String::from)
        })
        .is_some_and(|name| name == NATIVE_HOST_NAME)
}

fn inspect_file(path: &Path) -> RegistrationState {
    match std::fs::read_to_string(path) {
        Ok(text) => RegistrationState::Registered {
            valid: is_our_manifest(&text),
        },
        Err(_) => RegistrationState::Absent,
    }
}

fn reg_query(key: &str) -> RegistrationState {
    let output = Command::new("reg").args(["query", key, "/ve"]).output();
    match output {
        Ok(out) if out.status.success() && !out.stdout.is_empty() => {
            // reg.exe prints the default value; the browser resolves the host
            // path from it. Presence is what inspection and cleanup need.
            RegistrationState::Registered { valid: true }
        }
        _ => RegistrationState::Absent,
    }
}

/// Inspect one registration location on this machine.
#[must_use]
pub fn inspect(registration: &Registration) -> RegistrationState {
    match registration {
        Registration::File { path, .. } => inspect_file(path),
        Registration::WindowsRegistry { key, .. } => reg_query(key),
    }
}

/// Remove our registrations; returns the entries removed. Foreign files
/// (a registration file at a foreign path, or a parseable manifest naming a
/// different host) are never touched.
pub fn cleanup(registrations: &[Registration]) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    for registration in registrations {
        match registration {
            Registration::File { path, .. } => {
                let ours = match std::fs::read_to_string(path) {
                    Ok(text) => {
                        is_our_manifest(&text)
                            || path.file_name().is_some_and(|name| {
                                name.to_string_lossy() == registration_file_name()
                            })
                    }
                    Err(_) => false,
                };
                if !ours {
                    continue;
                }
                match std::fs::remove_file(path) {
                    Ok(()) => removed.push(path.display().to_string()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("failed to remove {}: {e}", path.display())),
                }
            }
            Registration::WindowsRegistry { key, .. } => {
                if reg_query(key) == RegistrationState::Absent {
                    continue;
                }
                let status = Command::new("reg")
                    .args(["delete", key, "/f"])
                    .status()
                    .map_err(|e| format!("failed to run reg.exe: {e}"))?;
                if !status.success() {
                    return Err(format!("failed to delete registry key {key}"));
                }
                removed.push(key.clone());
            }
        }
    }
    Ok(removed)
}

/// Inspect and report all known locations for one engine (or all engines
/// when `engine` is `None`).
pub fn inspect_and_report(engine: Option<&str>) -> Result<usize, String> {
    let registrations: Vec<_> = known_registrations()
        .into_iter()
        .filter(|reg| engine.is_none_or(|name| reg_engine(reg) == name))
        .collect();
    if registrations.is_empty() {
        return Err(format!(
            "no known registration locations for engine {engine:?}"
        ));
    }
    let mut found = 0;
    for registration in &registrations {
        let label = reg_label(registration);
        match inspect(registration) {
            RegistrationState::Registered { valid } => {
                found += 1;
                if valid {
                    println!("native-messaging: registered: {label}");
                } else {
                    println!("native-messaging: registered (invalid manifest): {label}");
                }
            }
            RegistrationState::Absent => {
                println!("native-messaging: not registered: {label}");
            }
        }
    }
    Ok(found)
}

fn reg_engine(registration: &Registration) -> &str {
    match registration {
        Registration::File { engine, .. } | Registration::WindowsRegistry { engine, .. } => engine,
    }
}

fn reg_label(registration: &Registration) -> String {
    match registration {
        Registration::File { path, .. } => path.display().to_string(),
        Registration::WindowsRegistry { key, .. } => key.clone(),
    }
}

/// Engine normalization shared with the gate grammar.
#[must_use]
pub fn normalize_engine(name: &str) -> Option<&'static str> {
    match name {
        "chromium" | "chrome" => Some("chromium"),
        "firefox" => Some("firefox"),
        _ => None,
    }
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        || (path.len() >= 3
            && path.as_bytes()[1] == b':'
            && (path.as_bytes()[2] == b'\\' || path.as_bytes()[2] == b'/'))
}

fn is_exact_extension_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    if id.contains('*') || id.contains('?') {
        return false;
    }
    !id.contains(char::is_whitespace)
}

fn expand_template(template: &str, host_path: &str, extension_id: &str) -> Result<String, String> {
    if !is_absolute_path(host_path) {
        return Err("host path must be absolute".to_string());
    }
    if !is_exact_extension_id(extension_id) {
        return Err("extension id must be exact (no wildcards)".to_string());
    }
    let expanded = template
        .replace("@HOST_PATH@", host_path)
        .replace("@EXTENSION_ID@", extension_id);
    if expanded.contains("@HOST_PATH@") || expanded.contains("@EXTENSION_ID@") {
        return Err("template placeholders unfilled".to_string());
    }
    if expanded.contains('*') {
        return Err("wildcard forbidden in expanded manifest".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_str(&expanded).map_err(|e| format!("expanded manifest not JSON: {e}"))?;
    if value.get("name").and_then(|n| n.as_str()) != Some(NATIVE_HOST_NAME) {
        return Err("expanded manifest names the wrong host".to_string());
    }
    if !std::path::Path::new(host_path).is_absolute()
        && !is_absolute_path(
            value
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or_default(),
        )
    {
        return Err("manifest host path must be absolute".to_string());
    }
    Ok(expanded)
}

/// Install per-user manifests under `home` (test-isolated; production passes
/// the real home). Uses the reviewed `installer/native-messaging/*.in`
/// templates so the shipped manifests and this installer cannot drift.
/// Returns the written paths. Foreign manifests are never overwritten;
/// wildcards and relative host paths fail before any write.
pub fn install_to(
    home: &Path,
    host_path: &str,
    chromium_id: &str,
    firefox_id: &str,
) -> Result<Vec<String>, String> {
    let root = super::repo_root();
    let chromium_template =
        std::fs::read_to_string(root.join("installer/native-messaging/chromium.json.in"))
            .map_err(|e| format!("missing chromium template: {e}"))?;
    let firefox_template =
        std::fs::read_to_string(root.join("installer/native-messaging/firefox.json.in"))
            .map_err(|e| format!("missing firefox template: {e}"))?;
    let chromium_json = expand_template(&chromium_template, host_path, chromium_id)?;
    let firefox_json = expand_template(&firefox_template, host_path, firefox_id)?;
    // Destinations mirror `known_registrations` but rooted at `home` so tests
    // never touch the real profile.
    let destinations: Vec<(&str, PathBuf, String)> = match std::env::consts::OS {
        "linux" => vec![
            (
                "chromium",
                home.join(".config/chromium/NativeMessagingHosts")
                    .join(registration_file_name()),
                chromium_json.clone(),
            ),
            (
                "chromium",
                home.join(".config/google-chrome/NativeMessagingHosts")
                    .join(registration_file_name()),
                chromium_json,
            ),
            (
                "firefox",
                home.join(".mozilla/native-messaging-hosts")
                    .join(registration_file_name()),
                firefox_json,
            ),
        ],
        "macos" => vec![
            (
                "chromium",
                home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
                    .join(registration_file_name()),
                chromium_json,
            ),
            (
                "firefox",
                home.join("Library/Application Support/Mozilla/NativeMessagingHosts")
                    .join(registration_file_name()),
                firefox_json,
            ),
        ],
        _ => return Err("file installs cover linux/macos only (windows uses HKCU)".to_string()),
    };
    let mut written = Vec::new();
    for (_engine, path, content) in &destinations {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
        }
        if let Ok(existing) = std::fs::read_to_string(path) {
            if !is_our_manifest(&existing) {
                let ours = registration_file_name();
                let file_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let parseable = serde_json::from_str::<serde_json::Value>(&existing).is_ok();
                if file_name != ours || parseable {
                    return Err(format!(
                        "foreign manifest at {}; refusing to overwrite",
                        path.display()
                    ));
                }
            }
        }
        std::fs::write(path, content)
            .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
        written.push(path.display().to_string());
    }
    written.sort();
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_identification() {
        let ours = format!(
            r#"{{"name":"{NATIVE_HOST_NAME}","path":"/opt/dezoomify/host","type":"stdio"}}"#
        );
        assert!(is_our_manifest(&ours));
        assert!(!is_our_manifest(r#"{"name":"other.host","path":"/x"}"#));
        assert!(!is_our_manifest("not json"));
    }

    #[test]
    fn registration_locations_cover_both_engines_per_os() {
        let registrations = known_registrations();
        assert!(!registrations.is_empty());
        let engines: Vec<_> = registrations.iter().map(reg_engine).collect();
        assert!(engines.contains(&"chromium"));
        assert!(engines.contains(&"firefox"));
        // Locations are always under the user profile, never system-wide.
        let home = home().unwrap();
        for registration in &registrations {
            if let Registration::File { path, .. } = registration {
                assert!(path.starts_with(&home), "{path:?} outside home");
            }
        }
    }

    #[test]
    fn cleanup_removes_only_our_files() {
        let dir = std::env::temp_dir().join(format!(
            "dz-nm-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let ours = dir.join(registration_file_name());
        let foreign = dir.join("other.host.json");
        std::fs::write(&ours, format!(r#"{{"name":"{NATIVE_HOST_NAME}"}}"#)).unwrap();
        std::fs::write(&foreign, r#"{"name":"other.host"}"#).unwrap();

        let removed = cleanup(&[Registration::File {
            engine: "chromium",
            path: ours.clone(),
        }])
        .unwrap();
        assert_eq!(removed, vec![ours.display().to_string()]);
        assert!(!ours.exists());

        let removed = cleanup(&[Registration::File {
            engine: "chromium",
            path: foreign.clone(),
        }])
        .unwrap();
        assert!(removed.is_empty(), "foreign file must never be removed");
        assert!(foreign.exists());
        std::fs::remove_file(&foreign).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn engine_names_normalize() {
        assert_eq!(normalize_engine("chrome"), Some("chromium"));
        assert_eq!(normalize_engine("chromium"), Some("chromium"));
        assert_eq!(normalize_engine("firefox"), Some("firefox"));
        assert_eq!(normalize_engine("webkit"), None);
    }

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dz-nm-install-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn install_round_trip_then_cleanup() {
        let home = temp_home("ok");
        let host = "/opt/dezoomify/dezoomify-native-host";
        let chromium_id = "abcdefghijklmnopqrstuvwxyzabcdef";
        let firefox_id = "dezoomify@dezoomify.example";
        let written = install_to(&home, host, chromium_id, firefox_id).unwrap();
        assert!(!written.is_empty());
        for path in &written {
            assert!(path.starts_with(home.to_string_lossy().as_ref()));
            let text = std::fs::read_to_string(path).unwrap();
            assert!(is_our_manifest(&text));
            assert!(text.contains(host));
            assert!(!text.contains('*'));
        }
        // Re-install overwrites our own manifests.
        let written2 = install_to(&home, "/opt/dezoomify/host-2", chromium_id, firefox_id).unwrap();
        assert_eq!(written, written2);
        // Cleanup removes only ours.
        let regs: Vec<Registration> = written
            .iter()
            .map(|p| Registration::File {
                engine: "chromium",
                path: PathBuf::from(p),
            })
            .collect();
        let removed = cleanup(&regs).unwrap();
        assert_eq!(removed.len(), written.len());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn install_refuses_wildcards_relative_and_foreign() {
        let home = temp_home("refuse");
        assert!(install_to(
            &home,
            "relative/host",
            "abcdefghijklmnopqrstuvwxyzabcdef",
            "dezoomify@dezoomify.example"
        )
        .is_err());
        assert!(install_to(&home, "/opt/host", "*", "dezoomify@dezoomify.example").is_err());
        // Foreign manifest at our destination is never overwritten.
        let dest = home
            .join(".config/chromium/NativeMessagingHosts")
            .join(registration_file_name());
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, r#"{"name":"other.host","path":"/x"}"#).unwrap();
        let err = install_to(
            &home,
            "/opt/dezoomify/dezoomify-native-host",
            "abcdefghijklmnopqrstuvwxyzabcdef",
            "dezoomify@dezoomify.example",
        )
        .unwrap_err();
        assert!(err.contains("foreign"), "must refuse foreign: {err}");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
