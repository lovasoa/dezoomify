//! Baseline ZIF: tiled BigTIFF with self-contained JPEG or RGB PNG payloads.
mod container;
mod profile;
mod pyramid;
pub(crate) use profile::can_reuse;
use profile::{profile, Profile};

use crate::{
    codecs::tile_metadata,
    encoded_tile::EncodedTile,
    output::StagedFile,
    tile_pyramid::{Rect, StoredTile, TileBytes, TileLevel},
};
use dezoomify::model::{Error, OutputPlan, Point, ReusedTile, Size};
use std::{collections::BTreeMap, path::Path, sync::atomic::AtomicBool};

fn failed(error: impl std::fmt::Display) -> Error {
    Error::EncodeFailed(format!("ZIF: {error}").into())
}

fn reusable_size(size: &Size, rect: Rect, cell: &Size) -> bool {
    // Edge payloads may be clipped to the image or padded to a full TIFF cell.
    (size.width == rect.w || size.width == cell.width)
        && (size.height == rect.h || size.height == cell.height)
}

type TileMetadata = (Point, Option<Vec<u8>>, Option<Vec<u8>>);

pub(crate) struct ZifWriter {
    staging: StagedFile,
    base: TileLevel,
    source_levels: Vec<TileLevel>,
    writer: Option<zif_tiff::Writer>,
    profile: Option<Profile>,
    compression: u8,
    retained: u64,
    peak_retained: u64,
    decoded: u64,
    metadata: BTreeMap<u32, TileMetadata>,
    infer_canvas: bool,
    max_tiles: u32,
}

impl ZifWriter {
    pub(crate) fn retained_bytes(&self) -> u64 {
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
            if self.base.regular {
                let icc_index = self
                    .metadata
                    .iter()
                    .find_map(|(&index, (_, icc, _))| icc.is_some().then_some(index));
                let exif_index = self
                    .metadata
                    .iter()
                    .find_map(|(&index, (_, _, exif))| exif.is_some().then_some(index));
                self.metadata.retain(|&index, (_, icc, exif)| {
                    if Some(index) != icc_index {
                        *icc = None;
                    }
                    if Some(index) != exif_index {
                        *exif = None;
                    }
                    icc.is_some() || exif.is_some()
                });
            }
            self.peak_retained = self.peak_retained.max(self.retained_bytes());
        }
    }

    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
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
        let mut source_levels = Vec::new();
        for size in &plan.source_levels {
            source_levels.push(TileLevel {
                size: size.clone(),
                cell: base.cell.clone(),
                tiles: BTreeMap::new(),
                regular: true,
            });
        }
        let count = base.count()?;
        if count > max_tiles {
            return Err(Error::ResourceLimit(
                "ZIF output tile count exceeds max_tiles".into(),
            ));
        }
        Ok(Self {
            staging: StagedFile::new(destination)?,
            base,
            source_levels,
            writer: None,
            profile: None,
            compression,
            retained: 0,
            peak_retained: 0,
            decoded: 0,
            metadata: BTreeMap::new(),
            infer_canvas: plan.canvas.is_none(),
            max_tiles,
        })
    }
}

#[cfg(test)]
mod tests;

impl crate::tile_output::TileWriter for ZifWriter {
    fn peak_retained(&self) -> u64 {
        self.peak_retained
    }

    fn place(&mut self, mut tile: EncodedTile, cancelled: &AtomicBool) -> Result<(), Error> {
        if tile
            .placement
            .canvas
            .as_ref()
            .is_some_and(|canvas| *canvas != self.base.size)
        {
            return self.place_source_level(tile, cancelled);
        }
        let mut rect = Rect::placed(&tile.placement, &tile.size, None);
        let mut inferred_size = self.base.size.clone();
        if self.infer_canvas {
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
        } else {
            rect = rect.clipped(&self.base.size);
        }
        if rect.w == 0 || rect.h == 0 {
            return Ok(());
        }
        let index = if self.base.regular {
            rect.y / self.base.cell.height * self.base.size.width.div_ceil(self.base.cell.width)
                + rect.x / self.base.cell.width
        } else {
            tile.id
        };

        let (icc, exif) = tile_metadata(&tile.bytes, tile.format)?;
        let mut metadata = Some((tile.placement.position.clone(), icc, exif));

        let source_profile = profile(&tile.bytes);
        // Commit the codec only after the first tile is accepted. Failed
        // conversion must not force later reusable tiles through that codec.
        let selected = self.select_profile(source_profile.filter(|_| {
            self.base.regular
                && rect == self.base.rect(index)
                && reusable_size(&tile.size, rect, &self.base.cell)
        }));
        let compatible = self.base.regular
            && rect == self.base.rect(index)
            && reusable_size(&tile.size, rect, &self.base.cell)
            && source_profile.is_some()
            && source_profile == Some(selected);
        if !compatible && matches!(selected, Profile::Jpeg { sampling } if sampling != (1, 1)) {
            return Err(failed(
                "cannot convert an incompatible tile into a subsampled JPEG passthrough container",
            ));
        }
        let stored = if compatible {
            if self.writer.is_none() {
                self.initialize(selected, cancelled)?;
            }
            self.accept_metadata(index, metadata.take());
            let mut stored = self.store(0, rect, &tile.bytes, cancelled)?;
            stored.size = tile.size;
            stored
        } else if self.base.regular && rect == self.base.rect(index) {
            self.decoded += 1;
            let pixels = tile.decode_pixels(&Size {
                width: rect.w,
                height: rect.h,
            })?;
            if self.writer.is_none() {
                self.initialize(selected, cancelled)?;
            }
            drop(tile);
            // Preserve this tile's own metadata; other arrivals must not change
            // its interpretation. Final pyramid metadata uses settled order.
            let (_, icc, exif) = metadata.as_ref().expect("source metadata");
            let bytes = self.encode_with_metadata(&pixels, icc.as_deref(), exif.as_deref())?;
            self.accept_metadata(index, metadata.take());
            drop(pixels);
            self.store(0, rect, &bytes, cancelled)?
        } else {
            if !self.base.regular
                || source_profile.is_none()
                || tile.size.width != rect.w
                || tile.size.height != rect.h
            {
                self.decoded += 1;
                crate::formats::png::convert_tile(
                    &mut tile,
                    Size {
                        width: rect.w,
                        height: rect.h,
                    },
                    self.compression,
                )?;
            }
            self.accept_metadata(index, metadata.take());
            self.retained += tile.bytes.len() as u64;
            let retained = self.retained_bytes();
            self.peak_retained = self.peak_retained.max(retained);

            StoredTile {
                rect,
                size: tile.size,
                format: tile.format,
                bytes: TileBytes::Memory(tile.bytes),
            }
        };
        self.base.size = inferred_size;
        self.base.tiles.insert(index, stored);
        Ok(())
    }

    fn finish(
        self: Box<Self>,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<crate::output::PreparedOutput, Error> {
        ZifWriter::finish(*self, reused, cancelled)
    }
}

pub(crate) fn probe_needs_preparation(tile: &EncodedTile, extent: &Size) -> bool {
    crate::tile_output::pyramid_probe_needs_preparation(tile, extent) || !can_reuse(&tile.bytes)
}
