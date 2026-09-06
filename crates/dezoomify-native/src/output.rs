//! Output writer: atomic file replacement, format/extension validation,
//! overwrite policy identical to legacy behavior (refuse without flag).
//! Single-file formats (PNG, JPEG, TIFF, WebP) encode to one file; `zif`
//! encodes one multi-directory TIFF pyramid file; `iiif-dir`
//! writes a static tiled directory holding an `info.json` beside JPEG tiles.

use std::path::Path;

use crate::error::NativeError;

/// One rendered `iiif-dir` tile set: `(relative path, bytes)` pairs in
/// sorted relative-path order for a deterministic digest.
pub type IiifTiles = Vec<(String, Vec<u8>)>;

/// Output format inferred from the destination path. File formats map from
/// the destination extension; [`OutputFormat::IiifDir`] maps from an
/// extensionless path (or an existing directory) and writes many files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputFormat {
    Png,
    Jpeg,
    Tiff,
    Zif,
    Webp,
    IiifDir,
}

impl OutputFormat {
    /// Stable lowercase id used in docs, capability negotiation, and digests.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            OutputFormat::Png => "png",
            OutputFormat::Jpeg => "jpeg",
            OutputFormat::Tiff => "tiff",
            OutputFormat::Zif => "zif",
            OutputFormat::Webp => "webp",
            OutputFormat::IiifDir => "iiif-dir",
        }
    }

    /// True for directory destinations (many files); false for single files.
    #[must_use]
    pub fn is_directory(self) -> bool {
        matches!(self, OutputFormat::IiifDir)
    }

    /// Infer the output format from the destination path:
    ///
    /// * `.png` becomes PNG, `.jpg`/`.jpeg` becomes JPEG, `.tif`/`.tiff`
    ///   becomes single-image TIFF, `.webp` becomes lossless WebP;
    /// * `.zif` becomes ZIF: a TIFF-compatible multi-directory pyramid
    ///   holding the full-resolution canvas plus halved levels (see
    ///   [`crate::pipeline::encode_zif_pyramid`]). Byte-preserving
    ///   encoded-tile passthrough cannot cross the job-engine boundary
    ///   (the engine plans one level and reports decoded-tile outcomes
    ///   only), so native re-encodes the assembled canvas at every
    ///   pyramid resolution instead of renaming a single image;
    /// * `.iiif` becomes `iiif-dir` (a directory written at the `.iiif`
    ///   path, mirroring the reference trigger) alongside the native
    ///   extensionless-or-existing-directory `iiif-dir` trigger;
    /// * an extensionless path, or a path that already exists as a
    ///   directory, becomes `iiif-dir`;
    /// * any other extension is a typed error (no output is attempted).
    ///   The reference generic canvas would write whatever `image` infers
    ///   from the extension; native stays fail-closed for the rest because
    ///   only the PNG/JPEG/TIFF/ZIF/WebP codecs are compiled in and the
    ///   capability manifest promises exactly those encoders.
    ///
    /// Track C consumes this rule for the `--tile-cache`-sibling CLI surface:
    /// the output file name alone selects the encoder.
    pub fn infer_from_path(path: &Path) -> Result<Self, NativeError> {
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
            other => Err(NativeError::unsupported_extension(format!(
                "unsupported output extension .{other}; use .png, .jpg, .jpeg, .tif, .tiff, .zif, .webp, .iiif, or an extensionless directory path for iiif-dir"
            ))),
        }
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
) -> Result<(), NativeError> {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            return Err(NativeError::destination_denied("path traversal rejected"));
        }
    }
    match format {
        OutputFormat::Png => {
            if path.is_dir() {
                return Err(NativeError::destination_denied(
                    "destination is a directory, not a png file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("png") {
                return Err(NativeError::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Jpeg => {
            if path.is_dir() {
                return Err(NativeError::destination_denied(
                    "destination is a directory, not a jpeg file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !(ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg")) {
                return Err(NativeError::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Tiff => {
            if path.is_dir() {
                return Err(NativeError::destination_denied(
                    "destination is a directory, not a tiff file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !(ext.eq_ignore_ascii_case("tif") || ext.eq_ignore_ascii_case("tiff")) {
                return Err(NativeError::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Zif => {
            if path.is_dir() {
                return Err(NativeError::destination_denied(
                    "destination is a directory, not a zif file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("zif") {
                return Err(NativeError::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::Webp => {
            if path.is_dir() {
                return Err(NativeError::destination_denied(
                    "destination is a directory, not a webp file",
                ));
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("webp") {
                return Err(NativeError::destination_denied(
                    "extension does not match format",
                ));
            }
        }
        OutputFormat::IiifDir => {
            if path.is_file() && !overwrite {
                return Err(NativeError::destination_denied(
                    "destination is a file, not a directory",
                ));
            }
            if is_single_file_extension(path) && !path.is_dir() {
                return Err(NativeError::destination_denied(
                    "extension does not match format",
                ));
            }
            if path.is_dir() && !overwrite {
                let non_empty = std::fs::read_dir(path)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(false);
                if non_empty {
                    return Err(NativeError::output_exists());
                }
            }
        }
    }
    if !format.is_directory() && path.exists() && !overwrite {
        return Err(NativeError::output_exists());
    }
    Ok(())
}

/// Sibling path for a kept partial output: inserts `.partial` before the
/// last extension when one exists (`out.png` becomes `out.partial.png`,
/// `tiles.iiif` becomes `tiles.partial.iiif`), else appends `.partial`
/// (`out` becomes `out.partial` for extensionless `iiif-dir` destinations).
/// A kept partial stays distinguishable from complete success on disk, not
/// just via the `partial: true` outcome flag; `--no-partial` writes nothing.
#[must_use]
pub fn partial_path_for(path: &Path, _format: OutputFormat) -> std::path::PathBuf {
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

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), NativeError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
        }
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)
        .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    Ok(())
}

/// Write one `iiif-dir` destination: `info.json` plus JPEG tiles at
/// `<scale>/<col>_<row>.jpg`, each file committed via temp-write plus
/// rename. `tiles` must arrive in sorted relative-path order; `info.json`
/// is written last so a half-written directory never carries a manifest.
/// Returns the digest preimage (`info.json` bytes followed by tile bytes in
/// the given order) for the caller to hash.
pub fn write_iiif_dir(
    dir: &Path,
    info_json: &[u8],
    tiles: &IiifTiles,
) -> Result<Vec<u8>, NativeError> {
    // Validation granted overwrite before this runs: a stale file at the
    // directory path (e.g. from a previous `.iiif` file output) is replaced,
    // mirroring the reference encoder removing the destination file first.
    if dir.is_file() {
        std::fs::remove_file(dir)
            .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    let mut preimage = Vec::with_capacity(info_json.len());
    preimage.extend_from_slice(info_json);
    for (relative, bytes) in tiles {
        if relative.contains("..") || relative.contains('\\') || Path::new(relative).is_absolute() {
            return Err(NativeError::destination_denied(
                "tile path escapes the destination",
            ));
        }
        let dest = dir.join(relative);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
        }
        let tmp = dest.with_extension("tmp");
        std::fs::write(&tmp, bytes)
            .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
        std::fs::rename(&tmp, &dest)
            .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
        preimage.extend_from_slice(bytes);
    }
    let manifest = dir.join("info.json");
    let tmp = manifest.with_extension("tmp");
    std::fs::write(&tmp, info_json)
        .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    std::fs::rename(&tmp, &manifest)
        .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    Ok(preimage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_path_inserts_partial_before_the_extension() {
        assert_eq!(
            partial_path_for(Path::new("out.png"), OutputFormat::Png),
            std::path::PathBuf::from("out.partial.png"),
        );
        assert_eq!(
            partial_path_for(Path::new("/tmp/a/out.jpg"), OutputFormat::Jpeg),
            std::path::PathBuf::from("/tmp/a/out.partial.jpg"),
        );
        assert_eq!(
            partial_path_for(Path::new("tiles.iiif"), OutputFormat::IiifDir),
            std::path::PathBuf::from("tiles.partial.iiif"),
        );
        assert_eq!(
            partial_path_for(Path::new("out"), OutputFormat::IiifDir),
            std::path::PathBuf::from("out.partial"),
        );
        // The partial sibling keeps its own encoder extension, so the output
        // file name still selects the encoder on a later inspection.
        assert_eq!(
            OutputFormat::infer_from_path(&partial_path_for(
                Path::new("out.png"),
                OutputFormat::Png
            ))
            .expect("partial png still infers"),
            OutputFormat::Png,
        );
    }
}
