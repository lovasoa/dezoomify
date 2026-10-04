//! Encoded tile output and bounded, local pyramid conversion. No PixelPipe.
use crate::output::StagedDirectory;
use dezoomify::model::{
    Error, LimitContext, LimitReason, OutputPlan, ReusedTile, Size, TilePlacement,
};
use std::{
    collections::BTreeMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) struct EncodedTile {
    pub id: u32,
    pub placement: TilePlacement,
    pub bytes: Vec<u8>,
    pub size: Size,
    pub format: image::ImageFormat,
}

/// Header inspection does not decode pixel data.
pub(crate) fn inspect(bytes: &[u8]) -> Result<(Size, image::ImageFormat), Error> {
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::DecodeFailed(e.to_string().into()))?;
    let format = reader
        .format()
        .ok_or_else(|| Error::DecodeFailed("unknown tile format".into()))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| Error::DecodeFailed(e.to_string().into()))?;
    Ok((Size { width, height }, format))
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
                TileBytes::Memory(bytes) => bytes.len() as u64,
                TileBytes::File(path) => std::fs::metadata(path)
                    .map_err(|e| crate::output::write_failed("tile stat failed", &e))?
                    .len(),
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
            };
            // Decode plus RGBA conversion may temporarily own two pixel buffers.
            memory_check(
                region_bytes
                    + u64::from(tile.size.width) * u64::from(tile.size.height) * 8
                    + bytes.len() as u64,
                budget,
            )?;
            let image = image::load_from_memory(bytes)
                .map_err(|e| Error::DecodeFailed(e.to_string().into()))?
                .to_rgba8();
            *decoded += 1;
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
    let output_bytes = u64::from(rect.w) * u64::from(rect.h) * 4;
    memory_check(output_bytes, budget)?;
    let input = source.region(
        Rect {
            x: left,
            y: top,
            w: right - left,
            h: bottom - top,
        },
        budget - output_bytes,
        cancelled,
        decoded,
    )?;
    Ok(image::RgbaImage::from_fn(rect.w, rect.h, |x, y| {
        let mut channels = [0.0f64; 4];
        for (sy, wy) in &ys[y as usize] {
            for (sx, wx) in &xs[x as usize] {
                let p = input.get_pixel(*sx - left, *sy - top);
                for c in 0..4 {
                    channels[c] += f64::from(p[c]) * wx * wy;
                }
            }
        }
        image::Rgba(channels.map(|v| v.round().clamp(0.0, 255.0) as u8))
    }))
}

