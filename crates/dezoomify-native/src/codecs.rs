//! Native image-codec facade. Detection, allocation and metadata are shared by
//! raster composition and compressed-tile outputs. Inspecting headers never
//! decodes pixels; callers run decoding on their blocking worker.
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
) -> ImageResult<Box<dyn ImageDecoder + '_>> {
    let NativeFormat::Image(format) = format else {
        return Ok(Box::new(crate::jpeg2000::Decoder::new(bytes)?));
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.no_limits();
    Ok(Box::new(reader.into_decoder()?))
}

pub(crate) fn decode(bytes: &[u8], format: NativeFormat) -> ImageResult<image::RgbaImage> {
    decode_pixels(decoder(bytes, format)?)
}

pub(crate) fn decode_pixels(decoder: impl ImageDecoder) -> ImageResult<image::RgbaImage> {
    use image::{ColorType, DynamicImage, GenericImageView};
    let (width, height) = decoder.dimensions();
    let color = decoder.color_type();
    let mut bytes = crate::buffers::zeroed(decoder.total_bytes())?;
    decoder.read_image(&mut bytes)?;
    macro_rules! image {
        ($variant:ident) => {
            DynamicImage::$variant(
                image::ImageBuffer::from_raw(width, height, bytes).expect("decoded pixels"),
            )
        };
        ($variant:ident, $sample:ty, $length:literal) => {{
            let mut samples = Vec::<$sample>::new();
            samples
                .try_reserve_exact(bytes.len() / $length)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::OutOfMemory, error))?;
            samples.extend(
                bytes
                    .as_chunks::<$length>()
                    .0
                    .iter()
                    .map(|sample| <$sample>::from_ne_bytes(*sample)),
            );
            drop(bytes);
            DynamicImage::$variant(
                image::ImageBuffer::from_raw(width, height, samples).expect("decoded pixels"),
            )
        }};
    }
    let decoded = match color {
        ColorType::Rgba8 => {
            return Ok(image::RgbaImage::from_raw(width, height, bytes).expect("decoded pixels"))
        }
        ColorType::Rgb8 => image!(ImageRgb8),
        ColorType::L8 => image!(ImageLuma8),
        ColorType::La8 => image!(ImageLumaA8),
        ColorType::Rgb16 => image!(ImageRgb16, u16, 2),
        ColorType::Rgba16 => image!(ImageRgba16, u16, 2),
        ColorType::L16 => image!(ImageLuma16, u16, 2),
        ColorType::La16 => image!(ImageLumaA16, u16, 2),
        ColorType::Rgb32F => image!(ImageRgb32F, f32, 4),
        ColorType::Rgba32F => image!(ImageRgba32F, f32, 4),
        _ => {
            return Err(image::ImageError::Unsupported(
                image::error::UnsupportedError::from_format_and_kind(
                    image::error::ImageFormatHint::Unknown,
                    image::error::UnsupportedErrorKind::Color(color.into()),
                ),
            ))
        }
    };
    let mut rgba = crate::imaging::rgba_pixels(&dezoomify::model::Size { width, height })
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::OutOfMemory, error.to_string()))?;
    for (x, y, pixel) in decoded.pixels() {
        rgba.put_pixel(x, y, pixel);
    }
    Ok(rgba)
}

pub(crate) fn inspect(bytes: &[u8]) -> Result<(Size, NativeFormat), Error> {
    let format = detect(bytes).map_err(decode_error)?;
    check_structure(bytes, format)?;
    let (width, height) = decoder(bytes, format).map_err(decode_error)?.dimensions();
    Ok((Size { width, height }, format))
}

type Metadata = (Option<Vec<u8>>, Option<Vec<u8>>);

pub(crate) fn tile_metadata(bytes: &[u8], format: NativeFormat) -> Result<Metadata, Error> {
    let mut decoder = decoder(bytes, format).map_err(decode_error)?;
    let mut icc = decoder.icc_profile().map_err(decode_error)?;
    let exif = decoder.exif_metadata().map_err(decode_error)?;
    drop(decoder);
    if icc.is_none() && format == NativeFormat::Image(image::ImageFormat::Png) {
        icc = png_icc(bytes)?;
    }

    Ok((icc, exif))
}

// Extract PNG ICC data without decoding pixels.
fn png_icc(bytes: &[u8]) -> Result<Option<Vec<u8>>, Error> {
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
            let mut decoder = flate2::read::ZlibDecoder::new(&data[start + 1..]);
            let mut output = crate::buffers::Buffer::default();
            std::io::copy(&mut decoder, &mut output).map_err(|error| {
                Error::DecodeFailed(format!("PNG ICC inflation failed: {error}").into())
            })?;
            return Ok(Some(output.into_vec()));
        }
        at += len + 12;
    }
    Ok(None)
}

pub(crate) fn decode_error(error: image::ImageError) -> Error {
    match error {
        image::ImageError::IoError(error) if error.kind() == std::io::ErrorKind::OutOfMemory => {
            Error::ResourceLimit(error.to_string().into())
        }
        image::ImageError::Limits(_) => {
            Error::ResourceLimit("tile decoder allocation failed".into())
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

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, ImageFormat};

    #[test]
    fn decoding_preserves_grayscale_alpha_and_sample_depth() {
        let images = [
            DynamicImage::ImageLuma8(ImageBuffer::from_raw(2, 1, vec![0, 253]).unwrap()),
            DynamicImage::ImageLumaA8(ImageBuffer::from_raw(2, 1, vec![17, 0, 253, 129]).unwrap()),
            DynamicImage::ImageRgb8(
                ImageBuffer::from_raw(2, 1, vec![0, 17, 253, 77, 129, 255]).unwrap(),
            ),
            DynamicImage::ImageRgba8(
                ImageBuffer::from_raw(2, 1, vec![0, 17, 253, 0, 77, 129, 255, 129]).unwrap(),
            ),
            DynamicImage::ImageLuma16(ImageBuffer::from_raw(2, 1, vec![129, 65000]).unwrap()),
            DynamicImage::ImageLumaA16(
                ImageBuffer::from_raw(2, 1, vec![129, 0, 65000, 32769]).unwrap(),
            ),
            DynamicImage::ImageRgb16(
                ImageBuffer::from_raw(2, 1, vec![0, 129, 65000, 32769, 50123, 65535]).unwrap(),
            ),
            DynamicImage::ImageRgba16(
                ImageBuffer::from_raw(2, 1, vec![0, 129, 65000, 0, 32769, 50123, 65535, 32769])
                    .unwrap(),
            ),
            DynamicImage::ImageRgb32F(
                ImageBuffer::from_raw(2, 1, vec![0.0, 0.1, 1.0, 0.5, 0.75, 0.99]).unwrap(),
            ),
            DynamicImage::ImageRgba32F(
                ImageBuffer::from_raw(2, 1, vec![0.0, 0.1, 1.0, 0.0, 0.5, 0.75, 0.99, 0.5])
                    .unwrap(),
            ),
        ];
        for source in images {
            let format = if matches!(
                source.color(),
                image::ColorType::Rgb32F | image::ColorType::Rgba32F
            ) {
                ImageFormat::Tiff
            } else {
                ImageFormat::Png
            };
            let mut encoded = Cursor::new(Vec::new());
            source.write_to(&mut encoded, format).unwrap();
            let decoded = decode(encoded.get_ref(), NativeFormat::Image(format)).unwrap();
            assert_eq!(decoded, source.into_rgba8());
        }
    }
}
