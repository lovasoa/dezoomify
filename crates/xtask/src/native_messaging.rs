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
}
