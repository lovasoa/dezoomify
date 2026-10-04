//! Output writer: atomic file replacement, format/extension validation,
//! overwrite refusal unless explicitly requested.
//! Single-file formats (PNG, JPEG, TIFF, WebP) encode to one file; `zif`
//! encodes one multi-directory TIFF pyramid file; `iiif-dir`
//! writes a static tiled directory holding an `info.json` beside JPEG tiles.

use std::io::{Seek, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use dezoomify::model::{Error, Failure, LimitContext, OutputFormat};

/// One rendered `iiif-dir` tile set: `(relative path, bytes)` pairs in
/// sorted relative-path order.
pub type IiifTiles = Vec<(String, Vec<u8>)>;

/// An exclusively created, invocation-owned file. Drop removes unpublished
/// output, including when an encoder or publication fails.
pub(crate) struct StagedFile {
    path: std::path::PathBuf,
    file: Option<std::fs::File>,
    io_error: Option<Error>,
}

impl StagedFile {
    pub(crate) fn new(destination: &Path) -> Result<Self, Error> {
        if let Some(parent) = destination.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| write_failed("output directory creation failed", &e))?;
        }
        let path = crate::sink::temp_sibling(destination);
        let file = std::fs::File::create_new(&path)
            .map_err(|e| write_failed("staging file creation failed", &e))?;
        Ok(Self {
            path,
            file: Some(file),
            io_error: None,
        })
    }

    pub(crate) fn writer<'a>(&'a mut self, cancelled: &'a AtomicBool) -> GuardedFile<'a> {
        GuardedFile {
            file: self.file.as_mut().expect("unpublished staging file"),
            cancelled,
            io_error: &mut self.io_error,
        }
    }

    pub(crate) fn check_error(&self) -> Result<(), Error> {
        self.io_error.clone().map_or(Ok(()), Err)
    }

    pub(crate) fn publish(
        mut self,
        destination: &Path,
        overwrite: bool,
        cancelled: &AtomicBool,
    ) -> Result<u64, Error> {
        self.check_error()?;
        let file = self.file.take().expect("unpublished staging file");
        file.sync_all()
            .map_err(|e| write_failed("output sync failed", &e))?;
        let bytes = file
            .metadata()
            .map_err(|e| write_failed("output stat failed", &e))?
            .len();
        drop(file);
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        if overwrite {
            std::fs::rename(&self.path, destination)
                .map_err(|e| write_failed("output publication failed", &e))?;
        } else {
            // Uses no-replace rename on Linux/macOS and MoveFileEx without
            // replacement on Windows; ordinary removable drives need no links.
            tempfile::TempPath::try_from_path(self.path.clone())
                .map_err(|e| write_failed("staging path failed", &e))?
                .persist_noclobber(destination)
                .map_err(|e| {
                    if e.error.kind() == std::io::ErrorKind::AlreadyExists {
                        Error::OutputExists
                    } else {
                        write_failed("output publication failed", &e.error)
                    }
                })?;
        }
        Ok(bytes)
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Standard Write/Seek adapter shared by the concrete native encoders.
pub(crate) struct GuardedFile<'a, W = std::fs::File> {
    file: &'a mut W,
    cancelled: &'a AtomicBool,
    io_error: &'a mut Option<Error>,
}

impl<W> GuardedFile<'_, W> {
    fn check(&self) -> std::io::Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            // write_all retries Interrupted, so use a terminal error kind.
            Err(std::io::Error::other("output cancelled"))
        } else {
            Ok(())
        }
    }

    fn record<T>(&mut self, result: std::io::Result<T>, step: &str) -> std::io::Result<T> {
        if let Err(error) = &result {
            if error.kind() != std::io::ErrorKind::Interrupted && self.io_error.is_none() {
                *self.io_error = Some(write_failed(step, error));
            }
        }
        result
    }
}

impl<W: Write> Write for GuardedFile<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.check()?;
        let result = self.file.write(bytes).and_then(|count| {
            if count == 0 && !bytes.is_empty() {
                Err(std::io::ErrorKind::WriteZero.into())
            } else {
                Ok(count)
            }
        });
        self.record(result, "output write failed")
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.check()?;
        let result = self.file.flush();
        self.record(result, "output flush failed")
    }
}

impl<W: Seek> Seek for GuardedFile<'_, W> {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.check()?;
        let result = self.file.seek(position);
        self.record(result, "output seek failed")
    }
}

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
    fn writer_preserves_io_errors_wrapped_by_codecs() {
        struct BrokenIo;
        impl Write for BrokenIo {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("injected disk full"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::other("injected flush failure"))
            }
        }
        impl Seek for BrokenIo {
            fn seek(&mut self, _: std::io::SeekFrom) -> std::io::Result<u64> {
                Err(std::io::Error::other("injected seek failure"))
            }
        }
        for step in ["write", "seek", "flush"] {
            let directory = crate::sink::temp_sibling(&std::env::temp_dir().join("io-test"));
            std::fs::create_dir(&directory).unwrap();
            let destination = directory.join("output.png");
            let mut staged = StagedFile::new(&destination).unwrap();
            let cancelled = AtomicBool::new(false);
            let mut writer = GuardedFile {
                file: &mut BrokenIo,
                cancelled: &cancelled,
                io_error: &mut staged.io_error,
            };
            match step {
                "write" => assert!(matches!(
                    crate::imaging::encode_png_to(
                        &mut writer,
                        &image::RgbaImage::new(1, 1),
                        image::codecs::png::CompressionType::Fast,
                        None,
                        None,
                    ),
                    Err(Error::EncodeFailed(_))
                )),
                "seek" => assert!(writer.seek(std::io::SeekFrom::Start(0)).is_err()),
                _ => assert!(writer.flush().is_err()),
            }
            assert!(
                matches!(staged.check_error(), Err(Error::WriteFailed(detail)) if detail.detail.as_deref().unwrap().contains(step))
            );
            assert!(matches!(
                staged.publish(&destination, false, &cancelled),
                Err(Error::WriteFailed(_))
            ));
            assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
            std::fs::remove_dir(directory).unwrap();
        }
    }

    #[test]
    fn staged_file_cancellation_and_late_collision_preserve_destination() {
        let directory = crate::sink::temp_sibling(&std::env::temp_dir().join("staging-test"));
        std::fs::create_dir(&directory).unwrap();
        let destination = directory.join("output.png");
        let cancelled = AtomicBool::new(false);
        {
            let mut staged = StagedFile::new(&destination).unwrap();
            staged.writer(&cancelled).write_all(b"unpublished").unwrap();
            cancelled.store(true, Ordering::SeqCst);
            assert!(staged.writer(&cancelled).write_all(b"more").is_err());
            assert!(matches!(
                staged.publish(&destination, true, &cancelled),
                Err(Error::Cancelled)
            ));
        }
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        cancelled.store(false, Ordering::SeqCst);
        let mut staged = StagedFile::new(&destination).unwrap();
        staged.writer(&cancelled).write_all(b"replacement").unwrap();
        std::fs::write(&destination, b"created during encoding").unwrap();
        assert!(matches!(
            staged.publish(&destination, false, &cancelled),
            Err(Error::OutputExists)
        ));
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"created during encoding"
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_file(&destination).unwrap();
        let mut staged = StagedFile::new(&destination).unwrap();
        staged.writer(&cancelled).write_all(b"published").unwrap();
        assert_eq!(staged.publish(&destination, false, &cancelled).unwrap(), 9);
        assert_eq!(std::fs::read(&destination).unwrap(), b"published");
        std::fs::remove_dir_all(directory).unwrap();
    }

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
