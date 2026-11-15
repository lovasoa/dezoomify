//! Image decoding, metadata, encoders, and format limits.
use std::path::PathBuf;

use dezoomify::model::{Error, LimitContext, LimitReason, OutputFormat, Size};

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
    use image::codecs::png::CompressionType;
    use tiff::encoder::compression::DeflateLevel;
    match png_compression_for(compression) {
        CompressionType::Fast => DeflateLevel::Fast,
        CompressionType::Default => DeflateLevel::Balanced,
        _ => DeflateLevel::Best,
    }
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

/// Encode PNG at the configured deflate tier, preserving ICC and EXIF metadata.
pub fn encode_png(
    image: &image::RgbaImage,
    compression: image::codecs::png::CompressionType,
    icc_profile: Option<&[u8]>,
    exif_metadata: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    let mut bytes = crate::buffers::Buffer::default();
    encode_png_to(&mut bytes, image, compression, icc_profile, exif_metadata)?;
    Ok(bytes.into_vec())
}

pub(crate) fn encode_png_to<W: std::io::Write>(
    writer: W,
    image: &image::RgbaImage,
    compression: image::codecs::png::CompressionType,
    icc_profile: Option<&[u8]>,
    exif_metadata: Option<&[u8]>,
) -> Result<(), Error> {
    use image::codecs::png::FilterType;
    let mut encoder =
        image::codecs::png::PngEncoder::new_with_quality(writer, compression, FilterType::Adaptive);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(
            &mut encoder,
            crate::buffers::copy(profile).map_err(crate::buffers::allocation_error)?,
        );
    }
    if let Some(exif) = exif_metadata {
        let _ = image::ImageEncoder::set_exif_metadata(
            &mut encoder,
            crate::buffers::copy(exif).map_err(crate::buffers::allocation_error)?,
        );
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
    Ok(())
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
    let mut bytes = crate::buffers::Buffer::default();
    encode_jpeg_to(&mut bytes, image, quality, icc_profile)?;
    Ok(bytes.into_vec())
}

pub(crate) fn encode_jpeg_to<W: std::io::Write>(
    writer: W,
    image: &image::RgbaImage,
    quality: u8,
    icc_profile: Option<&[u8]>,
) -> Result<(), Error> {
    check_dimensions(
        dezoomify::model::OutputFormat::Jpeg,
        &Size {
            width: image.width(),
            height: image.height(),
        },
    )?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, quality);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(
            &mut encoder,
            crate::buffers::copy(profile).map_err(crate::buffers::allocation_error)?,
        );
    }
    encoder.encode_image(&RgbView(image)).map_err(|e| {
        Error::EncodeFailed(
            format!("jpeg encode failed: {}", dezoomify::model::chain_text(&e)).into(),
        )
    })?;
    Ok(())
}

/// The common image-crate path. Override construction only when the crate's
/// default encoder cannot express the codec's settings or metadata contract.
pub(crate) fn encode_buffered_to<W: std::io::Write + std::io::Seek>(
    mut writer: W,
    image: &image::RgbaImage,
    format: OutputFormat,
    compression: u8,
    icc_profile: Option<&[u8]>,
) -> Result<(), Error> {
    macro_rules! encode {
        ($encoder:expr) => {
            image::ImageEncoder::write_image(
                $encoder,
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
        };
    }
    let result = match format {
        OutputFormat::Webp => {
            let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(writer);
            if let Some(profile) = icc_profile {
                let _ = image::ImageEncoder::set_icc_profile(
                    &mut encoder,
                    crate::buffers::copy(profile).map_err(crate::buffers::allocation_error)?,
                );
            }
            encode!(encoder)
        }
        OutputFormat::Avif => encode!(image::codecs::avif::AvifEncoder::new_with_speed_quality(
            writer,
            4,
            format.codec().control.quality(compression),
        )),
        _ => image::write_buffer_with_format(
            &mut writer,
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
            image::ImageFormat::from_extension(format.extension())
                .ok_or_else(|| Error::InvalidState("unregistered image encoder".into()))?,
        ),
    };
    result.map_err(|error| {
        Error::EncodeFailed(
            format!(
                "{} encode failed: {}",
                format.as_str(),
                dezoomify::model::chain_text(&error)
            )
            .into(),
        )
    })
}
