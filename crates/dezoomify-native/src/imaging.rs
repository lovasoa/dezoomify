//! Image decoding, metadata, encoders, and memory limits.
use std::path::PathBuf;

use dezoomify::model::{Error, LimitContext, LimitReason, Size};

pub(crate) fn check_dimensions(
    format: dezoomify::model::OutputFormat,
    size: &Size,
) -> Result<(), Error> {
    let Some(maximum) = format.codec().max_side else {
        return Ok(());
    };
    if size.width > maximum || size.height > maximum {
        return Err(Error::LimitExceeded {
            limit: LimitContext {
                reason: LimitReason::CodecSide(format),
                dimensions: Some(size.clone()),
                bytes_required: None,
                bytes_available: None,
            },
        });
    }
    Ok(())
}

/// Default number of tile acquisitions in flight.
pub const MAX_CONCURRENT: usize = 16;

/// Bytes currently available to the process according to the operating
/// system. The native Host samples this to guard buffered codecs and tiled output;
/// availability can change after sampling. Returns zero if the system probe
/// cannot be initialized.
#[must_use]
pub fn available_memory_bytes() -> u64 {
    let Ok(mut system) = sysinfo::System::new() else {
        return 0;
    };
    system.refresh_memory();
    system.available_memory()
}

/// Default on-disk tile-cache root: `<tmp>/dezoomify-tile-cache`. The cache
/// holds response bodies only (never headers or credentials) under a
/// versioned per-job namespace; a corrupt entry falls back to a fresh fetch.
#[must_use]
pub fn default_tile_cache_dir() -> PathBuf {
    std::env::temp_dir().join("dezoomify-tile-cache")
}

/// One owned tile decode, with its embedded metadata.
pub struct DecodedTile {
    pub image: image::RgbaImage,
    pub icc_profile: Option<Vec<u8>>,
    pub exif_metadata: Option<Vec<u8>>,
}

#[cfg(test)]
pub(crate) fn load_image_with_metadata(bytes: &[u8]) -> Result<DecodedTile, image::ImageError> {
    load_image_with_limit(bytes, None)
}
pub(crate) fn load_image_with_limit(
    bytes: &[u8],
    max_alloc: Option<u64>,
) -> Result<DecodedTile, image::ImageError> {
    use image::ImageDecoder as _;
    let format = crate::codecs::detect(bytes)?;
    let mut decoder = crate::codecs::decoder(bytes, format, max_alloc)?;
    let icc_profile = decoder.icc_profile().unwrap_or(None);
    let exif_metadata = decoder.exif_metadata().unwrap_or(None);
    let image = image::DynamicImage::from_decoder(decoder)?.into_rgba8();
    Ok(DecodedTile {
        image,
        icc_profile,
        exif_metadata,
    })
}

// Retain the public helpers at their existing paths.
pub use crate::formats::{jpeg::encode as encode_jpeg, png::encode as encode_png};
