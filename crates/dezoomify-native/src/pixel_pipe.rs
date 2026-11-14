//! Disk-backed composition and ordered strip delivery. Pixels and coverage share
//! rectangular blocks, so placement uses bulk I/O rather than per-row operations.
//! Producers never wait for the encoder; unread blocks stay in the staging file.
use crate::{
    imaging::DecodedTile,
    pixel_store::{discard, read_metadata, storage_error, store_metadata, MetadataLocation},
};
use dezoomify::model::{Error, OutputGrid, ReusedTile, Size, TilePlacement};
use image::{
    imageops::{crop_imm, overlay},
    GenericImage, ImageBuffer, Rgba,
};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Condvar, Mutex},
};

const STRIP_ROWS: u32 = 64; // JPEG consumes full-width eight-row bands.
const BLOCK_COLUMNS: u32 = 256;
type TileMetadata = (Option<Vec<u8>>, Option<Vec<u8>>);

pub(crate) struct PixelRegion {
    pub(crate) rect: crate::tile_output::Rect,
    pub(crate) rgba: Vec<u8>,
}

pub(crate) struct PixelStrip {
    pub(crate) first_row: u32,
    pub(crate) rows: u32,
    pub(crate) rgba: Vec<u8>,
}
struct Metadata {
    position: (u32, u32),
    icc: MetadataLocation,
    exif: MetadataLocation,
}
struct Producer {
    file: File,
    pending: BTreeMap<u32, u64>,
    next_region: u32,
    metadata: BTreeMap<u32, Metadata>,
    origin_icc: MetadataLocation,
    late: u64,
}
impl Producer {
    fn remember(
        &mut self,
        id: u32,
        placement: &TilePlacement,
        decoded: &DecodedTile,
    ) -> Result<(), Error> {
        if decoded.icc_profile.is_some() || decoded.exif_metadata.is_some() {
            let icc = store_metadata(&mut self.file, decoded.icc_profile.as_deref())
                .map_err(storage_error)?;
            let exif = store_metadata(&mut self.file, decoded.exif_metadata.as_deref())
                .map_err(storage_error)?;
            if placement.position.x == 0 && placement.position.y == 0 && self.next_region == 0 {
                self.origin_icc = self.origin_icc.or(icc);
            }
            self.metadata.insert(
                id,
                Metadata {
                    position: (placement.position.x, placement.position.y),
                    icc,
                    exif,
                },
            );
        }
        Ok(())
    }
}
#[derive(Default)]
struct Queue {
    available: u32,
    next_region: u32,
    metadata: Option<TileMetadata>,
    failure: Option<Error>,
    consumed: u64,
}
pub(crate) struct PixelPipe {
    pub(crate) size: Size,
    region: Size,
    region_columns: u32,
    count: u32,
    overlap: Size,
    block: Size,
    block_bytes: usize,
    columns: u32,
    reader: Mutex<File>,
    producer: Mutex<Producer>,
    queue: Mutex<Queue>,
    changed: Condvar,
    events: tokio::sync::Notify,
}
impl PixelPipe {
    #[cfg(test)]
    pub(crate) fn new(size: Size, directory: &Path) -> Result<Arc<Self>, Error> {
        Self::with_grid(size, directory, None)
    }
    /// A grid requests tile delivery and crops source overlap to each tile's
    /// nominal cell. Without a grid, existing encoders receive full-width strips.
    pub(crate) fn with_grid(
        size: Size,
        directory: &Path,
        grid: Option<&OutputGrid>,
    ) -> Result<Arc<Self>, Error> {
        let region = grid.map_or(
            Size {
                width: size.width,
                height: size.height.min(STRIP_ROWS),
            },
            |g| g.tile_size.clone(),
        );
        if region.width == 0 || region.height == 0 {
            return Err(Error::PlanInvalid("empty output region".into()));
        }
        let block = Size {
            width: region.width.min(size.width).min(if grid.is_some() {
                region.width
            } else {
                BLOCK_COLUMNS
            }),
            height: region.height.min(size.height),
        };
        let region_columns = size.width.div_ceil(region.width);
        let count = region_columns
            .checked_mul(size.height.div_ceil(region.height))
            .ok_or_else(|| Error::ResourceLimit("output region count overflow".into()))?;
        let pixels = block.width as usize * block.height as usize;
        let block_bytes = pixels * 4 + pixels.div_ceil(8);
        let columns = size.width.div_ceil(block.width);
        let length = u64::from(columns)
            .checked_mul(u64::from(size.height.div_ceil(block.height)))
            .and_then(|n| n.checked_mul(block_bytes as u64))
            .ok_or_else(|| Error::InvalidState("raster dimensions overflow".into()))?;
        std::fs::create_dir_all(directory).map_err(storage_error)?;
        let file = tempfile::NamedTempFile::new_in(directory).map_err(storage_error)?;
        // Reopen, rather than clone, to give the encoder an independent cursor.
        // Unlink before writing so the handles own cleanup, including on crashes.
        let reader = file.reopen().map_err(storage_error)?;
        let (file, path) = file.into_parts();
        path.close().map_err(storage_error)?;
        file.set_len(length).map_err(storage_error)?;
        Ok(Arc::new(Self {
            size,
            region,
            region_columns,
            count,
            overlap: grid.map_or(
                Size {
                    width: 0,
                    height: 0,
                },
                |g| g.overlap.clone(),
            ),
            block,
            block_bytes,
            columns,
            reader: Mutex::new(reader),
            producer: Mutex::new(Producer {
                file,
                pending: BTreeMap::new(),
                next_region: 0,
                metadata: BTreeMap::new(),
                origin_icc: None,
                late: 0,
            }),
            queue: Mutex::new(Queue::default()),
            changed: Condvar::new(),
            events: tokio::sync::Notify::new(),
        }))
    }
    pub(crate) fn error(&self) -> Option<Error> {
        self.queue.lock().expect("strip queue lock").failure.clone()
    }
    pub(crate) async fn wait_failed(&self) -> Error {
        loop {
            let event = self.events.notified();
            if let Some(error) = self.error() {
                return error;
            }
            event.await;
        }
    }
    pub(crate) fn fail(&self, error: Error) {
        let mut queue = self.queue.lock().expect("strip queue lock");
        queue.failure.get_or_insert(error);
        drop(queue);
        self.changed.notify_all();
        self.events.notify_waiters();
    }
    pub(crate) fn consumed(&self) -> u64 {
        self.queue.lock().expect("strip queue lock").consumed
    }
    pub(crate) fn region_size(&self) -> &Size {
        &self.region
    }
    pub(crate) fn consumed_strip(&self, strip: &PixelStrip) {
        self.queue.lock().expect("strip queue lock").consumed +=
            u64::from(self.size.width) * u64::from(strip.rows);
    }
    pub(crate) fn late(&self) -> u64 {
        self.producer.lock().expect("pixel producer lock").late
    }
    /// Placement does disk I/O and must run on a blocking worker. Contributions
    /// composite until whole-region handoff freezes the pixels. Later writes to
    /// frozen regions are discarded; conflicting overlaps have unspecified results.
    pub(crate) fn place(
        &self,
        id: u32,
        placement: &TilePlacement,
        decoded: DecodedTile,
    ) -> Result<(), Error> {
        let mut producer = self.producer.lock().expect("pixel producer lock");
        if let Some(error) = self.error() {
            return Err(error);
        }
        producer.remember(id, placement, &decoded)?;
        let image = decoded.image;
        let rect = self.contribution(placement, &image);
        let (x, y, width, height) = (rect.x, rect.y, rect.w, rect.h);
        if width == 0 || height == 0 {
            return Ok(());
        }
        let (source_x, source_y) = (placement.position.x, placement.position.y);
        let opaque = image.pixels().all(|p| p[3] == 255);
        let mut bytes = vec![0; self.block_bytes];
        for band in y / self.block.height..(y + height).div_ceil(self.block.height) {
            if let Some(error) = self.error() {
                return Err(error);
            }
            let first_row = band * self.block.height;
            let Producer {
                file,
                pending,
                next_region,
                late,
                ..
            } = &mut *producer;
            for column in x / self.block.width..(x + width).div_ceil(self.block.width) {
                let region =
                    band * self.region_columns + (column * self.block.width) / self.region.width;
                if region < *next_region {
                    *late += 1;
                    continue;
                }
                let mut covered = 0;
                let offset = (u64::from(band) * u64::from(self.columns) + u64::from(column))
                    * self.block_bytes as u64;
                file.seek(SeekFrom::Start(offset)).map_err(storage_error)?;
                file.read_exact(&mut bytes).map_err(storage_error)?;
                let (pixels, coverage) =
                    bytes.split_at_mut(self.block.width as usize * self.block.height as usize * 4);
                let left = column * self.block.width;
                let start_x = x.max(left);
                let start_y = y.max(first_row);
                let width = (x + width).min(left.saturating_add(self.block.width)) - start_x;
                let height =
                    (y + height).min(first_row.saturating_add(self.block.height)) - start_y;
                let source = crop_imm(
                    &image,
                    start_x - source_x,
                    start_y - source_y,
                    width,
                    height,
                );
                let mut target = ImageBuffer::<Rgba<u8>, _>::from_raw(
                    self.block.width,
                    self.block.height,
                    pixels,
                )
                .expect("block pixels");
                if opaque {
                    target
                        .copy_from(&*source, start_x - left, start_y - first_row)
                        .map_err(storage_error)?;
                } else {
                    overlay(
                        &mut target,
                        &*source,
                        i64::from(start_x - left),
                        i64::from(start_y - first_row),
                    );
                }
                for row in start_y - first_row..start_y - first_row + height {
                    let start = (row * self.block.width + start_x - left) as usize;
                    covered += cover(coverage, start, start + width as usize);
                }
                file.seek(SeekFrom::Start(offset)).map_err(storage_error)?;
                file.write_all(&bytes).map_err(storage_error)?;
                let rect = self.rect(region);
                *pending
                    .entry(region)
                    .or_insert(u64::from(rect.w) * u64::from(rect.h)) -= covered;
            }
        }
        while producer
            .pending
            .get(&producer.next_region)
            .is_some_and(|left| *left == 0)
        {
            self.publish_next(&mut producer)?;
        }
        Ok(())
    }
    fn contribution(
        &self,
        placement: &TilePlacement,
        image: &image::RgbaImage,
    ) -> crate::tile_output::Rect {
        let width = image
            .width()
            .min(
                placement
                    .expected_size
                    .as_ref()
                    .map_or(image.width(), |s| s.width),
            )
            .min(self.size.width.saturating_sub(placement.position.x));
        let height = image
            .height()
            .min(
                placement
                    .expected_size
                    .as_ref()
                    .map_or(image.height(), |s| s.height),
            )
            .min(self.size.height.saturating_sub(placement.position.y));
        let (x, width) = crop_overlap(
            placement.position.x,
            width,
            self.region.width,
            self.overlap.width,
        );
        let (y, height) = crop_overlap(
            placement.position.y,
            height,
            self.region.height,
            self.overlap.height,
        );
        crate::tile_output::Rect {
            x,
            y,
            w: width,
            h: height,
        }
    }
    fn publish_next(&self, producer: &mut Producer) -> Result<(), Error> {
        let index = producer.next_region;
        let mut queue = self.queue.lock().expect("strip queue lock");
        if let Some(error) = &queue.failure {
            return Err(error.clone());
        }
        producer.pending.remove(&index);
        producer.next_region += 1;
        queue.available = producer.next_region;
        drop(queue);
        self.changed.notify_all();
        Ok(())
    }
    /// After successful acquisition, finalize metadata in plan order and fill
    /// uncovered layout pixels with transparent black.
    pub(crate) fn finish(&self, reused: &[ReusedTile]) -> Result<(), Error> {
        let mut producer = self.producer.lock().expect("pixel producer lock");
        let mapping: BTreeMap<_, _> = reused
            .iter()
            .map(|t| ((t.position.x, t.position.y), t.index))
            .collect();
        let mut ordered: Vec<_> = producer.metadata.iter().collect();
        ordered.sort_by_key(|(id, m)| mapping.get(&m.position).copied().unwrap_or(**id));
        let icc = ordered.iter().find_map(|(_, m)| m.icc);
        let exif = ordered.iter().find_map(|(_, m)| m.exif);
        let metadata = (
            read_metadata(&mut producer.file, icc).map_err(storage_error)?,
            read_metadata(&mut producer.file, exif).map_err(storage_error)?,
        );
        producer.metadata.clear();
        self.queue.lock().expect("strip queue lock").metadata = Some(metadata);
        self.changed.notify_all();
        while producer.next_region < self.count {
            self.publish_next(&mut producer)?;
        }
        Ok(())
    }
    pub(crate) fn metadata(&self) -> Result<TileMetadata, Error> {
        let queue = self
            .changed
            .wait_while(self.queue.lock().expect("strip queue lock"), |q| {
                q.metadata.is_none() && q.failure.is_none()
            })
            .expect("strip queue lock");
        if let Some(error) = &queue.failure {
            return Err(error.clone());
        }
        Ok(queue.metadata.clone().expect("finished metadata"))
    }
    /// Read the first source tile's profile once the first region has frozen.
    /// Later tiles cannot change the container header. Call after receive_region.
    pub(crate) fn origin_profile(&self) -> Result<Option<Vec<u8>>, Error> {
        let mut producer = self.producer.lock().expect("pixel producer lock");
        let location = producer.origin_icc;
        read_metadata(&mut producer.file, location).map_err(storage_error)
    }
    pub(crate) fn consumed_region(&self, region: &PixelRegion) {
        self.queue.lock().expect("strip queue lock").consumed +=
            u64::from(region.rect.w) * u64::from(region.rect.h);
    }
    fn rect(&self, index: u32) -> crate::tile_output::Rect {
        let x = index % self.region_columns * self.region.width;
        let y = index / self.region_columns * self.region.height;
        crate::tile_output::Rect {
            x,
            y,
            w: self.region.width.min(self.size.width - x),
            h: self.region.height.min(self.size.height - y),
        }
    }
    /// Reads one immutable region. Waiting never holds the producer lock; unread
    /// regions remain on disk, regardless of arrival order or encoder speed.
    pub(crate) fn receive_region(&self) -> Result<Option<PixelRegion>, Error> {
        let mut queue = self
            .changed
            .wait_while(self.queue.lock().expect("strip queue lock"), |q| {
                q.next_region == q.available && q.next_region < self.count && q.failure.is_none()
            })
            .expect("strip queue lock");
        if let Some(error) = &queue.failure {
            return Err(error.clone());
        }
        if queue.next_region == self.count {
            return Ok(None);
        }
        let rect = self.rect(queue.next_region);
        queue.next_region += 1;
        drop(queue);
        let offset = (u64::from(rect.y / self.block.height) * u64::from(self.columns)
            + u64::from(rect.x / self.block.width))
            * self.block_bytes as u64;
        let length = rect.w as usize * rect.h as usize * 4;
        let mut reader = self.reader.lock().expect("pixel reader lock");
        let mut rgba = Vec::new();
        rgba.try_reserve_exact(length).map_err(storage_error)?;
        rgba.resize(length, 0);
        let mut rgba = image::RgbaImage::from_raw(rect.w, rect.h, rgba).expect("region pixels");
        let mut block = image::RgbaImage::new(self.block.width, self.block.height);
        let blocks = rect.w.div_ceil(self.block.width);
        for column in 0..blocks {
            reader
                .seek(SeekFrom::Start(
                    offset + u64::from(column) * self.block_bytes as u64,
                ))
                .map_err(storage_error)?;
            reader.read_exact(block.as_mut()).map_err(storage_error)?;
            let left = column * self.block.width;
            let width = self.block.width.min(rect.w - left);
            rgba.copy_from(&*crop_imm(&block, 0, 0, width, rect.h), left, 0)
                .map_err(storage_error)?;
        }
        discard(&reader, offset, u64::from(blocks) * self.block_bytes as u64);
        Ok(Some(PixelRegion {
            rect,
            rgba: rgba.into_raw(),
        }))
    }
    pub(crate) fn receive(&self) -> Result<Option<PixelStrip>, Error> {
        self.receive_region().map(|region| {
            region.map(|r| PixelStrip {
                first_row: r.rect.y,
                rows: r.rect.h,
                rgba: r.rgba,
            })
        })
    }
}

