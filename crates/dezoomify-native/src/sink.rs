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
//!   plan order at finalization, preserving byte-identical pixels with the
//!   old retain-everything publisher. Retention is bounded
//!   (`output_retain_cap`); unknown canvas dimensions spool decoded tiles
//!   to job-owned temp files (bounded by `output_spool_cap`) and assemble
//!   at finalization without retaining every tile in RAM.
//! * First-tile ICC/EXIF metadata is deterministic: the lowest-ordinal
//!   tile carrying a profile wins, independent of arrival order.
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

use dezoomify_core::Vec2d;
use image::RgbaImage;

use crate::error::NativeError;
use crate::output::{partial_path_for, validate_destination, write_iiif_dir, OutputFormat};
use crate::pipeline::{
    blit_onto, encode_jpeg, encode_png, encode_tiff, encode_webp, encode_zif_pyramid,
    render_iiif_dir, DecodedTile, PipelineConfig,
};

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
    /// Peak retained (unpainted, overlapping) tiles.
    pub peak_retained_tiles: usize,
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

/// Successfully committed output.
pub struct Published {
    pub output_path: PathBuf,
    pub tile_count: usize,
    pub image_size: Vec2d,
    pub partial: bool,
    pub missing: Vec<String>,
    pub encoded_bytes: u64,
}

/// Grouped [`Sink::commit`] arguments. Keeps the single commit point to two
/// parameters so the arity stays within the lint budget as output
/// bookkeeping grows; behavior is identical to the previous flat list.
pub struct CommitParams<'a> {
    pub dest: &'a Path,
    pub format: OutputFormat,
    pub overwrite: bool,
    pub cancelled: &'a std::sync::atomic::AtomicBool,
    pub partial: bool,
    pub missing: Vec<String>,
    pub tile_count: usize,
    pub image_size: Vec2d,
}

/// One output sink per job attempt. Single-threaded by construction: the
/// engine pump thread is the only caller.
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
    /// Declared canvas seen on any effect, once known.
    declared: Option<Vec2d>,
    /// Unknown-dimension spool: job-owned temp directory plus index.
    spool_dir: Option<PathBuf>,
    spooled: Vec<SpooledTile>,
    spool_bytes: u64,
    stats: SinkStats,
    painted_count: usize,
}

impl Sink {
    /// Create an empty sink. No allocation happens here; the canvas
    /// allocates on [`Sink::ensure_canvas`] after the memory pre-check.
    pub fn new(config: &PipelineConfig, _format: OutputFormat) -> Self {
        Self {
            compression: config.compression,
            jpeg_quality: config.jpeg_quality(),
            retain_cap_bytes: config.output_retain_cap,
            spool_cap_bytes: config.output_spool_cap,
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
            painted_count: 0,
        }
    }

    /// Note a declared canvas size from an effect. The allocation itself
    /// happens on first placement (or at finalization for spooled jobs).
    pub fn note_declared(&mut self, canvas: Option<Vec2d>) {
        if self.declared.is_none() {
            self.declared = canvas;
        }
    }

    /// Retained (overlapping, unpainted) tile bytes currently held.
    /// The pump adds in-flight decode bytes (tracked tails not yet placed)
    /// to this before enforcing the retain cap, so the cap covers decoded
    /// bytes from reservation to painting, not just from placement.
    pub fn retained_bytes(&self) -> u64 {
        self.retained_bytes
    }

    /// Bound on retained tile bytes (`output_retain_cap`).
    pub fn retain_cap_bytes(&self) -> u64 {
        self.retain_cap_bytes
    }

