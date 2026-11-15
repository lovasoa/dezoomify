//! PDF image eligibility and tile-local lossless fallback. Shared inspection and
//! decoding live in encoded_tile; this module owns PDF filters and color spaces.
use crate::{
    encoded_tile::{tile_metadata, EncodedTile},
    formats::pdf::document::PdfDocument,
    formats::{jpeg::header as jpeg_header, png::header as png_header},
};
use dezoomify::model::{Error, Size};
use flate2::{write::ZlibEncoder, Compression};
use pdf_writer::{Chunk, Filter, Finish, Name, Ref};
use std::{borrow::Cow, io::Write, sync::atomic::AtomicBool};

struct ImageData<'a> {
    bytes: Cow<'a, [u8]>,
    colors: i32,
    filter: Filter,
    predictor: bool,
    transform: Option<i32>,
    alpha: Option<Vec<u8>>,
}

/// Write a complete tile image before returning its reference. No image buffers
/// survive this call. Consume any stored probe pixels; count only fresh decoding,
/// including failures. Probe pixels carry no metadata and retain the full raster.
pub(crate) fn write_tile(
    document: &mut PdfDocument,
    tile: &mut EncodedTile,
    compression: u8,
    cancelled: &AtomicBool,
    decoded: &mut u64,
) -> Result<Ref, Error> {
    let probe_pixels = tile.probe_pixels.take();
    let raw = reusable(tile)?;
    let (icc, _) = tile_metadata(&tile.bytes, tile.format)?;
    let data = match raw {
        Some(data) => data,
        None => {
            let pixels = if let Some(pixels) = probe_pixels {
                pixels
            } else {
                *decoded += 1;
                tile.decode_pixels(&tile.size)?
            };
            convert(&pixels, compression)?
        }
    };
    let profile = write_profile(document, icc.as_deref(), data.colors, cancelled)?;
    let alpha = data
        .alpha
        .as_ref()
        .map(|bytes| {
            let mask = ImageData {
                bytes: Cow::Borrowed(bytes),
                colors: 1,
                filter: Filter::FlateDecode,
                predictor: false,
                transform: None,
                alpha: None,
            };
            write_image(document, &mask, &tile.size, None, None, cancelled)
        })
        .transpose()?;
    let id = write_image(document, &data, &tile.size, profile, alpha, cancelled)?;
    Ok(id)
}

pub(crate) fn can_reuse(tile: &EncodedTile) -> bool {
    jpeg_encoding(&tile.bytes).is_some() || png_colors(&tile.bytes).is_some()
}

fn jpeg_encoding(bytes: &[u8]) -> Option<(i32, Option<i32>)> {
    let header = jpeg_header(bytes)?;
    let transform = match header.channels {
        1 => None,
        3 if header.adobe_transform == Some(0) || header.rgb_ids => Some(0),
        3 if header.jfif
            || header.adobe_transform == Some(1)
            || header.ycbcr_sampling.is_some() =>
        {
            Some(1)
        }
        _ => return None,
    };
    Some((i32::from(header.channels), transform))
}

fn png_colors(bytes: &[u8]) -> Option<i32> {
    let header = png_header(bytes)?;
    (header.bits == 8 && matches!(header.color, 0 | 2) && !header.interlaced && !header.transparent)
        .then_some(if header.color == 0 { 1 } else { 3 })
}

fn reusable(tile: &EncodedTile) -> Result<Option<ImageData<'_>>, Error> {
    if let Some((colors, transform)) = jpeg_encoding(&tile.bytes) {
        return Ok(Some(ImageData {
            bytes: Cow::Borrowed(&tile.bytes),
            colors,
            filter: Filter::DctDecode,
            predictor: false,
            transform,
            alpha: None,
        }));
    }
    let Some(colors) = png_colors(&tile.bytes) else {
        return Ok(None);
    };
    let payload = crate::formats::png::image_data(&tile.bytes)?;
    Ok(Some(ImageData {
        bytes: Cow::Owned(payload),
        colors,
        filter: Filter::FlateDecode,
        predictor: true,
        transform: None,
        alpha: None,
    }))
}

