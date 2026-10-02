//! Output writer: atomic file replacement, format/extension validation,
//! overwrite refusal unless explicitly requested.
//! Single-file formats (PNG, JPEG, TIFF, WebP) encode to one file; `zif`
//! encodes one multi-directory TIFF pyramid file; `iiif-dir`
//! writes a static tiled directory holding an `info.json` beside JPEG tiles.

use std::path::Path;

use dezoomify::model::{Error, Failure, LimitContext, OutputFormat};

/// One rendered `iiif-dir` tile set: `(relative path, bytes)` pairs in
/// sorted relative-path order.
pub type IiifTiles = Vec<(String, Vec<u8>)>;

pub fn infer_from_path(path: &Path) -> Result<OutputFormat, Error> {
    if path.is_dir() {
        return Ok(OutputFormat::IiifDir);
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
            "png" => Ok(OutputFormat::Png),
            "jpg" | "jpeg" => Ok(OutputFormat::Jpeg),
            "tif" | "tiff" => Ok(OutputFormat::Tiff),
            "zif" => Ok(OutputFormat::Zif),
            "webp" => Ok(OutputFormat::Webp),
            "iiif" => Ok(OutputFormat::IiifDir),
            "" => Ok(OutputFormat::IiifDir),
            other => Err(crate::output::unsupported_extension(format!(
                "unsupported output extension .{other}; use .png, .jpg, .jpeg, .tif, .tiff, .zif, .webp, .iiif, or an extensionless directory path for iiif-dir"
            ))),
        }
}

/// Image extensions that always name a single file, never an `iiif-dir`
/// directory destination. `.zif` names a single multi-directory pyramid
/// file; `.iiif` names a directory and is intentionally absent here.
fn is_single_file_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "tif" | "tiff" | "zif" | "webp"
    )
}

pub fn validate_destination(
    path: &Path,
    format: &OutputFormat,
    overwrite: bool,
) -> Result<(), Error> {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            return Err(crate::output::destination_denied("path traversal rejected"));
        }
    }
    match format {
        OutputFormat::Png => {
            if path.is_dir() {
                return Err(crate::output::destination_denied(
                    "destination is a directory, not a png file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("png") {
                return Err(crate::output::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Jpeg => {
            if path.is_dir() {
                return Err(crate::output::destination_denied(
                    "destination is a directory, not a jpeg file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !(ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg")) {
                return Err(crate::output::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Tiff => {
            if path.is_dir() {
                return Err(crate::output::destination_denied(
                    "destination is a directory, not a tiff file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !(ext.eq_ignore_ascii_case("tif") || ext.eq_ignore_ascii_case("tiff")) {
                return Err(crate::output::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Zif => {
            if path.is_dir() {
                return Err(crate::output::destination_denied(
                    "destination is a directory, not a zif file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("zif") {
                return Err(crate::output::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Webp => {
            if path.is_dir() {
                return Err(crate::output::destination_denied(
                    "destination is a directory, not a webp file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("webp") {
                return Err(crate::output::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::IiifDir => {
            if path.is_file() && !overwrite {
                return Err(crate::output::destination_denied(
                    "destination is a file, not a directory",
                ));
            }
            if is_single_file_extension(path) && !path.is_dir() {
                return Err(crate::output::destination_denied(
                    "extension does not match format",
                ));
            }
            if path.is_dir() && !overwrite {
                let non_empty = std::fs::read_dir(path)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(false);
                if non_empty {
                    return Err(crate::output::output_exists());
                }
            }
        }
    }
    if !format.is_directory() && path.exists() && !overwrite {
        return Err(crate::output::output_exists());
    }
    Ok(())
}

/// Sibling path for a kept partial output: inserts `.partial` before the
/// last extension when one exists (`out.png` becomes `out.partial.png`,
/// `tiles.iiif` becomes `tiles.partial.iiif`), else appends `.partial`
/// (`out` becomes `out.partial` for extensionless `iiif-dir` destinations).
/// A kept partial stays distinguishable from complete success on disk;
/// `--no-partial` writes nothing.
#[must_use]
pub(crate) fn partial_path_for(path: &Path) -> std::path::PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let partial_name = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            format!("{stem}.partial.{ext}")
        }
        _ => format!("{file_name}.partial"),
    };
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(partial_name),
        _ => std::path::PathBuf::from(partial_name),
    }
}

/// Write one `iiif-dir` destination: `info.json` plus JPEG tiles at
/// `<scale>/<col>_<row>.jpg`, each file committed via temp-write plus
/// rename. `tiles` must arrive in sorted relative-path order; `info.json`
/// is written last so a half-written directory never carries a manifest.
pub fn write_iiif_dir(dir: &Path, info_json: &[u8], tiles: &IiifTiles) -> Result<(), Error> {
    // Validation granted overwrite before this runs: a stale file at the
    // directory path is replaced before the tile tree is written.
    if dir.is_file() {
        std::fs::remove_file(dir)
            .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    for (relative, bytes) in tiles {
        if relative.contains("..") || relative.contains('\\') || Path::new(relative).is_absolute() {
            return Err(crate::output::destination_denied(
                "tile path escapes the destination",
            ));
        }
        let dest = dir.join(relative);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| crate::output::write_failed("output write failed", &e))?;
        }
        let tmp = dest.with_extension("tmp");
        std::fs::write(&tmp, bytes)
            .map_err(|e| crate::output::write_failed("output write failed", &e))?;
        std::fs::rename(&tmp, &dest)
            .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    }
    let manifest = dir.join("info.json");
    let tmp = manifest.with_extension("tmp");
    std::fs::write(&tmp, info_json)
        .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    std::fs::rename(&tmp, &manifest)
        .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    Ok(())
}

/// A memory- or format-budget refusal with structured facts for host copy;
/// display prose is presentation only and never a data channel.
pub(crate) fn memory_limit(limit: LimitContext) -> Error {
    Error::LimitExceeded { limit }
}

fn output_exists() -> Error {
    Error::OutputExists
}

fn destination_denied(detail: impl Into<String>) -> Error {
    Error::DestinationDenied(Failure {
        request: None,
        detail: Some(detail.into()),
    })
}

fn unsupported_extension(detail: impl Into<String>) -> Error {
    Error::UnsupportedExtension(Failure {
        request: None,
        detail: Some(detail.into()),
    })
}

/// Output write failure with the failing step and cause chain preserved in
/// the failure detail.
pub(crate) fn write_failed(
    message: impl Into<String>,
    cause: &(dyn std::error::Error + 'static),
) -> Error {
    Error::WriteFailed(
        format!(
            "{}: {}",
            message.into(),
            dezoomify::model::chain_text(cause)
        )
        .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_path_inserts_partial_before_the_extension() {
        assert_eq!(
            partial_path_for(Path::new("out.png")),
            std::path::PathBuf::from("out.partial.png"),
        );
        assert_eq!(
            partial_path_for(Path::new("/tmp/a/out.jpg")),
            std::path::PathBuf::from("/tmp/a/out.partial.jpg"),
        );
        assert_eq!(
            partial_path_for(Path::new("tiles.iiif")),
            std::path::PathBuf::from("tiles.partial.iiif"),
        );
        assert_eq!(
            partial_path_for(Path::new("out")),
            std::path::PathBuf::from("out.partial"),
        );
        // The partial sibling keeps its own encoder extension, so the output
        // file name still selects the encoder on a later inspection.
        assert_eq!(
            crate::output::infer_from_path(&partial_path_for(Path::new("out.png")))
                .expect("partial png still infers"),
            OutputFormat::Png,
        );
    }
}
