//! Disk-backed composition and ordered strip delivery. Producers never wait for
//! the encoder: unread pixels and coverage stay in a private staging file.
use crate::{
    imaging::DecodedTile,
    pixel_store::{
        discard, read_metadata, storage_error, store_metadata, temporary_file, MetadataLocation,
    },
};
use dezoomify::model::{Error, ReusedTile, Size, TilePlacement};
use image::Pixel;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Condvar, Mutex},
};

const STRIP_ROWS: u32 = 64; // JPEG consumes full-width eight-row bands.
type TileMetadata = (Option<Vec<u8>>, Option<Vec<u8>>);

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
    next_row: u32,
    metadata: BTreeMap<u32, Metadata>,
    late: u64,
}
#[derive(Default)]
struct Queue {
    available: u32,
    next_row: u32,
    metadata: Option<TileMetadata>,
    failure: Option<Error>,
    consumed: u64,
}
pub(crate) struct PixelPipe {
    pub(crate) size: Size,
    producer: Mutex<Producer>,
    queue: Mutex<Queue>,
    changed: Condvar,
    events: tokio::sync::Notify,
}
impl PixelPipe {
    pub(crate) fn new(size: Size, directory: &Path) -> Result<Arc<Self>, Error> {
        let pixels = u64::from(size.width) * u64::from(size.height);
        let length = pixels
            .checked_mul(4)
            .and_then(|n| n.checked_add(pixels.div_ceil(8)))
            .ok_or_else(|| Error::InvalidState("raster dimensions overflow".into()))?;
        let file = temporary_file(directory).map_err(storage_error)?;
        file.set_len(length).map_err(storage_error)?;
        Ok(Arc::new(Self {
            size,
            producer: Mutex::new(Producer {
                file,
                pending: BTreeMap::new(),
                next_row: 0,
                metadata: BTreeMap::new(),
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
    pub(crate) fn consumed_strip(&self, strip: &PixelStrip) {
        self.queue.lock().expect("strip queue lock").consumed +=
            u64::from(self.size.width) * u64::from(strip.rows);
    }
    pub(crate) fn late(&self) -> u64 {
        self.producer.lock().expect("pixel producer lock").late
    }
    #[cfg(test)]
    pub(crate) fn queued_strips(&self) -> usize {
        let queue = self.queue.lock().expect("strip queue lock");
        (queue.available - queue.next_row).div_ceil(STRIP_ROWS) as usize
    }
    /// Placement does disk I/O and must run on a blocking worker. Contributions
    /// composite until whole-strip handoff freezes the pixels. Later writes to
    /// frozen rows are discarded; conflicting overlaps have unspecified results.
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
        if decoded.icc_profile.is_some() || decoded.exif_metadata.is_some() {
            let icc = store_metadata(&mut producer.file, decoded.icc_profile.as_deref())
                .map_err(storage_error)?;
            let exif = store_metadata(&mut producer.file, decoded.exif_metadata.as_deref())
                .map_err(storage_error)?;
            producer.metadata.insert(
                id,
                Metadata {
                    position: (placement.position.x, placement.position.y),
                    icc,
                    exif,
                },
            );
        }
        let image = decoded.image;
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
        if width == 0 || height == 0 {
            return Ok(());
        }
        let opaque = image
            .as_raw()
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| p[3] == 255);
        for y in placement.position.y..placement.position.y + height {
            if let Some(error) = self.error() {
                return Err(error);
            }
            let first_row = y / STRIP_ROWS * STRIP_ROWS;
            if first_row < producer.next_row {
                producer.late += u64::from(y % STRIP_ROWS == 0 || y == placement.position.y);
                continue;
            }
            let start = u64::from(y) * u64::from(self.size.width) + u64::from(placement.position.x);
            let source = (y - placement.position.y) as usize * image.width() as usize * 4;
            let source = &image.as_raw()[source..source + width as usize * 4];
            producer
                .file
                .seek(SeekFrom::Start(start * 4))
                .map_err(storage_error)?;
            if opaque {
                producer.file.write_all(source).map_err(storage_error)?;
            } else {
                let mut target = vec![0; source.len()];
                producer
                    .file
                    .read_exact(&mut target)
                    .map_err(storage_error)?;
                for (dst, src) in target
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(source.as_chunks::<4>().0)
                {
                    let mut pixel = image::Rgba(*dst);
                    pixel.blend(&image::Rgba(*src));
                    *dst = pixel.0;
                }
                producer
                    .file
                    .seek(SeekFrom::Start(start * 4))
                    .map_err(storage_error)?;
                producer.file.write_all(&target).map_err(storage_error)?;
            }
            let covered = self.cover(&mut producer.file, start, start + u64::from(width))?;
            let rows = STRIP_ROWS.min(self.size.height - first_row);
            *producer
                .pending
                .entry(first_row)
                .or_insert(u64::from(self.size.width) * u64::from(rows)) -= covered;
        }
        while producer
            .pending
            .get(&producer.next_row)
            .is_some_and(|left| *left == 0)
        {
            self.publish_next(&mut producer)?;
        }
        Ok(())
    }
    fn cover(&self, file: &mut File, start: u64, end: u64) -> Result<u64, Error> {
        if start == end {
            return Ok(0);
        }
        let offset = u64::from(self.size.width) * u64::from(self.size.height) * 4 + start / 8;
        let mut bytes = vec![0; (end.div_ceil(8) - start / 8) as usize];
        file.seek(SeekFrom::Start(offset)).map_err(storage_error)?;
        file.read_exact(&mut bytes).map_err(storage_error)?;
        let mut covered = 0;
        for (index, byte) in bytes.iter_mut().enumerate() {
            let first = (start / 8 + index as u64) * 8;
            let low = start.saturating_sub(first);
            let high = (end - first).min(8);
            let mask = (u8::MAX << low) & (u8::MAX >> (8 - high));
            covered += u64::from((!*byte & mask).count_ones());
            *byte |= mask;
        }
        file.seek(SeekFrom::Start(offset)).map_err(storage_error)?;
        file.write_all(&bytes).map_err(storage_error)?;
        Ok(covered)
    }
    fn publish_next(&self, producer: &mut Producer) -> Result<(), Error> {
        let row = producer.next_row;
        let mut queue = self.queue.lock().expect("strip queue lock");
        if let Some(error) = &queue.failure {
            return Err(error.clone());
        }
        producer.pending.remove(&row);
        producer.next_row += STRIP_ROWS.min(self.size.height - row);
        queue.available = producer.next_row;
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
        while producer.next_row < self.size.height {
            self.publish_next(&mut producer)?;
        }
        Ok(())
    }
    pub(crate) fn metadata(&self) -> Result<TileMetadata, Error> {
        let mut queue = self.queue.lock().expect("strip queue lock");
        loop {
            if let Some(error) = &queue.failure {
                return Err(error.clone());
            }
            if let Some(metadata) = &queue.metadata {
                return Ok(metadata.clone());
            }
            queue = self.changed.wait(queue).expect("strip queue lock");
        }
    }
    /// Reads one immutable strip from staging. No producer lock is held waiting
    /// for missing tiles, so later tiles cannot prevent the required acquisition.
    pub(crate) fn receive(&self) -> Result<Option<PixelStrip>, Error> {
        let mut queue = self.queue.lock().expect("strip queue lock");
        loop {
            if let Some(error) = &queue.failure {
                return Err(error.clone());
            }
            if queue.next_row < queue.available {
                let first_row = queue.next_row;
                let rows = STRIP_ROWS.min(self.size.height - first_row);
                queue.next_row += rows;
                drop(queue);
                let offset = u64::from(first_row) * u64::from(self.size.width) * 4;
                let length = self.size.width as usize * rows as usize * 4;
                let mut producer = self.producer.lock().expect("pixel producer lock");
                let mut rgba = Vec::new();
                rgba.try_reserve_exact(length).map_err(storage_error)?;
                rgba.resize(length, 0);
                producer
                    .file
                    .seek(SeekFrom::Start(offset))
                    .map_err(storage_error)?;
                producer.file.read_exact(&mut rgba).map_err(storage_error)?;
                discard(&producer.file, offset, length as u64);
                return Ok(Some(PixelStrip {
                    first_row,
                    rows,
                    rgba,
                }));
            }
            if queue.next_row == self.size.height {
                return Ok(None);
            }
            queue = self.changed.wait(queue).expect("strip queue lock");
        }
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::imaging::DecodedTile;
    use dezoomify::model::{Point, TileRole};
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
    fn shuffled_tiles_are_copied_into_one_owned_strip_and_handoff_is_final() {
        let pipe = new_pipe(4, 2);
        put(
            &pipe,
            0,
            0,
            0,
            image::RgbaImage::from_pixel(2, 2, image::Rgba([100, 0, 0, 255])),
        );
        put(
            &pipe,
            1,
            0,
            0,
            image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 100, 0, 128])),
        );
        assert_eq!(pipe.queued_strips(), 0);
        put(
            &pipe,
            2,
            2,
            0,
            image::RgbaImage::from_pixel(2, 2, image::Rgba([9, 8, 7, 255])),
        );
        let strip = pipe.receive().unwrap().unwrap();
        let mut expected = image::Rgba([100, 0, 0, 255]);
        expected.blend(&image::Rgba([0, 100, 0, 128]));
        assert_eq!(&strip.rgba[..4], &expected.0);
        assert_eq!(&strip.rgba[8..12], &[9, 8, 7, 255]);
        put(
            &pipe,
            3,
            0,
            0,
            image::RgbaImage::from_pixel(4, 2, image::Rgba([0, 0, 255, 255])),
        );
        assert_eq!(&strip.rgba[..4], &expected.0);
        assert_eq!(pipe.late(), 1);
        drop(strip);
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
        assert_eq!(pipe.queued_strips(), 0);
        pipe.finish(&[]).unwrap();
        assert_eq!(
            pipe.receive().unwrap().unwrap().rgba,
            [0, 0, 0, 0, 9, 8, 7, 255]
        );
    }
    #[test]
    fn slow_readers_and_cancellation_do_not_block_placement() {
        for cancel in [false, true] {
            let pipe = new_pipe(1, 256);
            let producer = Arc::clone(&pipe);
            let (sent, received) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                let image =
                    image::RgbaImage::from_fn(1, 256, |_, y| image::Rgba([y as u8, 0, 0, 255]));
                sent.send(producer.place(
                    0,
                    &placement(0, 0),
                    DecodedTile {
                        image,
                        icc_profile: None,
                        exif_metadata: None,
                    },
                ))
                .unwrap();
            });
            received
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()
                .unwrap();
            assert_eq!(pipe.queued_strips(), 4);
            if cancel {
                pipe.fail(Error::Cancelled);
                assert!(matches!(pipe.receive(), Err(Error::Cancelled)));
            } else {
                for row in [0, 64, 128, 192] {
                    let strip = pipe.receive().unwrap().unwrap();
                    assert_eq!(strip.first_row, row);
                    assert_eq!(strip.rgba[0], row as u8);
                }
                assert!(pipe.receive().unwrap().is_none());
            }
            thread.join().unwrap();
        }
    }
}
