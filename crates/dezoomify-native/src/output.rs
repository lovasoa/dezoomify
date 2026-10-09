//! Output writer: atomic file replacement, format/extension validation,
//! overwrite refusal unless explicitly requested.
//! Single-file formats (PNG, JPEG, TIFF, WebP) encode to one file; `zif`
//! encodes one multi-directory TIFF pyramid file; `iiif-dir`
//! writes a static tiled directory holding an `info.json` beside JPEG tiles.

use std::io::{Read, Seek, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use dezoomify::model::{Error, Failure, OutputFormat, Size};

pub(crate) fn temp_sibling(destination: &Path) -> std::path::PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = destination
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    destination.with_file_name(format!(
        "{name}.tmp.{}-{time}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

/// All routes end here, including a future encoded JPEG join. Preparation
/// owns staging; publication can choose another name without re-encoding.
pub(crate) struct PreparedOutput {
    pub(crate) staging: StagedOutput,
    pub(crate) size: Size,
    pub(crate) pixel_decodes: u64,
    pub(crate) late_writes: u64,
}
pub(crate) enum StagedOutput {
    File(StagedFile),
    Directory(StagedDirectory),
}
impl PreparedOutput {
    pub(crate) fn publish(
        &mut self,
        destination: &Path,
        overwrite: bool,
        cancelled: &AtomicBool,
    ) -> Result<u64, Error> {
        match &mut self.staging {
            StagedOutput::File(file) => file.publish(destination, overwrite, cancelled),
            StagedOutput::Directory(directory) => {
                // Relative service IDs remain valid across automatic renaming.
                let bytes = directory_bytes(&directory.path, cancelled)?;
                directory.publish(destination, cancelled)?;
                Ok(bytes)
            }
        }
    }
}
pub(crate) fn directory_bytes(path: &Path, cancelled: &AtomicBool) -> Result<u64, Error> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(Error::Cancelled);
    }
    let mut bytes = 0;
    for entry in
        std::fs::read_dir(path).map_err(|e| write_failed("output directory stat failed", &e))?
    {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let entry = entry.map_err(|e| write_failed("output entry stat failed", &e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| write_failed("output stat failed", &e))?;
        bytes += if metadata.is_dir() {
            directory_bytes(&entry.path(), cancelled)?
        } else {
            metadata.len()
        };
    }
    Ok(bytes)
}

/// An exclusively created, invocation-owned file. Drop removes unpublished
/// output, including when an encoder or publication fails.
pub(crate) struct StagedFile {
    path: std::path::PathBuf,
    file: Option<std::fs::File>,
    io_error: Option<Error>,
}

impl StagedFile {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn new(destination: &Path) -> Result<Self, Error> {
        if let Some(parent) = destination.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| write_failed("output directory creation failed", &e))?;
        }
        let path = temp_sibling(destination);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
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
        &mut self,
        destination: &Path,
        overwrite: bool,
        cancelled: &AtomicBool,
    ) -> Result<u64, Error> {
        self.check_error()?;
        if let Some(file) = self.file.as_ref() {
            file.sync_all()
                .map_err(|e| write_failed("output sync failed", &e))?;
        }
        let bytes = std::fs::metadata(&self.path)
            .map_err(|e| write_failed("output stat failed", &e))?
            .len();
        self.file.take();
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
                .map_err(|mut e| {
                    // StagedFile owns cleanup and may retry an automatic name.
                    e.path.disable_cleanup(true);
                    if e.error.kind() == std::io::ErrorKind::AlreadyExists {
                        Error::OutputExists
                    } else {
                        write_failed("output publication failed", &e.error)
                    }
                })?;
        }
        Ok(bytes)
    }

    /// Insert finalized header metadata after streaming the pixels. Move the
    /// already compressed payload backwards using a single bounded buffer.
    pub(crate) fn insert_header(
        &mut self,
        offset: u64,
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        if bytes.is_empty() {
            return Ok(());
        }
        let file = self.file.as_mut().expect("unpublished staging file");
        let len = file
            .metadata()
            .map_err(|e| write_failed("output stat failed", &e))?
            .len();
        let mut remaining = len.saturating_sub(offset);
        let mut buffer = vec![0; 64 << 10];
        while remaining > 0 {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            let count = remaining.min(buffer.len() as u64) as usize;
            remaining -= count as u64;
            file.seek(std::io::SeekFrom::Start(offset + remaining))
                .and_then(|_| file.read_exact(&mut buffer[..count]))
                .map_err(|e| write_failed("metadata payload read failed", &e))?;
            file.seek(std::io::SeekFrom::Start(
                offset + remaining + bytes.len() as u64,
            ))
            .and_then(|_| file.write_all(&buffer[..count]))
            .map_err(|e| write_failed("metadata payload move failed", &e))?;
        }
        file.seek(std::io::SeekFrom::Start(offset))
            .and_then(|_| file.write_all(bytes))
            .map_err(|e| write_failed("metadata header write failed", &e))
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

/// One unpublished tile tree. Only final tile payloads are stored here.
pub(crate) struct StagedDirectory {
    pub(crate) path: std::path::PathBuf,
}

impl StagedDirectory {
    pub(crate) fn new(destination: &Path) -> Result<Self, Error> {
        if destination.exists() {
            return Err(Error::OutputExists);
        }
        if let Some(parent) = destination.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| write_failed("output directory creation failed", &e))?;
        }
        let path = temp_sibling(destination);
        std::fs::create_dir(&path)
            .map_err(|e| write_failed("staging directory creation failed", &e))?;
        Ok(Self { path })
    }

    pub(crate) fn write(
        &self,
        relative: &str,
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<std::path::PathBuf, Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| write_failed("tile directory creation failed", &e))?;
        }
        let mut file =
            std::fs::File::create(&path).map_err(|e| write_failed("tile creation failed", &e))?;
        for chunk in bytes.chunks(64 << 10) {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            file.write_all(chunk)
                .map_err(|e| write_failed("tile write failed", &e))?;
        }
        file.sync_all()
            .map_err(|e| write_failed("tile sync failed", &e))?;
        Ok(path)
    }

    /// Alias one payload, falling back to identical bytes without hard links.
    pub(crate) fn alias(
        &self,
        source: &Path,
        relative: &str,
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let alias = self.path.join(relative);
        std::fs::create_dir_all(alias.parent().expect("tile parent"))
            .map_err(|e| write_failed("alias directory creation failed", &e))?;
        if std::fs::hard_link(source, alias).is_err() {
            self.write(relative, bytes, cancelled)?;
        }
        Ok(())
    }

    /// Alias a staged encoded payload without loading it into RAM.
    pub(crate) fn alias_file(
        &self,
        source: &Path,
        relative: &str,
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let alias = self.path.join(relative);
        std::fs::create_dir_all(alias.parent().expect("tile parent"))
            .map_err(|e| write_failed("alias directory creation failed", &e))?;
        if std::fs::hard_link(source, &alias).is_err() {
            let mut input = std::fs::File::open(source)
                .map_err(|e| write_failed("alias source open failed", &e))?;
            let mut file = StagedFile::new(&alias)?;
            let result = std::io::copy(&mut input, &mut file.writer(cancelled));
            file.check_error()?;
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            result.map_err(|e| write_failed("alias copy failed", &e))?;
            file.publish(&alias, false, cancelled)?;
        }
        Ok(())
    }

    pub(crate) fn publish(&self, destination: &Path, cancelled: &AtomicBool) -> Result<(), Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let result = rustix::fs::renameat_with(
            rustix::fs::CWD,
            &self.path,
            rustix::fs::CWD,
            destination,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(std::io::Error::from);
        #[cfg(target_os = "windows")]
        let result = std::fs::rename(&self.path, destination);
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let result = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "atomic directory publication is unavailable",
        ));
        result.map_err(|e| {
            if destination.exists() {
                Error::OutputExists
            } else {
                write_failed("directory publication failed", &e)
            }
        })
    }
}

