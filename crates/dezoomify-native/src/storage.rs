//! Seekable temporary storage. RAM is optional; growth or reservation failure
//! spills to disk without changing offsets or the current cursor.
use std::{
    fs::File,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

trait Storage: Read + Write + Seek + Send {
    fn len(&self) -> u64;
    /// Establish the writable extent before writes. Added bytes must read as zero.
    fn set_len(&mut self, length: u64) -> io::Result<()>;
    /// Optionally reclaim a byte range the caller will never read again.
    /// Reclamation must preserve the store's length, offsets, and cursor.
    fn discard(&self, offset: u64, length: u64);
}

struct MemoryStorage(Cursor<Vec<u8>>);

impl Read for MemoryStorage {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}
impl Write for MemoryStorage {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Seek for MemoryStorage {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.0.seek(position)
    }
}
impl Storage for MemoryStorage {
    fn len(&self) -> u64 {
        self.0.get_ref().len() as u64
    }
    fn set_len(&mut self, length: u64) -> io::Result<()> {
        let length = usize::try_from(length).map_err(io::Error::other)?;
        let bytes = self.0.get_mut();
        bytes
            .try_reserve(length.saturating_sub(bytes.len()))
            .map_err(io::Error::other)?;
        bytes.resize(length, 0);
        Ok(())
    }
    /// A contiguous RAM allocation cannot release an interior range. Its capacity
    /// remains allocated until the store is dropped or spills to disk.
    fn discard(&self, _: u64, _: u64) {}
}

struct DiskStorage {
    file: File,
    length: u64,
}

impl Read for DiskStorage {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.file.read(bytes)
    }
}
impl Write for DiskStorage {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.file.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
impl Seek for DiskStorage {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}
impl Storage for DiskStorage {
    fn len(&self) -> u64 {
        self.length
    }
    fn set_len(&mut self, length: u64) -> io::Result<()> {
        self.file.set_len(length)?;
        self.length = length;
        Ok(())
    }
    /// Reclaim consumed temporary-file blocks through Linux hole punching.
    /// This releases disk space without shifting the remaining data. Other
    /// platforms leave the file unchanged. Filesystem errors are ignored:
    /// failed reclamation must not fail a download whose data was already read.
    fn discard(&self, offset: u64, length: u64) {
        #[cfg(target_os = "linux")]
        let _ = rustix::fs::fallocate(
            &self.file,
            rustix::fs::FallocateFlags::PUNCH_HOLE | rustix::fs::FallocateFlags::KEEP_SIZE,
            offset,
            length,
        );
        #[cfg(not(target_os = "linux"))]
        let _ = (offset, length);
    }
}

/// Composition's RAM-to-disk threshold in bytes: the larger of 80% of available
/// memory and available memory minus 2 GiB. This does not limit job memory.
/// A failed memory probe selects disk for any nonempty composition.
pub(crate) fn memory_storage_limit(available: u64) -> u64 {
    let eighty_percent = available - available.div_ceil(5);
    eighty_percent.max(available.saturating_sub(2 << 30))
}

/// Seekable temporary bytes for image composition.
/// Once a store spills to disk, it remains there until dropped.
pub(crate) struct TemporaryStorage {
    storage: Box<dyn Storage>,
    directory: PathBuf,
    memory_limit: Option<u64>,
}

impl TemporaryStorage {
    /// Create `length` zero-filled bytes. `limit` is the maximum logical length
    /// kept in RAM, not an allocation limit: exceeding it or failing a RAM
    /// reservation selects disk. The directory is used only when disk is needed.
    pub(crate) fn with_memory_limit(directory: &Path, length: u64, limit: u64) -> io::Result<Self> {
        let mut result = Self {
            storage: Box::new(MemoryStorage(Cursor::new(Vec::new()))),
            directory: directory.to_path_buf(),
            memory_limit: Some(limit),
        };
        result.grow(length)?;
        Ok(result)
    }

