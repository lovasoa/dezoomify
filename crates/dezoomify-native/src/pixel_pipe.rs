//! Producer-owned reordering and immutable strips sharing one byte budget.
use dezoomify::model::{Error, ReusedTile, Size, TilePlacement};
use image::Pixel;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Condvar, Mutex},
};

#[derive(Default)]
struct Usage {
    current: u64,
    peak: u64,
}

pub(crate) struct MemoryBudget {
    cap: u64,
    usage: Mutex<Usage>,
}
impl MemoryBudget {
    pub(crate) fn new(cap: u64) -> Arc<Self> {
        Arc::new(Self {
            cap,
            usage: Mutex::new(Usage::default()),
        })
    }
    /// Never wait for RAM: an unresolved missing tile can prevent the reader
    /// from freeing any pixels until a retry supplies pixels. Fail with a typed
    /// limit instead of occupying every acquisition slot in a circular wait.
    pub(crate) fn reserve(self: &Arc<Self>, bytes: u64) -> Result<Reservation, Error> {
        let mut usage = self.usage.lock().expect("memory accounting lock");
        let required = usage.current.saturating_add(bytes);
        crate::tile_output::memory_check(required, self.cap)?;
        usage.current += bytes;
        usage.peak = usage.peak.max(usage.current);
        Ok(Reservation {
            budget: Arc::clone(self),
            bytes,
        })
    }
    pub(crate) fn peak(&self) -> u64 {
        self.usage.lock().expect("memory accounting lock").peak
    }
    pub(crate) fn available(&self) -> u64 {
        self.cap - self.usage.lock().expect("memory accounting lock").current
    }
    #[cfg(test)]
    pub(crate) fn current(&self) -> u64 {
        self.usage.lock().expect("memory accounting lock").current
    }
}
pub(crate) struct Reservation {
    budget: Arc<MemoryBudget>,
    bytes: u64,
}
impl Reservation {
    pub(crate) fn shrink(&mut self, bytes: u64) {
        assert!(bytes <= self.bytes);
        self.budget
            .usage
            .lock()
            .expect("memory accounting lock")
            .current -= self.bytes - bytes;
        self.bytes = bytes;
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget
            .usage
            .lock()
            .expect("memory accounting lock")
            .current -= self.bytes;
    }
}

const STRIP_ROWS: u32 = 64; // JPEG finishes full-width eight-row bands.

