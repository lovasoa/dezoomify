// Install-integration path computation plus per-user registration writes.
//
// Path helpers are pure; `install_*` writes per-user files only (never
// system-wide, never root): Native Messaging manifests under the user profile
// and the `dezoomify://` protocol handler (Linux `.desktop`, macOS plist,
// Windows HKCU). Browser enforcement of the manifest allowed extension IDs
// authenticates the extension sender of an established Native Messaging
// channel; the host does not invent a separate nonce or signature identity
// check. Dev IDs and destinations stay isolated under test profiles. No
// wildcards are emitted. Foreign manifests (parseable files naming another
// host) are never overwritten.

/// Native host name shared with capabilities and installer templates.
pub const NATIVE_HOST_NAME: &str = "dev.ophir.dezoomify.native_host";
/// Release Chromium extension id (exact, no wildcards).
/// This is the EXISTING Chrome Web Store listing for Dezoomify; store updates
/// reuse this public id, never a new item. Reviewed in release/config.toml.
pub const CHROMIUM_RELEASE_EXTENSION_ID: &str = "iapjjopjejpelnfdonefbffahmcndfbm";
/// Example Firefox extension id (exact, no wildcards).
pub const FIREFOX_RELEASE_EXTENSION_ID: &str = "dezoomify@dezoomify.example";
/// Protocol scheme handled by the desktop app.
pub const PROTOCOL_SCHEME: &str = "dezoomify";

/// Windows protocol registration key (HKCU).
pub fn windows_protocol_key() -> String {
    format!(r"Software\Classes\{PROTOCOL_SCHEME}")
}

/// Windows Native Messaging host registry key (HKCU).
pub fn windows_native_host_key() -> String {
    format!(r"Software\Google\Chrome\NativeMessagingHosts\{NATIVE_HOST_NAME}")
}

/// macOS protocol handler plist destination for one home directory.
pub fn macos_protocol_plist_path(home: &str) -> String {
    format!("{home}/Library/Preferences/dev.ophir.dezoomify.plist")
}

/// macOS Chromium manifest destination for one home directory.
pub fn macos_chromium_manifest_path(home: &str) -> String {
    format!("{home}/Library/Application Support/Google/Chrome/NativeMessagingHosts/{NATIVE_HOST_NAME}.json")
}

/// macOS Firefox manifest destination for one home directory.
pub fn macos_firefox_manifest_path(home: &str) -> String {
    format!(
        "{home}/Library/Application Support/Mozilla/NativeMessagingHosts/{NATIVE_HOST_NAME}.json"
    )
}

/// Linux desktop entry destination for one home directory.
pub fn linux_desktop_file_path(home: &str) -> String {
    format!("{home}/.local/share/applications/dezoomify.desktop")
}

/// Linux Chromium manifest destination (XDG config) for one home.
pub fn linux_chromium_manifest_path(home: &str) -> String {
    format!("{home}/.config/chromium/NativeMessagingHosts/{NATIVE_HOST_NAME}.json")
}

/// Linux Chrome (google-chrome) manifest destination for one home.
pub fn linux_chrome_manifest_path(home: &str) -> String {
    format!("{home}/.config/google-chrome/NativeMessagingHosts/{NATIVE_HOST_NAME}.json")
}

/// Linux Firefox manifest destination for one home.
pub fn linux_firefox_manifest_path(home: &str) -> String {
    format!("{home}/.mozilla/native-messaging-hosts/{NATIVE_HOST_NAME}.json")
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
    // Chromium: 32 lowercase letters; Firefox: dotted id or uuid-like.
    // Accept either shape here; wildcards are already rejected above.
    !id.contains(char::is_whitespace)
}

fn json_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 2);
    for c in input.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Chromium manifest JSON with exact allowed origin (no wildcards).
