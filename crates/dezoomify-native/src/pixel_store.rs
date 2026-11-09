//! Invocation-owned tile spooling. Raw pixels and metadata share a private file
//! beside the destination; stored tiles retain its ownership until restored.
use crate::imaging::DecodedTile;
use dezoomify::model::{Error, Size};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
};

pub(crate) type MetadataLocation = Option<(u64, usize)>;

pub(crate) fn temporary_file(directory: &Path) -> io::Result<File> {
    std::fs::create_dir_all(directory)?;
    tempfile::tempfile_in(directory)
}

/// Metadata locations are scoped to this file; preserve the appended bytes
/// until selection has finished. These helpers use standard seekable I/O.
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

/// Reclaim consumed staging blocks where supported. Failure only retains disk
/// space until cleanup; callers must never read the discarded range again.
pub(crate) fn discard(file: &File, offset: u64, length: u64) {
    #[cfg(target_os = "linux")]
    let _ = rustix::fs::fallocate(
        file,
        rustix::fs::FallocateFlags::PUNCH_HOLE | rustix::fs::FallocateFlags::KEEP_SIZE,
        offset,
        length,
    );
    #[cfg(not(target_os = "linux"))]
    let _ = (file, offset, length);
}

/// One append-only spool for tiles whose output geometry or format is not yet
/// known. Shares one file regardless of tile count; call store on a blocking worker.
pub(crate) struct TileSpool(Mutex<File>);

impl TileSpool {
    pub(crate) fn new(directory: &Path) -> Result<Arc<Self>, Error> {
        Ok(Arc::new(Self(Mutex::new(
            temporary_file(directory).map_err(storage_error)?,
        ))))
    }

    pub(crate) fn store(self: &Arc<Self>, decoded: DecodedTile) -> Result<StoredPixels, Error> {
        let mut file = self.0.lock().expect("tile spool lock");
        let pixels = file.seek(SeekFrom::End(0)).map_err(storage_error)?;
        file.write_all(decoded.image.as_raw())
            .map_err(storage_error)?;
        let icc =
            store_metadata(&mut *file, decoded.icc_profile.as_deref()).map_err(storage_error)?;
        let exif =
            store_metadata(&mut *file, decoded.exif_metadata.as_deref()).map_err(storage_error)?;
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

/// Reading consumes the handle and restores one tile without decoding again.
/// Its spool remains alive until every stored tile and worker has released it.
pub(crate) struct StoredPixels {
    spool: Arc<TileSpool>,
    pixels: u64,
    pub(crate) size: Size,
    pub(crate) transparent: bool,
    icc: MetadataLocation,
    exif: MetadataLocation,
}

impl StoredPixels {
    pub(crate) fn read(self) -> Result<DecodedTile, Error> {
        let mut file = self.spool.0.lock().expect("tile spool lock");
        let length = self.size.width as usize * self.size.height as usize * 4;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(storage_error)?;
        bytes.resize(length, 0);
        file.seek(SeekFrom::Start(self.pixels))
            .map_err(storage_error)?;
        file.read_exact(&mut bytes).map_err(storage_error)?;
        discard(&file, self.pixels, length as u64);
        let image = image::RgbaImage::from_raw(self.size.width, self.size.height, bytes)
            .ok_or_else(|| Error::InvalidState("incomplete stored tile".into()))?;
        let icc_profile = read_metadata(&mut *file, self.icc).map_err(storage_error)?;
        let exif_metadata = read_metadata(&mut *file, self.exif).map_err(storage_error)?;
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
