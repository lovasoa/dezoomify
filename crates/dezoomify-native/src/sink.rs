//! One output sink owning assembly and publication.
//!
//! The sink owns the canvas, tile painting order, metadata retention,
//! bounded spooling, encoding, the single commit point, and cleanup. No
//! other module paints, encodes, writes, or deletes output:
//!
//! * The canvas is allocated once, after an explicit memory pre-check
//!   against currently available memory (`output.canvas-limit` fail-fast,
//!   no safety margin by design).
//! * Tiles paint in streaming order with plan-order guarantees: isolated
//!   tiles (no extent intersection with any seen tile) paint immediately
//!   and release their pixels, so one slow tile never blocks unrelated
//!   non-overlapping tiles. Overlapping tiles are retained and painted in
//!   plan order at finalization for deterministic pixels. Retention is bounded
//!   (`output_retain_cap`); unknown canvas dimensions spool decoded tiles
//!   to job-owned temp files (bounded by `output_spool_cap`) and assemble
//!   at finalization without retaining every tile in RAM.
//! * First-tile ICC/EXIF metadata is deterministic: the earliest tile in
//!   final plan order carrying each metadata block wins, including reused
//!   probes and independently of arrival order or resource storage slots.
//! * Encoders render one transient in-memory buffer (buffered codecs are
//!   honestly accounted in [`SinkStats`]); bytes stream to temp files in
//!   chunks with fsync before the atomic rename. `iiif-dir` stages into a
//!   temp directory and renames once, so a half-written tree never sits at
//!   the destination.
//! * [`Sink::commit`] is the single commit point: cancellation is checked
//!   first (explicit ordering -- a lost race publishes nothing), then the
//!   destination validates, then exactly one atomic publication happens.
//!   [`Sink::rollback`] removes job-owned temp files and the spool
//!   directory only. It never touches the destination: on the cancel and
//!   failure paths nothing was committed, so anything at the destination
//!   is pre-existing or independent.
//! * Kept partials publish to the `.partial` sibling, never masquerading
//!   as complete output.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::imaging::{
    blit_onto, encode_jpeg, encode_png, encode_tiff, encode_webp, encode_zif_pyramid,
    render_iiif_dir, DecodedTile,
};
use crate::output::{partial_path_for, validate_destination, write_iiif_dir};
use dezoomify::model::{Error, LimitContext, LimitReason, OutputFormat, ReusedTile, Size};
use dezoomify::Vec2d;
use image::RgbaImage;

/// Encoder and buffering settings owned by the output sink.
#[derive(Clone, Debug)]
pub(crate) struct SinkOptions {
    pub compression: u8,
    pub retain_cap_bytes: u64,
    pub spool_cap_bytes: u64,
}

/// First-seen ICC profile plus EXIF metadata bytes per tile ordinal.
type TileMetadata = (Option<Vec<u8>>, Option<Vec<u8>>);

/// Pixel rectangle in canvas space.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

impl Rect {
    fn intersects(self, other: Rect) -> bool {
        self.x < other.x.saturating_add(other.w)
            && other.x < self.x.saturating_add(self.w)
            && self.y < other.y.saturating_add(other.h)
            && other.y < self.y.saturating_add(self.h)
    }
}

/// One spooled tile on disk: geometry header plus raw RGBA bytes.
struct SpooledTile {
    ordinal: u32,
    destination: Vec2d,
    extent: Option<Vec2d>,
    width: u32,
    height: u32,
}

/// Honest sink accounting, folded into the job instrumentation.
#[derive(Clone, Debug, Default)]
pub struct SinkStats {
    /// Peak retained pixel bytes.
    pub peak_retained_bytes: u64,
    /// Canvas bytes (4 bytes per pixel).
    pub canvas_bytes: u64,
    /// Transient encoded bytes for the committed output.
    pub encoded_bytes: u64,
    /// Peak spooled (on-disk) tile bytes.
    pub peak_spool_bytes: u64,
    /// Late paints (ordinal below the painted frontier, same-tile retries).
    pub late_repaints: u64,
}

