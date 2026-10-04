//! RAM-only pixels, indexed in output order. Producers own geometry; readers
//! count reads and seal requested pixels against subsequent writes.
use dezoomify::model::{Error, ReusedTile, Size, TilePlacement};
use image::Pixel;
use std::{
    collections::BTreeMap,
    ops::Range,
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
    /// from freeing any pixels until the user chooses Keep. Fail with a typed
    /// limit instead of occupying every acquisition slot in a circular wait.
    pub(crate) fn reserve(
        self: &Arc<Self>,
        bytes: u64,
        priority_credit: u64,
    ) -> Result<Reservation, Error> {
        let mut usage = self.usage.lock().expect("memory accounting lock");
        let required = usage
            .current
            .saturating_add(bytes)
            .saturating_add(priority_credit);
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

/// Each backing allocation is charged once, until its last stripe/lease dies.
struct PixelBuffer {
    bytes: Vec<u8>,
    _reservation: Reservation,
}
#[derive(Clone)]
struct PixelStripe {
    start: u64,
    buffer: Arc<PixelBuffer>,
    bytes: Range<usize>,
    remaining_reads: u64,
}
impl PixelStripe {
    fn end(&self) -> u64 {
        self.start + (self.bytes.len() / 4) as u64
    }
    fn slice(&self, range: Range<u64>) -> Self {
        let a = self.bytes.start + ((range.start - self.start) * 4) as usize;
        Self {
            start: range.start,
            buffer: Arc::clone(&self.buffer),
            bytes: a..a + ((range.end - range.start) * 4) as usize,
            remaining_reads: 0,
        }
    }
    fn pixels(&self) -> &[u8] {
        &self.buffer.bytes[self.bytes.clone()]
    }
}
type TileMetadata = (Option<Vec<u8>>, Option<Vec<u8>>);
struct Metadata {
    position: (u32, u32),
    data: TileMetadata,
    _reservation: Reservation,
}
#[derive(Default)]
struct PipeState {
    ready: BTreeMap<u64, PixelStripe>,
    // Consumed intervals beyond the contiguous frontier (JPEG block reads).
    sealed: BTreeMap<u64, u64>,
    frontier: u64,
    // Extra reads only occur at padded JPEG edges. Ordinary first reads are
    // already represented by frontier/sealed; no per-pixel counter array.
    extra_reads: BTreeMap<u64, u32>,
    metadata: BTreeMap<u32, Metadata>,
    final_metadata: Option<TileMetadata>,
    failure: Option<Error>,
    consumed: u64,
    late: u64,
}
pub(crate) struct PixelPipe {
    pub(crate) size: Size,
    pub(crate) budget: Arc<MemoryBudget>,
    state: Mutex<PipeState>,
    producer: Mutex<()>,
    changed: Condvar,
    events: tokio::sync::Notify,
    // Credit keeps later tiles from spending RAM needed by the first band.
    band_height: u32,
    reads: ReadCounts,
}
/// Supplied by the codec adapter. The pipe has no JPEG traversal logic.
#[derive(Clone, Copy, Default)]
pub(crate) struct ReadCounts {
    pub(crate) pad_x: u32,
    pub(crate) pad_y: u32,
}
impl ReadCounts {
    fn at(self, position: u64, size: &Size) -> u32 {
        if self.pad_x == 0 && self.pad_y == 0 {
            return 1;
        }
        let x = position % u64::from(size.width);
        let y = position / u64::from(size.width);
        (1 + if x + 1 == u64::from(size.width) {
            self.pad_x
        } else {
            0
        }) * (1 + if y + 1 == u64::from(size.height) {
            self.pad_y
        } else {
            0
        })
    }
    fn total(self, range: Range<u64>, size: &Size) -> u64 {
        let width = u64::from(size.width);
        let last_row = width * u64::from(size.height - 1);
        let final_pixel = width * u64::from(size.height) - 1;
        range.end - range.start
            + u64::from(self.pad_x) * (range.end / width - range.start / width)
            + u64::from(self.pad_y)
                * range
                    .end
                    .min(final_pixel + 1)
                    .saturating_sub(range.start.max(last_row))
            + if range.contains(&final_pixel) {
                u64::from(self.pad_x) * u64::from(self.pad_y)
            } else {
                0
            }
    }
}
impl PixelPipe {
    pub(crate) fn new(
        size: Size,
        budget: Arc<MemoryBudget>,
        band_height: u32,
        reads: ReadCounts,
    ) -> Arc<Self> {
        Arc::new(Self {
            size,
            budget,
            state: Mutex::new(PipeState::default()),
            producer: Mutex::new(()),
            changed: Condvar::new(),
            events: tokio::sync::Notify::new(),
            band_height: band_height.max(8),
            reads,
        })
    }
    pub(crate) fn error(&self) -> Option<Error> {
        self.state.lock().expect("pixel pipe lock").failure.clone()
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
        let mut state = self.state.lock().expect("pixel pipe lock");
        if state.failure.is_none() {
            state.failure = Some(error);
        }
        state.ready.clear();
        drop(state);
        self.changed.notify_all();
        self.events.notify_waiters();
    }
    pub(crate) fn consumed(&self) -> u64 {
        self.state.lock().expect("pixel pipe lock").consumed
    }
    pub(crate) fn late(&self) -> u64 {
        self.state.lock().expect("pixel pipe lock").late
    }
    #[cfg(test)]
    pub(crate) fn buffered_stripes(&self) -> usize {
        self.state.lock().expect("pixel pipe lock").ready.len()
    }
    pub(crate) fn priority_credit(&self, placement: &TilePlacement) -> u64 {
        let state = self.state.lock().expect("pixel pipe lock");
        let row = (state.frontier / u64::from(self.size.width)) as u32;
        if placement.position.y <= row.saturating_add(7) {
            return 0;
        }
        let end =
            u64::from((row + self.band_height).min(self.size.height)) * u64::from(self.size.width);
        let present: u64 = state
            .ready
            .values()
            .map(|s| s.end().min(end).saturating_sub(s.start.max(state.frontier)))
            .sum();
        (end.saturating_sub(state.frontier).saturating_sub(present)) * 4
    }
    pub(crate) fn place(
        &self,
        id: u32,
        placement: &TilePlacement,
        decoded: crate::imaging::DecodedTile,
        reservation: Reservation,
    ) -> Result<(), Error> {
        let _producer = self.producer.lock().expect("pixel producer lock");
        if let Some(error) = self.error() {
            return Err(error);
        }
        let width = decoded.image.width();
        let height = decoded.image.height();
        let expected = placement.expected_size.as_ref();
        let w = width
            .min(expected.map_or(width, |s| s.width))
            .min(self.size.width.saturating_sub(placement.position.x));
        let h = height
            .min(expected.map_or(height, |s| s.height))
            .min(self.size.height.saturating_sub(placement.position.y));
        let buffer = Arc::new(PixelBuffer {
            bytes: decoded.image.into_raw(),
            _reservation: reservation,
        });
        let metadata_bytes = decoded.icc_profile.as_ref().map_or(0, Vec::len)
            + decoded.exif_metadata.as_ref().map_or(0, Vec::len);
        if metadata_bytes > 0 {
            let metadata_reservation = self.budget.reserve(metadata_bytes as u64 * 3 + 128, 0)?;
            let mut state = self.state.lock().expect("pixel pipe lock");
            state.metadata.insert(
                id,
                Metadata {
                    position: (placement.position.x, placement.position.y),
                    data: (decoded.icc_profile, decoded.exif_metadata),
                    _reservation: metadata_reservation,
                },
            );
        }
        let rows = (0..h).map(|y| {
            let start = u64::from(placement.position.y + y) * u64::from(self.size.width)
                + u64::from(placement.position.x);
            let bytes = (u64::from(y) * u64::from(width) * 4) as usize;
            PixelStripe {
                start,
                buffer: Arc::clone(&buffer),
                bytes: bytes..bytes + w as usize * 4,
                remaining_reads: 0,
            }
        });
        if buffer.bytes.as_chunks::<4>().0.iter().all(|p| p[3] == 255) {
            let mut state = self.state.lock().expect("pixel pipe lock");
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            for stripe in rows {
                self.publish(&mut state, stripe);
            }
            drop(state);
            self.changed.notify_all();
            return Ok(());
        }
        for incoming in rows {
            let start = incoming.start;
            let old = {
                let state = self.state.lock().expect("pixel pipe lock");
                segments(&state.ready, start..start + u64::from(w))
            };
            // Geometry and alpha composition happen outside the shared lock.
            // Opaque writes just replace descriptors without copying pixels.
            let composite = if !old.is_empty()
                && incoming
                    .pixels()
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|p| p[3] != 255)
            {
                let reservation = self.budget.reserve(w as u64 * 4, 0)?;
                let mut bytes = vec![0; w as usize * 4];
                for stripe in old {
                    let offset = ((stripe.start - start) * 4) as usize;
                    bytes[offset..offset + stripe.bytes.len()].copy_from_slice(stripe.pixels());
                }
                for (dst, src) in bytes
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(incoming.pixels().as_chunks::<4>().0.iter())
                {
                    let mut pixel = image::Rgba([dst[0], dst[1], dst[2], dst[3]]);
                    pixel.blend(&image::Rgba([src[0], src[1], src[2], src[3]]));
                    dst.copy_from_slice(&pixel.0);
                }
                PixelStripe {
                    start,
                    buffer: Arc::new(PixelBuffer {
                        bytes,
                        _reservation: reservation,
                    }),
                    bytes: 0..w as usize * 4,
                    remaining_reads: 0,
                }
            } else {
                incoming
            };
            let mut state = self.state.lock().expect("pixel pipe lock");
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            self.publish(&mut state, composite);
            drop(state);
            self.changed.notify_all();
        }
        Ok(())
    }
    fn publish(&self, state: &mut PipeState, stripe: PixelStripe) {
        let writable = unsealed(state, stripe.start..stripe.end());
        if writable.iter().map(|r| r.end - r.start).sum::<u64>() != stripe.end() - stripe.start {
            state.late += 1;
        }
        for range in writable {
            self.remove(state, range.clone());
            let mut part = stripe.slice(range.clone());
            part.remaining_reads = self.reads.total(range, &self.size);
            insert(&mut state.ready, part);
        }
    }
    /// Called only after acquisition and the Keep/complete decision. Until
    /// then a gap can still be repaired by Retry and cannot be read as black.
    pub(crate) fn finish(&self, reused: &[ReusedTile]) {
        let mut state = self.state.lock().expect("pixel pipe lock");
        let mapping: BTreeMap<_, _> = reused
            .iter()
            .map(|t| ((t.position.x, t.position.y), t.index))
            .collect();
        let mut ordered: Vec<_> = state.metadata.iter().collect();
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
        state.final_metadata = Some(metadata);
        drop(state);
        self.changed.notify_all();
    }
    pub(crate) fn metadata(&self) -> Result<TileMetadata, Error> {
        let mut state = self.state.lock().expect("pixel pipe lock");
        loop {
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            if let Some(metadata) = &state.final_metadata {
                return Ok(metadata.clone());
            }
            state = self.changed.wait(state).expect("pixel pipe lock");
        }
    }
    pub(crate) fn read(&self, range: Range<u64>) -> Result<PixelLease, Error> {
        let mut state = self.state.lock().expect("pixel pipe lock");
        loop {
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            let stripes = segments(&state.ready, range.clone());
            let count: u64 = stripes.iter().map(|s| s.end() - s.start).sum();
            if count == range.end - range.start || state.final_metadata.is_some() {
                let mut filled = Vec::new();
                let mut position = range.start;
                for stripe in stripes {
                    if stripe.start > position {
                        filled.push(self.blank(position..stripe.start)?);
                    }
                    position = stripe.end();
                    filled.push(stripe);
                }
                if position < range.end {
                    filled.push(self.blank(position..range.end)?);
                }
                self.remove(&mut state, range.clone());
                seal(&mut state, range.clone());
                state.consumed += range.end - range.start;
                return Ok(PixelLease { stripes: filled });
            }
            state = self.changed.wait(state).expect("pixel pipe lock");
        }
    }
    fn blank(&self, range: Range<u64>) -> Result<PixelStripe, Error> {
        let len = ((range.end - range.start) * 4) as usize;
        let reservation = self.budget.reserve(len as u64, 0)?;
        Ok(PixelStripe {
            start: range.start,
            buffer: Arc::new(PixelBuffer {
                bytes: vec![0; len],
                _reservation: reservation,
            }),
            bytes: 0..len,
            remaining_reads: self.reads.total(range, &self.size),
        })
    }
    fn remaining(&self, state: &PipeState, range: Range<u64>) -> u64 {
        let first_reads = range.end.min(state.frontier).saturating_sub(range.start)
            + state
                .sealed
                .range(..range.end)
                .map(|(&a, &b)| b.min(range.end).saturating_sub(a.max(range.start)))
                .sum::<u64>();
        let extra = state
            .extra_reads
            .range(range.clone())
            .map(|(_, &n)| u64::from(n))
            .sum::<u64>();
        self.reads
            .total(range, &self.size)
            .saturating_sub(first_reads + extra)
    }
    fn remove(&self, state: &mut PipeState, range: Range<u64>) {
        for stripe in segments(&state.ready, range.clone()) {
            let original = state
                .ready
                .range(..=stripe.start)
                .next_back()
                .map(|(_, s)| s.clone())
                .expect("indexed stripe");
            state.ready.remove(&original.start);
            for remaining in [
                original.start..original.end().min(range.start),
                original.start.max(range.end)..original.end(),
            ] {
                if remaining.start < remaining.end {
                    let mut stripe = original.slice(remaining.clone());
                    stripe.remaining_reads = self.remaining(state, remaining);
                    if stripe.remaining_reads > 0 {
                        state.ready.insert(stripe.start, stripe);
                    }
                }
            }
        }
    }
    /// JPEG's fallible adapter calls this once per actual pixel request. The
    /// stripe remains indexed until its aggregate counter reaches zero.
    pub(crate) fn pixel(&self, position: u64) -> Result<image::Rgb<u8>, Error> {
        let mut state = self.state.lock().expect("pixel pipe lock");
        loop {
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            let already_read = position < state.frontier
                || state
                    .sealed
                    .range(..=position)
                    .next_back()
                    .is_some_and(|(_, &end)| position < end);
            let count = if already_read {
                1 + state.extra_reads.get(&position).copied().unwrap_or(0)
            } else {
                0
            };
            if let Some((&key, stripe)) = state
                .ready
                .range_mut(..=position)
                .next_back()
                .filter(|(_, s)| position < s.end())
            {
                if count >= self.reads.at(position, &self.size) {
                    return Err(Error::Internal(
                        "codec exceeded declared pixel reads".into(),
                    ));
                }
                let offset = stripe.bytes.start + ((position - stripe.start) * 4) as usize;
                let bytes = &stripe.buffer.bytes[offset..offset + 3];
                let pixel = image::Rgb([bytes[0], bytes[1], bytes[2]]);
                stripe.remaining_reads -= 1;
                let end = stripe.end();
                let done = stripe.remaining_reads == 0;
                if already_read {
                    *state.extra_reads.entry(position).or_default() += 1;
                } else {
                    seal(&mut state, position..position + 1);
                    state.consumed += 1;
                }
                if done {
                    state.ready.remove(&key);
                    let extras: Vec<_> =
                        state.extra_reads.range(key..end).map(|(&p, _)| p).collect();
                    for position in extras {
                        state.extra_reads.remove(&position);
                    }
                }
                return Ok(pixel);
            }
            if state.final_metadata.is_some() {
                // Keep finalized this hole. Black padding needs no allocation.
                if position >= state.frontier
                    && !state
                        .sealed
                        .range(..=position)
                        .next_back()
                        .is_some_and(|(_, &end)| position < end)
                {
                    seal(&mut state, position..position + 1);
                    state.consumed += 1;
                }
                return Ok(image::Rgb([0, 0, 0]));
            }
            if position < state.frontier
                || state
                    .sealed
                    .range(..=position)
                    .next_back()
                    .is_some_and(|(_, &end)| position < end)
            {
                return Err(Error::Internal("codec reread a released stripe".into()));
            }
            state = self.changed.wait(state).expect("pixel pipe lock");
        }
    }
}
pub(crate) struct PixelLease {
    stripes: Vec<PixelStripe>,
}
impl PixelLease {
    pub(crate) fn segments(&self) -> impl Iterator<Item = &[u8]> {
        self.stripes.iter().map(PixelStripe::pixels)
    }
}
fn segments(map: &BTreeMap<u64, PixelStripe>, range: Range<u64>) -> Vec<PixelStripe> {
    map.range(..range.end)
        .rev()
        .take_while(|(_, s)| s.end() > range.start)
        .map(|(_, s)| s.slice(s.start.max(range.start)..s.end().min(range.end)))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}
fn insert(map: &mut BTreeMap<u64, PixelStripe>, mut stripe: PixelStripe) {
    if let Some((_, previous)) = map.range(..stripe.start).next_back() {
        if previous.end() == stripe.start
            && Arc::ptr_eq(&previous.buffer, &stripe.buffer)
            && previous.bytes.end == stripe.bytes.start
        {
            let previous = previous.clone();
            map.remove(&previous.start);
            stripe.start = previous.start;
            stripe.bytes.start = previous.bytes.start;
            stripe.remaining_reads += previous.remaining_reads;
        }
    }
    map.insert(stripe.start, stripe);
}
fn unsealed(state: &PipeState, range: Range<u64>) -> Vec<Range<u64>> {
    let mut start = range.start.max(state.frontier);
    let mut result = Vec::new();
    for (&a, &b) in state.sealed.range(..range.end) {
        if b <= start {
            continue;
        }
        if a > start {
            result.push(start..a);
        }
        start = start.max(b);
    }
    if start < range.end {
        result.push(start..range.end);
    }
    result
}
fn seal(state: &mut PipeState, range: Range<u64>) {
    let mut a = range.start;
    let mut b = range.end;
    if a <= state.frontier {
        state.frontier = state.frontier.max(b);
        while let Some((&start, &end)) = state.sealed.first_key_value() {
            if start > state.frontier {
                break;
            }
            state.frontier = state.frontier.max(end);
            state.sealed.pop_first();
        }
        return;
    }
    if let Some((&start, &end)) = state.sealed.range(..=a).next_back() {
        if end >= a {
            a = start;
            b = b.max(end);
        }
    }
    while let Some((&start, &end)) = state.sealed.range(a + 1..=b).next() {
        b = b.max(end);
        state.sealed.remove(&start);
    }
    state.sealed.insert(a, b);
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::imaging::DecodedTile;
    use dezoomify::model::{Point, TileRole};
    fn new_pipe(width: u32, height: u32, reads: ReadCounts) -> Arc<PixelPipe> {
        PixelPipe::new(Size { width, height }, MemoryBudget::new(4096), 8, reads)
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
        let reservation = pipe
            .budget
            .reserve(image.as_raw().len() as u64, 0)
            .expect("tile RAM");
        pipe.place(
            id,
            &placement(x, y),
            DecodedTile {
                image,
                icc_profile: None,
                exif_metadata: None,
            },
            reservation,
        )
        .expect("place tile");
    }
    #[test]
    fn shuffled_stripes_share_buffers_and_release_after_the_last_row() {
        let pipe = new_pipe(8, 2, ReadCounts::default());
        put(
            &pipe,
            1,
            4,
            0,
            image::RgbaImage::from_pixel(4, 2, image::Rgba([20, 30, 40, 255])),
        );
        let backing = {
            let state = pipe.state.lock().expect("state");
            assert_eq!(state.ready.keys().copied().collect::<Vec<_>>(), [4, 12]);
            assert!(Arc::ptr_eq(
                &state.ready[&4].buffer,
                &state.ready[&12].buffer
            ));
            Arc::downgrade(&state.ready[&4].buffer)
        };
        put(
            &pipe,
            0,
            0,
            0,
            image::RgbaImage::from_pixel(4, 2, image::Rgba([1, 2, 3, 255])),
        );
        let first = pipe.read(0..8).expect("first row");
        assert_eq!(
            first.segments().map(<[u8]>::len).collect::<Vec<_>>(),
            [16, 16]
        );
        drop(first);
        assert!(
            backing.upgrade().is_some(),
            "second row retains the allocation"
        );
        let second = pipe.read(8..16).expect("second row");
        assert!(
            backing.upgrade().is_some(),
            "writer references the original allocation"
        );
        drop(second);
        assert!(backing.upgrade().is_none());
        assert!(pipe.state.lock().expect("state").ready.is_empty());
        drop(pipe);
    }
    #[test]
    fn producer_composites_unread_pixels_and_discards_late_writes() {
        let pipe = new_pipe(4, 1, ReadCounts::default());
        put(
            &pipe,
            0,
            0,
            0,
            image::RgbaImage::from_pixel(4, 1, image::Rgba([100, 0, 0, 255])),
        );
        assert_eq!(pipe.pixel(0).expect("first pixel").0, [100, 0, 0]);
        put(
            &pipe,
            1,
            0,
            0,
            image::RgbaImage::from_pixel(4, 1, image::Rgba([0, 100, 0, 128])),
        );
        let mut expected = image::Rgba([100, 0, 0, 255]);
        expected.blend(&image::Rgba([0, 100, 0, 128]));
        for position in 1..4 {
            assert_eq!(
                pipe.pixel(position).expect("unread pixel").0,
                [expected.0[0], expected.0[1], expected.0[2]]
            );
        }
        assert_eq!(pipe.late(), 1);
        assert!(pipe.state.lock().expect("state").ready.is_empty());
    }
    #[test]
    fn retry_keeps_holes_unresolved_and_finish_or_failure_wakes_readers() {
        for fail in [false, true] {
            let pipe = new_pipe(2, 1, ReadCounts::default());
            put(
                &pipe,
                1,
                1,
                0,
                image::RgbaImage::from_pixel(1, 1, image::Rgba([9, 8, 7, 255])),
            );
            let reader = Arc::clone(&pipe);
            let (sent, received) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                sent.send(reader.read(0..2)).expect("read result");
            });
            assert!(
                received
                    .recv_timeout(std::time::Duration::from_millis(20))
                    .is_err(),
                "a retryable hole must wait"
            );
            if fail {
                pipe.fail(Error::WriteFailed("original disk failure".into()));
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
                .expect("reader wakes");
            if fail {
                assert!(matches!(result, Err(Error::WriteFailed(_))));
            } else {
                assert_eq!(
                    result
                        .expect("retry pixels")
                        .segments()
                        .flatten()
                        .copied()
                        .collect::<Vec<_>>(),
                    [1, 2, 3, 255, 9, 8, 7, 255]
                );
            }
            thread.join().expect("reader exits");
        }
        let pipe = new_pipe(2, 1, ReadCounts::default());
        pipe.finish(&[]);
        assert_eq!(
            pipe.read(0..2)
                .expect("Keep holes")
                .segments()
                .flatten()
                .copied()
                .collect::<Vec<_>>(),
            [0; 8]
        );
    }
    #[test]
    fn full_budget_preserves_credit_and_returns_a_limit_without_waiting() {
        let budget = MemoryBudget::new(100);
        let in_use = budget.reserve(60, 0).expect("reservation");
        assert!(
            budget.reserve(30, 20).is_err(),
            "later work cannot consume the reader's reserved credit"
        );
        let priority = budget
            .reserve(40, 0)
            .expect("needed tile can use the credit");
        assert_eq!(budget.current(), 100);
        assert!(budget.reserve(1, 0).is_err());
        drop(priority);
        drop(in_use);
        assert_eq!(budget.current(), 0);
        assert_eq!(budget.peak(), 100);
    }
    #[test]
    fn padded_pixel_lives_until_read_64_and_counts_allow_arbitrary_order() {
        let pipe = new_pipe(1, 1, ReadCounts { pad_x: 7, pad_y: 7 });
        put(
            &pipe,
            0,
            0,
            0,
            image::RgbaImage::from_pixel(1, 1, image::Rgba([3, 4, 5, 255])),
        );
        for _ in 0..63 {
            assert_eq!(pipe.pixel(0).expect("padded pixel").0, [3, 4, 5]);
            assert_eq!(pipe.buffered_stripes(), 1);
        }
        assert_eq!(pipe.pixel(0).expect("last read").0, [3, 4, 5]);
        assert_eq!(pipe.buffered_stripes(), 0);

        let size = Size {
            width: 3,
            height: 2,
        };
        let reads = ReadCounts { pad_x: 5, pad_y: 6 };
        let pipe = PixelPipe::new(size.clone(), MemoryBudget::new(4096), 8, reads);
        put(
            &pipe,
            0,
            0,
            0,
            image::RgbaImage::from_fn(3, 2, |x, y| image::Rgba([x as u8, y as u8, 8, 255])),
        );
        let mut pending = (0..6)
            .flat_map(|p| std::iter::repeat_n(p, reads.at(p, &size) as usize))
            .collect::<Vec<_>>();
        let mut seed = 42u64;
        while !pending.is_empty() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let p = pending.swap_remove((seed % pending.len() as u64) as usize);
            assert_eq!(
                pipe.pixel(p).expect("unordered read").0,
                [(p % 3) as u8, (p / 3) as u8, 8]
            );
        }
        assert_eq!(pipe.buffered_stripes(), 0);
    }
}