impl Drop for StagedDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
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
    if format.is_directory() {
        if is_single_file_extension(path) && !path.is_dir() {
            return Err(destination_denied("extension does not match format"));
        }
        if path.exists() {
            return Err(output_exists());
        }
    } else {
        if path.is_dir() {
            return Err(destination_denied(
                "destination is a directory, not an image file",
            ));
        }
        if infer_from_path(path).ok().as_ref() != Some(format) {
            return Err(destination_denied("extension does not match format"));
        }
        if path.exists() && !overwrite {
            return Err(output_exists());
        }
    }
    Ok(())
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
            let directory = temp_sibling(&std::env::temp_dir().join("io-test"));
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
                    image::ImageEncoder::write_image(
                        image::codecs::png::PngEncoder::new(&mut writer),
                        &[0; 4],
                        1,
                        1,
                        image::ExtendedColorType::Rgba8,
                    ),
                    Err(image::ImageError::IoError(_))
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
            drop(staged);
            assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
            std::fs::remove_dir(directory).unwrap();
        }
    }

    #[test]
    fn staged_file_cancellation_and_late_collision_preserve_destination() {
        let directory = temp_sibling(&std::env::temp_dir().join("staging-test"));
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
        let next = directory.join("output-2.png");
        staged.publish(&next, false, &cancelled).unwrap();
        assert_eq!(std::fs::read(&next).unwrap(), b"replacement");
        drop(staged);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
