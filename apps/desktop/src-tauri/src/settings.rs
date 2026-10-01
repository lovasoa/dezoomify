//! Desktop settings with validated bounds and scoped user headers.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use dezoomify_native::JobOptions;

/// Default compression; JPEG quality is 100-5 = 95.
pub const DEFAULT_COMPRESSION: u8 = 5;
/// Default tile retry budget (`0` means no retries).
pub const DEFAULT_RETRIES: u32 = 3;
/// Upper bound for retries: generous but finite so absurd values fail closed.
pub const MAX_RETRIES: u32 = 100;
/// Upper bound for max-width / max-height caps (positive ints only).
pub const MAX_DIMENSION: u32 = 1_000_000;
/// Upper bound for directory path settings (bytes).
pub const MAX_PATH_LEN: usize = 4096;
/// Upper bound for trusted user headers (repeatable -H, last wins).
pub const MAX_HEADERS: usize = 32;
/// Output formats selected on the desktop main screen.
pub const OUTPUT_FORMATS: &[&str] = &["png", "jpeg", "tiff", "zif", "webp", "iiif-dir"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum NetworkProfile {
    #[default]
    Maximum,
    Balanced,
    Gentle,
}

/// Validated desktop settings. All bounds are enforced by
/// `parse_settings`; direct construction (e.g. `Default`) is already valid.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopSettings {
    /// Destination directory for derived output paths. `None` keeps the
    /// temp-dir fallback.
    pub output_dir: Option<PathBuf>,
    /// Encoder selected on the main screen. The native pipeline derives the
    /// matching extension after selecting an image title.
    pub output_format: String,
    /// Output compression 0-100 (default 5).
    pub compression: u8,
    /// Optional width cap (positive int).
    pub max_width: Option<u32>,
    /// Optional height cap (positive int).
    pub max_height: Option<u32>,
    /// Tile retry budget (default 3, 0 = no retries).
    pub retries: u32,
    /// Request pacing preset exposed by the desktop app.
    pub network_profile: NetworkProfile,
    /// Optional resume-cache directory (tile bodies only).
    pub cache_dir: Option<PathBuf>,
    /// Trusted user headers, lowercased names (origin-scoped).
    pub headers: BTreeMap<String, String>,
}

impl DesktopSettings {
    /// Default settings matching the CLI defaults (compression 5, retries 3).
    pub fn with_defaults() -> Self {
        Self {
            output_dir: None,
            output_format: "png".to_string(),
            compression: DEFAULT_COMPRESSION,
            max_width: None,
            max_height: None,
            retries: DEFAULT_RETRIES,
            network_profile: NetworkProfile::Maximum,
            cache_dir: None,
            headers: BTreeMap::new(),
        }
    }
}

pub fn job_options_for(settings: &DesktopSettings) -> JobOptions {
    let (max_concurrent, min_interval) = match settings.network_profile {
        NetworkProfile::Maximum => (16, Duration::ZERO),
        NetworkProfile::Balanced => (8, Duration::from_millis(200)),
        NetworkProfile::Gentle => (4, Duration::from_millis(500)),
    };
    JobOptions {
        headers: settings.headers.clone(),
        max_width: settings.max_width,
        max_height: settings.max_height,
        max_concurrent,
        max_retries: settings.retries,
        min_interval,
        compression: settings.compression,
        cache_dir: settings.cache_dir.clone(),
        ..JobOptions::default()
    }
}

fn validate_dir_field(raw: &str, field: &str) -> Result<Option<PathBuf>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_PATH_LEN {
        return Err(format!("{field} too long (max {MAX_PATH_LEN} bytes)"));
    }
    if trimmed.contains('\0') {
        return Err(format!("{field} must not contain NUL"));
    }
    Ok(Some(PathBuf::from(trimmed)))
}

fn parse_opt_dir(value: &serde_json::Value, field: &str) -> Result<Option<PathBuf>, String> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) => validate_dir_field(s, field),
        _ => Err(format!("{field} must be a string path or null")),
    }
}

fn parse_output_format(value: Option<&serde_json::Value>) -> Result<String, String> {
    let Some(value) = value else {
        return Ok("png".to_string());
    };
    let format = value
        .as_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "output_format must be a string".to_string())?;
    if OUTPUT_FORMATS.contains(&format.as_str()) {
        Ok(format)
    } else {
        Err("output_format must be png, jpeg, tiff, zif, webp, or iiif-dir".to_string())
    }
}

