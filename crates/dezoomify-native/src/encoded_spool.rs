//! Disk-backed encoded probes awaiting output preflight. Handles retain only
//! placement metadata and share one invocation-owned temporary file.
use crate::{blob_store::BlobStore, encoded_tile::EncodedTile};
use dezoomify::model::{Error, ResourceRequest};
use std::{path::Path, sync::Arc};

pub(crate) struct EncodedSpool {
    blobs: Arc<BlobStore>,
}

pub(crate) struct StoredEncoded {
    tile: EncodedTile,
    spool: Arc<BlobStore>,
    location: (u64, usize),
}

impl EncodedSpool {
    pub(crate) fn new(directory: &Path) -> Result<Arc<Self>, Error> {
        Ok(Arc::new(Self {
            blobs: BlobStore::new(directory)?,
        }))
    }

    /// Run on a blocking worker. The returned handle releases the encoded body;
    /// the spool disappears after the last handle and owner have been released.
    pub(crate) fn store(self: &Arc<Self>, mut tile: EncodedTile) -> Result<StoredEncoded, Error> {
        let location = self.blobs.append(&tile.bytes)?;
        tile.bytes = Vec::new();
        Ok(StoredEncoded {
            tile,
            spool: Arc::clone(&self.blobs),
            location,
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
        self.tile.bytes = self.spool.read(self.location, budget)?;
        Ok(self.tile)
    }
}