/// Filesystem publication options.
pub struct CommitParams<'a> {
    pub dest: &'a Path,
    pub format: OutputFormat,
    pub overwrite: bool,
    pub cancelled: &'a std::sync::atomic::AtomicBool,
    pub partial: bool,
    pub reused_tiles: &'a [ReusedTile],
}

pub struct Sink {
    compression: u8,
    jpeg_quality: u8,
    retain_cap_bytes: u64,
    spool_cap_bytes: u64,
    canvas: Option<RgbaImage>,
    width: u32,
    height: u32,
    /// First-seen (plan) order of tile ordinals.
    plan: Vec<u32>,
    extents: HashMap<u32, Rect>,
    painted: HashMap<u32, ()>,
    max_painted_ordinal: Option<u32>,
    pending: HashMap<u32, DecodedTile>,
    retained_bytes: u64,
    meta: HashMap<u32, TileMetadata>,
    declared: Option<Vec2d>,
    /// Unknown-dimension spool: job-owned temp directory plus index.
    spool_dir: Option<PathBuf>,
    spooled: Vec<SpooledTile>,
    spool_bytes: u64,
    stats: SinkStats,
}

impl Sink {
    /// Create an empty sink. No allocation happens here; the canvas
    /// allocates on [`Sink::ensure_canvas`] after the memory pre-check.
    pub(crate) fn new(options: &SinkOptions) -> Self {
        Self {
            compression: options.compression,
            jpeg_quality: 100u8.saturating_sub(options.compression),
            retain_cap_bytes: options.retain_cap_bytes,
            spool_cap_bytes: options.spool_cap_bytes,
            canvas: None,
            width: 0,
            height: 0,
            plan: Vec::new(),
            extents: HashMap::new(),
            painted: HashMap::new(),
            max_painted_ordinal: None,
            pending: HashMap::new(),
            retained_bytes: 0,
            meta: HashMap::new(),
            declared: None,
            spool_dir: None,
            spooled: Vec::new(),
            spool_bytes: 0,
            stats: SinkStats::default(),
        }
    }

    pub fn note_declared(&mut self, canvas: Option<Vec2d>) {
        if self.declared.is_none() {
            self.declared = canvas;
        }
    }

    pub fn retained_bytes(&self) -> u64 {
        self.retained_bytes
    }

    /// Bound on retained tile bytes (`output_retain_cap`).
    pub fn retain_cap_bytes(&self) -> u64 {
        self.retain_cap_bytes
    }

    fn tile_rect(destination: Vec2d, extent: Option<Vec2d>, image: &RgbaImage) -> Rect {
        let extent = extent.unwrap_or(Vec2d {
            x: image.width(),
            y: image.height(),
        });
        Rect {
            x: destination.x,
            y: destination.y,
            w: extent.x.min(image.width()),
            h: extent.y.min(image.height()),
        }
    }

