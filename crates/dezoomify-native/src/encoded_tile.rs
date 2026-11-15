//! Encoded tile inspection, metadata normalization, and pixel conversion.
use crate::codecs::NativeFormat;
pub(crate) use crate::codecs::{inspect, tile_metadata};
use dezoomify::model::{Error, Size, TilePlacement};

pub(crate) struct EncodedTile {
    pub request: Option<dezoomify::model::ResourceRequest>,
    pub id: u32,
    pub placement: TilePlacement,
    pub bytes: Vec<u8>,
    pub size: Size,
    pub format: NativeFormat,
    /// Full raster for a decoded document probe. Metadata remains in bytes.
    pub probe_pixels: Option<image::RgbaImage>,
}

impl EncodedTile {
    pub(crate) fn retained_bytes(&self) -> u64 {
        std::mem::size_of::<Self>() as u64
            + self.bytes.len() as u64
            + self
                .probe_pixels
                .as_ref()
                .map_or(0, |pixels| pixels.as_raw().len() as u64)
            + self.request.as_ref().map_or(0, |request| {
                request.uri.len() as u64
                    + request
                        .headers
                        .iter()
                        .map(|header| (header.name.len() + header.value.len()) as u64 + 64)
                        .sum::<u64>()
            })
    }

    pub(crate) fn decode_pixels(&self, size: &Size) -> Result<image::RgbaImage, Error> {
        let image =
            crate::codecs::decode(&self.bytes, self.format).map_err(crate::codecs::decode_error)?;
        Ok(if *size == self.size {
            image
        } else {
            crate::imaging::crop_pixels(&image, size)?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reusable_tiles_reject_truncated_structure_and_missing_terminators() {
        let image = image::RgbaImage::new(8, 8);
        for bytes in [
            crate::formats::jpeg::encode(&image, 90, None).unwrap(),
            crate::formats::png::encode(
                &image,
                image::codecs::png::CompressionType::Fast,
                None,
                None,
            )
            .unwrap(),
        ] {
            assert_eq!(
                inspect(&bytes).unwrap().0,
                Size {
                    width: 8,
                    height: 8
                }
            );
            for length in [bytes.len() / 2, bytes.len() - 16, bytes.len() - 1] {
                assert!(matches!(
                    inspect(&bytes[..length]),
                    Err(Error::DecodeFailed(_))
                ));
            }
            let mut broken = bytes.clone();
            let length = if bytes.starts_with(b"\x89PNG") { 8 } else { 4 };
            broken[length..length + 2].fill(0xff);
            assert!(inspect(&broken).is_err());
        }
    }
}
