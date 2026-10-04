//! Encoded tile output and bounded, local pyramid conversion. No PixelPipe.
use crate::output::StagedDirectory;
use dezoomify::model::{
    Error, LimitContext, LimitReason, OutputPlan, ReusedTile, Size, TilePlacement,
};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Seek},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) struct EncodedTile {
    pub request: Option<dezoomify::model::ResourceRequest>,
    pub id: u32,
    pub placement: TilePlacement,
    pub bytes: Vec<u8>,
    pub size: Size,
    pub format: image::ImageFormat,
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
    #[test]
    fn region_borrows_already_accounted_encoded_memory() {
        let pixels = image::RgbaImage::from_fn(8, 8, |x, _| {
            if x < 4 {
                image::Rgba([220, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        });
        let bytes = crate::imaging::encode_png(
            &pixels,
            image::codecs::png::CompressionType::Fast,
            None,
            None,
        )
        .unwrap();
        let size = Size {
            width: 8,
            height: 8,
        };
        let rect = Rect {
            x: 0,
            y: 0,
            w: 8,
            h: 8,
        };
        let level = TileLevel {
            size: size.clone(),
            cell: size.clone(),
            regular: true,
            tiles: BTreeMap::from([(
                0,
                StoredTile {
                    rect,
                    size,
                    format: image::ImageFormat::Png,
                    bytes: TileBytes::Memory(bytes),
                },
            )]),
        };
        let mut decoded = 0;
        assert_eq!(
            level
                .region(rect, 8 * 8 * 12, &AtomicBool::new(false), &mut decoded)
                .unwrap(),
            pixels
        );
        assert_eq!(decoded, 1);
        let size = Size {
            width: 4,
            height: 4,
        };
        let rect = Rect {
            x: 0,
            y: 0,
            w: 4,
            h: 4,
        };
        let reduced = downsample(
            &level,
            &size,
            rect,
            4096,
            &AtomicBool::new(false),
            &mut decoded,
        )
        .unwrap();
        let edge = reduced.get_pixel(1, 0);
        assert_eq!(edge[0], 220);
        assert!(edge[3] > 0 && edge[3] < 255);
        assert!(matches!(
            downsample(
                &level,
                &size,
                rect,
                64,
                &AtomicBool::new(false),
                &mut decoded
            ),
            Err(Error::LimitExceeded { .. })
        ));
    }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}
impl Rect {
    fn intersects(self, other: Self) -> bool {
        self.x < other.x.saturating_add(other.w)
            && other.x < self.x.saturating_add(self.w)
            && self.y < other.y.saturating_add(other.h)
            && other.y < self.y.saturating_add(self.h)
    }
}

pub(crate) enum TileBytes {
    File(PathBuf),
    Memory(Vec<u8>),
    Range {
        path: PathBuf,
        offset: u64,
        length: u64,
    },
}
pub(crate) struct StoredTile {
    pub rect: Rect,
    pub size: Size,
    pub format: image::ImageFormat,
    pub bytes: TileBytes,
}
pub(crate) struct TileLevel {
    pub size: Size,
    pub cell: Size,
    pub tiles: BTreeMap<u32, StoredTile>,
    pub regular: bool,
}

pub(crate) fn memory_check(required: u64, budget: u64) -> Result<(), Error> {
    if required > budget {
        Err(Error::LimitExceeded {
            limit: LimitContext {
                reason: LimitReason::Memory,
                dimensions: None,
                bytes_required: Some(required),
                bytes_available: Some(budget),
            },
        })
    } else {
        Ok(())
    }
}

impl TileLevel {
    pub(crate) fn rect(&self, index: u32) -> Rect {
        let columns = self.size.width.div_ceil(self.cell.width);
        let x = (index % columns) * self.cell.width;
        let y = (index / columns) * self.cell.height;
        Rect {
            x,
            y,
            w: self.cell.width.min(self.size.width - x),
            h: self.cell.height.min(self.size.height - y),
        }
    }
    pub(crate) fn count(&self) -> Result<u32, Error> {
        self.size
            .width
            .div_ceil(self.cell.width)
            .checked_mul(self.size.height.div_ceil(self.cell.height))
            .ok_or_else(|| Error::ResourceLimit("output tile count overflow".into()))
    }
    pub(crate) fn region(
        &self,
        rect: Rect,
        budget: u64,
        cancelled: &AtomicBool,
        decoded: &mut u64,
    ) -> Result<image::RgbaImage, Error> {
        let region_bytes = u64::from(rect.w) * u64::from(rect.h) * 4;
        memory_check(region_bytes, budget)?;
        let mut pixels = vec![];
        pixels
            .try_reserve_exact(
                usize::try_from(region_bytes)
                    .map_err(|_| Error::ResourceLimit("region address space exceeded".into()))?,
            )
            .map_err(|_| Error::ResourceLimit("region allocation failed".into()))?;
        pixels.resize(region_bytes as usize, 0);
        let mut region = image::RgbaImage::from_raw(rect.w, rect.h, pixels)
            .ok_or_else(|| Error::Internal("invalid region".into()))?;
        let relevant: Vec<_> = if self.regular {
            let columns = self.size.width.div_ceil(self.cell.width);
            (rect.y / self.cell.height..(rect.y + rect.h).div_ceil(self.cell.height))
                .flat_map(|row| {
                    (rect.x / self.cell.width..(rect.x + rect.w).div_ceil(self.cell.width))
                        .filter_map(move |col| self.tiles.get(&(row * columns + col)))
                })
                .collect()
        } else {
            self.tiles
                .values()
                .filter(|tile| rect.intersects(tile.rect))
                .collect()
        };
        for tile in relevant {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            let encoded_len = match &tile.bytes {
                TileBytes::Memory(_) => 0, // Retained by the caller; borrowed below.
                TileBytes::File(path) => std::fs::metadata(path)
                    .map_err(|e| crate::output::write_failed("tile stat failed", &e))?
                    .len(),
                TileBytes::Range { length, .. } => *length,
            };
            memory_check(
                region_bytes
                    + u64::from(tile.size.width) * u64::from(tile.size.height) * 8
                    + encoded_len,
                budget,
            )?;
            let body;
            let bytes = match &tile.bytes {
                TileBytes::Memory(bytes) => bytes.as_slice(),
                TileBytes::File(path) => {
                    body = std::fs::read(path)
                        .map_err(|e| crate::output::write_failed("tile read failed", &e))?;
                    &body
                }
                TileBytes::Range {
                    path,
                    offset,
                    length,
                } => {
                    let mut file = std::fs::File::open(path)
                        .map_err(|e| crate::output::write_failed("tile range open failed", &e))?;
                    file.seek(std::io::SeekFrom::Start(*offset))
                        .map_err(|e| crate::output::write_failed("tile range seek failed", &e))?;
                    body = {
                        let mut bytes = Vec::new();
                        file.take(*length).read_to_end(&mut bytes).map_err(|e| {
                            crate::output::write_failed("tile range read failed", &e)
                        })?;
                        bytes
                    };
                    if body.len() as u64 != *length {
                        return Err(Error::WriteFailed("truncated encoded tile range".into()));
                    }
                    &body
                }
            };
            // Decode plus RGBA conversion may temporarily own two pixel buffers.
            *decoded += 1;
            let mut reader = image::ImageReader::with_format(Cursor::new(bytes), tile.format);
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(budget.saturating_sub(region_bytes + encoded_len) / 2);
            reader.limits(limits);
            let image = reader.decode().map_err(decode_error)?.into_rgba8();
            let left = rect.x.max(tile.rect.x);
            let top = rect.y.max(tile.rect.y);
            let right = (rect.x + rect.w).min(tile.rect.x + tile.rect.w);
            let bottom = (rect.y + rect.h).min(tile.rect.y + tile.rect.h);
            let cropped = image::imageops::crop_imm(
                &image,
                left - tile.rect.x,
                top - tile.rect.y,
                right - left,
                bottom - top,
            );
            image::imageops::overlay(
                &mut region,
                &*cropped,
                i64::from(left - rect.x),
                i64::from(top - rect.y),
            );
        }
        Ok(region)
    }
}

/// Triangle resampling in global coordinates, so adjacent output tiles agree
/// at their shared edge, including odd image dimensions.
pub(crate) fn downsample(
    source: &TileLevel,
    target: &Size,
    rect: Rect,
    budget: u64,
    cancelled: &AtomicBool,
    decoded: &mut u64,
) -> Result<image::RgbaImage, Error> {
    let rx = f64::from(source.size.width) / f64::from(target.width);
    let ry = f64::from(source.size.height) / f64::from(target.height);
    let output_bytes = u64::from(rect.w) * u64::from(rect.h) * 4;
    let axis_bytes = |length: u32, ratio: f64| {
        u64::from(length)
            * (std::mem::size_of::<Vec<(u32, f64)>>() as u64
                + ((2.0 * ratio).ceil() as u64 + 2) * std::mem::size_of::<(u32, f64)>() as u64)
    };
    let weight_bytes = axis_bytes(rect.w, rx) + axis_bytes(rect.h, ry);
    memory_check(output_bytes + weight_bytes, budget)?;
    let weights = |pixel: u32, ratio: f64, side: u32| -> Vec<(u32, f64)> {
        let center = (f64::from(pixel) + 0.5) * ratio;
        let left = (center - ratio).floor().max(0.0) as u32;
        let right = (center + ratio).ceil().min(f64::from(side)) as u32;
        let mut weights: Vec<_> = (left..right)
            .map(|p| {
                (
                    p,
                    (1.0 - ((f64::from(p) + 0.5 - center) / ratio).abs()).max(0.0),
                )
            })
            .collect();
        let sum: f64 = weights.iter().map(|(_, w)| w).sum();
        for (_, w) in &mut weights {
            *w /= sum;
        }
        weights
    };
    let xs: Vec<_> = (rect.x..rect.x + rect.w)
        .map(|x| weights(x, rx, source.size.width))
        .collect();
    let ys: Vec<_> = (rect.y..rect.y + rect.h)
        .map(|y| weights(y, ry, source.size.height))
        .collect();
    let left = xs[0][0].0;
    let top = ys[0][0].0;
    let right = xs.last().and_then(|v| v.last()).map_or(left, |v| v.0) + 1;
    let bottom = ys.last().and_then(|v| v.last()).map_or(top, |v| v.0) + 1;
    let input = source.region(
        Rect {
            x: left,
            y: top,
            w: right - left,
            h: bottom - top,
        },
        budget - output_bytes - weight_bytes,
        cancelled,
        decoded,
    )?;
    Ok(image::RgbaImage::from_fn(rect.w, rect.h, |x, y| {
        let mut channels = [0.0f64; 4];
        for (sy, wy) in &ys[y as usize] {
            for (sx, wx) in &xs[x as usize] {
                let p = input.get_pixel(*sx - left, *sy - top);
                for c in 0..3 {
                    channels[c] += f64::from(p[c]) * f64::from(p[3]) / 255.0 * wx * wy;
                }
                channels[3] += f64::from(p[3]) * wx * wy;
            }
        }
        if channels[3] > 0.0 {
            for c in 0..3 {
                channels[c] *= 255.0 / channels[3];
            }
        }
        image::Rgba(channels.map(|v| v.round().clamp(0.0, 255.0) as u8))
    }))
}

fn tile_path(
    rect: Rect,
    scale: u32,
    format: image::ImageFormat,
    canvas: &Size,
    explicit: bool,
) -> String {
    let x = rect.x * scale;
    let y = rect.y * scale;
    let w = rect.w.saturating_mul(scale).min(canvas.width - x);
    let h = rect.h.saturating_mul(scale).min(canvas.height - y);
    format!(
        "{x},{y},{w},{h}/{}/0/default.{}",
        if explicit {
            format!("{},{}", rect.w, rect.h)
        } else {
            format!("{},", rect.w)
        },
        if format == image::ImageFormat::Jpeg {
            "jpg"
        } else {
            "png"
        }
    )
}

pub(crate) struct IiifWriter {
    staging: StagedDirectory,
    base: TileLevel,
    budget: u64,
    compression: u8,
    pub(crate) decoded_tiles: u64,
    retained: u64,
    peak_retained: u64,
    infer_canvas: bool,
    max_tiles: u32,
    icc_profile: Option<Vec<u8>>,
    index_bytes: u64,
}

/// Two concrete encoded-tile writers, with one acquisition/publication route.
pub(crate) enum TileWriter {
    Iiif(IiifWriter),
    Zif(crate::zif_output::ZifWriter),
}
impl TileWriter {
    pub(crate) fn release_probe_bytes(&mut self, bytes: u64) {
        match self {
            Self::Iiif(writer) => writer.release_probe_bytes(bytes),
            Self::Zif(writer) => writer.release_probe_bytes(bytes),
        }
    }

    pub(crate) fn peak_retained(&self) -> u64 {
        match self {
            Self::Iiif(writer) => writer.peak_retained(),
            Self::Zif(writer) => writer.peak_retained(),
        }
    }

    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
        budget: u64,
        compression: u8,
        max_tiles: u32,
    ) -> Result<Self, Error> {
        match plan.format {
            dezoomify::model::OutputFormat::IiifDir => {
                IiifWriter::new(destination, plan, budget, compression).map(Self::Iiif)
            }
            dezoomify::model::OutputFormat::Zif => {
                crate::zif_output::ZifWriter::new(destination, plan, budget, compression, max_tiles)
                    .map(Self::Zif)
            }
            _ => Err(Error::InvalidState(
                "encoded tile writer requires IIIF or ZIF".into(),
            )),
        }
    }
    pub(crate) fn place(&mut self, tile: EncodedTile, cancelled: &AtomicBool) -> Result<(), Error> {
        match self {
            Self::Iiif(writer) => writer.place(tile, cancelled),
            Self::Zif(writer) => writer.place(tile, cancelled),
        }
    }
    pub(crate) fn finish(
        self,
        destination: &Path,
        overwrite: bool,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<(Size, u64, u64), Error> {
        match self {
            Self::Iiif(writer) => writer.finish(destination, reused, cancelled),
            Self::Zif(writer) => writer.finish(destination, overwrite, reused, cancelled),
        }
    }
}

impl IiifWriter {
    pub(crate) fn retained_bytes(&self) -> u64 {
        self.retained + self.index_bytes
    }

    pub(crate) fn hold_queued_bytes(&mut self, bytes: u64) -> Result<(), Error> {
        memory_check(self.retained.saturating_add(bytes), self.budget)?;
        self.budget -= bytes;
        Ok(())
    }

    pub(crate) fn release_probe_bytes(&mut self, bytes: u64) {
        self.budget = self.budget.saturating_add(bytes);
    }

    pub(crate) fn peak_retained(&self) -> u64 {
        self.peak_retained
    }

    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
        budget: u64,
        compression: u8,
        max_tiles: u32,
    ) -> Result<Self, Error> {
        if plan
            .canvas
            .as_ref()
            .is_some_and(|size| size.width == 0 || size.height == 0)
        {
            return Err(Error::PlanInvalid(
                "IIIF canvas dimensions must be positive".into(),
            ));
        }
        let regular = plan
            .grid
            .as_ref()
            .is_some_and(|grid| grid.overlap.width == 0 && grid.overlap.height == 0);
        let cell = if regular {
            plan.grid.as_ref().expect("regular grid").tile_size.clone()
        } else {
            Size {
                width: 512,
                height: 512,
            }
        };
        let index_bytes = u64::from(plan.tile_count)
            * (std::mem::size_of::<StoredTile>() + destination.as_os_str().len() + 128) as u64;
        memory_check(index_bytes, budget)?;
        Ok(Self {
            staging: StagedDirectory::new(destination)?,
            base: TileLevel {
                size: plan.canvas.clone().unwrap_or(Size {
                    width: 1,
                    height: 1,
                }),
                cell,
                tiles: BTreeMap::new(),
                regular,
            },
            budget: budget - index_bytes,
            compression,
            decoded_tiles: 0,
            retained: 0,
            peak_retained: index_bytes,
            infer_canvas: plan.canvas.is_none(),
            max_tiles,
            icc_profile: None,
            index_bytes,
        })
    }

    pub(crate) fn place(
        &mut self,
        mut tile: EncodedTile,
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        let extent = tile.placement.expected_size.as_ref().unwrap_or(&tile.size);
        let mut rect = Rect {
            x: tile.placement.position.x,
            y: tile.placement.position.y,
            w: extent.width.min(tile.size.width),
            h: extent.height.min(tile.size.height),
        };
        if !self.infer_canvas {
            rect.w = rect.w.min(self.base.size.width.saturating_sub(rect.x));
            rect.h = rect.h.min(self.base.size.height.saturating_sub(rect.y));
        }
        if rect.w == 0 || rect.h == 0 {
            return Ok(());
        }
        memory_check(self.retained + tile.bytes.len() as u64, self.budget)?;
        let index = if self.base.regular {
            (rect.y / self.base.cell.height) * self.base.size.width.div_ceil(self.base.cell.width)
                + rect.x / self.base.cell.width
        } else {
            tile.id
        };
        let mut compatible = matches!(
            tile.format,
            image::ImageFormat::Jpeg | image::ImageFormat::Png
        ) && tile.size.width == rect.w
            && tile.size.height == rect.h
            && self.base.regular
            && rect == self.base.rect(index);
        if !compatible {
            self.decoded_tiles += 1;
            tile.convert_to_png(
                Size {
                    width: rect.w,
                    height: rect.h,
                },
                self.budget.saturating_sub(self.retained),
                self.compression,
            )?;
            compatible = self.base.regular && rect == self.base.rect(index);
        }
        let bytes = if compatible {
            TileBytes::File(self.write_tile(
                rect,
                1,
                tile.format,
                &self.base.size,
                &tile.bytes,
                cancelled,
            )?)
        } else {
            self.retained += tile.bytes.len() as u64;
            self.peak_retained = self.peak_retained.max(self.retained_bytes());
            memory_check(self.retained, self.budget)?;
            TileBytes::Memory(tile.bytes)
        };
        if self.infer_canvas {
            self.base.size.width = self.base.size.width.max(rect.x.saturating_add(rect.w));
            self.base.size.height = self.base.size.height.max(rect.y.saturating_add(rect.h));
        }
        self.base.tiles.insert(
            index,
            StoredTile {
                rect,
                size: tile.size,
                format: tile.format,
                bytes,
            },
        );
        Ok(())
    }

    fn write_tile(
        &self,
        rect: Rect,
        scale: u32,
        format: image::ImageFormat,
        canvas: &Size,
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<PathBuf, Error> {
        // Different pyramid levels can request the same clipped corner.
        // Reuse its existing payload; writing would also truncate its aliases.
        let existing = self
            .staging
            .path
            .join(tile_path(rect, scale, format, canvas, false));
        if existing.is_file() {
            return Ok(existing);
        }
        let path = self.staging.write(
            &tile_path(rect, scale, format, canvas, false),
            bytes,
            cancelled,
        )?;
        self.staging.alias(
            &path,
            &tile_path(rect, scale, format, canvas, true),
            bytes,
            cancelled,
        )?;
        Ok(path)
    }

    fn encode_tile(
        &self,
        rect: Rect,
        scale: u32,
        canvas: &Size,
        pixels: &image::RgbaImage,
        format: image::ImageFormat,
        cancelled: &AtomicBool,
    ) -> Result<PathBuf, Error> {
        memory_check(
            pixels.as_raw().len() as u64 + self.icc_profile.as_ref().map_or(0, Vec::len) as u64 * 3,
            self.budget.saturating_sub(self.retained),
        )?;
        let relative = tile_path(rect, scale, format, canvas, false);
        let public = self.staging.path.join(&relative);
        // Public edge routes can coincide across levels. Preserve their first
        // payload, but keep the generated pixels for the next resampling pass.
        let collision = public.is_file();
        let path = if collision {
            self.staging
                .path
                .join(format!(".pyramid/{scale}/{},{}", rect.x, rect.y))
        } else {
            public
        };
        let mut file = crate::output::StagedFile::new(&path)?;
        // Stream compressed bytes instead of retaining a second tile buffer.
        let result = if format == image::ImageFormat::Jpeg {
            crate::imaging::encode_jpeg_to(
                file.writer(cancelled),
                pixels,
                100 - self.compression,
                self.icc_profile.as_deref(),
            )
        } else {
            crate::imaging::encode_png_to(
                file.writer(cancelled),
                pixels,
                crate::imaging::png_compression_for(self.compression),
                self.icc_profile.as_deref(),
                None,
            )
        };
        file.check_error()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result?;
        file.publish(&path, false, cancelled)?;
        if !collision {
            self.staging.alias_file(
                &path,
                &tile_path(rect, scale, format, canvas, true),
                cancelled,
            )?;
        }
        Ok(path)
    }

    pub(crate) fn finish(
        mut self,
        destination: &Path,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<(Size, u64, u64), Error> {
        if !self.base.regular {
            let mut tiles = BTreeMap::new();
            for (index, tile) in std::mem::take(&mut self.base.tiles) {
                let index = reused
                    .iter()
                    .find(|reuse| {
                        reuse.position.x == tile.rect.x && reuse.position.y == tile.rect.y
                    })
                    .map_or(index, |reuse| reuse.index);
                tiles.insert(index, tile);
            }
            self.base.tiles = tiles;
        }
        let format = if self
            .base
            .tiles
            .values()
            .all(|tile| tile.format == image::ImageFormat::Jpeg)
        {
            image::ImageFormat::Jpeg
        } else {
            image::ImageFormat::Png
        };
        let mut normalized = TileLevel {
            size: self.base.size.clone(),
            cell: self.base.cell.clone(),
            tiles: BTreeMap::new(),
            regular: true,
        };
        if normalized.count()? > self.max_tiles {
            return Err(Error::ResourceLimit(
                "IIIF output tile count exceeds max_tiles".into(),
            ));
        }
        let indexes = u64::from(normalized.count()?)
            * 2
            * (std::mem::size_of::<StoredTile>() + self.staging.path.as_os_str().len() + 128)
                as u64;
        let growth = indexes.saturating_sub(self.index_bytes);
        memory_check(self.retained + growth, self.budget)?;
        self.budget -= growth;
        self.index_bytes += growth;
        // Acquisition has settled and reused probes now have their final order.
        // Read just one profile at a time; no completion-order metadata cache.
        for tile in self.base.tiles.values() {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            let body;
            let bytes = if let TileBytes::Memory(bytes) = &tile.bytes {
                bytes.as_slice()
            } else if let TileBytes::File(path) = &tile.bytes {
                let len = std::fs::metadata(path)
                    .map_err(|e| crate::output::write_failed("tile stat failed", &e))?
                    .len();
                memory_check(self.retained + len, self.budget)?;
                body = std::fs::read(path)
                    .map_err(|e| crate::output::write_failed("tile read failed", &e))?;
                &body
            } else {
                return Err(Error::Internal("unexpected IIIF tile storage".into()));
            };
            let extra = if matches!(tile.bytes, TileBytes::Memory(_)) {
                0
            } else {
                bytes.len() as u64
            };
            let budget = self.budget.saturating_sub(self.retained + extra);
            if let (Some(icc), _) = tile_metadata(bytes, tile.format, budget)? {
                self.retained += icc.len() as u64;
                self.icc_profile = Some(icc);
                break;
            }
        }
        for index in 0..normalized.count()? {
            let rect = normalized.rect(index);
            let existing = self.base.tiles.get(&index).filter(|tile| {
                self.base.regular
                    && tile.rect == rect
                    && tile.format == format
                    && matches!(tile.bytes, TileBytes::File(_))
            });
            let stored = if let Some(tile) = existing {
                let TileBytes::File(path) = &tile.bytes else {
                    unreachable!()
                };
                StoredTile {
                    rect,
                    size: tile.size.clone(),
                    format,
                    bytes: TileBytes::File(path.clone()),
                }
            } else {
                let pixels = self.base.region(
                    rect,
                    self.budget.saturating_sub(self.retained),
                    cancelled,
                    &mut self.decoded_tiles,
                )?;
                StoredTile {
                    rect,
                    size: Size {
                        width: rect.w,
                        height: rect.h,
                    },
                    format,
                    bytes: TileBytes::File(self.encode_tile(
                        rect,
                        1,
                        &normalized.size,
                        &pixels,
                        format,
                        cancelled,
                    )?),
                }
            };
            normalized.tiles.insert(index, stored);
        }
        // Conversion may read any source tile; remove superseded payloads only
        // after all normalized base tiles have been produced.
        for tile in self.base.tiles.values().filter(|t| t.format != format) {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            if let TileBytes::File(path) = &tile.bytes {
                for path in [
                    path.clone(),
                    self.staging.path.join(tile_path(
                        tile.rect,
                        1,
                        tile.format,
                        &self.base.size,
                        true,
                    )),
                ] {
                    std::fs::remove_file(path).map_err(|e| {
                        crate::output::write_failed("obsolete tile removal failed", &e)
                    })?;
                }
            }
        }
        self.base = normalized;
        self.retained = self.icc_profile.as_ref().map_or(0, Vec::len) as u64;
        let full_size = self.base.size.clone();
        let mut factors = vec![1u32];
        let cell = self.base.cell.clone();
        let mut level = std::mem::replace(
            &mut self.base,
            TileLevel {
                size: full_size.clone(),
                cell,
                tiles: BTreeMap::new(),
                regular: true,
            },
        );
        while level.size.width > level.cell.width || level.size.height > level.cell.height {
            let scale = factors.last().copied().unwrap_or(1) * 2;
            let mut next = TileLevel {
                size: Size {
                    width: level.size.width.div_ceil(2),
                    height: level.size.height.div_ceil(2),
                },
                cell: level.cell.clone(),
                tiles: BTreeMap::new(),
                regular: true,
            };
            for index in 0..next.count()? {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(Error::Cancelled);
                }
                let rect = next.rect(index);
                let pixels = downsample(
                    &level,
                    &next.size,
                    rect,
                    self.budget.saturating_sub(self.retained),
                    cancelled,
                    &mut self.decoded_tiles,
                )?;
                let path = self.encode_tile(rect, scale, &full_size, &pixels, format, cancelled)?;
                next.tiles.insert(
                    index,
                    StoredTile {
                        rect,
                        size: Size {
                            width: rect.w,
                            height: rect.h,
                        },
                        format,
                        bytes: TileBytes::File(path),
                    },
                );
            }
            factors.push(scale);
            level = next;
        }
        // A real overview at the smallest advertised size. The full-size
        // response remains available through the tile API, without JPEG's cap.
        let tile = level.tiles.values().next().expect("complete lowest level");
        let TileBytes::File(path) = &tile.bytes else {
            unreachable!()
        };
        let ext = if format == image::ImageFormat::Jpeg {
            "jpg"
        } else {
            "png"
        };
        let overview = format!("full/{},/0/default.{ext}", level.size.width);
        self.staging.alias_file(path, &overview, cancelled)?;
        self.staging.alias_file(
            path,
            &format!(
                "full/{},{}/0/default.{ext}",
                level.size.width, level.size.height
            ),
            cancelled,
        )?;
        if level.size == full_size {
            self.staging
                .alias_file(path, &format!("full/full/0/default.{ext}"), cancelled)?;
        }
        let intermediate = self.staging.path.join(".pyramid");
        if intermediate.exists() {
            std::fs::remove_dir_all(intermediate)
                .map_err(|e| crate::output::write_failed("pyramid cleanup failed", &e))?;
        }
        let capabilities = serde_json::json!({"formats": [ext], "qualities": ["default"], "supports": ["sizeByWhListed"]});
        let profile = if format == image::ImageFormat::Jpeg {
            serde_json::json!(["http://iiif.io/api/image/2/level0.json", capabilities])
        } else {
            serde_json::json!([capabilities])
        };
        let info = serde_json::to_vec_pretty(&serde_json::json!({
            "@context": "http://iiif.io/api/image/2/context.json", "@id": ".",
            "protocol": "http://iiif.io/api/image", "width": full_size.width, "height": full_size.height,
            "tiles": [{ "width": self.base.cell.width, "height": self.base.cell.height, "scaleFactors": factors }],
            "sizes": [{"width": level.size.width, "height": level.size.height}],
            "preferredFormats": [ext], "profile": profile
        })).map_err(|e| Error::EncodeFailed(e.to_string().into()))?;
        self.staging.write("info.json", &info, cancelled)?;
        let bytes = crate::output::directory_bytes(&self.staging.path, cancelled)?;
        self.staging.publish(destination, cancelled)?;
        Ok((full_size, bytes, self.decoded_tiles))
    }
}
