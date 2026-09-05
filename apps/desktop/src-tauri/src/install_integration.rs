// Install-integration path and manifest computation (pure, std only).
//
// Generates OS-specific protocol registration destinations and Native
// Messaging host manifests from installed executable paths. Browser
// enforcement of the manifest allowed extension IDs authenticates the
// extension sender of an established Native Messaging channel; the host does
// not invent a separate nonce or signature identity check. Dev IDs and
// destinations stay isolated under test profiles. No wildcards are emitted.

/// Native host name shared with capabilities and installer templates.
pub const NATIVE_HOST_NAME: &str = "com.dezoomify.native_host";
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
    format!("{home}/Library/Preferences/com.dezoomify.app.plist")
}

/// macOS Chromium manifest destination for one home directory.
pub fn macos_chromium_manifest_path(home: &str) -> String {
    format!("{home}/Library/Application Support/Google/Chrome/NativeMessagingHosts/{NATIVE_HOST_NAME}.json")
}

/// macOS Firefox manifest destination for one home directory.
pub fn macos_firefox_manifest_path(home: &str) -> String {
    format!("{home}/Library/Application Support/Mozilla/NativeMessagingHosts/{NATIVE_HOST_NAME}.json")
}

/// Linux desktop entry destination for one home directory.
pub fn linux_desktop_file_path(home: &str) -> String {
    format!("{home}/.local/share/applications/dezoomify.desktop")
}

/// Linux Chromium manifest destination (XDG config) for one home.
pub fn linux_chromium_manifest_path(home: &str) -> String {
    format!("{home}/.config/chromium/NativeMessagingHosts/{NATIVE_HOST_NAME}.json")
}

/// Linux Firefox manifest destination for one home.
pub fn linux_firefox_manifest_path(home: &str) -> String {
    format!("{home}/.mozilla/native-messaging-hosts/{NATIVE_HOST_NAME}.json")
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/') || (path.len() >= 3 && path.as_bytes()[1] == b':' && (path.as_bytes()[2] == b'\\' || path.as_bytes()[2] == b'/'))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_manifest_uses_exact_origin() {
        let json = chromium_manifest("/opt/dezoomify/dezoomify-native-host", CHROMIUM_RELEASE_EXTENSION_ID).unwrap();
        assert!(json.contains("chrome-extension://iapjjopjejpelnfdonefbffahmcndfbm/"));
        assert!(!json.contains('*'));
        assert!(chromium_manifest("relative/host", CHROMIUM_RELEASE_EXTENSION_ID).is_err());
        assert!(chromium_manifest("/opt/host", "*").is_err());
    }

    #[test]
    fn firefox_manifest_uses_exact_extension() {
        let json = firefox_manifest("/opt/dezoomify/dezoomify-native-host", FIREFOX_RELEASE_EXTENSION_ID).unwrap();
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
}
