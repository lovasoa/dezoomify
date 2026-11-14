//! Encoded tile inspection, metadata normalization, and bounded pixel conversion.
use crate::tile_budget::memory_check;
use dezoomify::model::{Error, Size, TilePlacement};
use std::io::Cursor;

pub(crate) struct EncodedTile {
    pub request: Option<dezoomify::model::ResourceRequest>,
    pub id: u32,
    pub placement: TilePlacement,
    pub bytes: Vec<u8>,
    pub size: Size,
    pub format: image::ImageFormat,
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
        if marker == 0xe0 && data.starts_with(b"JFIF\0") {
            header.jfif = true;
        }
        if marker == 0xee && data.starts_with(b"Adobe") {
            header.adobe_transform = data.get(11).copied();
        }
        if matches!(marker, 0xc0 | 0xc2) {
            read_jpeg_frame(data, &mut header)?;
        }
        at += len;
    }
    None
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

type Metadata = (Option<Vec<u8>>, Option<Vec<u8>>);

pub(crate) fn tile_metadata(
    bytes: &[u8],
    format: image::ImageFormat,
    budget: u64,
) -> Result<Metadata, Error> {
    use image::ImageDecoder as _;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(budget / 3);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    let mut icc = decoder.icc_profile().map_err(decode_error)?;
    let exif = decoder.exif_metadata().map_err(decode_error)?;
    drop(decoder);
    if icc.is_none() && format == image::ImageFormat::Png {
        icc = png_icc(bytes, budget / 3)?;
    }
    memory_check(
        (icc.as_ref().map_or(0, Vec::len) as u64 + exif.as_ref().map_or(0, Vec::len) as u64) * 3,
        budget,
    )?;
    Ok((icc, exif))
}

impl EncodedTile {
    /// Conversion required by the output geometry/codec happens during acquisition.
    pub(crate) fn convert_to_png(
        &mut self,
        size: Size,
        budget: u64,
        compression: u8,
    ) -> Result<(), Error> {
        let pixels = u64::from(self.size.width) * u64::from(self.size.height);
        memory_check(self.bytes.len() as u64 + pixels * 16, budget)?;
        let (icc, exif) = tile_metadata(
            &self.bytes,
            self.format,
            budget.saturating_sub(self.bytes.len() as u64 + pixels * 16),
        )?;
        let budget = budget.saturating_sub(
            (icc.as_ref().map_or(0, Vec::len) as u64 + exif.as_ref().map_or(0, Vec::len) as u64)
                * 4,
        );
        let image = self.decode_pixels(&size, budget)?;
        self.bytes = crate::imaging::encode_png(
            &image,
            crate::imaging::png_compression_for(compression),
            icc.as_deref(),
            exif.as_deref(),
        )?;
        self.format = image::ImageFormat::Png;
        self.size = size;
        Ok(())
    }

    pub(crate) fn decode_pixels(
        &self,
        size: &Size,
        budget: u64,
    ) -> Result<image::RgbaImage, Error> {
        let pixels = u64::from(self.size.width) * u64::from(self.size.height);
        memory_check(self.bytes.len() as u64 + pixels * 16, budget)?;
        let mut reader = image::ImageReader::with_format(Cursor::new(&self.bytes), self.format);
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(budget.saturating_sub(self.bytes.len() as u64) / 2);
        reader.limits(limits);
        let image = reader.decode().map_err(decode_error)?.into_rgba8();
        Ok(if *size == self.size {
            image
        } else {
            image::imageops::crop_imm(&image, 0, 0, size.width, size.height).to_image()
        })
    }
}

// Extract PNG ICC data with bounded inflation, without decoding pixels.
pub(crate) fn png_icc(bytes: &[u8], cap: u64) -> Result<Option<Vec<u8>>, Error> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(None);
    }
    let mut at = 8;
    while let Some(header) = bytes.get(at..at + 8) {
        let len = u32::from_be_bytes(header[..4].try_into().expect("chunk length")) as usize;
        let data = bytes
            .get(at + 8..at + 8 + len)
            .ok_or_else(|| Error::DecodeFailed("truncated PNG metadata".into()))?;
        if &header[4..] == b"iCCP" {
            let start = data
                .iter()
                .position(|&byte| byte == 0)
                .filter(|&name| name > 0 && name <= 79)
                .ok_or_else(|| Error::DecodeFailed("invalid PNG ICC name".into()))?
                + 1;
            if data.get(start) != Some(&0) {
                return Err(Error::DecodeFailed("invalid PNG ICC compression".into()));
            }
            return fdeflate::decompress_to_vec_bounded(
                &data[start + 1..],
                usize::try_from(cap).unwrap_or(usize::MAX),
            )
            .map(Some)
            .map_err(|error| match error {
                fdeflate::BoundedDecompressionError::OutputTooLarge { .. } => {
                    Error::ResourceLimit("PNG ICC metadata exceeds memory limit".into())
                }
                fdeflate::BoundedDecompressionError::DecompressionError { inner } => {
                    Error::DecodeFailed(format!("PNG ICC inflation failed: {inner:?}").into())
                }
            });
        }
        at += len + 12;
    }
    Ok(None)
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

