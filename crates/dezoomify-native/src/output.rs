//! Output writer: atomic file replacement, format/extension validation,
//! overwrite policy identical to legacy behavior (refuse without flag).

use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutputFormat {
    Png,
    Jpeg,
}

pub fn validate_destination(
    path: &Path,
    format: &OutputFormat,
    overwrite: bool,
) -> Result<(), String> {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            return Err("path traversal rejected".to_string());
        }
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    match format {
        OutputFormat::Png if ext.eq_ignore_ascii_case("png") => {}
        OutputFormat::Jpeg
            if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") => {}
        _ => return Err("extension does not match format".to_string()),
    }
    if path.exists() && !overwrite {
        return Err("output exists (refusing overwrite)".to_string());
    }
    Ok(())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}
