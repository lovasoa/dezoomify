//! Image decoding, metadata, encoders, and memory limits.
use std::path::PathBuf;

use dezoomify::model::{Error, LimitContext, LimitReason, Size};

/// JPEG caps both dimensions at 65535 pixels.
pub const JPEG_MAX_SIDE: u32 = 65_535;

/// WebP lossless caps both dimensions at 16383 px.
pub const WEBP_MAX_SIDE: u32 = 16_383;

pub(crate) fn check_dimensions(
    format: dezoomify::model::OutputFormat,
    size: &Size,
) -> Result<(), Error> {
    use dezoomify::model::OutputFormat;
    let (maximum, reason) = match format {
        OutputFormat::Jpeg => (JPEG_MAX_SIDE, LimitReason::JpegSide),
        OutputFormat::Webp => (WEBP_MAX_SIDE, LimitReason::WebpSide),
        _ => return Ok(()),
    };
    if size.width > maximum || size.height > maximum {
        return Err(Error::LimitExceeded {
            limit: LimitContext {
                reason,
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
/// system. The native Host samples this to cap its invocation's RAM budget;
/// availability can change after sampling.
#[must_use]
pub fn available_memory_bytes() -> u64 {
    let mut system = sysinfo::System::new();
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

/// PNG deflate tier for a `--compression` value.
pub(crate) fn png_compression_for(compression: u8) -> image::codecs::png::CompressionType {
    use image::codecs::png::CompressionType;
    match compression {
        0..=19 => CompressionType::Fast,
        20..=60 => CompressionType::Default,
        _ => CompressionType::Best,
    }
}

/// TIFF deflate level for a `--compression` value: the same tiers as
/// [`png_compression_for`] (0-19 fast, 20-60 balanced, above best), so one
/// flag drives every lossless encoder identically. The `tiff` encoder has
/// no inner-JPEG quality knob, and native never re-encodes lossy inside
/// TIFF: higher compression only trades slower encodes for smaller files.
pub(crate) fn tiff_compression_for(compression: u8) -> tiff::encoder::compression::DeflateLevel {
    use tiff::encoder::compression::DeflateLevel;
    match compression {
        0..=19 => DeflateLevel::Fast,
        20..=60 => DeflateLevel::Balanced,
        _ => DeflateLevel::Best,
    }
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
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    if let Some(max_alloc) = max_alloc {
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(max_alloc);
        reader.limits(limits);
    }
    let mut decoder = reader.into_decoder()?;
    let icc_profile = decoder.icc_profile().unwrap_or(None);
    let exif_metadata = decoder.exif_metadata().unwrap_or(None);
    let image = image::DynamicImage::from_decoder(decoder)?.into_rgba8();
    Ok(DecodedTile {
        image,
        icc_profile,
        exif_metadata,
    })
}

/// Encode PNG at the configured deflate tier, preserving ICC and EXIF metadata.
pub fn encode_png(
    image: &image::RgbaImage,
    compression: image::codecs::png::CompressionType,
    icc_profile: Option<&[u8]>,
    exif_metadata: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    use image::codecs::png::FilterType;
    let mut encoder = image::codecs::png::PngEncoder::new_with_quality(
        &mut bytes,
        compression,
        FilterType::Adaptive,
    );
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
    if let Some(exif) = exif_metadata {
        let _ = image::ImageEncoder::set_exif_metadata(&mut encoder, exif.to_vec());
    }
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| {
        Error::EncodeFailed(
            format!("png encode failed: {}", dezoomify::model::chain_text(&e)).into(),
        )
    })?;
    Ok(bytes)
}

/// Borrow RGB channels without copying the RGBA allocation.
struct RgbView<'a>(&'a image::RgbaImage);

impl image::GenericImageView for RgbView<'_> {
    type Pixel = image::Rgb<u8>;

    fn dimensions(&self) -> (u32, u32) {
        self.0.dimensions()
    }

    fn get_pixel(&self, x: u32, y: u32) -> Self::Pixel {
        let pixel = self.0.get_pixel(x, y);
        image::Rgb([pixel[0], pixel[1], pixel[2]])
    }
}

/// Encode a local RGB tile, borrowing the RGBA allocation.
pub fn encode_jpeg(
    image: &image::RgbaImage,
    quality: u8,
    icc_profile: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    check_dimensions(
        dezoomify::model::OutputFormat::Jpeg,
        &Size {
            width: image.width(),
            height: image.height(),
        },
    )?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
    encoder.encode_image(&RgbView(image)).map_err(|e| {
        Error::EncodeFailed(
            format!("jpeg encode failed: {}", dezoomify::model::chain_text(&e)).into(),
        )
    })?;
    Ok(bytes)
}

/// Lossless WebP requires contiguous pixels; preserve the selected ICC profile.
pub(crate) fn encode_webp_to<W: std::io::Write>(
    writer: W,
    image: &image::RgbaImage,
    icc_profile: Option<&[u8]>,
) -> Result<(), Error> {
    check_dimensions(
        dezoomify::model::OutputFormat::Webp,
        &Size {
            width: image.width(),
            height: image.height(),
        },
    )?;
    let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(writer);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| {
        Error::EncodeFailed(
            format!("webp encode failed: {}", dezoomify::model::chain_text(&e)).into(),
        )
    })?;
    Ok(())
}
