//! Private disk-backed pixel storage. Files live beside the destination, not in
//! a potentially RAM-backed system temporary directory, and close on settlement.
use crate::imaging::DecodedTile;
use dezoomify::model::{Error, Size};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
};

pub(crate) type StoredBytes = Option<(u64, usize)>;

pub(crate) struct PixelFile(File);

impl PixelFile {
    pub(crate) fn new(directory: &Path, length: u64) -> Result<Self, Error> {
        std::fs::create_dir_all(directory).map_err(storage_error)?;
        let file = tempfile::tempfile_in(directory).map_err(storage_error)?;
        file.set_len(length).map_err(storage_error)?;
        Ok(Self(file))
    }

    pub(crate) fn read(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, Error> {
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(storage_error)?;
        bytes.resize(length, 0);
        self.0
            .seek(SeekFrom::Start(offset))
            .map_err(storage_error)?;
        self.0.read_exact(&mut bytes).map_err(storage_error)?;
        Ok(bytes)
    }

    pub(crate) fn write(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Error> {
        self.0
            .seek(SeekFrom::Start(offset))
            .map_err(storage_error)?;
        self.0.write_all(bytes).map_err(storage_error)
    }

    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<(u64, usize), Error> {
        let offset = self.0.seek(SeekFrom::End(0)).map_err(storage_error)?;
        self.0.write_all(bytes).map_err(storage_error)?;
        Ok((offset, bytes.len()))
    }

    pub(crate) fn read_optional(
        &mut self,
        location: StoredBytes,
    ) -> Result<Option<Vec<u8>>, Error> {
        location
            .map(|(offset, length)| self.read(offset, length))
            .transpose()
    }

    pub(crate) fn append_optional(&mut self, bytes: Option<&[u8]>) -> Result<StoredBytes, Error> {
        bytes.map(|bytes| self.append(bytes)).transpose()
    }

    /// Reclaim consumed staging blocks where supported. Failure only retains
    /// disk space until cleanup; it must not affect the already-read pixels.
    pub(crate) fn discard(&self, offset: u64, length: u64) {
        #[cfg(target_os = "linux")]
        let _ = rustix::fs::fallocate(
            &self.0,
            rustix::fs::FallocateFlags::PUNCH_HOLE | rustix::fs::FallocateFlags::KEEP_SIZE,
            offset,
            length,
        );
        #[cfg(not(target_os = "linux"))]
        let _ = (offset, length);
    }
}

/// One invocation-owned append-only spool for tiles whose output geometry or
/// format is not yet known. Shares one file regardless of the tile count.
pub(crate) struct TileSpool(Mutex<PixelFile>);

impl TileSpool {
    pub(crate) fn new(directory: &Path) -> Result<Arc<Self>, Error> {
        Ok(Arc::new(Self(Mutex::new(PixelFile::new(directory, 0)?))))
    }

    pub(crate) fn store(self: &Arc<Self>, decoded: DecodedTile) -> Result<StoredPixels, Error> {
        let mut file = self.0.lock().expect("tile spool lock");
        let pixels = file.append(decoded.image.as_raw())?;
        let icc = file.append_optional(decoded.icc_profile.as_deref())?;
        let exif = file.append_optional(decoded.exif_metadata.as_deref())?;
        Ok(StoredPixels {
            spool: Arc::clone(self),
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

/// Restoring consumes the handle; callers place one restored tile at a time.
/// Pixels and metadata remain on disk until read, and never require another decode.
pub(crate) struct StoredPixels {
    spool: Arc<TileSpool>,
    pixels: (u64, usize),
    pub(crate) size: Size,
    pub(crate) transparent: bool,
    icc: StoredBytes,
    exif: StoredBytes,
}

impl StoredPixels {
    pub(crate) fn read(self) -> Result<DecodedTile, Error> {
        let mut file = self.spool.0.lock().expect("tile spool lock");
        let bytes = file.read(self.pixels.0, self.pixels.1)?;
        file.discard(self.pixels.0, self.pixels.1 as u64);
        let image = image::RgbaImage::from_raw(self.size.width, self.size.height, bytes)
            .ok_or_else(|| Error::InvalidState("incomplete stored tile".into()))?;
        let icc_profile = file.read_optional(self.icc)?;
        let exif_metadata = file.read_optional(self.exif)?;
        Ok(DecodedTile {
            image,
            icc_profile,
            exif_metadata,
        })
    }
}

pub(crate) fn storage_error(error: impl std::fmt::Display) -> Error {
    Error::WriteFailed(format!("pixel staging: {error}").into())
}