pub(crate) struct PixelStrip {
    pub(crate) first_row: u32,
    pub(crate) rows: u32,
    pub(crate) rgba: Vec<u8>,
    _memory: Reservation,
}
struct PendingStrip {
    pixels: PixelStrip,
    coverage: Vec<u64>,
    missing: u64,
}
impl PendingStrip {
    fn cover(&mut self, start: usize, end: usize) {
        for word in start / 64..end.div_ceil(64) {
            let a = start.saturating_sub(word * 64);
            let b = (end - word * 64).min(64);
            let mask = (u64::MAX << a) & (u64::MAX >> (64 - b));
            self.missing -= u64::from((mask & !self.coverage[word]).count_ones());
            self.coverage[word] |= mask;
        }
    }
}
type TileMetadata = (Option<Vec<u8>>, Option<Vec<u8>>);
pub(crate) struct ReceivedPixels {
    pub(crate) decoded: crate::imaging::DecodedTile,
    _pixels: Reservation,
    metadata: Reservation,
}
impl ReceivedPixels {
    pub(crate) fn new(
        decoded: crate::imaging::DecodedTile,
        mut pixels: Reservation,
    ) -> Result<Self, Error> {
        let bytes = decoded.icc_profile.as_ref().map_or(0, Vec::len)
            + decoded.exif_metadata.as_ref().map_or(0, Vec::len);
        // Keep the metadata and its finalization copies charged from decode
        // through placement, including time spent waiting in deferred storage.
        let metadata = pixels.budget.reserve(if bytes == 0 {
            0
        } else {
            bytes as u64 * 3 + 128
        })?;
        pixels.shrink(decoded.image.as_raw().len() as u64);
        Ok(Self {
            decoded,
            _pixels: pixels,
            metadata,
        })
    }
}
struct Metadata {
    position: (u32, u32),
    data: TileMetadata,
    _memory: Reservation,
}
#[derive(Default)]
struct Producer {
    pending: BTreeMap<u32, PendingStrip>,
    next_row: u32,
    metadata: BTreeMap<u32, Metadata>,
    late: u64,
}
#[derive(Default)]
struct Queue {
    ready: VecDeque<PixelStrip>,
    closed: bool,
    metadata: Option<TileMetadata>,
    failure: Option<Error>,
    consumed: u64,
}
pub(crate) struct PixelPipe {
    pub(crate) size: Size,
    pub(crate) budget: Arc<MemoryBudget>,
    producer: Mutex<Producer>,
    queue: Mutex<Queue>,
    changed: Condvar,
    events: tokio::sync::Notify,
}
impl PixelPipe {
    pub(crate) fn new(size: Size, budget: Arc<MemoryBudget>) -> Arc<Self> {
        Arc::new(Self {
            size,
            budget,
            producer: Mutex::new(Producer::default()),
            queue: Mutex::new(Queue::default()),
            changed: Condvar::new(),
            events: tokio::sync::Notify::new(),
        })
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
        {
            let mut queue = self.queue.lock().expect("strip queue lock");
            queue.failure.get_or_insert(error);
            queue.ready.clear();
        }
        self.changed.notify_all();
        self.events.notify_waiters();
        let mut producer = self.producer.lock().expect("pixel producer lock");
        producer.pending.clear();
        producer.metadata.clear();
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
        self.queue.lock().expect("strip queue lock").ready.len()
    }
    fn blank(&self, first_row: u32) -> Result<PendingStrip, Error> {
        let rows = STRIP_ROWS.min(self.size.height - first_row);
        let pixels = u64::from(self.size.width) * u64::from(rows);
        let words = pixels.div_ceil(64) as usize;
        let memory = self.budget.reserve(pixels * 4 + words as u64 * 8 + 128)?;
        Ok(PendingStrip {
            pixels: PixelStrip {
                first_row,
                rows,
                rgba: vec![0; pixels as usize * 4],
                _memory: memory,
            },
            coverage: vec![0; words],
            missing: pixels,
        })
    }
    /// Geometry and composition operate only on producer-owned allocations.
    /// Any contribution covers a pixel; overlaps composite until whole-strip
    /// handoff freezes even unread pixels. Later contributions to handed-off
    /// rows are discarded, but later rows still apply. Conflicting overlaps
    /// have unspecified results across runs/strips; identical opaque ones do not.
    pub(crate) fn place(
        &self,
        id: u32,
        placement: &TilePlacement,
        pixels: ReceivedPixels,
    ) -> Result<(), Error> {
        let mut producer = self.producer.lock().expect("pixel producer lock");
        if let Some(error) = self.error() {
            return Err(error);
        }
        let decoded = pixels.decoded;
        let image = decoded.image;
        let metadata_bytes = decoded.icc_profile.as_ref().map_or(0, Vec::len)
            + decoded.exif_metadata.as_ref().map_or(0, Vec::len);
        if metadata_bytes > 0 {
            producer.metadata.insert(
                id,
                Metadata {
                    position: (placement.position.x, placement.position.y),
                    data: (decoded.icc_profile, decoded.exif_metadata),
                    _memory: pixels.metadata,
                },
            );
        }
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
        let end = placement.position.y + height;
        let mut y = placement.position.y;
        let opaque = image
            .as_raw()
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| p[3] == 255);
        while y < end {
            let first_row = y / STRIP_ROWS * STRIP_ROWS;
            let until = end.min(first_row.saturating_add(STRIP_ROWS));
            if first_row < producer.next_row {
                producer.late += 1;
            } else {
                if let std::collections::btree_map::Entry::Vacant(entry) =
                    producer.pending.entry(first_row)
                {
                    let pending = self.blank(first_row)?;
                    entry.insert(pending);
                }
                let pending = producer.pending.get_mut(&first_row).expect("pending strip");
                for row in y..until {
                    let source =
                        ((row - placement.position.y) as usize * image.width() as usize) * 4;
                    let start = (row - first_row) as usize * self.size.width as usize
                        + placement.position.x as usize;
                    let target = &mut pending.pixels.rgba[start * 4..(start + width as usize) * 4];
                    let source = &image.as_raw()[source..source + width as usize * 4];
                    if opaque {
                        target.copy_from_slice(source);
                    } else {
                        for (dst, src) in target
                            .as_chunks_mut::<4>()
                            .0
                            .iter_mut()
                            .zip(source.as_chunks::<4>().0.iter())
                        {
                            let mut pixel = image::Rgba(*dst);
                            pixel.blend(&image::Rgba(*src));
                            *dst = pixel.0;
                        }
                    }
                    pending.cover(start, start + width as usize);
                }
                self.publish(&mut producer, false)?;
            }
            y = until;
        }
        Ok(())
    }
    fn publish(&self, producer: &mut Producer, keep: bool) -> Result<(), Error> {
        while producer.next_row < self.size.height {
            let row = producer.next_row;
            if !keep && !producer.pending.get(&row).is_some_and(|s| s.missing == 0) {
                break;
            }
            if let std::collections::btree_map::Entry::Vacant(entry) = producer.pending.entry(row) {
                entry.insert(self.blank(row)?);
            }
            let mut queue = self.queue.lock().expect("strip queue lock");
            if let Some(error) = &queue.failure {
                return Err(error.clone());
            }
            let mut pending = producer.pending.remove(&row).expect("ready strip");
            drop(pending.coverage);
            pending
                .pixels
                ._memory
                .shrink(pending.pixels.rgba.len() as u64);
            producer.next_row += pending.pixels.rows;
            // Handoff freezes the whole strip. Its reservation follows it into
            // the queue and encoder; there is no separate queue capacity/wait.
            queue.ready.push_back(pending.pixels);
            queue.closed = producer.next_row == self.size.height;
            drop(queue);
            self.changed.notify_all();
        }
        Ok(())
    }
    /// Finalize uncovered pixels for positioned layouts after acquisition succeeds.
    pub(crate) fn finish(&self, reused: &[ReusedTile]) -> Result<(), Error> {
        let mut producer = self.producer.lock().expect("pixel producer lock");
        let mapping: BTreeMap<_, _> = reused
            .iter()
            .map(|t| ((t.position.x, t.position.y), t.index))
            .collect();
        let mut ordered: Vec<_> = producer.metadata.iter().collect();
        ordered.sort_by_key(|(id, m)| mapping.get(&m.position).copied().unwrap_or(**id));
        let mut metadata = (None, None);
        for (_, m) in ordered {
            if metadata.0.is_none() {
                metadata.0.clone_from(&m.data.0);
            }
            if metadata.1.is_none() {
                metadata.1.clone_from(&m.data.1);
            }
        }
        self.queue.lock().expect("strip queue lock").metadata = Some(metadata);
        self.changed.notify_all();
        self.publish(&mut producer, true)
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
    /// The encoder receives exclusive ownership; pixel access needs no lock.
    pub(crate) fn receive(&self) -> Result<Option<PixelStrip>, Error> {
        let mut queue = self.queue.lock().expect("strip queue lock");
        loop {
            if let Some(error) = &queue.failure {
                return Err(error.clone());
            }
            if let Some(strip) = queue.ready.pop_front() {
                drop(queue);
                self.changed.notify_all();
                return Ok(Some(strip));
            }
            if queue.closed {
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
        PixelPipe::new(Size { width, height }, MemoryBudget::new(8192))
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
        let memory = pipe.budget.reserve(image.as_raw().len() as u64).unwrap();
        pipe.place(
            id,
            &placement(x, y),
            ReceivedPixels::new(
                DecodedTile {
                    image,
                    icc_profile: None,
                    exif_metadata: None,
                },
                memory,
            )
            .unwrap(),
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
        assert_eq!(pipe.budget.current(), strip.rgba.len() as u64);
        drop(strip);
        assert_eq!(pipe.budget.current(), 0);
    }
    #[test]
    fn retry_and_finish_preserve_holes_and_failure_wakes_the_reader() {
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
        let pipe = new_pipe(2, 1);
        pipe.finish(&[]).unwrap();
        assert_eq!(pipe.receive().unwrap().unwrap().rgba, [0; 8]);
    }
    #[test]
    fn handoffs_release_owned_memory_and_cancellation_clears_queued_strips() {
        for cancel in [false, true] {
            let pipe = new_pipe(1, 256);
            let producer = Arc::clone(&pipe);
            let (sent, received) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                let image =
                    image::RgbaImage::from_fn(1, 256, |_, y| image::Rgba([y as u8, 0, 0, 255]));
                let memory = producer.budget.reserve(1024).unwrap();
                sent.send(
                    producer.place(
                        0,
                        &placement(0, 0),
                        ReceivedPixels::new(
                            DecodedTile {
                                image,
                                icc_profile: None,
                                exif_metadata: None,
                            },
                            memory,
                        )
                        .unwrap(),
                    ),
                )
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
            assert_eq!(pipe.budget.current(), 0);
        }
    }
    #[test]
    fn full_budget_returns_a_limit_without_waiting() {
        let budget = MemoryBudget::new(100);
        let in_use = budget.reserve(60).unwrap();
        let remainder = budget.reserve(40).unwrap();
        assert_eq!(budget.current(), 100);
        assert!(budget.reserve(1).is_err());
        drop(remainder);
        drop(in_use);
        assert_eq!(budget.current(), 0);
        assert_eq!(budget.peak(), 100);
    }
}