    /// Allocate the canvas after the explicit memory pre-check. Fails
    /// `output.canvas-limit` before allocating, never after.
    fn allocate(&mut self, width: u32, height: u32) -> Result<(), Error> {
        let width = width.max(1);
        let height = height.max(1);
        if self.canvas.is_some() {
            return Ok(());
        }
        let available = crate::imaging::available_memory_bytes();
        let required = u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(4));
        let Some(bytes) = required else {
            return Err(crate::output::memory_limit(LimitContext {
                reason: LimitReason::Memory,
                dimensions: Some(Size { width, height }),
                bytes_required: None,
                bytes_available: Some(available),
            }));
        };
        if crate::imaging::exceeds_available_memory(bytes, available) {
            return Err(crate::output::memory_limit(LimitContext {
                reason: LimitReason::Memory,
                dimensions: Some(Size { width, height }),
                bytes_required: Some(bytes),
                bytes_available: Some(available),
            }));
        }
        self.stats.canvas_bytes = bytes;
        self.width = width;
        self.height = height;
        self.canvas = Some(RgbaImage::new(width, height));
        Ok(())
    }

    /// Place one decoded tile: paint immediately when isolated, retain for
    /// plan-order painting at finalization when overlapping, spool to disk
    /// when canvas dimensions are still unknown.
    pub fn place(
        &mut self,
        ordinal: u32,
        destination: Vec2d,
        extent: Option<Vec2d>,
        tile: DecodedTile,
    ) -> Result<(), Error> {
        if !self.plan.contains(&ordinal) {
            self.plan.push(ordinal);
        }
        let rect = Self::tile_rect(destination, extent, &tile.image);
        self.extents.insert(ordinal, rect);
        if tile.icc_profile.is_some() || tile.exif_metadata.is_some() {
            self.meta.insert(
                ordinal,
                (tile.icc_profile.clone(), tile.exif_metadata.clone()),
            );
        }
        // Unknown dimensions: spool to job-owned temp files, bounded.
        if self.declared.is_none() && self.canvas.is_none() {
            return self.spool(ordinal, destination, extent, tile);
        }
        if self.canvas.is_none() {
            let declared = self.declared.unwrap_or(Vec2d { x: 1, y: 1 });
            self.allocate(declared.x, declared.y)?;
        }
        // Late arrival below the painted frontier (same-tile retry landing
        // after higher tiles painted): same source bytes repaint harmlessly;
        // count it so order assumptions stay observable.
        if self.max_painted_ordinal.is_some_and(|max| ordinal < max) {
            self.stats.late_repaints += 1;
        }
        let overlaps = self
            .extents
            .iter()
            .any(|(other, other_rect)| *other != ordinal && other_rect.intersects(rect));
        if overlaps {
            let bytes = tile_bytes(&tile.image);
            if self.retained_bytes.saturating_add(bytes) > self.retain_cap_bytes {
                return Err(crate::output::memory_limit(LimitContext {
                    reason: LimitReason::Memory,
                    dimensions: Some(Size {
                        width: self.width,
                        height: self.height,
                    }),
                    bytes_required: Some(self.retained_bytes.saturating_add(bytes)),
                    bytes_available: Some(self.retain_cap_bytes),
                }));
            }
            self.retained_bytes += bytes;
            self.pending.insert(ordinal, tile);
            self.stats.peak_retained_bytes =
                self.stats.peak_retained_bytes.max(self.retained_bytes);
            return Ok(());
        }
        self.paint(ordinal, destination, extent, &tile.image);
        Ok(())
    }

    fn paint(
        &mut self,
        ordinal: u32,
        destination: Vec2d,
        extent: Option<Vec2d>,
        image: &RgbaImage,
    ) {
        if let Some(target) = self.canvas.as_mut() {
            blit_onto(target, destination, extent, image);
        }
        self.painted.insert(ordinal, ());
        self.max_painted_ordinal = Some(
            self.max_painted_ordinal
                .map_or(ordinal, |max| max.max(ordinal)),
        );
    }

    fn spool_dir(&mut self) -> Result<PathBuf, Error> {
        if let Some(dir) = self.spool_dir.clone() {
            return Ok(dir);
        }
        let dir = std::env::temp_dir().join(format!(
            "dezoomify-spool-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        std::fs::create_dir_all(&dir)
            .map_err(|e| crate::output::write_failed("spool dir failed", &e))?;
        self.spool_dir = Some(dir.clone());
        Ok(dir)
    }

    /// Spool one tile to job-owned temp files (raw header + RGBA bytes).
    /// Bounded by the spool cap; the directory is removed on
    /// commit/rollback, never the destination.
    fn spool(
        &mut self,
        ordinal: u32,
        destination: Vec2d,
        extent: Option<Vec2d>,
        tile: DecodedTile,
    ) -> Result<(), Error> {
        let bytes = tile_bytes(&tile.image);
        if self.spool_bytes.saturating_add(bytes) > self.spool_cap_bytes {
            return Err(crate::output::memory_limit(LimitContext {
                reason: LimitReason::Memory,
                dimensions: None,
                bytes_required: Some(self.spool_bytes.saturating_add(bytes)),
                bytes_available: Some(self.spool_cap_bytes),
            }));
        }
        let dir = self.spool_dir()?;
        let path = dir.join(format!("tile-{ordinal}.raw"));
        let tmp = dir.join(format!("tile-{ordinal}.raw.tmp"));
        let (extent_x, extent_y) = extent.map_or((u32::MAX, u32::MAX), |e| (e.x, e.y));
        let mut header = Vec::with_capacity(32);
        for v in [
            tile.image.width(),
            tile.image.height(),
            destination.x,
            destination.y,
            extent_x,
            extent_y,
        ] {
            header.extend_from_slice(&v.to_le_bytes());
        }
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| crate::output::write_failed("spool write failed", &e))?;
        use std::io::Write as _;
        file.write_all(&header)
            .and_then(|()| file.write_all(tile.image.as_raw()))
            .map_err(|e| crate::output::write_failed("spool write failed", &e))?;
        drop(file);
        std::fs::rename(&tmp, &path)
            .map_err(|e| crate::output::write_failed("spool write failed", &e))?;
        self.spool_bytes += bytes;
        self.stats.peak_spool_bytes = self.stats.peak_spool_bytes.max(self.spool_bytes);
        self.spooled.push(SpooledTile {
            ordinal,
            destination,
            extent,
            width: tile.image.width(),
            height: tile.image.height(),
        });
        Ok(())
    }

    /// Assemble the final canvas: allocate (declared or max-extent sized),
    /// replay spooled tiles, then paint retained overlapping tiles in plan
    /// order.
    pub fn assemble(&mut self) -> Result<Vec2d, Error> {
        // Size the canvas: declared wins; otherwise max extents (spooled or
        // retained geometries); degenerate jobs get 1x1.
        let (mut width, mut height) = self
            .declared
            .map_or((1u32, 1u32), |d| (d.x.max(1), d.y.max(1)));
        if self.declared.is_none() {
            for tile in &self.spooled {
                let (w, h) = tile
                    .extent
                    .map_or((tile.width, tile.height), |e| (e.x, e.y));
                width = width.max(tile.destination.x.saturating_add(w));
                height = height.max(tile.destination.y.saturating_add(h));
            }
            for (ordinal, rect) in &self.extents {
                if self.pending.contains_key(ordinal) {
                    width = width.max(rect.x.saturating_add(rect.w));
                    height = height.max(rect.y.saturating_add(rect.h));
                }
            }
        }
        self.allocate(width, height)?;
        // Replay spooled tiles in plan (first-seen) order.
        let mut spooled = std::mem::take(&mut self.spooled);
        spooled.sort_by_key(|t| {
            self.plan
                .iter()
                .position(|o| *o == t.ordinal)
                .unwrap_or(usize::MAX)
        });
        for tile in spooled {
            let path = self
                .spool_dir
                .as_ref()
                .map(|dir| dir.join(format!("tile-{}.raw", tile.ordinal)))
                .unwrap_or_default();
            let bytes = std::fs::read(&path)
                .map_err(|e| crate::output::write_failed("spool read failed", &e))?;
            if bytes.len() < 24 {
                return Err(Error::WriteFailed(
                    "spool entry truncated".to_string().into(),
                ));
            }
            let w = u32::from_le_bytes(bytes[0..4].try_into().unwrap_or([0; 4]));
            let h = u32::from_le_bytes(bytes[4..8].try_into().unwrap_or([0; 4]));
            let pixels = &bytes[24..];
            let expected = (w as usize).saturating_mul(h as usize).saturating_mul(4);
            if pixels.len() != expected || w == 0 || h == 0 {
                return Err(Error::WriteFailed("spool entry corrupt".to_string().into()));
            }
            let image = RgbaImage::from_raw(w, h, pixels.to_vec())
                .ok_or_else(|| Error::WriteFailed("spool entry corrupt".to_string().into()))?;
            self.paint(tile.ordinal, tile.destination, tile.extent, &image);
        }
        self.remove_spool_dir();
        // Paint retained overlapping tiles in plan order for deterministic pixels.
        let mut ordinals: Vec<u32> = self.pending.keys().copied().collect();
        ordinals.sort_by_key(|o| self.plan.iter().position(|p| p == o).unwrap_or(usize::MAX));
        for ordinal in ordinals {
            if let Some(tile) = self.pending.remove(&ordinal) {
                self.retained_bytes = self.retained_bytes.saturating_sub(tile_bytes(&tile.image));
                let geom = self.extents.get(&ordinal).copied();
                let (destination, extent) = geom
                    .map(|r| (Vec2d { x: r.x, y: r.y }, Some(Vec2d { x: r.w, y: r.h })))
                    .unwrap_or((Vec2d::default(), None));
                self.paint(ordinal, destination, extent, &tile.image);
            }
        }
        Ok(Vec2d {
            x: self.width,
            y: self.height,
        })
    }

    /// The earliest final-plan tile carrying metadata wins, independently of
    /// arrival order or the resource slot used while probing its geometry.
    fn first_meta(&self, reused_tiles: &[ReusedTile]) -> TileMetadata {
        let reused: HashMap<_, _> = reused_tiles
            .iter()
            .map(|tile| ((tile.position.x, tile.position.y), tile.index))
            .collect();
        let mut ordinals: Vec<u32> = self.meta.keys().copied().collect();
        ordinals.sort_unstable_by_key(|ordinal| {
            self.extents
                .get(ordinal)
                .and_then(|rect| reused.get(&(rect.x, rect.y)))
                .copied()
                .unwrap_or(*ordinal)
        });
        let mut icc = None;
        let mut exif = None;
        for ordinal in ordinals {
            if let Some((profile, metadata)) = self.meta.get(&ordinal) {
                if icc.is_none() {
                    icc.clone_from(profile);
                }
                if exif.is_none() {
                    exif.clone_from(metadata);
                }
                if icc.is_some() && exif.is_some() {
                    break;
                }
            }
        }
        (icc, exif)
    }

    /// The single commit point. Ordering is explicit: cancellation first
    /// (a lost race publishes nothing), then destination validation, then
    /// exactly one atomic publication. Returns the honest published record.
    pub fn commit(&mut self, params: CommitParams<'_>) -> Result<PathBuf, Error> {
        use std::sync::atomic::Ordering;
        let CommitParams {
            dest: dest_path,
            format,
            overwrite,
            cancelled,
            partial,
            reused_tiles,
        } = params;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        // Kept partials publish to the `.partial` sibling so a partial file
        // never masquerades as a complete save. Fail-closed on collision.
        let dest: PathBuf = if partial {
            let sibling = partial_path_for(dest_path);
            validate_destination(&sibling, &format, overwrite)?;
            sibling
        } else {
            dest_path.to_path_buf()
        };
        validate_destination(&dest, &format, overwrite)?;
        let canvas = self
            .canvas
            .clone()
            .ok_or_else(|| Error::Internal("commit without assembled canvas".to_string().into()))?;
        let (icc, exif) = self.first_meta(reused_tiles);
        let encoded_len: u64;
        match format {
            OutputFormat::Png => {
                let encoded = encode_png(
                    &canvas,
                    crate::imaging::png_compression_for(self.compression),
                    icc.as_deref(),
                    exif.as_deref(),
                )?;
                encoded_len = encoded.len() as u64;
                commit_bytes(&dest, &encoded)?;
            }
            OutputFormat::Jpeg => {
                let encoded = encode_jpeg(&canvas, self.jpeg_quality, icc.as_deref())?;
                encoded_len = encoded.len() as u64;
                commit_bytes(&dest, &encoded)?;
            }
            OutputFormat::Tiff => {
                let encoded = encode_tiff(&canvas, self.compression, icc.as_deref())?;
                encoded_len = encoded.len() as u64;
                commit_bytes(&dest, &encoded)?;
            }
            OutputFormat::Zif => {
                let encoded = encode_zif_pyramid(&canvas, self.compression, icc.as_deref())?;
                encoded_len = encoded.len() as u64;
                commit_bytes(&dest, &encoded)?;
            }
            OutputFormat::Webp => {
                let encoded = encode_webp(&canvas, icc.as_deref())?;
                encoded_len = encoded.len() as u64;
                commit_bytes(&dest, &encoded)?;
            }
            OutputFormat::IiifDir => {
                let id = dest
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("image");
                let (info_json, tiles) = render_iiif_dir(&canvas, id, self.jpeg_quality)?;
                encoded_len =
                    info_json.len() as u64 + tiles.iter().map(|(_, b)| b.len() as u64).sum::<u64>();
                commit_iiif_dir(&dest, &info_json, &tiles)?;
            }
        }
        self.stats.encoded_bytes = encoded_len;
        self.remove_spool_dir();
        // Release the canvas promptly after the bytes are committed.
        self.canvas = None;
        self.pending.clear();
        self.retained_bytes = 0;
        Ok(dest)
    }

    /// Release retained pixel buffers without publishing. Spool files stay
    /// until commit/rollback removes the job-owned directory.
    pub fn release(&mut self) {
        self.pending.clear();
        self.retained_bytes = 0;
        self.canvas = None;
    }

    /// Remove job-owned temp files and the spool directory. Never touches
    /// the destination: uncommitted output lives only in temp paths.
    pub fn rollback(&mut self) {
        self.pending.clear();
        self.retained_bytes = 0;
        self.canvas = None;
        self.remove_spool_dir();
    }

    fn remove_spool_dir(&mut self) {
        if let Some(dir) = self.spool_dir.take() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        self.spooled.clear();
        self.spool_bytes = 0;
    }

    pub fn stats(&self) -> SinkStats {
        self.stats.clone()
    }
}

