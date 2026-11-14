//! PDF image eligibility and tile-local lossless fallback. Shared inspection and
//! decoding live in encoded_tile; this module owns PDF filters and color spaces.
use crate::{
    encoded_tile::{jpeg_header, png_header, tile_metadata, EncodedTile},
    pdf_document::PdfDocument,
    tile_budget::memory_check,
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
/// survive this call. Record pixel decoding before it starts, including failures.
pub(crate) fn write_tile(
    document: &mut PdfDocument,
    tile: &EncodedTile,
    budget: u64,
    compression: u8,
    cancelled: &AtomicBool,
    decoded: &mut u64,
) -> Result<Ref, Error> {
    memory_check(tile.bytes.len() as u64 * 3 + (64 << 10), budget)?;
    let raw = reusable(tile);
    let workspace = if raw.is_some() {
        0
    } else {
        u64::from(tile.size.width) * u64::from(tile.size.height) * 16
    };
    memory_check(tile.bytes.len() as u64 * 3 + workspace + (64 << 10), budget)?;
    let (icc, _) = tile_metadata(
        &tile.bytes,
        tile.format,
        budget.saturating_sub(tile.bytes.len() as u64 * 3 + workspace),
    )?;
    let data = match raw {
        Some(data) => data,
        None => {
            *decoded += 1;
            convert(tile, budget, compression)?
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

fn reusable(tile: &EncodedTile) -> Option<ImageData<'_>> {
    if let Some((colors, transform)) = jpeg_encoding(&tile.bytes) {
        return Some(ImageData {
            bytes: Cow::Borrowed(&tile.bytes),
            colors,
            filter: Filter::DctDecode,
            predictor: false,
            transform,
            alpha: None,
        });
    }
    let colors = png_colors(&tile.bytes)?;
    let mut payload = Vec::new();
    let mut at = 8usize;
    while let Some(chunk) = tile.bytes.get(at..at.checked_add(8)?) {
        let length = u32::from_be_bytes(chunk[..4].try_into().ok()?) as usize;
        if &chunk[4..] == b"IDAT" {
            payload.extend_from_slice(tile.bytes.get(at + 8..at + 8 + length)?);
        }
        at = at.checked_add(length)?.checked_add(12)?;
    }
    Some(ImageData {
        bytes: Cow::Owned(payload),
        colors,
        filter: Filter::FlateDecode,
        predictor: true,
        transform: None,
        alpha: None,
    })
}

fn convert(tile: &EncodedTile, budget: u64, compression: u8) -> Result<ImageData<'static>, Error> {
    let pixels = tile.decode_pixels(&tile.size, budget)?;
    let level = Compression::new(match compression {
        0..=19 => 1,
        20..=60 => 6,
        _ => 9,
    });
    let mut rgb = ZlibEncoder::new(Vec::new(), level);
    let transparent = pixels.pixels().any(|pixel| pixel[3] != 255);
    let mut alpha = transparent.then(|| ZlibEncoder::new(Vec::new(), level));
    let mut row = Vec::with_capacity(tile.size.width as usize * 3);
    let mut mask = Vec::with_capacity(tile.size.width as usize);
    for pixels in pixels.rows() {
        row.clear();
        mask.clear();
        for pixel in pixels {
            row.extend_from_slice(&pixel.0[..3]);
            mask.push(pixel[3]);
        }
        rgb.write_all(&row).map_err(encoding_failed)?;
        if let Some(alpha) = &mut alpha {
            alpha.write_all(&mask).map_err(encoding_failed)?;
        }
    }
    let alpha = alpha
        .map(|encoder| encoder.finish().map_err(encoding_failed))
        .transpose()?;
    Ok(ImageData {
        bytes: Cow::Owned(rgb.finish().map_err(encoding_failed)?),
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