fn convert(pixels: &image::RgbaImage, compression: u8) -> Result<ImageData<'static>, Error> {
    let level = Compression::new(super::super::deflate_level(compression));
    let mut rgb = ZlibEncoder::new(crate::buffers::Buffer::default(), level);
    let transparent = pixels.pixels().any(|pixel| pixel[3] != 255);
    let mut alpha = transparent.then(|| ZlibEncoder::new(crate::buffers::Buffer::default(), level));
    let mut row = Vec::with_capacity(pixels.width() as usize * 3);
    let mut mask = Vec::with_capacity(if transparent {
        pixels.width() as usize
    } else {
        0
    });
    for pixels in pixels.rows() {
        row.clear();
        mask.clear();
        for pixel in pixels {
            row.extend_from_slice(&pixel.0[..3]);
            if transparent {
                mask.push(pixel[3]);
            }
        }
        rgb.write_all(&row).map_err(encoding_failed)?;
        if let Some(alpha) = &mut alpha {
            alpha.write_all(&mask).map_err(encoding_failed)?;
        }
    }
    let alpha = alpha
        .map(|encoder| {
            encoder
                .finish()
                .map(crate::buffers::Buffer::into_vec)
                .map_err(encoding_failed)
        })
        .transpose()?;
    Ok(ImageData {
        bytes: Cow::Owned(rgb.finish().map_err(encoding_failed)?.into_vec()),
        colors: 3,
        filter: Filter::FlateDecode,
        predictor: false,
        transform: None,
        alpha,
    })
}

fn write_profile(
    document: &mut PdfDocument,
    profile: Option<&[u8]>,
    colors: i32,
    cancelled: &AtomicBool,
) -> Result<Option<Ref>, Error> {
    let Some(profile) = profile.filter(|profile| {
        profile.len() >= 128
            && profile.get(16..20) == Some(if colors == 1 { b"GRAY" } else { b"RGB " })
    }) else {
        return Ok(None);
    };
    let id = document.alloc()?;
    let mut chunk = Chunk::new();
    chunk.icc_profile(id, profile).n(colors);
    document.write(id, &chunk, cancelled)?;
    Ok(Some(id))
}

fn write_image(
    document: &mut PdfDocument,
    data: &ImageData<'_>,
    size: &Size,
    profile: Option<Ref>,
    alpha: Option<Ref>,
    cancelled: &AtomicBool,
) -> Result<Ref, Error> {
    let width = i32::try_from(size.width)
        .map_err(|_| Error::ResourceLimit("PDF tile width exceeded".into()))?;
    let height = i32::try_from(size.height)
        .map_err(|_| Error::ResourceLimit("PDF tile height exceeded".into()))?;
    // pdf-writer represents each individual stream length with an i32.
    i32::try_from(data.bytes.len())
        .map_err(|_| Error::ResourceLimit("PDF tile stream length exceeded".into()))?;
    let id = document.alloc()?;
    let mut chunk = Chunk::with_capacity(data.bytes.len() + 512);
    let mut image = chunk.image_xobject(id, &data.bytes);
    image
        .width(width)
        .height(height)
        .bits_per_component(8)
        .filter(data.filter);
    if let Some(profile) = profile {
        image.color_space().icc_based(profile);
    } else {
        image.color_space_name(Name(if data.colors == 1 {
            b"DeviceGray"
        } else {
            b"DeviceRGB"
        }));
    }
    if let Some(alpha) = alpha {
        image.s_mask(alpha);
    }
    if data.predictor {
        image
            .insert(Name(b"DecodeParms"))
            .dict()
            .pair(Name(b"Predictor"), 15)
            .pair(Name(b"Colors"), data.colors)
            .pair(Name(b"BitsPerComponent"), 8)
            .pair(Name(b"Columns"), width);
    } else if let Some(transform) = data.transform {
        image
            .insert(Name(b"DecodeParms"))
            .dict()
            .pair(Name(b"ColorTransform"), transform);
    }
    image.finish();
    document.write(id, &chunk, cancelled)?;
    Ok(id)
}

fn encoding_failed(error: std::io::Error) -> Error {
    Error::EncodeFailed(format!("PDF tile compression failed: {error}").into())
}