fn tile_path(rect: Rect, scale: u32, format: image::ImageFormat, canvas: &Size) -> String {
    let x = rect.x * scale;
    let y = rect.y * scale;
    let w = rect.w.saturating_mul(scale).min(canvas.width - x);
    let h = rect.h.saturating_mul(scale).min(canvas.height - y);
    format!(
        "{x},{y},{w},{h}/{},/0/default.{}",
        rect.w,
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
    pub(crate) encoded_bytes: u64,
    pub(crate) decoded_tiles: u64,
    retained: u64,
}

impl IiifWriter {
    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
        budget: u64,
        compression: u8,
    ) -> Result<Self, Error> {
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
            budget,
            compression,
            encoded_bytes: 0,
            decoded_tiles: 0,
            retained: 0,
        })
    }

    pub(crate) fn place(&mut self, tile: EncodedTile, cancelled: &AtomicBool) -> Result<(), Error> {
        let extent = tile.placement.expected_size.as_ref().unwrap_or(&tile.size);
        let rect = Rect {
            x: tile.placement.position.x,
            y: tile.placement.position.y,
            w: extent.width.min(tile.size.width),
            h: extent.height.min(tile.size.height),
        };
        let index = if self.base.regular {
            (rect.y / self.base.cell.height) * self.base.size.width.div_ceil(self.base.cell.width)
                + rect.x / self.base.cell.width
        } else {
            tile.id
        };
        let compatible = matches!(
            tile.format,
            image::ImageFormat::Jpeg | image::ImageFormat::Png
        ) && tile.size.width == rect.w
            && tile.size.height == rect.h
            && self.base.regular
            && rect == self.base.rect(index);
        let bytes = if compatible {
            let relative = tile_path(rect, 1, tile.format, &self.base.size);
            self.encoded_bytes += tile.bytes.len() as u64;
            TileBytes::File(self.staging.write(&relative, &tile.bytes, cancelled)?)
        } else {
            self.retained += tile.bytes.len() as u64;
            memory_check(self.retained, self.budget)?;
            TileBytes::Memory(tile.bytes)
        };
        self.base.size.width = self.base.size.width.max(rect.x.saturating_add(rect.w));
        self.base.size.height = self.base.size.height.max(rect.y.saturating_add(rect.h));
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

    fn encode(
        &self,
        pixels: &image::RgbaImage,
        format: image::ImageFormat,
    ) -> Result<Vec<u8>, Error> {
        if format == image::ImageFormat::Jpeg {
            crate::imaging::encode_jpeg(pixels, 100 - self.compression, None)
        } else {
            crate::imaging::encode_png(
                pixels,
                crate::imaging::png_compression_for(self.compression),
                None,
                None,
            )
        }
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
        memory_check(
            u64::from(normalized.count()?) * std::mem::size_of::<StoredTile>() as u64,
            self.budget,
        )?;
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
                let bytes = self.encode(&pixels, format)?;
                self.encoded_bytes += bytes.len() as u64;
                StoredTile {
                    rect,
                    size: Size {
                        width: rect.w,
                        height: rect.h,
                    },
                    format,
                    bytes: TileBytes::File(self.staging.write(
                        &tile_path(rect, 1, format, &normalized.size),
                        &bytes,
                        cancelled,
                    )?),
                }
            };
            normalized.tiles.insert(index, stored);
        }
        self.base = normalized;
        self.retained = 0;
        let full_size = self.base.size.clone();
        let mut factors = vec![1u32];
        let mut level = &self.base;
        let mut generated: Vec<TileLevel> = Vec::new();
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
                    level,
                    &next.size,
                    rect,
                    self.budget,
                    cancelled,
                    &mut self.decoded_tiles,
                )?;
                let bytes = self.encode(&pixels, format)?;
                self.encoded_bytes += bytes.len() as u64;
                let path = self.staging.write(
                    &tile_path(rect, scale, format, &full_size),
                    &bytes,
                    cancelled,
                )?;
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
            generated.push(next);
            level = generated.last().expect("generated level");
        }
        // A real overview at the smallest advertised size. The full-size
        // response remains available through the tile API, without JPEG's cap.
        let tile = level.tiles.values().next().expect("complete lowest level");
        let TileBytes::File(path) = &tile.bytes else {
            unreachable!()
        };
        let bytes = std::fs::read(path)
            .map_err(|e| crate::output::write_failed("overview read failed", &e))?;
        let ext = if format == image::ImageFormat::Jpeg {
            "jpg"
        } else {
            "png"
        };
        let overview = format!("full/{},/0/default.{ext}", level.size.width);
        self.staging.write(&overview, &bytes, cancelled)?;
        self.staging.write(
            &format!(
                "full/{},{}/0/default.{ext}",
                level.size.width, level.size.height
            ),
            &bytes,
            cancelled,
        )?;
        self.encoded_bytes += bytes.len() as u64;
        let info = serde_json::to_vec_pretty(&serde_json::json!({
            "@context": "http://iiif.io/api/image/2/context.json", "@id": destination.file_name().and_then(|v| v.to_str()).unwrap_or("image"),
            "protocol": "http://iiif.io/api/image", "width": full_size.width, "height": full_size.height,
            "tiles": [{ "width": self.base.cell.width, "height": self.base.cell.height, "scaleFactors": factors }],
            "sizes": [{"width": level.size.width, "height": level.size.height}],
            "preferredFormats": [ext], "profile": ["http://iiif.io/api/image/2/level0.json", {"formats": [ext], "qualities": ["default"]}]
        })).map_err(|e| Error::EncodeFailed(e.to_string().into()))?;
        self.staging.write("info.json", &info, cancelled)?;
        self.encoded_bytes += info.len() as u64;
        self.staging.publish(destination, cancelled)?;
        Ok((full_size, self.encoded_bytes, self.decoded_tiles))
    }
}
