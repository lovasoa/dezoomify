//! Native image-codec facade. Detection, limits and metadata are shared by
//! raster composition and compressed-tile outputs. Inspecting headers never
//! decodes pixels; callers run decoding on their blocking worker.
use crate::tile_budget::memory_check;
use dezoomify::model::{Error, Size};
use image::{ImageDecoder, ImageResult};
use std::io::Cursor;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeFormat {
    Image(image::ImageFormat),
    Jpeg2000,
}

pub(crate) fn detect(bytes: &[u8]) -> ImageResult<NativeFormat> {
    if openjp2::detect_format(bytes).is_ok() {
        return Ok(NativeFormat::Jpeg2000);
    }
    image::guess_format(bytes).map(NativeFormat::Image)
}

pub(crate) fn decoder(
    bytes: &[u8],
    format: NativeFormat,
    max_alloc: Option<u64>,
) -> ImageResult<Box<dyn ImageDecoder + '_>> {
    let NativeFormat::Image(format) = format else {
        return Ok(Box::new(crate::jpeg2000::Decoder::new(bytes, max_alloc)?));
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = max_alloc;
    reader.limits(limits);
    Ok(Box::new(reader.into_decoder()?))
}

pub(crate) fn decode(
    bytes: &[u8],
    format: NativeFormat,
    max_alloc: Option<u64>,
) -> ImageResult<image::RgbaImage> {
    image::DynamicImage::from_decoder(decoder(bytes, format, max_alloc)?)
        .map(image::DynamicImage::into_rgba8)
}

pub(crate) fn inspect(bytes: &[u8], budget: u64) -> Result<(Size, NativeFormat), Error> {
    let format = detect(bytes).map_err(decode_error)?;
    check_structure(bytes, format)?;
    let (width, height) = decoder(bytes, format, Some(budget))
        .map_err(decode_error)?
        .dimensions();
    Ok((Size { width, height }, format))
}

type Metadata = (Option<Vec<u8>>, Option<Vec<u8>>);

pub(crate) fn tile_metadata(
    bytes: &[u8],
    format: NativeFormat,
    budget: u64,
) -> Result<Metadata, Error> {
    let mut decoder = decoder(bytes, format, Some(budget / 3)).map_err(decode_error)?;
    let mut icc = decoder.icc_profile().map_err(decode_error)?;
    let exif = decoder.exif_metadata().map_err(decode_error)?;
    drop(decoder);
    if icc.is_none() && format == NativeFormat::Image(image::ImageFormat::Png) {
        icc = png_icc(bytes, budget / 3)?;
    }
    memory_check(
        (icc.as_ref().map_or(0, Vec::len) as u64 + exif.as_ref().map_or(0, Vec::len) as u64) * 3,
        budget,
    )?;
    Ok((icc, exif))
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

pub(crate) fn decode_error(error: image::ImageError) -> Error {
    match error {
        image::ImageError::Limits(_) => {
            Error::ResourceLimit("tile decoder memory limit exceeded".into())
        }
        error => Error::DecodeFailed(error.to_string().into()),
    }
}

// Bounded structural checks do not decompress pixels or validate entropy/zlib.
fn check_structure(bytes: &[u8], format: NativeFormat) -> Result<(), Error> {
    let invalid = || Error::DecodeFailed("truncated or invalid encoded tile structure".into());
    match format {
        NativeFormat::Image(image::ImageFormat::Png) => {
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
        NativeFormat::Image(image::ImageFormat::Jpeg) => {
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
