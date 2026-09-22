//! Per-user `dezoomify://` protocol-handler registration.
//!
//! Registration never writes system-wide locations or requires root. Linux
//! uses a desktop entry, macOS uses a user preference plist, and Windows uses
//! the current user's registry hive.

/// Protocol scheme handled by the desktop app.
pub const PROTOCOL_SCHEME: &str = "dezoomify";

/// Windows protocol registration key (HKCU).
#[must_use]
pub fn windows_protocol_key() -> String {
    format!(r"Software\Classes\{PROTOCOL_SCHEME}")
}

/// macOS protocol-handler plist destination for one home directory.
#[must_use]
pub fn macos_protocol_plist_path(home: &str) -> String {
    format!("{home}/Library/Preferences/dev.ophir.dezoomify.plist")
}

/// Linux desktop-entry destination for one home directory.
#[must_use]
pub fn linux_desktop_file_path(home: &str) -> String {
    format!("{home}/.local/share/applications/dezoomify.desktop")
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        || (path.len() >= 3
            && path.as_bytes()[1] == b':'
            && (path.as_bytes()[2] == b'\\' || path.as_bytes()[2] == b'/'))
}

/// Linux desktop entry registering the `dezoomify://` scheme.
pub fn linux_desktop_entry(exec_path: &str) -> Result<String, String> {
    if !is_absolute_path(exec_path) {
        return Err("exec path must be absolute".to_string());
    }
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Dezoomify\nExec={} %u\nMimeType=x-scheme-handler/dezoomify;\nNoDisplay=true\n",
        exec_path.replace('%', "%%")
    ))
}

/// Install the per-user `dezoomify://` protocol handler.
pub fn install_protocol_handler(home: &str, exec_path: &str) -> Result<String, String> {
    if home.is_empty() {
        return Err("home must not be empty".to_string());
    }
    if !is_absolute_path(exec_path) {
        return Err("exec path must be absolute".to_string());
    }
    match std::env::consts::OS {
        "linux" => {
            let path = linux_desktop_file_path(home);
            let content = linux_desktop_entry(exec_path)?;
            if let Some(parent) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
            }
            std::fs::write(&path, content).map_err(|e| format!("failed to write {path}: {e}"))?;
            Ok(path)
        }
        "macos" => {
            let path = macos_protocol_plist_path(home);
            let content = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>dezoomify-handler</key><string>{}</string><key>dezoomify-scheme</key><string>dezoomify</string></dict></plist>\n",
                exec_path.replace('&', "&amp;").replace('<', "&lt;")
            );
            if let Some(parent) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
            }
            std::fs::write(&path, content).map_err(|e| format!("failed to write {path}: {e}"))?;
            Ok(path)
        }
        _ => install_windows_protocol_handler(exec_path),
    }
}

/// Install the Windows per-user protocol handler through `reg.exe`.
pub fn install_windows_protocol_handler(exec_path: &str) -> Result<String, String> {
    use std::process::Command;
    if !is_absolute_path(exec_path) {
        return Err("exec path must be absolute".to_string());
    }
    let key = windows_protocol_key();
    let steps: Vec<Vec<String>> = vec![
        vec![
            "add".into(),
            format!("HKCU\\{key}"),
            "/ve".into(),
            "/d".into(),
            "Dezoomify".into(),
            "/f".into(),
        ],
        vec![
            "add".into(),
            format!("HKCU\\{key}"),
            "/v".into(),
            "URL Protocol".into(),
            "/d".into(),
            String::new(),
            "/f".into(),
        ],
        vec![
            "add".into(),
            format!("HKCU\\{key}\\shell\\open\\command"),
            "/ve".into(),
            "/d".into(),
            format!("\"{exec_path}\" \"%1\""),
            "/f".into(),
        ],
    ];
    for args in &steps {
        let status = Command::new("reg")
            .args(args)
            .status()
            .map_err(|e| format!("failed to run reg.exe: {e}"))?;
        if !status.success() {
            return Err(format!("reg.exe refused the write ({})", args.join(" ")));
        }
    }
    Ok(format!("HKCU\\{key}"))
}

/// Remove the per-user protocol-handler registration on this OS.
pub fn uninstall_protocol_handler(home: &str) -> Result<Option<String>, String> {
    if home.is_empty() {
        return Err("home must not be empty".to_string());
    }
    match std::env::consts::OS {
        "linux" => remove_file_if_present(&linux_desktop_file_path(home)),
        "macos" => remove_file_if_present(&macos_protocol_plist_path(home)),
        _ => uninstall_windows_protocol_handler(),
    }
}

fn remove_file_if_present(path: &str) -> Result<Option<String>, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(Some(path.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to remove {path}: {error}")),
    }
}

fn uninstall_windows_protocol_handler() -> Result<Option<String>, String> {
    use std::process::Command;
    let key = format!("HKCU\\{}", windows_protocol_key());
    let query = Command::new("reg")
        .args(["query", &key, "/ve"])
        .output()
        .map_err(|e| format!("failed to run reg.exe: {e}"))?;
    if !query.status.success() {
        return Ok(None);
    }
    let status = Command::new("reg")
        .args(["delete", &key, "/f"])
        .status()
        .map_err(|e| format!("failed to run reg.exe: {e}"))?;
    if !status.success() {
        return Err(format!("reg.exe refused to delete {key}"));
    }
    Ok(Some(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "dz-protocol-install-{}-{tag}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp home");
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn linux_entry_is_absolute_and_advertises_scheme() {
        assert!(linux_desktop_entry("relative/bin").is_err());
        let entry =
            linux_desktop_entry("/opt/dezoomify/dezoomify-desktop").expect("absolute executable");
        assert!(entry.contains("x-scheme-handler/dezoomify"));
        assert!(entry.contains("/opt/dezoomify/dezoomify-desktop %u"));
    }

    #[test]
    fn install_and_uninstall_stay_per_user() {
        if std::env::consts::OS != "linux" {
            return;
        }
        let home = temp_home("roundtrip");
        let installed = install_protocol_handler(&home, "/opt/dezoomify/dezoomify-desktop")
            .expect("install protocol handler");
        assert!(installed.starts_with(&home));
        assert!(!installed.contains("/etc/"));
        assert!(std::path::Path::new(&installed).exists());
        assert_eq!(
            uninstall_protocol_handler(&home).expect("uninstall protocol handler"),
            Some(installed.clone())
        );
        assert!(!std::path::Path::new(&installed).exists());
        assert_eq!(
            uninstall_protocol_handler(&home).expect("idempotent uninstall"),
            None
        );
        std::fs::remove_dir_all(home).expect("remove temp home");
    }
}
