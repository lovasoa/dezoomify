//! Baseline ZIF: tiled BigTIFF with self-contained JPEG or RGB PNG payloads.
use crate::{
    output::StagedFile,
    tile_output::{downsample, memory_check, EncodedTile, Rect, StoredTile, TileBytes, TileLevel},
};
use dezoomify::model::{Error, OutputPlan, Point, ReusedTile, Size};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Profile {
    PngRgb,
    Jpeg { sampling: (u16, u16) },
}

/// Container eligibility only. Future coefficient joining can inspect the same
/// encoded input without inheriting these output-specific rules.
fn profile(bytes: &[u8]) -> Option<Profile> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut at = 8usize;
        while let Some(header) = bytes.get(at..at.checked_add(8)?) {
            if &header[4..] == b"tRNS" {
                return None;
            }
            if &header[4..] == b"IEND" {
                break;
            }
            let length = u32::from_be_bytes(header[..4].try_into().ok()?) as usize;
            at = at.checked_add(length)?.checked_add(12)?;
        }
        return (bytes.get(24) == Some(&8) && bytes.get(25) == Some(&2)).then_some(Profile::PngRgb);
    }
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut at = 2;
    let mut jfif = false;
    let mut frame = None;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        if marker == 0xda {
            break;
        }
        let length = usize::from(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]));
        if length < 2 {
            return None;
        }
        let data = bytes.get(at + 2..at.checked_add(length)?)?;
        if marker == 0xe0 && data.starts_with(b"JFIF\0") {
            jfif = true;
        }
        if marker == 0xee && data.starts_with(b"Adobe") && data.get(11) == Some(&0) {
            return None;
        }
        if matches!(marker, 0xc0 | 0xc2) {
            if data.len() != 15
                || data[0] != 8
                || data[5] != 3
                || data[6] != 1
                || data[9] != 2
                || data[12] != 3
                || data[10] != 0x11
                || data[13] != 0x11
            {
                return None;
            }
            frame = match data[7] {
                0x11 => Some((1, 1)),
                0x22 => Some((2, 2)),
                _ => None,
            };
        }
        at += length;
    }
    if jfif {
        frame.map(|sampling| Profile::Jpeg { sampling })
    } else {
        None
    }
}

pub(crate) fn can_reuse(bytes: &[u8]) -> bool {
    profile(bytes).is_some()
}

fn failed(error: impl std::fmt::Display) -> Error {
    Error::EncodeFailed(format!("ZIF: {error}").into())
}

type TileMetadata = (Point, Option<Vec<u8>>, Option<Vec<u8>>);

pub(crate) struct ZifWriter {
    staging: StagedFile,
    base: TileLevel,
    writer: Option<zif_tiff::Writer>,
    profile: Option<Profile>,
    compression: u8,
    budget: u64,
    retained: u64,
    peak_retained: u64,
    decoded: u64,
    metadata: BTreeMap<u32, TileMetadata>,
    infer_canvas: bool,
    max_tiles: u32,
    index_bytes: u64,
}

impl ZifWriter {
    pub(crate) fn hold_queued_bytes(&mut self, bytes: u64) -> Result<(), Error> {
        memory_check(self.retained_bytes().saturating_add(bytes), self.budget)?;
        self.budget -= bytes;
        Ok(())
    }

    pub(crate) fn release_probe_bytes(&mut self, bytes: u64) {
        self.budget = self.budget.saturating_add(bytes);
    }

    pub(crate) fn peak_retained(&self) -> u64 {
        self.peak_retained
    }

    fn retained_bytes(&self) -> u64 {
        self.retained
            + self
                .metadata
                .values()
                .map(|(_, icc, exif)| {
                    icc.as_ref().map_or(0, Vec::len) as u64
                        + exif.as_ref().map_or(0, Vec::len) as u64
                })
                .sum::<u64>()
    }