/// Stream bytes to a temp sibling in chunks with fsync, then atomically
/// rename into place. Only the temp path is ever uncommitted.
fn commit_bytes(dest: &Path, bytes: &[u8]) -> Result<(), Error> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| crate::output::write_failed("output write failed", &e))?;
        }
    }
    let tmp = temp_sibling(dest);
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| crate::output::write_failed("output write failed", &e))?;
        for chunk in bytes.chunks(64 << 10) {
            file.write_all(chunk)
                .map_err(|e| crate::output::write_failed("output write failed", &e))?;
        }
        file.sync_all()
            .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    }
    std::fs::rename(&tmp, dest)
        .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    Ok(())
}

/// Stage an `iiif-dir` tree in a temp directory, then rename once so a
/// half-written tree never sits at the destination.
fn commit_iiif_dir(
    dest: &Path,
    info_json: &[u8],
    tiles: &crate::output::IiifTiles,
) -> Result<(), Error> {
    let staging = temp_sibling(dest);
    // An existing file is replaced at commit before the tile tree is written. Validation already granted overwrite.
    write_iiif_dir(&staging, info_json, tiles)?;
    if dest.is_file() {
        std::fs::remove_file(dest)
            .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    }
    std::fs::rename(&staging, dest)
        .map_err(|e| crate::output::write_failed("output write failed", &e))?;
    Ok(())
}

/// Temp sibling for atomic publication: `<name>.tmp.<pid>-<unique>`.
/// Unique per commit so concurrent jobs never share a temp path.
fn temp_sibling(dest: &Path) -> PathBuf {
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("output");
    let tmp_name = format!("{file_name}.tmp.{}-{}", std::process::id(), unique_suffix());
    match dest.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(tmp_name),
        _ => PathBuf::from(tmp_name),
    }
}

fn unique_suffix() -> u64 {
    use std::sync::atomic::Ordering;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (now ^ (count.wrapping_mul(0x9E37_79B9_7F4A_7C15) as u128)) as u64
}

pub(crate) fn tile_bytes(image: &RgbaImage) -> u64 {
    u64::from(image.width())
        .saturating_mul(u64::from(image.height()))
        .saturating_mul(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_uses_its_own_temp_file_and_preserves_unrelated_files() {
        let dir = std::env::temp_dir().join(format!("dezoomify-publication-{}", unique_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("output.png");
        let unrelated = dir.join("output.tmp");
        std::fs::write(&unrelated, b"unrelated").unwrap();
        commit_bytes(&output, b"image bytes").unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"image bytes");
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"unrelated");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
