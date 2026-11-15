use super::{buffered_pixels, encoding_error, RasterWriter, StripEncoder};
use crate::pixel_pipe::PixelPipe;
use dezoomify::model::Error;
use image::ImageEncoder;
use std::sync::Arc;

pub(crate) struct Encoder;

impl StripEncoder for Encoder {
    fn write(&self, output: &mut RasterWriter<'_>, pipe: &Arc<PixelPipe>) -> Result<(), Error> {
        let image = buffered_pixels(pipe)?;
        let (icc, _) = pipe.metadata()?;
        let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(output);
        if let Some(profile) = icc {
            let _ = encoder.set_icc_profile(profile);
        }
        encoder
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| {
                encoding_error(format!(
                    "webp encode failed: {}",
                    dezoomify::model::chain_text(&error)
                ))
            })
    }
}
