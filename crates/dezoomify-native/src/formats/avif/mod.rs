use super::{buffered_pixels, encoding_error, RasterWriter, StripEncoder};
use crate::pixel_pipe::PixelPipe;
use dezoomify::model::{Error, Size};
use image::ImageEncoder;
use std::sync::Arc;

pub(crate) struct Encoder {
    pub(crate) compression: u8,
}

impl StripEncoder for Encoder {
    fn workspace(&self, size: &Size) -> u64 {
        let pixels = u64::from(size.width) * u64::from(size.height);
        pixels.saturating_mul(64).saturating_add(16 << 20)
    }
    fn write(&self, output: &mut RasterWriter<'_>, pipe: &Arc<PixelPipe>) -> Result<(), Error> {
        let image = buffered_pixels(pipe)?;
        pipe.metadata()?;
        let encoder = image::codecs::avif::AvifEncoder::new_with_speed_quality(
            output,
            4,
            dezoomify::model::OutputFormat::Avif
                .codec()
                .control
                .quality(self.compression),
        );
        encoder
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| {
                encoding_error(format!(
                    "avif encode failed: {}",
                    dezoomify::model::chain_text(&error)
                ))
            })
    }
}

#[cfg(test)]
mod tests;