    /// Extend with zeros while preserving existing offsets and the cursor.
    /// A spill replaces RAM only after copying successfully; failed spills leave
    /// the RAM contents and cursor intact so the caller retains its data.
    fn grow(&mut self, length: u64) -> io::Result<()> {
        if length <= self.storage.len() {
            return Ok(());
        }
        if let Some(limit) = self.memory_limit {
            if length <= limit && self.storage.set_len(length).is_ok() {
                return Ok(());
            }
            std::fs::create_dir_all(&self.directory)?;
            let mut disk = DiskStorage {
                file: tempfile::tempfile_in(&self.directory)?,
                length: 0,
            };
            disk.set_len(length)?;
            let position = self.storage.stream_position()?;
            self.storage.rewind()?;
            let copied = io::copy(&mut self.storage, &mut disk);
            self.storage.seek(SeekFrom::Start(position))?;
            copied?;
            disk.seek(SeekFrom::Start(position))?;
            self.storage = Box::new(disk);
            self.memory_limit = None;
            return Ok(());
        }
        self.storage.set_len(length)
    }

    /// Give up a byte range after its data has been copied into an owned buffer.
    /// The range must never be read again. File length, offsets, and cursor stay
    /// unchanged. Reclamation is best effort on Linux and does nothing for RAM
    /// or on other platforms; failure only delays releasing temporary disk space.
    pub(crate) fn discard(&self, offset: u64, length: u64) {
        self.storage.discard(offset, length);
    }
}

impl Read for TemporaryStorage {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.storage.read(bytes)
    }
}
impl Write for TemporaryStorage {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let end = self
            .storage
            .stream_position()?
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("temporary storage length overflow"))?;
        self.grow(end)?;
        self.storage.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.storage.flush()
    }
}
impl Seek for TemporaryStorage {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.storage.seek(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composition_memory_threshold_keeps_the_smaller_reserve() {
        for (available, expected) in [
            (0, 0),
            (100, 80),
            (1 << 30, (1 << 30) * 4 / 5),
            (2 << 30, (2 << 30) * 4 / 5),
            (10 << 30, 8 << 30),
            (16 << 30, 14 << 30),
            (u64::MAX, u64::MAX - (2 << 30)),
        ] {
            assert_eq!(memory_storage_limit(available), expected);
        }
    }

    #[test]
    fn ram_needs_no_scratch_directory() {
        let directory = tempfile::tempdir().unwrap();
        let scratch = directory.path().join("unused");
        let mut storage = TemporaryStorage::with_memory_limit(&scratch, 8, 32).unwrap();
        storage.seek(SeekFrom::Start(3)).unwrap();
        storage.write_all(b"abc").unwrap();
        storage.rewind().unwrap();
        let mut bytes = Vec::new();
        storage.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"\0\0\0abc\0\0");
        assert!(!scratch.exists());
    }

    #[test]
    fn spilling_preserves_sparse_pixels_cursor_and_growth() {
        for limit in [0, 8, 128] {
            let directory = tempfile::tempdir().unwrap();
            let mut storage =
                TemporaryStorage::with_memory_limit(directory.path(), 8, limit).unwrap();
            storage.seek(SeekFrom::Start(2)).unwrap();
            storage.write_all(b"abc").unwrap();
            storage.seek(SeekFrom::Start(12)).unwrap();
            storage.write_all(b"pixels").unwrap();
            assert_eq!(storage.seek(SeekFrom::End(0)).unwrap(), 18);
            storage.write_all(b"more pixels").unwrap();
            storage.seek(SeekFrom::Start(4)).unwrap();
            storage.write_all(b"X").unwrap();
            storage.rewind().unwrap();
            let mut bytes = Vec::new();
            storage.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"\0\0abX\0\0\0\0\0\0\0pixelsmore pixels");
            drop(storage);
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn failed_spill_preserves_ram_contents_and_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("file");
        std::fs::write(&blocked, b"occupied").unwrap();
        let mut storage = TemporaryStorage::with_memory_limit(&blocked, 4, 4).unwrap();
        storage.write_all(b"keep").unwrap();
        assert!(storage.write_all(b"more").is_err());
        assert_eq!(storage.stream_position().unwrap(), 4);
        storage.rewind().unwrap();
        let mut bytes = Vec::new();
        storage.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"keep");
        assert_eq!(std::fs::read(blocked).unwrap(), b"occupied");
    }
}