    /// Current canvas dimensions, once allocated or declared.
    pub fn dimensions(&self) -> Option<Vec2d> {
        if self.width > 0 && self.height > 0 {
            Some(Vec2d {
                x: self.width,
                y: self.height,
            })
        } else {
            self.declared
        }
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
    fn allocate(&mut self, width: u32, height: u32) -> Result<(), NativeError> {
        let width = width.max(1);
        let height = height.max(1);
        if self.canvas.is_some() {
            return Ok(());
        }
        let available = crate::pipeline::available_memory_bytes();
        let required = u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(4));
        let Some(bytes) = required else {
            return Err(NativeError::canvas_memory_unavailable(
                width,
                height,
                "over 16 EiB",
                &describe_bytes(available),
            ));
        };
        if crate::pipeline::exceeds_available_memory(bytes, available) {
            return Err(NativeError::canvas_memory_unavailable(
                width,
                height,
                &describe_bytes(bytes),
                &describe_bytes(available),
            ));
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
    ) -> Result<(), NativeError> {
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
                return Err(NativeError::canvas_memory_unavailable(
                    self.width,
                    self.height,
                    &format!(
                        "overlapping-tile retention beyond {}",
                        describe_bytes(self.retain_cap_bytes)
                    ),
                    &describe_bytes(crate::pipeline::available_memory_bytes()),
                ));
            }
            self.retained_bytes += bytes;
            self.pending.insert(ordinal, tile);
            self.stats.peak_retained_tiles = self.stats.peak_retained_tiles.max(self.pending.len());
            self.stats.peak_retained_bytes =
                self.stats.peak_retained_bytes.max(self.retained_bytes);
            return Ok(());
        }
        self.paint(ordinal, &tile.image, destination, extent);
        Ok(())
    }

    fn paint(
        &mut self,
        ordinal: u32,
        image: &RgbaImage,
        destination: Vec2d,
        extent: Option<Vec2d>,
    ) {
        if let Some(target) = self.canvas.as_mut() {
            blit_onto(target, destination, extent, image);
        }
        self.painted.insert(ordinal, ());
        self.max_painted_ordinal = Some(
            self.max_painted_ordinal
                .map_or(ordinal, |max| max.max(ordinal)),
        );
        self.painted_count += 1;
    }

    fn spool_dir(&mut self) -> Result<PathBuf, NativeError> {
        if let Some(dir) = self.spool_dir.clone() {
            return Ok(dir);
        }
        let dir = std::env::temp_dir().join(format!(
            "dezoomify-spool-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        std::fs::create_dir_all(&dir)
            .map_err(|e| NativeError::write_failed(format!("spool dir failed: {e}")))?;
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
    ) -> Result<(), NativeError> {
        let bytes = tile_bytes(&tile.image);
        if self.spool_bytes.saturating_add(bytes) > self.spool_cap_bytes {
            return Err(NativeError::canvas_memory_unavailable(
                1,
                1,
                &format!("tile spool beyond {}", describe_bytes(self.spool_cap_bytes)),
                &describe_bytes(crate::pipeline::available_memory_bytes()),
            ));
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
            .map_err(|e| NativeError::write_failed(format!("spool write failed: {e}")))?;
        use std::io::Write as _;
        file.write_all(&header)
            .and_then(|()| file.write_all(tile.image.as_raw()))
            .map_err(|e| NativeError::write_failed(format!("spool write failed: {e}")))?;
        drop(file);
        std::fs::rename(&tmp, &path)
            .map_err(|e| NativeError::write_failed(format!("spool write failed: {e}")))?;
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
    /// order. Returns the missing-tile ids for a kept partial.
    pub fn assemble(
        &mut self,
        order: &[String],
        decoded_present: &dyn Fn(&str) -> bool,
    ) -> Result<(Vec2d, bool, Vec<String>), NativeError> {
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
                .map_err(|e| NativeError::write_failed(format!("spool read failed: {e}")))?;
            if bytes.len() < 24 {
                return Err(NativeError::write_failed("spool entry truncated"));
            }
            let w = u32::from_le_bytes(bytes[0..4].try_into().unwrap_or([0; 4]));
            let h = u32::from_le_bytes(bytes[4..8].try_into().unwrap_or([0; 4]));
            let pixels = &bytes[24..];
            let expected = (w as usize).saturating_mul(h as usize).saturating_mul(4);
            if pixels.len() != expected || w == 0 || h == 0 {
                return Err(NativeError::write_failed("spool entry corrupt"));
            }
            let image = RgbaImage::from_raw(w, h, pixels.to_vec())
                .ok_or_else(|| NativeError::write_failed("spool entry corrupt"))?;
            self.paint(tile.ordinal, &image, tile.destination, tile.extent);
        }
        self.remove_spool_dir();
        // Paint retained overlapping tiles in plan order for deterministic
        // pixels identical to the old retain-everything publisher.
        let mut ordinals: Vec<u32> = self.pending.keys().copied().collect();
        ordinals.sort_by_key(|o| self.plan.iter().position(|p| p == o).unwrap_or(usize::MAX));
        for ordinal in ordinals {
            if let Some(tile) = self.pending.remove(&ordinal) {
                self.retained_bytes = self.retained_bytes.saturating_sub(tile_bytes(&tile.image));
                let geom = self.extents.get(&ordinal).copied();
                let (destination, extent) = geom
                    .map(|r| (Vec2d { x: r.x, y: r.y }, Some(Vec2d { x: r.w, y: r.h })))
                    .unwrap_or((Vec2d::default(), None));
                self.paint(ordinal, &tile.image, destination, extent);
            }
        }
        // Missing = plan ids never placed (kept-partial holes stay blank).
        let mut missing: Vec<String> = order
            .iter()
            .filter(|id| !decoded_present(id))
            .cloned()
            .collect();
        missing.sort();
        missing.dedup();
        let partial = !missing.is_empty();
        Ok((
            Vec2d {
                x: self.width,
                y: self.height,
            },
            partial,
            missing,
        ))
    }

    /// Deterministic first-tile metadata: the lowest-ordinal tile carrying
    /// a profile wins, independent of arrival order.
    fn first_meta(&self) -> TileMetadata {
        let mut ordinals: Vec<u32> = self.meta.keys().copied().collect();
        ordinals.sort_unstable();
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
    pub fn commit(&mut self, params: CommitParams<'_>) -> Result<Published, NativeError> {
        use std::sync::atomic::Ordering;
        let CommitParams {
            dest: dest_path,
            format,
            overwrite,
            cancelled,
            partial,
            missing,
            tile_count,
            image_size,
        } = params;
        if cancelled.load(Ordering::SeqCst) {
            return Err(NativeError::new(
                "job.cancelled",
                "job cancelled before completion",
            ));
        }
        // Kept partials publish to the `.partial` sibling so a partial file
        // never masquerades as a complete save. Fail-closed on collision.
        let dest: PathBuf = if partial {
            let sibling = partial_path_for(dest_path, format);
            validate_destination(&sibling, &format, overwrite)?;
            sibling
        } else {
            dest_path.to_path_buf()
        };
        validate_destination(&dest, &format, overwrite)?;
        let canvas = self.canvas.clone().ok_or_else(|| {
            NativeError::new("native.internal", "commit without assembled canvas")
        })?;
        let (icc, exif) = self.first_meta();
        let encoded_len: u64;
        match format {
            OutputFormat::Png => {
                let encoded = encode_png(
                    &canvas,
                    crate::pipeline::png_compression_for(self.compression),
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
        Ok(Published {
            output_path: dest,
            tile_count,
            image_size,
            partial,
            missing,
            encoded_bytes: encoded_len,
        })
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

    /// Snapshot the accounting for the job instrumentation.
    pub fn stats(&self) -> SinkStats {
        self.stats.clone()
    }

    /// Tiles painted so far (acquired work that reached the canvas).
    pub fn painted_count(&self) -> usize {
        self.painted_count
    }
}

/// Stream bytes to a temp sibling in chunks with fsync, then atomically
/// rename into place. Only the temp path is ever uncommitted.
fn commit_bytes(dest: &Path, bytes: &[u8]) -> Result<(), NativeError> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
        }
    }
    let tmp = temp_sibling(dest);
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
        for chunk in bytes.chunks(64 << 10) {
            file.write_all(chunk)
                .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
        }
        file.sync_all()
            .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    }
    std::fs::rename(&tmp, dest)
        .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    Ok(())
}

/// Stage an `iiif-dir` tree in a temp directory, then rename once so a
/// half-written tree never sits at the destination.
fn commit_iiif_dir(
    dest: &Path,
    info_json: &[u8],
    tiles: &crate::output::IiifTiles,
) -> Result<(), NativeError> {
    let staging = temp_sibling(dest);
    // A stale file at the destination (e.g. a previous `.iiif` file output)
    // is replaced at commit, mirroring the reference encoder removing the
    // destination file first. Validation already granted overwrite.
    write_iiif_dir(&staging, info_json, tiles)?;
    if dest.is_file() {
        std::fs::remove_file(dest)
            .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
    }
    std::fs::rename(&staging, dest)
        .map_err(|e| NativeError::write_failed(format!("output write failed: {e}")))?;
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

/// Human-readable byte counts for limit errors (exact bytes plus a
/// GiB/MiB approximation); never carries paths or credentials.
fn describe_bytes(bytes: u64) -> String {
    const GIB: f64 = (1u64 << 30) as f64;
    const MIB: f64 = (1u64 << 20) as f64;
    let approx = bytes as f64;
    if approx >= GIB {
        format!("{:.1} GiB ({bytes} bytes)", approx / GIB)
    } else if approx >= MIB {
        format!("{:.1} MiB ({bytes} bytes)", approx / MIB)
    } else {
        format!("{bytes} bytes")
    }
}
