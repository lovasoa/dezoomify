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
    if crate::formats::jpeg2000::matches(bytes) {
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
        return Ok(Box::new(crate::formats::jpeg2000::Decoder::new(
            bytes, max_alloc,
        )?));
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
    match format {
        NativeFormat::Image(image::ImageFormat::Png) => {
            crate::formats::png::check_structure(bytes)?
        }
        NativeFormat::Image(image::ImageFormat::Jpeg) => {
            crate::formats::jpeg::check_structure(bytes)?
        }
        _ => {}
    }
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
        icc = crate::formats::png::icc_profile(bytes, budget / 3)?;
    }
    memory_check(
        (icc.as_ref().map_or(0, Vec::len) as u64 + exif.as_ref().map_or(0, Vec::len) as u64) * 3,
        budget,
    )?;
    Ok((icc, exif))
}

pub(crate) fn decode_error(error: image::ImageError) -> Error {
    match error {
        image::ImageError::Limits(_) => {
            Error::ResourceLimit("tile decoder memory limit exceeded".into())
        }
        error => Error::DecodeFailed(error.to_string().into()),
    }
}
