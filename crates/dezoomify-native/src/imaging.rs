//! Image decoding, metadata, encoders, and format limits.
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
/// system. Temporary storage uses this to choose RAM or disk; availability can
/// change after sampling. Returns zero if the system probe
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

pub(crate) fn rgba_pixels(size: &Size) -> Result<image::RgbaImage, Error> {
    let length = u64::from(size.width)
        .checked_mul(u64::from(size.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| Error::ResourceLimit("pixel buffer size overflow".into()))?;
    let pixels = crate::buffers::zeroed(length)
        .map_err(|error| Error::ResourceLimit(format!("pixel allocation: {error}").into()))?;
    image::RgbaImage::from_raw(size.width, size.height, pixels)
        .ok_or_else(|| Error::InvalidState("invalid pixel buffer dimensions".into()))
}

pub(crate) fn crop_pixels(
    image: &image::RgbaImage,
    size: &Size,
) -> Result<image::RgbaImage, Error> {
    use image::GenericImage;
    let mut pixels = rgba_pixels(size)?;
    pixels
        .copy_from(
            &*image::imageops::crop_imm(image, 0, 0, size.width, size.height),
            0,
            0,
        )
        .map_err(|error| Error::DecodeFailed(error.to_string().into()))?;
    Ok(pixels)
}

pub(crate) fn load_image_with_metadata(bytes: &[u8]) -> Result<DecodedTile, image::ImageError> {
    use image::ImageDecoder as _;
    let format = crate::codecs::detect(bytes)?;
    let mut decoder = crate::codecs::decoder(bytes, format)?;
    let icc_profile = decoder.icc_profile().unwrap_or(None);
    let exif_metadata = decoder.exif_metadata().unwrap_or(None);
    let image = crate::codecs::decode_pixels(decoder)?;
    Ok(DecodedTile {
        image,
        icc_profile,
        exif_metadata,
    })
}

// Retain the public helpers at their existing paths.
pub use crate::formats::{jpeg::encode as encode_jpeg, png::encode as encode_png};
