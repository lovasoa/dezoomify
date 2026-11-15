//! Invocation-owned adaptive storage for transient payloads. Appends and
//! reads share one RAM buffer or temporary file under internal locking. Consumed ranges
//! can be punched out where the filesystem supports hole punching.
use dezoomify::model::Error;
use std::{
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

pub(crate) type MetadataLocation = Option<(u64, usize)>;

/// Store metadata in a seekable stream at the current end.
pub(crate) fn store_metadata(
    file: &mut (impl Write + Seek),
    bytes: Option<&[u8]>,
) -> io::Result<MetadataLocation> {
    bytes
        .map(|bytes| {
            let offset = file.seek(SeekFrom::End(0))?;
            file.write_all(bytes)?;
            Ok((offset, bytes.len()))
        })
        .transpose()
}

/// Read stored metadata from a seekable stream.
pub(crate) fn read_metadata(
    file: &mut (impl Read + Seek),
    location: MetadataLocation,
) -> io::Result<Option<Vec<u8>>> {
    location
        .map(|(offset, length)| {
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(length).map_err(io::Error::other)?;
            bytes.resize(length, 0);
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut bytes)?;
            Ok(bytes)
        })
        .transpose()
}

pub(crate) fn storage_error(error: impl std::fmt::Display) -> Error {
    Error::WriteFailed(format!("temporary storage: {error}").into())
}

/// Synchronizes append, read, and discard on one adaptive store.
pub(crate) struct BlobStore {
    file: Mutex<crate::storage::TemporaryStorage>,
}

impl BlobStore {
    pub(crate) fn new(directory: &Path) -> Result<Arc<Self>, Error> {
        let file = crate::storage::TemporaryStorage::new(directory, 0).map_err(storage_error)?;
        Ok(Arc::new(Self {
            file: Mutex::new(file),
        }))
    }

    fn lock(&self) -> Result<MutexGuard<'_, crate::storage::TemporaryStorage>, Error> {
        self.file
            .lock()
            .map_err(|_| Error::Internal("blob store lock poisoned".into()))
    }

    /// Append on a blocking worker. The returned range belongs to this store.
    pub(crate) fn append(&self, bytes: &[u8]) -> Result<(u64, usize), Error> {
        let mut file = self.lock()?;
        let offset = file.seek(SeekFrom::End(0)).map_err(storage_error)?;
        file.write_all(bytes).map_err(storage_error)?;
        Ok((offset, bytes.len()))
    }

    /// Restore a range on a blocking worker, then reclaim its disk space.
    /// Each range may be read only once.
    pub(crate) fn read(&self, (offset, length): (u64, usize)) -> Result<Vec<u8>, Error> {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length)
            .map_err(|_| Error::ResourceLimit("spool payload allocation failed".into()))?;
        bytes.resize(length, 0);
        let mut file = self.lock()?;
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(storage_error)?;
        file.discard(offset, length as u64);
        Ok(bytes)
    }
}
