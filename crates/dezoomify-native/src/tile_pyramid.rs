//! Stored tile geometry, bounded region composition, and pyramid resampling.
use crate::{
    codecs::{decode_error, NativeFormat},
    tile_budget::memory_check,
};
use dezoomify::model::{Error, Size};
use std::{
    collections::BTreeMap,
    io::{Read, Seek},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) use crate::tile_geometry::Rect;

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
    pub format: NativeFormat,
    pub bytes: TileBytes,
}
pub(crate) struct TileLevel {
    pub size: Size,
    pub cell: Size,
    pub tiles: BTreeMap<u32, StoredTile>,
    pub regular: bool,
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
            let image = crate::codecs::decode(
                bytes,
                tile.format,
                Some(budget.saturating_sub(region_bytes + encoded_len) / 2),
            )
            .map_err(decode_error)?;
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

#[cfg(test)]
mod tests {
    use super::*;
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
                    format: NativeFormat::Image(image::ImageFormat::Png),
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
