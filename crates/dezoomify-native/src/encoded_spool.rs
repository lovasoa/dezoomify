//! Disk-backed encoded probes awaiting output preflight. Handles retain only
//! placement metadata and share one invocation-owned temporary file.
use crate::{encoded_tile::EncodedTile, output::write_failed, tile_budget::memory_check};
use dezoomify::model::{Error, ResourceRequest};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
};

pub(crate) struct EncodedSpool(Mutex<File>);

pub(crate) struct StoredEncoded {
    tile: EncodedTile,
    spool: Arc<EncodedSpool>,
    offset: u64,
    length: usize,
}

impl EncodedSpool {
    pub(crate) fn new(directory: &Path) -> Result<Arc<Self>, Error> {
        std::fs::create_dir_all(directory)
            .map_err(|e| write_failed("probe directory creation failed", &e))?;
        let file = tempfile::tempfile_in(directory)
            .map_err(|e| write_failed("probe spool creation failed", &e))?;
        Ok(Arc::new(Self(Mutex::new(file))))
    }

    /// Run on a blocking worker. The returned handle releases the encoded body;
    /// the spool disappears after the last handle and owner have been released.
    pub(crate) fn store(self: &Arc<Self>, mut tile: EncodedTile) -> Result<StoredEncoded, Error> {
        let mut file = self
            .0
            .lock()
            .map_err(|_| Error::Internal("probe spool poisoned".into()))?;
        let offset = file
            .seek(SeekFrom::End(0))
            .map_err(|e| write_failed("probe spool seek failed", &e))?;
        file.write_all(&tile.bytes)
            .map_err(|e| write_failed("probe spool write failed", &e))?;
        let length = tile.bytes.len();
        tile.bytes = Vec::new();
        Ok(StoredEncoded {
            tile,
            spool: Arc::clone(self),
            offset,
            length,
        })
    }
}

impl StoredEncoded {
    pub(crate) fn retained_bytes(&self) -> u64 {
        std::mem::size_of::<Self>() as u64
            + self.tile.request.as_ref().map_or(0, |request| {
                request.uri.len() as u64
                    + request
                        .headers
                        .iter()
                        .map(|header| (header.name.len() + header.value.len()) as u64 + 64)
                        .sum::<u64>()
            })
    }
    pub(crate) fn request(&self) -> Option<&ResourceRequest> {
        self.tile.request.as_ref()
    }

    /// Load only this body on a blocking worker; the caller accounts for the
    /// other retained probe handles and the writer's own memory separately.
    pub(crate) fn load(mut self, budget: u64) -> Result<EncodedTile, Error> {
        memory_check(self.length as u64, budget)?;
        self.tile
            .bytes
            .try_reserve_exact(self.length)
            .map_err(|_| Error::ResourceLimit("probe payload allocation failed".into()))?;
        self.tile.bytes.resize(self.length, 0);
        let mut file = self
            .spool
            .0
            .lock()
            .map_err(|_| Error::Internal("probe spool poisoned".into()))?;
        file.seek(SeekFrom::Start(self.offset))
            .and_then(|_| file.read_exact(&mut self.tile.bytes))
            .map_err(|e| write_failed("probe spool read failed", &e))?;
        Ok(self.tile)
    }
}