fn parse_opt_dimension(value: &serde_json::Value, field: &str) -> Result<Option<u32>, String> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            parse_dimension_str(trimmed, field)
        }
        serde_json::Value::Number(n) => {
            let Some(v) = n.as_u64() else {
                return Err(format!("{field} must be a positive integer"));
            };
            parse_dimension_u64(v, field)
        }
        _ => Err(format!("{field} must be a positive integer or null")),
    }
}

fn parse_dimension_str(raw: &str, field: &str) -> Result<Option<u32>, String> {
    let v: u64 = raw
        .parse()
        .map_err(|_| format!("{field} must be a positive integer"))?;
    parse_dimension_u64(v, field)
}

fn parse_dimension_u64(v: u64, field: &str) -> Result<Option<u32>, String> {
    if v == 0 || v > u64::from(MAX_DIMENSION) {
        return Err(format!(
            "{field} must be 1..={} (positive int)",
            MAX_DIMENSION
        ));
    }
    Ok(Some(v as u32))
}

fn is_valid_header_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 {
        return false;
    }
    name.bytes().all(|b| {
        matches!(b,
            b'a'..=b'z' | b'0'..=b'9' | b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*'
            | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
    })
}

/// Parse one `Name: value` header line (trusted `-H` shape, last wins).
/// Returns `Ok(None)` for blank lines; `Err` fails closed on malformed input.
fn parse_header_line(line: &str) -> Result<Option<(String, String)>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let (name_raw, value_raw) = line.split_once(':').ok_or_else(|| {
        "invalid header (expected \"Name: value\"): line without colon".to_string()
    })?;
    let name = name_raw.trim().to_ascii_lowercase();
    let value = value_raw.trim().to_string();
    if !is_valid_header_name(&name) {
        return Err("invalid header: bad name".to_string());
    }
    if value.len() > 4096 {
        return Err("invalid header: value too long".to_string());
    }
    if value.contains(['\r', '\n', '\0']) {
        return Err("invalid header: value must not contain CR/LF/NUL".to_string());
    }
    Ok(Some((name, value)))
}

fn parse_headers_value(value: &serde_json::Value) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    match value {
        serde_json::Value::Null => return Ok(out),
        serde_json::Value::Object(map) => {
            for (key, val) in map {
                let name = key.trim().to_ascii_lowercase();
                // Header values are strings (numbers stay fail-closed, matching
                // the single validator for this corpus).
                let val_str = match val {
                    serde_json::Value::String(s) => s.clone(),
                    _ => {
                        return Err("invalid header: value must be a string".to_string());
                    }
                };
                if !is_valid_header_name(&name) {
                    return Err("invalid header: bad name".to_string());
                }
                let trimmed_val = val_str.trim().to_string();
                if trimmed_val.len() > 4096 {
                    return Err("invalid header: value too long".to_string());
                }
                if trimmed_val.contains(['\r', '\n', '\0']) {
                    return Err("invalid header: value must not contain CR/LF/NUL".to_string());
                }
                out.insert(name, trimmed_val);
                if out.len() > MAX_HEADERS {
                    return Err(format!("too many headers (max {MAX_HEADERS})"));
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                let line = match item {
                    serde_json::Value::String(s) => s.clone(),
                    _ => return Err("invalid header: array items must be strings".to_string()),
                };
                if let Some((name, val)) = parse_header_line(&line)? {
                    out.insert(name, val);
                    if out.len() > MAX_HEADERS {
                        return Err(format!("too many headers (max {MAX_HEADERS})"));
                    }
                }
            }
        }
        serde_json::Value::String(s) => {
            for line in s.lines() {
                if let Some((name, val)) = parse_header_line(line)? {
                    out.insert(name, val);
                    if out.len() > MAX_HEADERS {
                        return Err(format!("too many headers (max {MAX_HEADERS})"));
                    }
                }
            }
        }
        _ => return Err("headers must be an object, array, or string".to_string()),
    }
    Ok(out)
}

fn parse_u8_field(value: &serde_json::Value, field: &str, min: u8, max: u8) -> Result<u8, String> {
    match value {
        serde_json::Value::Number(n) => {
            let Some(v) = n.as_u64() else {
                return Err(format!("{field} must be an integer {min}..={max}"));
            };
            if v < u64::from(min) || v > u64::from(max) {
                return Err(format!("{field} must be {min}..={max}"));
            }
            Ok(v as u8)
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            let v: u64 = trimmed
                .parse()
                .map_err(|_| format!("{field} must be an integer {min}..={max}"))?;
            if v < u64::from(min) || v > u64::from(max) {
                return Err(format!("{field} must be {min}..={max}"));
            }
            Ok(v as u8)
        }
        _ => Err(format!("{field} must be an integer {min}..={max}")),
    }
}