    fn accept_metadata(&mut self, index: u32, metadata: Option<TileMetadata>) {
        if let Some(metadata) = metadata {
            self.metadata.insert(index, metadata);
            self.peak_retained = self.peak_retained.max(self.retained_bytes());
        }
    }

    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
        budget: u64,
        compression: u8,
        max_tiles: u32,
    ) -> Result<Self, Error> {
        let grid = plan.grid.as_ref().filter(|grid| {
            plan.canvas.is_some()
                && grid.overlap.width == 0
                && grid.overlap.height == 0
                && grid.tile_size.width == grid.tile_size.height
                && grid.tile_size.width % 16 == 0
        });
        let cell = grid.map_or(
            Size {
                width: 256,
                height: 256,
            },
            |grid| grid.tile_size.clone(),
        );
        let base = TileLevel {
            size: plan.canvas.clone().unwrap_or(Size {
                width: 1,
                height: 1,
            }),
            cell,
            tiles: BTreeMap::new(),
            regular: grid.is_some(),
        };
        let count = base.count()?;
        if count > max_tiles {
            return Err(Error::ResourceLimit(
                "ZIF output tile count exceeds max_tiles".into(),
            ));
        }
        // Reserve container indexes, two simultaneous level maps, and input
        // tile/metadata nodes. Payloads and conversion use only the remainder.
        let index_bytes = u64::from(count) * 512;
        let structural = index_bytes + u64::from(plan.tile_count) * 256;
        memory_check(structural, budget)?;
        Ok(Self {
            staging: StagedFile::new(destination)?,
            base,
            writer: None,
            profile: None,
            compression,
            budget: budget - structural,
            retained: 0,
            peak_retained: 0,
            decoded: 0,
            metadata: BTreeMap::new(),
            infer_canvas: plan.canvas.is_none(),
            max_tiles,
            index_bytes,
        })
    }

    fn initialize(&mut self, selected: Profile, cancelled: &AtomicBool) -> Result<(), Error> {
        let (codec, color) = match selected {
            Profile::PngRgb => (zif_tiff::Codec::Png, zif_tiff::ColorModel::Rgb),
            Profile::Jpeg { .. } => (zif_tiff::Codec::Jpeg, zif_tiff::ColorModel::YCbCr),
        };
        let mut builder = zif_tiff::Writer::new()
            .dimensions((
                u64::from(self.base.size.width),
                u64::from(self.base.size.height),
            ))
            .tile_size((self.base.cell.width, self.base.cell.height))
            .map_err(failed)?
            .pyramid()
            .codec(codec)
            .color_model(color)
            .channels(3)
            .map_err(failed)?;
        if let Profile::Jpeg { sampling } = selected {
            builder = builder.ycbcr_subsampling(sampling).map_err(failed)?;
        }
        let mut writer = builder.build().map_err(failed)?;
        let result = zif_tiff::std::RangeWriter::wrap(self.staging.writer(cancelled))
            .apply(writer.init().map_err(failed)?)
            .map_err(failed);
        self.staging.check_error()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result?;
        self.profile = Some(selected);
        self.writer = Some(writer);
        Ok(())
    }

    fn store(
        &mut self,
        level: usize,
        rect: Rect,
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<StoredTile, Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        memory_check(self.retained_bytes() + bytes.len() as u64 * 2, self.budget)?;
        let writer = self.writer.as_mut().expect("initialized ZIF writer");
        let batch = writer
            .put_tile_at_level(
                level,
                (
                    u64::from(rect.x / self.base.cell.width),
                    u64::from(rect.y / self.base.cell.height),
                ),
                bytes,
            )
            .map_err(failed)?;
        // Initialization was applied separately; the first action is the tile
        // payload, followed by its offset and length index updates.
        let offset = batch
            .actions()
            .first()
            .ok_or_else(|| Error::Internal("missing ZIF tile action".into()))?
            .offset;
        let result = zif_tiff::std::RangeWriter::wrap(self.staging.writer(cancelled))
            .apply(batch)
            .map_err(failed);
        self.staging.check_error()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result?;
        let format = match self.profile.expect("initialized ZIF profile") {
            Profile::Jpeg { .. } => image::ImageFormat::Jpeg,
            Profile::PngRgb => image::ImageFormat::Png,
        };
        Ok(StoredTile {
            rect,
            size: Size {
                width: rect.w,
                height: rect.h,
            },
            format,
            bytes: TileBytes::Range {
                path: self.staging.path().to_path_buf(),
                offset,
                length: bytes.len() as u64,
            },
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
        let mut inferred_size = self.base.size.clone();
        let index_growth = if self.infer_canvas {
            inferred_size.width = inferred_size.width.max(rect.x.saturating_add(rect.w));
            inferred_size.height = inferred_size.height.max(rect.y.saturating_add(rect.h));
            let count = inferred_size
                .width
                .div_ceil(self.base.cell.width)
                .checked_mul(inferred_size.height.div_ceil(self.base.cell.height))
                .ok_or_else(|| Error::ResourceLimit("output tile count overflow".into()))?;
            if count > self.max_tiles {
                return Err(Error::ResourceLimit(
                    "ZIF output tile count exceeds max_tiles".into(),
                ));
            }
            let index_bytes = u64::from(count) * 512;
            let growth = index_bytes.saturating_sub(self.index_bytes);
            memory_check(growth + self.retained_bytes(), self.budget)?;
            growth
        } else {
            rect.w = rect.w.min(self.base.size.width.saturating_sub(rect.x));
            rect.h = rect.h.min(self.base.size.height.saturating_sub(rect.y));
            0
        };
        if rect.w == 0 || rect.h == 0 {
            return Ok(());
        }
        let index = if self.base.regular {
            rect.y / self.base.cell.height * self.base.size.width.div_ceil(self.base.cell.width)
                + rect.x / self.base.cell.width
        } else {
            tile.id
        };
        use image::ImageDecoder as _;
        memory_check(
            tile.bytes.len() as u64 + self.retained_bytes() + index_growth,
            self.budget,
        )?;
        let mut reader =
            image::ImageReader::with_format(std::io::Cursor::new(&tile.bytes), tile.format);
        let mut limits = image::Limits::default();
        // Set before construction: PNG can inflate ICC metadata in read_info.
        // Leave room for the encoded body and copies returned by metadata APIs.
        limits.max_alloc = Some(
            self.budget
                .saturating_sub(self.retained_bytes() + index_growth + tile.bytes.len() as u64)
                / 2,
        );
        reader.limits(limits);
        let mut decoder = reader
            .into_decoder()
            .map_err(crate::tile_output::decode_error)?;
        let mut metadata = Some((
            tile.placement.position.clone(),
            decoder
                .icc_profile()
                .map_err(crate::tile_output::decode_error)?,
            decoder
                .exif_metadata()
                .map_err(crate::tile_output::decode_error)?,
        ));
        drop(decoder);
        let metadata_bytes = metadata.as_ref().map_or(0, |(_, icc, exif)| {
            icc.as_ref().map_or(0, Vec::len) as u64 + exif.as_ref().map_or(0, Vec::len) as u64
        });
        memory_check(
            self.retained_bytes() + metadata_bytes + index_growth,
            self.budget,
        )?;
        let conversion_budget = self
            .budget
            .saturating_sub(self.retained_bytes() + metadata_bytes + index_growth);
        let source_profile = profile(&tile.bytes);
        // Commit the codec only after the first tile is accepted. Failed
        // conversion must not force later reusable tiles through that codec.
        let selected = self.profile.or(source_profile).unwrap_or(Profile::PngRgb);
        let compatible = self.base.regular
            && rect == self.base.rect(index)
            && tile.size.width == rect.w
            && tile.size.height == rect.h
            && source_profile.is_some()
            && source_profile == Some(selected);
        let stored = if compatible {
            if self.writer.is_none() {
                self.initialize(selected, cancelled)?;
            }
            self.accept_metadata(index, metadata.take());
            self.store(0, rect, &tile.bytes, cancelled)?
        } else if self.base.regular && rect == self.base.rect(index) {
            self.decoded += 1;
            let pixels = tile.decode_pixels(
                &Size {
                    width: rect.w,
                    height: rect.h,
                },
                conversion_budget,
            )?;
            if self.writer.is_none() {
                self.initialize(selected, cancelled)?;
            }
            self.accept_metadata(index, metadata.take());
            drop(tile);
            let bytes = self.encode(&pixels)?;
            drop(pixels);
            self.store(0, rect, &bytes, cancelled)?
        } else {
            if !self.base.regular
                || source_profile.is_none()
                || tile.size.width != rect.w
                || tile.size.height != rect.h
            {
                self.decoded += 1;
                tile.convert_to_png(
                    Size {
                        width: rect.w,
                        height: rect.h,
                    },
                    conversion_budget,
                    self.compression,
                )?;
            }
            self.accept_metadata(index, metadata.take());
            self.retained += tile.bytes.len() as u64;
            let retained = self.retained_bytes();
            self.peak_retained = self.peak_retained.max(retained);
            memory_check(retained + index_growth, self.budget)?;
            StoredTile {
                rect,
                size: tile.size,
                format: tile.format,
                bytes: TileBytes::Memory(tile.bytes),
            }
        };
        self.base.size = inferred_size;
        self.budget -= index_growth;
        self.index_bytes += index_growth;
        self.base.tiles.insert(index, stored);
        Ok(())
    }

    fn encode(&self, pixels: &image::RgbaImage) -> Result<Vec<u8>, Error> {
        memory_check(
            pixels.as_raw().len() as u64 * 3 + (64 << 10),
            self.budget.saturating_sub(self.retained_bytes()),
        )?;
        let mut bytes = Vec::new();
        match self.profile.expect("initialized ZIF profile") {
            Profile::PngRgb => {
                let rgb = image::RgbImage::from_fn(pixels.width(), pixels.height(), |x, y| {
                    let p = pixels.get_pixel(x, y);
                    image::Rgb([p[0], p[1], p[2]])
                });
                let mut encoder = image::codecs::png::PngEncoder::new_with_quality(
                    &mut bytes,
                    crate::imaging::png_compression_for(self.compression),
                    image::codecs::png::FilterType::Adaptive,
                );
                if let Some(icc) = self.metadata.values().find_map(|(_, icc, _)| icc.as_ref()) {
                    let _ = image::ImageEncoder::set_icc_profile(&mut encoder, icc.clone());
                }
                if let Some(exif) = self
                    .metadata
                    .values()
                    .find_map(|(_, _, exif)| exif.as_ref())
                {
                    let _ = image::ImageEncoder::set_exif_metadata(&mut encoder, exif.clone());
                }
                image::ImageEncoder::write_image(
                    encoder,
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(failed)?;
            }
            Profile::Jpeg { sampling } => {
                let mut encoder =
                    jpeg_encoder::Encoder::new(&mut bytes, (100 - self.compression).max(1));
                encoder.set_sampling_factor(if sampling == (2, 2) {
                    jpeg_encoder::SamplingFactor::F_2_2
                } else {
                    jpeg_encoder::SamplingFactor::F_1_1
                });
                if let Some(icc) = self.metadata.values().find_map(|(_, icc, _)| icc.as_ref()) {
                    encoder.add_icc_profile(icc).map_err(failed)?;
                }
                encoder
                    .encode(
                        pixels.as_raw(),
                        u16::try_from(pixels.width()).map_err(failed)?,
                        u16::try_from(pixels.height()).map_err(failed)?,
                        jpeg_encoder::ColorType::Rgba,
                    )
                    .map_err(failed)?;
            }
        }
        Ok(bytes)
    }

    pub(crate) fn finish(
        mut self,
        destination: &Path,
        overwrite: bool,
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
            self.metadata = std::mem::take(&mut self.metadata)
                .into_iter()
                .map(|(index, meta)| {
                    (
                        reused
                            .iter()
                            .find(|reuse| reuse.position == meta.0)
                            .map_or(index, |reuse| reuse.index),
                        meta,
                    )
                })
                .collect();
        }
        if self.writer.is_none() {
            let selected = if self.base.regular {
                self.base
                    .tiles
                    .values()
                    .find_map(|tile| {
                        if let TileBytes::Memory(bytes) = &tile.bytes {
                            profile(bytes)
                        } else {
                            None
                        }
                    })
                    .unwrap_or(Profile::PngRgb)
            } else {
                Profile::PngRgb
            };
            self.initialize(selected, cancelled)?;
        }
        let mut normalized = TileLevel {
            size: self.base.size.clone(),
            cell: self.base.cell.clone(),
            tiles: BTreeMap::new(),
            regular: true,
        };
        for index in 0..normalized.count()? {
            let rect = normalized.rect(index);
            let reusable = self.base.tiles.get(&index).is_some_and(|tile| {
                self.base.regular
                    && tile.rect == rect
                    && tile.size.width == rect.w
                    && tile.size.height == rect.h
                    && match &tile.bytes {
                        TileBytes::Range { .. } => true,
                        TileBytes::Memory(bytes) => {
                            profile(bytes).is_some() && profile(bytes) == self.profile
                        }
                        _ => false,
                    }
            });
            let existing = if reusable {
                self.base.tiles.remove(&index)
            } else {
                None
            };
            let stored = if let Some(tile) = existing {
                if let TileBytes::Memory(bytes) = tile.bytes {
                    self.retained = self.retained.saturating_sub(bytes.len() as u64);
                    self.store(0, rect, &bytes, cancelled)?
                } else {
                    tile
                }
            } else {
                let pixels = self.base.region(
                    rect,
                    self.budget.saturating_sub(self.retained_bytes()),
                    cancelled,
                    &mut self.decoded,
                )?;
                let bytes = self.encode(&pixels)?;
                drop(pixels);
                self.store(0, rect, &bytes, cancelled)?
            };
            normalized.tiles.insert(index, stored);
        }
        self.base = normalized;
        self.retained = 0;
        let full_size = self.base.size.clone();
        let cell = self.base.cell.clone();
        let mut previous = std::mem::replace(
            &mut self.base,
            TileLevel {
                size: full_size.clone(),
                cell,
                tiles: BTreeMap::new(),
                regular: true,
            },
        );
        let levels = self
            .writer
            .as_ref()
            .expect("initialized ZIF writer")
            .level_count();
        for level in 1..levels {
            let (width, height) = self
                .writer
                .as_ref()
                .expect("initialized ZIF writer")
                .level_dimensions(level)
                .map_err(failed)?;
            let mut next = TileLevel {
                size: Size {
                    width: width as u32,
                    height: height as u32,
                },
                cell: previous.cell.clone(),
                tiles: BTreeMap::new(),
                regular: true,
            };
            for index in 0..next.count()? {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(Error::Cancelled);
                }
                let rect = next.rect(index);
                let pixels = downsample(
                    &previous,
                    &next.size,
                    rect,
                    self.budget.saturating_sub(self.retained_bytes()),
                    cancelled,
                    &mut self.decoded,
                )?;
                let bytes = self.encode(&pixels)?;
                drop(pixels);
                next.tiles
                    .insert(index, self.store(level, rect, &bytes, cancelled)?);
            }
            previous = next;
        }
        let bytes = self.staging.publish(destination, overwrite, cancelled)?;
        Ok((full_size, bytes, self.decoded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dezoomify::model::{OutputFormat, ProcessingRecipe, TilePlacement, TileRole};

    #[test]
    fn retained_tile_and_metadata_share_one_budget() {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder.set_icc_profile(vec![42; 4096]).unwrap();
        encoder
            .write_image(&[1, 2, 3], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        assert!(matches!(profile(&bytes), Some(Profile::PngRgb)));
        let mut transparent = bytes.clone();
        // Valid RGB tRNS chunk for the encoded pixel [1, 2, 3].
        transparent.splice(
            33..33,
            [
                0, 0, 0, 6, b't', b'R', b'N', b'S', 0, 1, 0, 2, 0, 3, 201, 75, 171, 245,
            ],
        );
        assert!(profile(&transparent).is_none());
        let size = Size {
            width: 1,
            height: 1,
        };
        let directory = tempfile::tempdir().unwrap();
        let budget = 4096 + bytes.len() as u64 - 1;
        let mut writer = ZifWriter::new(
            &directory.path().join("out.zif"),
            &OutputPlan {
                canvas: Some(size.clone()),
                grid: None,
                tile_count: 1,
                format: OutputFormat::Zif,
                title: None,
            },
            budget,
            5,
            100,
        )
        .unwrap();
        let error = writer
            .place(
                EncodedTile {
                    request: None,
                    id: 0,
                    size: size.clone(),
                    bytes,
                    format: image::ImageFormat::Png,
                    placement: TilePlacement {
                        position: Point { x: 0, y: 0 },
                        expected_size: None,
                        canvas: Some(size),
                        processing: ProcessingRecipe::None,
                        role: TileRole::output(),
                    },
                },
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            Error::LimitExceeded { .. } | Error::ResourceLimit(_)
        ));
        assert!(
            writer.metadata.is_empty(),
            "rejected tile metadata is not retained"
        );
    }

    #[test]
    fn cancelled_header_write_preserves_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let plan = OutputPlan {
            canvas: Some(Size {
                width: 16,
                height: 16,
            }),
            grid: None,
            tile_count: 1,
            format: OutputFormat::Zif,
            title: None,
        };
        let mut writer =
            ZifWriter::new(&directory.path().join("out.zif"), &plan, 1 << 20, 5, 100).unwrap();
        assert_eq!(
            writer.initialize(Profile::PngRgb, &AtomicBool::new(true)),
            Err(Error::Cancelled)
        );
    }
}
