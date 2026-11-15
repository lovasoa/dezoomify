//! Stored tile geometry, bounded region composition, and pyramid resampling.
use crate::codecs::{decode_error, NativeFormat};
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
        cancelled: &AtomicBool,
        decoded: &mut u64,
    ) -> Result<image::RgbaImage, Error> {
        let mut region = crate::imaging::rgba_pixels(&Size {
            width: rect.w,
            height: rect.h,
        })?;
        let relevant: Box<dyn Iterator<Item = &StoredTile> + '_> = if self.regular {
            let columns = self.size.width.div_ceil(self.cell.width);
            Box::new(
                (rect.y / self.cell.height..(rect.y + rect.h).div_ceil(self.cell.height)).flat_map(
                    move |row| {
                        (rect.x / self.cell.width..(rect.x + rect.w).div_ceil(self.cell.width))
                            .filter_map(move |col| self.tiles.get(&(row * columns + col)))
                    },
                ),
            )
        } else {
            Box::new(
                self.tiles
                    .values()
                    .filter(|tile| rect.intersects(tile.rect)),
            )
        };
        for tile in relevant {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            let mut body;
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
                    body = crate::buffers::zeroed(*length)
                        .map_err(crate::buffers::allocation_error)?;
                    file.read_exact(&mut body)
                        .map_err(|e| crate::output::write_failed("tile range read failed", &e))?;
                    &body
                }
            };
            // Decode plus RGBA conversion may temporarily own two pixel buffers.
            *decoded += 1;
            let image = crate::codecs::decode(bytes, tile.format).map_err(decode_error)?;
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
    cancelled: &AtomicBool,
    decoded: &mut u64,
) -> Result<image::RgbaImage, Error> {
    let rx = f64::from(source.size.width) / f64::from(target.width);
    let ry = f64::from(source.size.height) / f64::from(target.height);
    let weights = |pixel: u32, ratio: f64, side: u32| -> Result<Vec<(u32, f64)>, Error> {
        let center = (f64::from(pixel) + 0.5) * ratio;
        let left = (center - ratio).floor().max(0.0) as u32;
        let right = (center + ratio).ceil().min(f64::from(side)) as u32;
        let mut weights = Vec::new();
        weights
            .try_reserve_exact((right - left) as usize)
            .map_err(crate::buffers::allocation_error)?;
        weights.extend((left..right).map(|p| {
            (
                p,
                (1.0 - ((f64::from(p) + 0.5 - center) / ratio).abs()).max(0.0),
            )
        }));
        let sum: f64 = weights.iter().map(|(_, w)| w).sum();
        for (_, w) in &mut weights {
            *w /= sum;
        }
        Ok(weights)
    };
    let mut xs = Vec::new();
    xs.try_reserve_exact(rect.w as usize)
        .map_err(crate::buffers::allocation_error)?;
    for x in rect.x..rect.x + rect.w {
        xs.push(weights(x, rx, source.size.width)?);
    }
    let mut ys = Vec::new();
    ys.try_reserve_exact(rect.h as usize)
        .map_err(crate::buffers::allocation_error)?;
    for y in rect.y..rect.y + rect.h {
        ys.push(weights(y, ry, source.size.height)?);
    }
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
        cancelled,
        decoded,
    )?;
    let mut output = crate::imaging::rgba_pixels(&Size {
        width: rect.w,
        height: rect.h,
    })?;
    for (x, y, output_pixel) in output.enumerate_pixels_mut() {
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
        *output_pixel = image::Rgba(channels.map(|v| v.round().clamp(0.0, 255.0) as u8));
    }
    Ok(output)
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
                .region(rect, &AtomicBool::new(false), &mut decoded)
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
        let reduced =
            downsample(&level, &size, rect, &AtomicBool::new(false), &mut decoded).unwrap();
        let edge = reduced.get_pixel(1, 0);
        assert_eq!(edge[0], 220);
        assert!(edge[3] > 0 && edge[3] < 255);
    }
}
