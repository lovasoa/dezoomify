use super::{encoding_error, RasterWriter, StripEncoder};
use crate::pixel_pipe::PixelPipe;
use dezoomify::model::{Error, OutputFormat, Size};
use std::sync::Arc;

mod header;
mod metadata;
mod stream;
pub(crate) use header::{check_structure, header, normalize_orientation};

pub(crate) struct Encoder {
    pub(crate) compression: u8,
}

impl StripEncoder for Encoder {
    fn write(&self, output: &mut RasterWriter<'_>, pipe: &Arc<PixelPipe>) -> Result<(), Error> {
        let view = stream::JpegView::new(pipe)?;
        image::codecs::jpeg::JpegEncoder::new_with_quality(
            output,
            OutputFormat::Jpeg.codec().control.quality(self.compression),
        )
        .encode_image(&view)
        .map_err(encoding_error)?;
        view.finish();
        Ok(())
    }
    fn finish_metadata(
        &self,
        staging: &mut crate::output::StagedFile,
        pipe: &PixelPipe,
        controls: &crate::host::Controls,
    ) -> Result<(), Error> {
        metadata::finish(staging, pipe, controls)
    }
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
pub fn encode(
    image: &image::RgbaImage,
    quality: u8,
    icc_profile: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    encode_to(&mut bytes, image, quality, icc_profile)?;
    Ok(bytes)
}

pub(crate) fn encode_to<W: std::io::Write>(
    writer: W,
    image: &image::RgbaImage,
    quality: u8,
    icc_profile: Option<&[u8]>,
) -> Result<(), Error> {
    crate::imaging::check_dimensions(
        dezoomify::model::OutputFormat::Jpeg,
        &Size {
            width: image.width(),
            height: image.height(),
        },
    )?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, quality);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
    encoder.encode_image(&RgbView(image)).map_err(|e| {
        Error::EncodeFailed(
            format!("jpeg encode failed: {}", dezoomify::model::chain_text(&e)).into(),
        )
    })?;
    Ok(())
}