pub fn chromium_manifest(host_path: &str, extension_id: &str) -> Result<String, String> {
    if !is_absolute_path(host_path) {
        return Err("host path must be absolute".to_string());
    }
    if !is_exact_extension_id(extension_id) {
        return Err("extension id must be exact (no wildcards)".to_string());
    }
    if extension_id.contains('*') {
        return Err("wildcard extension id forbidden".to_string());
    }
    Ok(format!(
        "{{\n  \"name\": \"{}\",\n  \"description\": \"Dezoomify native host\",\n  \"path\": \"{}\",\n  \"type\": \"stdio\",\n  \"allowed_origins\": [\"chrome-extension://{}/\"]\n}}\n",
        NATIVE_HOST_NAME,
        json_escape(host_path),
        json_escape(extension_id)
    ))
}

/// Firefox manifest JSON with exact allowed extension (no wildcards).
pub fn firefox_manifest(host_path: &str, extension_id: &str) -> Result<String, String> {
    if !is_absolute_path(host_path) {
        return Err("host path must be absolute".to_string());
    }
    if !is_exact_extension_id(extension_id) {
        return Err("extension id must be exact (no wildcards)".to_string());
    }
    if extension_id.contains('*') {
        return Err("wildcard extension id forbidden".to_string());
    }
    Ok(format!(
        "{{\n  \"name\": \"{}\",\n  \"description\": \"Dezoomify native host\",\n  \"path\": \"{}\",\n  \"type\": \"stdio\",\n  \"allowed_extensions\": [\"{}\"]\n}}\n",
        NATIVE_HOST_NAME,
        json_escape(host_path),
        json_escape(extension_id)
    ))
}

/// True when manifest text names our host. Unparseable text is not ours
/// (callers treat our exact file name with unparseable content as a
/// truncated write and replace it; foreign paths are never touched).
#[must_use]
pub fn is_our_manifest_text(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("name")
                .and_then(|name| name.as_str())
                .map(str::to_string)
        })
        .is_some_and(|name| name == NATIVE_HOST_NAME)
}

/// Destinations for one home directory on the current OS: `(engine, path,
/// manifest_json)`. File destinations only; Windows registry keys are
/// handled by `install_windows_registry`.
fn manifest_destinations(
    home: &str,
    host_path: &str,
    chromium_id: &str,
    firefox_id: &str,
) -> Result<Vec<(String, String, String)>, String> {
    // Validate on every OS, including Windows (which writes no files here),
    // so bad input fails closed before anything is written anywhere.
    let chromium_json = chromium_manifest(host_path, chromium_id)?;
    let firefox_json = firefox_manifest(host_path, firefox_id)?;
    let mut out = Vec::new();
    match std::env::consts::OS {
        "linux" => {
            out.push((
                "chromium".to_string(),
                linux_chromium_manifest_path(home),
                chromium_json.clone(),
            ));
            out.push((
                "chromium".to_string(),
                linux_chrome_manifest_path(home),
                chromium_json,
            ));
            out.push((
                "firefox".to_string(),
                linux_firefox_manifest_path(home),
                firefox_json,
            ));
        }
        "macos" => {
            out.push((
                "chromium".to_string(),
                macos_chromium_manifest_path(home),
                chromium_json,
            ));
            out.push((
                "firefox".to_string(),
                macos_firefox_manifest_path(home),
                firefox_json,
            ));
        }
        // Windows uses HKCU registry keys; file manifests are not written.
        _ => {}
    }
    Ok(out)
}

