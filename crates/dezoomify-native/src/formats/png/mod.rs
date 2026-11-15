use super::{encoding_error, RasterWriter, StripEncoder};
use crate::{host::Controls, output::StagedFile, pixel_pipe::PixelPipe};
use dezoomify::model::Error;
use std::{io::Write, sync::Arc};

mod convert;
mod header;
mod metadata;
pub(crate) use convert::convert_tile;
pub(crate) use header::{check_structure, header, image_data};
pub(crate) use metadata::icc_profile;

pub(crate) struct Encoder {
    pub(crate) compression: u8,
}

impl StripEncoder for Encoder {
    fn write(&self, output: &mut RasterWriter<'_>, pipe: &Arc<PixelPipe>) -> Result<(), Error> {
        let mut encoder = png::Encoder::new(output, pipe.size.width, pipe.size.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(match compression_for(self.compression) {
            image::codecs::png::CompressionType::Fast => png::Compression::Fast,
            image::codecs::png::CompressionType::Default => png::Compression::Balanced,
            _ => png::Compression::High,
        });
        let mut writer = encoder.write_header().map_err(encoding_error)?;
        {
            let mut stream = writer
                .stream_writer_with_size(64 << 10)
                .map_err(encoding_error)?;
            while let Some(strip) = pipe.receive()? {
                stream.write_all(&strip.rgba).map_err(encoding_error)?;
                pipe.consumed_strip(&strip);
            }
            stream.finish().map_err(encoding_error)?;
        }
        writer.finish().map_err(encoding_error)?;
        Ok(())
    }
    fn finish_metadata(
        &self,
        staging: &mut StagedFile,
        pipe: &PixelPipe,
        controls: &Controls,
    ) -> Result<(), Error> {
        let (icc, exif) = pipe.metadata()?;
        if icc.is_some() || exif.is_some() {
            let header = metadata::header(icc.as_deref(), exif.as_deref())?;
            staging.insert_header(33, &header, controls.cancel_flag())?;
        }
        Ok(())
    }
}

/// PNG deflate tier for a `--compression` value.
pub(crate) fn compression_for(compression: u8) -> image::codecs::png::CompressionType {
    use image::codecs::png::CompressionType;
    match compression {
        0..=19 => CompressionType::Fast,
        20..=60 => CompressionType::Default,
        _ => CompressionType::Best,
    }
}

/// Encode PNG at the configured deflate tier, preserving ICC and EXIF metadata.
pub fn encode(
    image: &image::RgbaImage,
    compression: image::codecs::png::CompressionType,
    icc_profile: Option<&[u8]>,
    exif_metadata: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    let mut bytes = crate::buffers::Buffer::default();
    encode_to(&mut bytes, image, compression, icc_profile, exif_metadata)?;
    Ok(bytes.into_vec())
}

pub(crate) fn encode_to<W: std::io::Write>(
    writer: W,
    image: &image::RgbaImage,
    compression: image::codecs::png::CompressionType,
    icc_profile: Option<&[u8]>,
    exif_metadata: Option<&[u8]>,
) -> Result<(), Error> {
    write_image(writer, image, compression, icc_profile, exif_metadata)
}

fn write_image<P: image::PixelWithColorType<Subpixel = u8>>(
    writer: impl Write,
    pixels: &image::ImageBuffer<P, Vec<u8>>,
    compression: image::codecs::png::CompressionType,
    icc_profile: Option<&[u8]>,
    exif_metadata: Option<&[u8]>,
) -> Result<(), Error> {
    use image::codecs::png::FilterType;
    let mut encoder =
        image::codecs::png::PngEncoder::new_with_quality(writer, compression, FilterType::Adaptive);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
    if let Some(exif) = exif_metadata {
        let _ = image::ImageEncoder::set_exif_metadata(&mut encoder, exif.to_vec());
    }
    image::ImageEncoder::write_image(
        encoder,
        pixels.as_raw(),
        pixels.width(),
        pixels.height(),
        P::COLOR_TYPE,
    )
    .map_err(|e| {
        Error::EncodeFailed(
            format!("png encode failed: {}", dezoomify::model::chain_text(&e)).into(),
        )
    })?;
    Ok(())
}

pub(crate) fn encode_rgb_to(
    writer: impl Write,
    pixels: &image::RgbaImage,
    compression: u8,
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
) -> Result<(), Error> {
    let mut rgb = Vec::new();
    rgb.try_reserve_exact(pixels.as_raw().len() / 4 * 3)
        .map_err(crate::buffers::allocation_error)?;
    for pixel in pixels.pixels() {
        rgb.extend_from_slice(&pixel.0[..3]);
    }
    let rgb = image::RgbImage::from_raw(pixels.width(), pixels.height(), rgb).expect("RGB pixels");
    write_image(writer, &rgb, compression_for(compression), icc, exif)
}

#[cfg(test)]
mod tests;
