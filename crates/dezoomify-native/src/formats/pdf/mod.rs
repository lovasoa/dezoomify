//! One PDF page: stream tile image objects, retain bounded placements, then seal
//! the page in plan order. Document ownership and publication live elsewhere.
pub(crate) mod document;
pub(crate) mod images;
pub mod pages;

use crate::{
    document::{DocumentPage, OutputDocument},
    encoded_tile::EncodedTile,
    formats::pdf::images as pdf_images,
    output::{PreparedOutput, StagedOutput},
    tile_geometry::Rect,
    OutputTarget,
};
use dezoomify::model::{Error, OutputGrid, OutputPlan, ReusedTile, Size};
use pdf_writer::{Content, Finish, Name, Ref};
use std::{collections::BTreeMap, path::Path, sync::atomic::AtomicBool};

struct PlacedImage {
    image: Ref,
    rect: Rect,
    size: Size,
}

pub(crate) struct PdfWriter {
    page: DocumentPage,
    standalone: Option<OutputDocument>,
    tiles: BTreeMap<u32, PlacedImage>,
    size: Size,
    infer_canvas: bool,
    grid: Option<OutputGrid>,
    indexes: u64,
    compression: u8,
    decoded: u64,
    max_tiles: u32,
}

impl PdfWriter {
    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
        compression: u8,
        max_tiles: u32,
        page: Option<DocumentPage>,
        controls: crate::Controls,
    ) -> Result<Self, Error> {
        if plan
            .canvas
            .as_ref()
            .is_some_and(|size| size.width == 0 || size.height == 0)
            || plan
                .grid
                .as_ref()
                .is_some_and(|grid| grid.tile_size.width == 0 || grid.tile_size.height == 0)
        {
            return Err(Error::PlanInvalid("PDF dimensions must be positive".into()));
        }
        let mut standalone = if page.is_none() {
            Some(OutputDocument::new(
                OutputTarget::File(destination.to_path_buf()),
                true,
            )?)
        } else {
            None
        };
        let page = match page {
            Some(page) => page,
            None => standalone.as_mut().expect("standalone document").page()?,
        };
        let indexes = u64::from(plan.tile_count) * 512 + page.lock()?.retained_bytes();
        page.lock()?.set_controls(Some(controls));

        Ok(Self {
            page,
            standalone,
            tiles: BTreeMap::new(),
            size: plan.canvas.clone().unwrap_or(Size {
                width: 0,
                height: 0,
            }),
            infer_canvas: plan.canvas.is_none(),
            grid: plan.grid.clone(),
            indexes,
            compression,
            decoded: 0,
            max_tiles,
        })
    }

    pub(crate) fn finish(
        mut self,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<PreparedOutput, Error> {
        if self.size.width == 0 || self.size.height == 0 {
            return Err(Error::PlanEmpty);
        }
        let order = crate::tile_geometry::TileOrder::new(reused);
        let mut ordered = BTreeMap::new();
        for (index, tile) in std::mem::take(&mut self.tiles) {
            let index = order.index(index, tile.rect.x, tile.rect.y);
            ordered.insert(index, tile);
        }
        let page = self.write_page(&ordered, cancelled)?;
        self.page.seal(page)?;
        let staging = match &mut self.standalone {
            Some(document) => StagedOutput::File(document.take_staging(cancelled)?),
            None => StagedOutput::DocumentPage,
        };
        Ok(PreparedOutput {
            staging,
            size: self.size,
            pixel_decodes: self.decoded,
            late_writes: 0,
        })
    }

    fn write_page(
        &self,
        tiles: &BTreeMap<u32, PlacedImage>,
        cancelled: &AtomicBool,
    ) -> Result<Ref, Error> {
        let scale = (14_400.0 / f64::from(self.size.width.max(self.size.height))).min(1.0) as f32;
        let mut document = self.page.lock()?;
        let mut contents = Vec::with_capacity(tiles.len());
        for (&index, tile) in tiles {
            let clip = self.grid.as_ref().map_or(tile.rect, |grid| {
                tile.rect
                    .intersection(Rect::grid_cell(grid, &self.size, index))
            });
            let mut content = Content::new(crate::buffers::Buffer::default());
            content
                .save_state()
                .transform([scale, 0.0, 0.0, scale, 0.0, 0.0]);
            content
                .rect(
                    clip.x as f32,
                    self.size.height as f32 - clip.y as f32 - clip.h as f32,
                    clip.w as f32,
                    clip.h as f32,
                )
                .clip_nonzero()
                .end_path();
            content.transform([
                tile.size.width as f32,
                0.0,
                0.0,
                tile.size.height as f32,
                tile.rect.x as f32,
                self.size.height as f32 - tile.rect.y as f32 - tile.size.height as f32,
            ]);
            content
                .x_object(Name(format!("T{}", tile.image.get()).as_bytes()))
                .restore_state();
            let id = document.alloc()?;
            let content = content.finish().map_err(|error| {
                Error::EncodeFailed(format!("PDF content failed: {error}").into())
            })?;
            document.write(cancelled, |pdf| {
                pdf.stream(id, &content.into_vec());
            })?;
            contents.push(id);
        }
        let id = document.alloc()?;
        document.write(cancelled, |pdf| {
            let mut page = pdf.page(id);
            page.parent(Ref::new(2)).media_box(pdf_writer::Rect::new(
                0.0,
                0.0,
                self.size.width as f32 * scale,
                self.size.height as f32 * scale,
            ));
            page.insert(Name(b"Contents")).array().items(contents);
            let mut resources = page.resources();
            let mut images = resources.x_objects();
            for tile in tiles.values() {
                images.pair(
                    Name(format!("T{}", tile.image.get()).as_bytes()),
                    tile.image,
                );
            }
            images.finish();
            resources.finish();
            page.finish();
        })?;
        Ok(id)
    }
}

impl crate::tile_output::TileWriter for PdfWriter {
    fn peak_retained(&self) -> u64 {
        self.indexes
    }

    fn place(&mut self, mut tile: EncodedTile, cancelled: &AtomicBool) -> Result<(), Error> {
        if self.tiles.contains_key(&tile.id) {
            return Ok(());
        }
        if self.tiles.len() >= self.max_tiles as usize {
            return Err(Error::ResourceLimit(
                "PDF tile count exceeds max_tiles".into(),
            ));
        }
        let rect = Rect::placed(
            &tile.placement,
            &tile.size,
            (!self.infer_canvas).then_some(&self.size),
        );
        if rect.w == 0 || rect.h == 0 {
            return Ok(());
        }
        let image = pdf_images::write_tile(
            &mut *self.page.lock()?,
            &mut tile,
            self.compression,
            cancelled,
            &mut self.decoded,
        )?;
        if self.infer_canvas {
            self.size.width = self.size.width.max(rect.x.saturating_add(rect.w));
            self.size.height = self.size.height.max(rect.y.saturating_add(rect.h));
        }
        self.tiles.insert(
            tile.id,
            PlacedImage {
                image,
                rect,
                size: tile.size,
            },
        );
        Ok(())
    }

    fn finish(
        self: Box<Self>,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<crate::output::PreparedOutput, Error> {
        PdfWriter::finish(*self, reused, cancelled)
    }
}

pub(crate) fn probe_needs_preparation(tile: &EncodedTile, _extent: &Size) -> bool {
    !images::can_reuse(tile)
}
