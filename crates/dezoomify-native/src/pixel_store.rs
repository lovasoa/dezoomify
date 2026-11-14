//! Invocation-owned tile spooling. Raw pixels and metadata share a private file
//! beside the destination; stored tiles retain its ownership until restored.
pub(crate) use crate::blob_store::{
    discard, read_metadata, storage_error, store_metadata, MetadataLocation,
};
use crate::{blob_store::BlobStore, imaging::DecodedTile};
use dezoomify::model::{Error, Size};
use std::{path::Path, sync::Arc};

/// One append-only spool for tiles whose output geometry or format is not yet
/// known. Shares one file regardless of tile count; call store on a blocking worker.
pub(crate) struct TileSpool {
    blobs: Arc<BlobStore>,
}

impl TileSpool {
    pub(crate) fn new(directory: &Path) -> Result<Arc<Self>, Error> {
        Ok(Arc::new(Self {
            blobs: BlobStore::new(directory)?,
        }))
    }

    pub(crate) fn store(self: &Arc<Self>, decoded: DecodedTile) -> Result<StoredPixels, Error> {
        let pixels = self.blobs.append(decoded.image.as_raw())?;
        let icc = decoded
            .icc_profile
            .as_deref()
            .map(|bytes| self.blobs.append(bytes))
            .transpose()?;
        let exif = decoded
            .exif_metadata
            .as_deref()
            .map(|bytes| self.blobs.append(bytes))
            .transpose()?;
        Ok(StoredPixels {
            spool: Arc::clone(&self.blobs),
            pixels,
            size: Size {
                width: decoded.image.width(),
                height: decoded.image.height(),
            },
            transparent: decoded.image.pixels().any(|p| p[3] != 255),
            icc,
            exif,
        })
    }
}

/// Reading consumes the handle and restores one tile without decoding again.
/// Its spool remains alive until every stored tile and worker has released it.
pub(crate) struct StoredPixels {
    spool: Arc<BlobStore>,
    pixels: (u64, usize),
    pub(crate) size: Size,
    pub(crate) transparent: bool,
    icc: MetadataLocation,
    exif: MetadataLocation,
}

impl StoredPixels {
    pub(crate) fn read(self) -> Result<DecodedTile, Error> {
        let bytes = self.spool.read(self.pixels, u64::MAX)?;
        let icc_profile = self
            .icc
            .map(|location| self.spool.read(location, u64::MAX))
            .transpose()?;
        let exif_metadata = self
            .exif
            .map(|location| self.spool.read(location, u64::MAX))
            .transpose()?;
        let image = image::RgbaImage::from_raw(self.size.width, self.size.height, bytes)
            .ok_or_else(|| Error::InvalidState("incomplete stored tile".into()))?;
        Ok(DecodedTile {
            image,
            icc_profile,
            exif_metadata,
        })
    }
}
