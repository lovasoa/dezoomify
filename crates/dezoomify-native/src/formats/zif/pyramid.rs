use super::{failed, profile, reusable_size, Profile, ZifWriter};
use crate::{
    codecs::tile_metadata,
    encoded_tile::EncodedTile,
    tile_pyramid::{downsample, TileBytes, TileLevel},
};
use dezoomify::model::{Error, ReusedTile, Size};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

impl ZifWriter {
    pub(super) fn place_source_level(
        &mut self,
        tile: EncodedTile,
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        let source_index = self
            .source_levels
            .iter()
            .position(|level| tile.placement.canvas.as_ref() == Some(&level.size))
            .ok_or_else(|| failed("tile belongs to an undeclared source level"))?;
        let level = &self.source_levels[source_index];
        let position = &tile.placement.position;
        if position.x >= level.size.width
            || position.y >= level.size.height
            || !position.x.is_multiple_of(level.cell.width)
            || !position.y.is_multiple_of(level.cell.height)
        {
            return Err(failed(
                "source pyramid tile does not align to the output grid",
            ));
        }
        let index = position.y / level.cell.height * level.size.width.div_ceil(level.cell.width)
            + position.x / level.cell.width;
        let rect = level.rect(index);
        let source_profile = profile(&tile.bytes);
        if tile.size.width < rect.w
            || tile.size.height < rect.h
            || tile
                .placement
                .expected_size
                .as_ref()
                .is_some_and(|size| size.width != rect.w || size.height != rect.h)
            || level.tiles.contains_key(&index)
            || (source_profile.is_some() && source_profile != self.profile)
        {
            return Err(failed("source pyramid tiles must have matching codec, sampling, dimensions and non-overlapping placement"));
        }
        let writer = self
            .writer
            .as_ref()
            .ok_or_else(|| failed("source level arrived before the base level"))?;
        let output_level = (1..writer.level_count())
            .find(|&index| {
                writer.level_dimensions(index).ok()
                    == Some((u64::from(level.size.width), u64::from(level.size.height)))
            })
            .ok_or_else(|| failed("source level is not represented in the output pyramid"))?;
        let stored = if source_profile.is_some() && reusable_size(&tile.size, rect, &level.cell) {
            let mut stored = self.store(output_level, rect, &tile.bytes, cancelled)?;
            stored.size = tile.size;
            stored
        } else {
            self.require_pixel_encoder()?;
            let (icc, exif) = tile_metadata(&tile.bytes, tile.format)?;
            self.decoded += 1;
            let pixels = tile.decode_pixels(&Size {
                width: rect.w,
                height: rect.h,
            })?;
            drop(tile);
            let bytes = self.encode_with_metadata(&pixels, icc.as_deref(), exif.as_deref())?;
            drop(pixels);
            self.store(output_level, rect, &bytes, cancelled)?
        };
        self.source_levels[source_index].tiles.insert(index, stored);
        Ok(())
    }

    pub(super) fn finish(
        mut self,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<crate::output::PreparedOutput, Error> {
        if !self.base.regular {
            let order = crate::tile_geometry::TileOrder::new(reused);
            let mut tiles = BTreeMap::new();
            for (index, tile) in std::mem::take(&mut self.base.tiles) {
                let index = order.index(index, tile.rect.x, tile.rect.y);
                tiles.insert(index, tile);
            }
            self.base.tiles = tiles;
            self.metadata = std::mem::take(&mut self.metadata)
                .into_iter()
                .map(|(index, meta)| (order.index(index, meta.0.x, meta.0.y), meta))
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
            self.initialize(self.select_profile(Some(selected)), cancelled)?;
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
                    && reusable_size(&tile.size, rect, &normalized.cell)
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
                self.require_pixel_encoder()?;
                let pixels = self.base.region(rect, cancelled, &mut self.decoded)?;
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
            if let Some(source) = self
                .source_levels
                .iter_mut()
                .find(|source| source.size == next.size)
            {
                next.tiles = std::mem::take(&mut source.tiles);
            }
            for index in 0..next.count()? {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(Error::Cancelled);
                }
                if next.tiles.contains_key(&index) {
                    continue;
                }
                self.require_pixel_encoder()?;
                let rect = next.rect(index);
                let pixels = downsample(&previous, &next.size, rect, cancelled, &mut self.decoded)?;
                let bytes = self.encode(&pixels)?;
                drop(pixels);
                next.tiles
                    .insert(index, self.store(level, rect, &bytes, cancelled)?);
            }
            previous = next;
        }
        Ok(crate::output::PreparedOutput {
            staging: crate::output::StagedOutput::File(self.staging),
            size: full_size,
            pixel_decodes: self.decoded,
            late_writes: 0,
        })
    }
}
