use super::{failed, ZifWriter};
use dezoomify::model::Error;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Profile {
    PngRgb,
    Jpeg { sampling: (u16, u16) },
}

/// Apply ZIF's color and sampling requirements to shared encoded header facts.
pub(super) fn profile(bytes: &[u8]) -> Option<Profile> {
    if let Some(header) = crate::formats::png::header(bytes) {
        return (header.bits == 8
            && header.color == 2
            && !header.transparent
            && (!header.color_chunks || header.icc))
            .then_some(Profile::PngRgb);
    }
    let header = crate::formats::jpeg::header(bytes)?;
    if header.jfif && header.adobe_transform != Some(0) {
        header
            .ycbcr_sampling
            .map(|sampling| Profile::Jpeg { sampling })
    } else {
        None
    }
}

pub(crate) fn can_reuse(bytes: &[u8]) -> bool {
    profile(bytes).is_some()
}

impl ZifWriter {
    pub(super) fn select_profile(&self, source: Option<Profile>) -> Profile {
        self.profile
            .or(source.filter(|profile| {
                *profile == Profile::PngRgb
                    || (self.base.cell.width.min(self.base.size.width) <= u16::MAX.into()
                        && self.base.cell.height.min(self.base.size.height) <= u16::MAX.into())
            }))
            .unwrap_or(Profile::PngRgb)
    }

    pub(super) fn require_pixel_encoder(&self) -> Result<(), Error> {
        if matches!(self.profile, Some(Profile::Jpeg { sampling }) if sampling != (1, 1)) {
            Err(failed("subsampled JPEG passthrough requires complete compatible source tiles; pixel conversion would change sampling"))
        } else {
            Ok(())
        }
    }

    pub(super) fn encode(&self, pixels: &image::RgbaImage) -> Result<Vec<u8>, Error> {
        let icc = self
            .metadata
            .values()
            .find_map(|(_, icc, _)| icc.as_deref());
        let exif = self
            .metadata
            .values()
            .find_map(|(_, _, exif)| exif.as_deref());
        self.encode_with_metadata(pixels, icc, exif)
    }

    pub(super) fn encode_with_metadata(
        &self,
        pixels: &image::RgbaImage,
        icc: Option<&[u8]>,
        exif: Option<&[u8]>,
    ) -> Result<Vec<u8>, Error> {
        self.require_pixel_encoder()?;

        let mut bytes = crate::buffers::Buffer::default();
        match self.profile.expect("initialized ZIF profile") {
            Profile::PngRgb => {
                crate::formats::png::encode_rgb_to(
                    &mut bytes,
                    pixels,
                    self.compression,
                    icc,
                    exif,
                )?;
            }
            Profile::Jpeg { .. } => {
                crate::formats::jpeg::encode_to(
                    &mut bytes,
                    pixels,
                    dezoomify::model::OutputFormat::Jpeg
                        .codec()
                        .control
                        .quality(self.compression)
                        .max(1),
                    icc,
                )?;
            }
        }
        Ok(bytes.into_vec())
    }
}