fn write_manifest_file(path: &str, content: &str) -> Result<bool, String> {
    use std::path::Path;
    let dest = Path::new(path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    // Never overwrite a foreign manifest (parseable, different host).
    if let Ok(existing) = std::fs::read_to_string(dest) {
        if !is_our_manifest_text(&existing) {
            // Our exact file name with unparseable content is a truncated
            // write: replace it. Anything else naming another host is foreign.
            let file_name = dest
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ours = format!("{NATIVE_HOST_NAME}.json");
            if file_name != ours || serde_json::from_str::<serde_json::Value>(&existing).is_ok() {
                return Err(format!("foreign manifest at {path}; refusing to overwrite"));
            }
        }
    }
    std::fs::write(dest, content).map_err(|e| format!("failed to write {path}: {e}"))?;
    Ok(true)
}

/// Install per-user Native Messaging manifests for one home directory.
/// Returns the written file paths. Validates absolute host path and exact
/// extension ids (no wildcards) before writing anything; foreign manifests
/// are never overwritten. Windows registry installs go through
/// `install_windows_registry`.
pub fn install_native_manifests(
    home: &str,
    host_path: &str,
    chromium_id: &str,
    firefox_id: &str,
) -> Result<Vec<String>, String> {
    if home.is_empty() {
        return Err("home must not be empty".to_string());
    }
    let destinations = manifest_destinations(home, host_path, chromium_id, firefox_id)?;
    if destinations.is_empty() {
        // Windows (or unknown OS): no file manifests to write.
        return Ok(Vec::new());
    }
    let mut written = Vec::new();
    for (_engine, path, content) in &destinations {
        write_manifest_file(path, content)?;
        written.push(path.clone());
    }
    written.sort();
    Ok(written)
}

/// Linux `.desktop` entry registering the `dezoomify://` scheme. The entry
/// points at the installed desktop binary and advertises the scheme handler;
/// enabling uses `xdg-mime default` (run by the installer, not here).
pub fn linux_desktop_entry(exec_path: &str) -> Result<String, String> {
    if !is_absolute_path(exec_path) {
        return Err("exec path must be absolute".to_string());
    }
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Dezoomify\nExec={} %u\nMimeType=x-scheme-handler/dezoomify;\nNoDisplay=true\n",
        exec_path.replace('%', "%%")
    ))
}

/// Install the per-user `dezoomify://` protocol handler for one home.
/// Linux writes the `.desktop` file; macOS writes the handler plist;
/// Windows attempts the HKCU registry write via `reg.exe` and fails closed
/// when it is unavailable. Returns the written path or registry key.
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
        _ => install_windows_registry(exec_path),
    }
}