/// Header inspection does not decode pixel data.
pub(crate) fn inspect(bytes: &[u8], budget: u64) -> Result<(Size, image::ImageFormat), Error> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::DecodeFailed(e.to_string().into()))?;
    let format = reader
        .format()
        .ok_or_else(|| Error::DecodeFailed("unknown tile format".into()))?;
    check_structure(bytes, format)?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(budget);
    reader.limits(limits);
    let (width, height) = reader.into_dimensions().map_err(decode_error)?;
    Ok((Size { width, height }, format))
}

pub(crate) fn decode_error(error: image::ImageError) -> Error {
    match error {
        image::ImageError::Limits(_) => {
            Error::ResourceLimit("tile decoder memory limit exceeded".into())
        }
        error => Error::DecodeFailed(error.to_string().into()),
    }
}

// Bounded structural checks do not decompress pixels or validate entropy/zlib.
fn check_structure(bytes: &[u8], format: image::ImageFormat) -> Result<(), Error> {
    let invalid = || Error::DecodeFailed("truncated or invalid encoded tile structure".into());
    match format {
        image::ImageFormat::Png => {
            let mut pos = 8usize;
            let mut data = false;
            while let Some(header) = bytes.get(pos..pos + 8) {
                let len =
                    u32::from_be_bytes(header[..4].try_into().expect("chunk length")) as usize;
                let end = pos
                    .checked_add(len)
                    .and_then(|v| v.checked_add(12))
                    .ok_or_else(invalid)?;
                if end > bytes.len() {
                    return Err(invalid());
                }
                match &header[4..] {
                    b"IHDR" if pos == 8 && len != 13 => return Err(invalid()),
                    b"IDAT" => data = true,
                    b"IEND" => {
                        return if len == 0 && data {
                            Ok(())
                        } else {
                            Err(invalid())
                        }
                    }
                    _ => {}
                }
                pos = end;
            }
            Err(invalid())
        }
        image::ImageFormat::Jpeg => {
            let mut pos = 2;
            let mut scan = false;
            while bytes.get(pos) == Some(&0xff) {
                while bytes.get(pos) == Some(&0xff) {
                    pos += 1;
                }
                let marker = *bytes.get(pos).ok_or_else(invalid)?;
                pos += 1;
                if marker == 0xd9 {
                    return if scan { Ok(()) } else { Err(invalid()) };
                }
                if marker == 0 || marker == 0xd8 {
                    return Err(invalid());
                }
                if marker == 1 || (0xd0..=0xd7).contains(&marker) {
                    continue;
                }
                let length = bytes.get(pos..pos + 2).ok_or_else(invalid)?;
                let len = u16::from_be_bytes(length.try_into().expect("segment length")) as usize;
                if len < 2 || len > bytes.len().saturating_sub(pos) {
                    return Err(invalid());
                }
                pos += len;
                if marker == 0xda {
                    scan = true;
                    while pos < bytes.len() {
                        if bytes[pos] != 0xff {
                            pos += 1;
                            continue;
                        }
                        let start = pos;
                        while bytes.get(pos) == Some(&0xff) {
                            pos += 1;
                        }
                        let next = *bytes.get(pos).ok_or_else(invalid)?;
                        if next == 0 || (0xd0..=0xd7).contains(&next) {
                            pos += 1;
                        } else {
                            pos = start;
                            break;
                        }
                    }
                }
            }
            Err(invalid())
        }
        _ => Ok(()),
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
                inspect(&bytes, 4096).unwrap().0,
                Size {
                    width: 8,
                    height: 8
                }
            );
            for length in [bytes.len() / 2, bytes.len() - 16, bytes.len() - 1] {
                assert!(matches!(
                    inspect(&bytes[..length], 4096),
                    Err(Error::DecodeFailed(_))
                ));
            }
            let mut broken = bytes.clone();
            let length = if bytes.starts_with(b"\x89PNG") { 8 } else { 4 };
            broken[length..length + 2].fill(0xff);
            assert!(inspect(&broken, 4096).is_err());
        }
    }
}
