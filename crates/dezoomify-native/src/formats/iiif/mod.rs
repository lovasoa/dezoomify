//! Static IIIF publication and offline viewer, using shared tile conversion and pyramids.
mod pyramid;
mod tiles;

use crate::{
    codecs::NativeFormat,
    encoded_tile::EncodedTile,
    output::StagedDirectory,
    tile_pyramid::{Rect, StoredTile, TileBytes, TileLevel},
};
use dezoomify::model::{Error, OutputPlan, ReusedTile, Size};
use std::{collections::BTreeMap, path::Path, sync::atomic::AtomicBool};

pub(crate) struct IiifWriter {
    staging: StagedDirectory,
    base: TileLevel,
    compression: u8,
    pub(crate) decoded_tiles: u64,
    retained: u64,
    peak_retained: u64,
    infer_canvas: bool,
    max_tiles: u32,
    icc_profile: Option<Vec<u8>>,
    index_bytes: u64,
}

impl IiifWriter {
    pub(crate) fn retained_bytes(&self) -> u64 {
        self.retained + self.index_bytes
    }

    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
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
}

impl crate::tile_output::TileWriter for IiifWriter {
    fn peak_retained(&self) -> u64 {
        self.peak_retained
    }

    fn place(&mut self, mut tile: EncodedTile, cancelled: &AtomicBool) -> Result<(), Error> {
        let rect = Rect::placed(
            &tile.placement,
            &tile.size,
            (!self.infer_canvas).then_some(&self.base.size),
        );
        if rect.w == 0 || rect.h == 0 {
            return Ok(());
        }

        let index = if self.base.regular {
            (rect.y / self.base.cell.height) * self.base.size.width.div_ceil(self.base.cell.width)
                + rect.x / self.base.cell.width
        } else {
            tile.id
        };
        let mut compatible = matches!(
            tile.format,
            NativeFormat::Image(image::ImageFormat::Jpeg | image::ImageFormat::Png)
        ) && tile.size.width == rect.w
            && tile.size.height == rect.h
            && self.base.regular
            && rect == self.base.rect(index);
        if !compatible {
            self.decoded_tiles += 1;
            crate::formats::png::convert_tile(
                &mut tile,
                Size {
                    width: rect.w,
                    height: rect.h,
                },
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

    fn finish(
        self: Box<Self>,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<crate::output::PreparedOutput, Error> {
        IiifWriter::finish(*self, reused, cancelled)
    }
}

pub(crate) fn probe_needs_preparation(tile: &EncodedTile, extent: &Size) -> bool {
    crate::tile_output::pyramid_probe_needs_preparation(tile, extent)
}