/// Windows HKCU registration (protocol + native host keys) via `reg.exe`.
/// Fails closed when `reg.exe` is missing or refuses the write.
pub fn install_windows_registry(exec_path: &str) -> Result<String, String> {
    use std::process::Command;
    if !is_absolute_path(exec_path) {
        return Err("exec path must be absolute".to_string());
    }
    let protocol_key = windows_protocol_key();
    let host_key = windows_native_host_key();
    // Protocol handler: URL Protocol + default icon + open command.
    let steps: Vec<Vec<String>> = vec![
        vec![
            "add".into(),
            format!("HKCU\\{protocol_key}"),
            "/ve".into(),
            "/d".into(),
            "Dezoomify".into(),
            "/f".into(),
        ],
        vec![
            "add".into(),
            format!("HKCU\\{protocol_key}"),
            "/v".into(),
            "URL Protocol".into(),
            "/d".into(),
            "".into(),
            "/f".into(),
        ],
        vec![
            "add".into(),
            format!("HKCU\\{protocol_key}\\shell\\open\\command"),
            "/ve".into(),
            "/d".into(),
            format!("\"{exec_path}\" \"%1\""),
            "/f".into(),
        ],
        vec![
            "add".into(),
            format!("HKCU\\{host_key}"),
            "/ve".into(),
            "/d".into(),
            exec_path.into(),
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
    Ok(format!("HKCU\\{protocol_key} + HKCU\\{host_key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_manifest_uses_exact_origin() {
        let json = chromium_manifest(
            "/opt/dezoomify/dezoomify-native-host",
            CHROMIUM_RELEASE_EXTENSION_ID,
        )
        .unwrap();
        assert!(json.contains("chrome-extension://iapjjopjejpelnfdonefbffahmcndfbm/"));
        assert!(!json.contains('*'));
        assert!(chromium_manifest("relative/host", CHROMIUM_RELEASE_EXTENSION_ID).is_err());
        assert!(chromium_manifest("/opt/host", "*").is_err());
    }

    #[test]
    fn firefox_manifest_uses_exact_extension() {
        let json = firefox_manifest(
            "/opt/dezoomify/dezoomify-native-host",
            FIREFOX_RELEASE_EXTENSION_ID,
        )
        .unwrap();
        assert!(json.contains("dezoomify@dezoomify.example"));
        assert!(!json.contains('*'));
        assert!(firefox_manifest("/opt/host", "chrome-extension://*/").is_err());
    }

    #[test]
    fn paths_survive_spaces_and_non_ascii() {
        let home = "/home/tëst user";
        let json = chromium_manifest("/opt/my app/hôst", CHROMIUM_RELEASE_EXTENSION_ID).unwrap();
        assert!(json.contains("/opt/my app/hôst"));
        assert!(linux_chromium_manifest_path(home).starts_with(home));
        assert!(macos_chromium_manifest_path(home).contains("NativeMessagingHosts"));
        assert!(windows_protocol_key().contains("dezoomify"));
    }

    fn temp_home(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "dz-install-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn install_writes_per_user_manifests_and_protocol_handler() {
        let home = temp_home("ok");
        let host = "/opt/dezoomify/dezoomify-native-host";
        let written = install_native_manifests(
            &home,
            host,
            CHROMIUM_RELEASE_EXTENSION_ID,
            FIREFOX_RELEASE_EXTENSION_ID,
        )
        .unwrap();
        // Linux writes chromium, google-chrome, and firefox manifests.
        if std::env::consts::OS == "linux" {
            assert_eq!(written.len(), 3);
        }
        for path in &written {
            assert!(path.starts_with(&home), "{path} outside home");
            let text = std::fs::read_to_string(path).unwrap();
            assert!(is_our_manifest_text(&text));
            assert!(text.contains(host));
            assert!(!text.contains('*'));
        }
        // Re-install overwrites our own manifests (host path update).
        let host2 = "/opt/dezoomify/dezoomify-native-host-2";
        let rewritten = install_native_manifests(
            &home,
            host2,
            CHROMIUM_RELEASE_EXTENSION_ID,
            FIREFOX_RELEASE_EXTENSION_ID,
        )
        .unwrap();
        assert_eq!(written, rewritten);
        for path in &rewritten {
            assert!(std::fs::read_to_string(path).unwrap().contains(host2));
        }
        // Protocol handler installs per-user and advertises the scheme.
        if std::env::consts::OS == "linux" {
            let entry =
                install_protocol_handler(&home, "/opt/dezoomify/dezoomify-desktop").unwrap();
            assert!(entry.starts_with(&home));
            let text = std::fs::read_to_string(&entry).unwrap();
            assert!(text.contains("x-scheme-handler/dezoomify"));
            assert!(text.contains("/opt/dezoomify/dezoomify-desktop"));
        }
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn install_refuses_wildcards_relative_paths_and_foreign_files() {
        let home = temp_home("refuse");
        // Wildcard ids and relative host paths fail before any write.
        assert!(install_native_manifests(
            &home,
            "relative/host",
            CHROMIUM_RELEASE_EXTENSION_ID,
            FIREFOX_RELEASE_EXTENSION_ID
        )
        .is_err());
        assert!(
            install_native_manifests(&home, "/opt/host", "*", FIREFOX_RELEASE_EXTENSION_ID)
                .is_err()
        );
        assert!(install_protocol_handler(&home, "relative/bin").is_err());
        // A foreign manifest at our destination is never overwritten.
        if std::env::consts::OS == "linux" {
            let dest = linux_chromium_manifest_path(&home);
            if let Some(parent) = std::path::Path::new(&dest).parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&dest, r#"{"name":"other.host","path":"/x"}"#).unwrap();
            let err = install_native_manifests(
                &home,
                "/opt/dezoomify/dezoomify-native-host",
                CHROMIUM_RELEASE_EXTENSION_ID,
                FIREFOX_RELEASE_EXTENSION_ID,
            )
            .unwrap_err();
            assert!(err.contains("foreign"), "must refuse foreign: {err}");
            assert!(std::fs::read_to_string(&dest)
                .unwrap()
                .contains("other.host"));
        }
        std::fs::remove_dir_all(&home).unwrap();
    }
}
