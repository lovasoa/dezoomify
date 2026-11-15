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
    /// Full stored raster for a decoded document probe. Metadata remains in bytes.
    pub probe_pixels: Option<crate::pixel_store::StoredPixels>,
}

/// JPEG container facts inspected without decoding entropy data. Unsupported
/// frames return None; each output applies its own stricter eligibility rules.
pub(crate) struct JpegHeader {
    pub channels: u8,
    pub jfif: bool,
    pub adobe_transform: Option<u8>,
    pub ycbcr_sampling: Option<(u16, u16)>,
    pub rgb_ids: bool,
}

pub(crate) fn jpeg_header(bytes: &[u8]) -> Option<JpegHeader> {
    if !bytes.starts_with(b"\xff\xd8") {
        return None;
    }
    let mut header = JpegHeader {
        channels: 0,
        jfif: false,
        adobe_transform: None,
        ycbcr_sampling: None,
        rgb_ids: false,
    };
    let mut at = 2usize;
    while bytes.get(at) == Some(&0xff) {
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        if marker == 0xda {
            return (header.channels != 0).then_some(header);
        }
        if marker == 1 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let len = usize::from(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
        if len < 2 {
            return None;
        }
        let data = bytes.get(at + 2..at.checked_add(len)?)?;
        read_jpeg_segment(marker, data, &mut header)?;
        at += len;
    }
    None
}

fn read_jpeg_segment(marker: u8, data: &[u8], header: &mut JpegHeader) -> Option<()> {
    match marker {
        0xe0 if data.starts_with(b"JFIF\0") => header.jfif = true,
        0xee if data.starts_with(b"Adobe") => header.adobe_transform = data.get(11).copied(),
        0xc0 | 0xc2 => read_jpeg_frame(data, header)?,
        _ => {}
    }
    Some(())
}

fn read_jpeg_frame(data: &[u8], header: &mut JpegHeader) -> Option<()> {
    if data.first() != Some(&8) {
        return None;
    }
    header.channels = *data.get(5)?;
    if data.len() != 6 + usize::from(header.channels) * 3 {
        return None;
    }
    if header.channels == 3 {
        let sampling = (u16::from(data[7] >> 4), u16::from(data[7] & 15));
        if data[6] == 1
            && data[9] == 2
            && data[12] == 3
            && data[10] == 0x11
            && data[13] == 0x11
            && (1..=4).contains(&sampling.0)
            && (1..=4).contains(&sampling.1)
        {
            header.ycbcr_sampling = Some(sampling);
        }
        header.rgb_ids = data[6] == b'R' && data[9] == b'G' && data[12] == b'B';
    }
    Some(())
}

/// PNG header/chunk facts, shared by encoded output profiles. Pixel bytes stay
/// compressed; structural validation belongs to `inspect` before this call.
pub(crate) struct PngHeader {
    pub bits: u8,
    pub color: u8,
    pub interlaced: bool,
    pub transparent: bool,
    pub color_chunks: bool,
    pub icc: bool,
}

pub(crate) fn png_header(bytes: &[u8]) -> Option<PngHeader> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut header = PngHeader {
        bits: *bytes.get(24)?,
        color: *bytes.get(25)?,
        interlaced: *bytes.get(28)? != 0,
        transparent: false,
        color_chunks: false,
        icc: false,
    };
    let mut at = 8usize;
    while let Some(chunk) = bytes.get(at..at.checked_add(8)?) {
        header.transparent |= &chunk[4..] == b"tRNS";
        header.color_chunks |= matches!(&chunk[4..], b"gAMA" | b"cHRM" | b"sRGB");
        header.icc |= &chunk[4..] == b"iCCP";
        if &chunk[4..] == b"IEND" {
            return Some(header);
        }
        at = at
            .checked_add(u32::from_be_bytes(chunk[..4].try_into().ok()?) as usize)?
            .checked_add(12)?;
    }
    None
}

impl EncodedTile {
    /// Conversion required by the output geometry/codec happens during acquisition.
    pub(crate) fn convert_to_png(&mut self, size: Size, compression: u8) -> Result<(), Error> {
        let (icc, exif) = tile_metadata(&self.bytes, self.format)?;
        let image = self.decode_pixels(&size)?;
        self.bytes = crate::imaging::encode_png(
            &image,
            crate::imaging::png_compression_for(compression),
            icc.as_deref(),
            exif.as_deref(),
        )?;
        self.format = NativeFormat::Image(image::ImageFormat::Png);
        self.size = size;
        Ok(())
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

/// Tile positions refer to the stored raster. Remove JPEG display transforms
/// in place, preserving compressed pixels and all other EXIF fields.
pub(crate) fn normalize_orientation(bytes: &mut [u8]) {
    if !bytes.starts_with(b"\xff\xd8") {
        return;
    }
    let mut at = 2;
    while bytes.get(at) == Some(&0xff) {
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let Some(&marker) = bytes.get(at) else { break };
        at += 1;
        if matches!(marker, 0xda | 0xd9) {
            break;
        }
        if marker == 1 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let Some(length) = bytes.get(at..at + 2) else {
            break;
        };
        let len = usize::from(u16::from_be_bytes(
            length.try_into().expect("segment length"),
        ));
        if len < 2 {
            break;
        }
        let Some(data) = bytes.get_mut(at + 2..at + len) else {
            break;
        };
        if marker == 0xe1 && data.starts_with(b"Exif\0\0") {
            let _ = image::metadata::Orientation::remove_from_exif_chunk(&mut data[6..]);
        }
        at += len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reusable_tiles_reject_truncated_structure_and_missing_terminators() {
        let image = image::RgbaImage::new(8, 8);
        for bytes in [
            crate::imaging::encode_jpeg(&image, 90, None).unwrap(),
            crate::imaging::encode_png(
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