fn parse_retries_field(value: &serde_json::Value) -> Result<u32, String> {
    match value {
        serde_json::Value::Number(n) => {
            let Some(v) = n.as_u64() else {
                return Err(format!("retries must be an integer 0..={MAX_RETRIES}"));
            };
            if v > u64::from(MAX_RETRIES) {
                return Err(format!("retries must be 0..={MAX_RETRIES}"));
            }
            Ok(v as u32)
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            let v: u64 = trimmed
                .parse()
                .map_err(|_| format!("retries must be an integer 0..={MAX_RETRIES}"))?;
            if v > u64::from(MAX_RETRIES) {
                return Err(format!("retries must be 0..={MAX_RETRIES}"));
            }
            Ok(v as u32)
        }
        _ => Err(format!("retries must be an integer 0..={MAX_RETRIES}")),
    }
}

/// Parse and validate a settings JSON value, failing closed on any invalid
/// field. Missing fields take CLI-matching defaults; `null`/empty-string
/// directory and dimension fields mean unset. Unknown fields are ignored.
pub fn parse_settings(value: &serde_json::Value) -> Result<DesktopSettings, String> {
    if value.is_null() {
        return Ok(DesktopSettings::with_defaults());
    }
    let obj = value
        .as_object()
        .ok_or_else(|| "settings must be a JSON object".to_string())?;
    let compression = match obj.get("compression") {
        None => DEFAULT_COMPRESSION,
        Some(v) => parse_u8_field(v, "compression", 0, 100)?,
    };
    let retries = match obj.get("retries") {
        None => DEFAULT_RETRIES,
        Some(v) => parse_retries_field(v)?,
    };
    let network_profile = match obj.get("network_profile") {
        None => NetworkProfile::Maximum,
        Some(serde_json::Value::String(value)) => match value.as_str() {
            "maximum" => NetworkProfile::Maximum,
            "balanced" => NetworkProfile::Balanced,
            "gentle" => NetworkProfile::Gentle,
            _ => return Err("network_profile must be maximum, balanced, or gentle".to_string()),
        },
        Some(_) => return Err("network_profile must be a string".to_string()),
    };
    let max_width = match obj.get("max_width") {
        None => None,
        Some(v) => parse_opt_dimension(v, "max_width")?,
    };
    let max_height = match obj.get("max_height") {
        None => None,
        Some(v) => parse_opt_dimension(v, "max_height")?,
    };
    let output_dir = match obj.get("output_dir") {
        None => None,
        Some(v) => parse_opt_dir(v, "output_dir")?,
    };
    let output_format = parse_output_format(obj.get("output_format"))?;
    let cache_dir = match obj.get("cache_dir") {
        None => None,
        Some(v) => parse_opt_dir(v, "cache_dir")?,
    };
    let headers = match obj.get("headers") {
        None => BTreeMap::new(),
        Some(v) => parse_headers_value(v)?,
    };
    Ok(DesktopSettings {
        output_dir,
        output_format,
        compression,
        max_width,
        max_height,
        retries,
        network_profile,
        cache_dir,
        headers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_cli() {
        let settings = parse_settings(&serde_json::Value::Null).unwrap();
        assert_eq!(settings.output_format, "png");
        assert_eq!(settings.compression, 5);
        assert_eq!(settings.retries, 3);
        assert_eq!(settings.max_width, None);
        assert_eq!(settings.max_height, None);
        let options = job_options_for(&settings);
        assert_eq!(options.compression, 5);
        assert_eq!(options.max_retries, 3);
        assert_eq!(options.max_concurrent, 16);
        assert_eq!(options.timeout, Duration::from_secs(30));
        assert_eq!(options.connect_timeout, Duration::from_secs(6));
        assert_eq!(options.max_idle_per_host, 32);
        assert!(options.keep_partial);
    }

    #[test]
    fn compression_bounds_fail_closed() {
        assert!(parse_settings(&json!({"compression": 0})).is_ok());
        assert!(parse_settings(&json!({"compression": 100})).is_ok());
        assert!(parse_settings(&json!({"compression": 101})).is_err());
        assert!(parse_settings(&json!({"compression": -1})).is_err());
        assert!(parse_settings(&json!({"compression": "x"})).is_err());
    }

    #[test]
    fn output_format_is_validated_for_automatic_saves() {
        assert_eq!(
            parse_settings(&json!({"output_format": "webp"}))
                .unwrap()
                .output_format,
            "webp"
        );
        assert!(parse_settings(&json!({"output_format": "exe"})).is_err());
    }

    #[test]
    fn retries_zero_allowed_and_bounded() {
        assert_eq!(parse_settings(&json!({"retries": 0})).unwrap().retries, 0);
        assert_eq!(parse_settings(&json!({"retries": 3})).unwrap().retries, 3);
        assert!(parse_settings(&json!({"retries": -1})).is_err());
        assert!(parse_settings(&json!({"retries": 101})).is_err());
        assert!(parse_settings(&json!({"retries": "x"})).is_err());
    }

    #[test]
    fn network_profiles_apply_real_pacing_and_concurrency() {
        let balanced = parse_settings(&json!({"network_profile": "balanced"})).unwrap();
        let balanced_options = job_options_for(&balanced);
        assert_eq!(balanced_options.max_concurrent, 8);
        assert_eq!(balanced_options.min_interval, Duration::from_millis(200));

        let gentle = parse_settings(&json!({"network_profile": "gentle"})).unwrap();
        let gentle_options = job_options_for(&gentle);
        assert_eq!(gentle_options.max_concurrent, 4);
        assert_eq!(gentle_options.min_interval, Duration::from_millis(500));
        assert!(parse_settings(&json!({"network_profile": "unsafe"})).is_err());
    }

    #[test]
    fn dimensions_must_be_positive() {
        assert!(parse_settings(&json!({"max_width": 0})).is_err());
        assert!(parse_settings(&json!({"max_width": 800})).is_ok());
        assert!(parse_settings(&json!({"max_height": 0})).is_err());
        assert!(parse_settings(&json!({"max_height": null}))
            .unwrap()
            .max_height
            .is_none());
        assert!(parse_settings(&json!({"max_width": ""}))
            .unwrap()
            .max_width
            .is_none());
    }

    #[test]
    fn headers_are_validated() {
        let settings = parse_settings(&json!({"headers": {"Cookie": "secret=1"}})).unwrap();
        assert_eq!(
            settings.headers.get("cookie").map(String::as_str),
            Some("secret=1")
        );
        assert!(parse_settings(&json!({"headers": {"bad name": "v"}})).is_err());
        assert!(parse_settings(&json!({"headers": ["no-colon"]})).is_err());
    }

    #[test]
    fn dirs_reject_nul_and_accept_empty_as_unset() {
        assert!(parse_settings(&json!({"output_dir": ""}))
            .unwrap()
            .output_dir
            .is_none());
        assert!(parse_settings(&json!({"output_dir": "a\0b"})).is_err());
        assert!(parse_settings(&json!({"cache_dir": null}))
            .unwrap()
            .cache_dir
            .is_none());
    }

    /// Shared cross-language oracle: every case in
    /// `testdata/policy-vectors.json` is asserted here against the shell's
    /// `parse_settings`/`parse_header_line`, so the Rust settings validation
    /// can never drift apart unnoticed. Rejection reason strings are
    /// pinned per side; where the sides differ in wording only, the vector
    /// carries both strings plus a comment.
    #[test]
    fn policy_vectors_match_the_shared_oracle() {
        let header_lines = crate::test_vectors::cases("policy-vectors.json", "headerLines");
        assert!(
            (15..=25).contains(&header_lines.len()),
            "the header-line list stays bounded ({} cases)",
            header_lines.len()
        );
        for case in header_lines {
            let name = case["name"].as_str().expect("case name");
            let line = case["line"].as_str().expect("case line");
            let result = parse_header_line(line);
            crate::test_vectors::assert_case(&case, result, |accept, entry| {
                if accept.is_null() {
                    assert_eq!(entry, None, "{name} blank line is ignored");
                } else {
                    let entry = entry.expect("entry");
                    assert_eq!(entry.0, accept["name"].as_str().expect("name"), "{name}");
                    assert_eq!(entry.1, accept["value"].as_str().expect("value"), "{name}");
                }
            });
        }
        let settings_cases = crate::test_vectors::cases("policy-vectors.json", "settings");
        assert!(
            (5..=25).contains(&settings_cases.len()),
            "the settings list stays bounded ({} cases)",
            settings_cases.len()
        );
        for case in settings_cases {
            let name = case["name"].as_str().expect("case name");
            let result = parse_settings(&case["input"]);
            crate::test_vectors::assert_case(&case, result, |accept, parsed| {
                if let Some(retries) = accept["retries"].as_u64() {
                    assert_eq!(u64::from(parsed.retries), retries, "{name}: retries");
                }
                if let Some(headers) = accept["headers"].as_object() {
                    assert_eq!(parsed.headers.len(), headers.len(), "{name}: headers");
                    for (key, value) in headers {
                        assert_eq!(
                            parsed.headers.get(key).map(String::as_str),
                            value.as_str(),
                            "{name}: header {key}"
                        );
                    }
                }
            });
        }
    }
}