// Extremely large overlap makes the source cell ambiguous from a clipped
// position. In that case preserve the contributions and use ordinary composition.
fn crop_overlap(start: u32, length: u32, cell: u32, overlap: u32) -> (u32, u32) {
    if overlap == 0 || overlap >= cell {
        return (start, length);
    }
    let origin = ((start.saturating_add(overlap) / cell) * cell).max(start);
    (origin, length.saturating_sub(origin - start).min(cell))
}

fn cover(bytes: &mut [u8], start: usize, end: usize) -> u64 {
    let mut covered = 0;
    for (index, byte) in bytes[start / 8..end.div_ceil(8)].iter_mut().enumerate() {
        let first = (start / 8 + index) * 8;
        let low = start.saturating_sub(first);
        let high = (end - first).min(8);
        let mask = (u8::MAX << low) & (u8::MAX >> (8 - high));
        covered += u64::from((!*byte & mask).count_ones());
        *byte |= mask;
    }
    covered
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::imaging::DecodedTile;
    use dezoomify::model::{Point, TileRole};
    use image::Pixel;
    fn new_pipe(width: u32, height: u32) -> Arc<PixelPipe> {
        PixelPipe::new(Size { width, height }, std::env::temp_dir().as_path()).unwrap()
    }
    pub(crate) fn placement(x: u32, y: u32) -> TilePlacement {
        TilePlacement {
            position: Point { x, y },
            expected_size: None,
            canvas: None,
            processing: Default::default(),
            role: TileRole::output(),
        }
    }
    pub(crate) fn put(pipe: &PixelPipe, id: u32, x: u32, y: u32, image: image::RgbaImage) {
        pipe.place(
            id,
            &placement(x, y),
            DecodedTile {
                image,
                icc_profile: None,
                exif_metadata: None,
            },
        )
        .unwrap();
    }
    #[test]
    fn overlapping_tiles_are_composited_until_handoff_then_frozen() {
        let pipe = new_pipe(517, 257);
        for (id, (x, width, color)) in [
            (0, 257, [100, 0, 0, 255]),
            (0, 257, [0, 100, 0, 128]),
            (257, 260, [9, 8, 7, 255]),
            (0, 517, [0, 0, 255, 255]), // Complete strips are already frozen.
        ]
        .into_iter()
        .enumerate()
        {
            put(
                &pipe,
                id as u32,
                x,
                0,
                image::RgbaImage::from_pixel(width, 257, image::Rgba(color)),
            );
        }
        let mut left = image::Rgba([100, 0, 0, 255]);
        left.blend(&image::Rgba([0, 100, 0, 128]));
        let expected = image::RgbaImage::from_fn(517, 257, |x, _| {
            if x < 257 {
                left
            } else {
                image::Rgba([9, 8, 7, 255])
            }
        });
        let mut pixels = Vec::new();
        while let Some(strip) = pipe.receive().unwrap() {
            pixels.extend(strip.rgba);
        }
        assert_eq!(pixels, expected.into_raw());
        assert!(pipe.late() > 0);
    }
    #[test]
    fn reader_waits_for_required_pixels_and_failure_wakes_it() {
        for fail in [false, true] {
            let pipe = new_pipe(2, 1);
            put(
                &pipe,
                1,
                1,
                0,
                image::RgbaImage::from_pixel(1, 1, image::Rgba([9, 8, 7, 255])),
            );
            let reader = Arc::clone(&pipe);
            let (sent, received) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || sent.send(reader.receive()).unwrap());
            assert!(received
                .recv_timeout(std::time::Duration::from_millis(20))
                .is_err());
            if fail {
                pipe.fail(Error::WriteFailed("original failure".into()));
            } else {
                put(
                    &pipe,
                    0,
                    0,
                    0,
                    image::RgbaImage::from_pixel(1, 1, image::Rgba([1, 2, 3, 255])),
                );
            }
            let result = received
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            if fail {
                assert!(matches!(result, Err(Error::WriteFailed(_))));
            } else {
                assert_eq!(result.unwrap().unwrap().rgba, [1, 2, 3, 255, 9, 8, 7, 255]);
            }
            thread.join().unwrap();
        }
    }
    #[test]
    fn finish_fills_uncovered_layout_pixels() {
        let pipe = new_pipe(2, 1);
        put(
            &pipe,
            0,
            1,
            0,
            image::RgbaImage::from_pixel(1, 1, image::Rgba([9, 8, 7, 255])),
        );
        pipe.finish(&[]).unwrap();
        assert_eq!(
            pipe.receive().unwrap().unwrap().rgba,
            [0, 0, 0, 0, 9, 8, 7, 255]
        );
    }
    #[test]
    fn placement_can_finish_before_the_reader_starts() {
        let pipe = new_pipe(1, 256);
        let source = image::RgbaImage::from_fn(1, 256, |_, y| image::Rgba([y as u8, 0, 0, 255]));
        let expected = source.clone().into_raw();
        let producer = Arc::clone(&pipe);
        let (sent, received) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            put(&producer, 0, 0, 0, source);
            sent.send(()).unwrap();
        });
        received
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        thread.join().unwrap();
        let mut pixels = Vec::new();
        while let Some(strip) = pipe.receive().unwrap() {
            pixels.extend(strip.rgba);
        }
        assert_eq!(pixels, expected);
    }
}
