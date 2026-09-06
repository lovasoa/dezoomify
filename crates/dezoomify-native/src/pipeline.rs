//! Native download pipeline: one [`dezoomify_job::Job`] owns discovery,
//! selection, planning, retry, and lifecycle policy; this module executes its
//! effects with real HTTP, decode, assemble, encode, and atomic-write fns.
//!
//! All network I/O goes through [`crate::http`]; all format logic stays in
//! `dezoomify-core`; all lifecycle policy stays in `dezoomify-job`. Failures
//! are honest: the pipeline never fabricates progress, completion, or hashes.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

use dezoomify_core::core::adaptive::ObservationResult;
use dezoomify_core::core::model::{ProcessingRecipe, Request};
use dezoomify_core::Vec2d;

use crate::error::NativeError;
use crate::http::{fetch, FetchLimits, UserHeaders};
use crate::output::{validate_destination, OutputFormat};

/// Default JPEG quality for `.jpg` output and `iiif-dir` tiles: visually
/// transparent for scanned artwork at a fraction of PNG bytes.
pub const JPEG_QUALITY: u8 = 92;

/// JPEG (ISO 10918-1) caps both dimensions at 65535 px; larger canvases must
/// use PNG, TIFF, or `iiif-dir`.
pub const JPEG_MAX_SIDE: u32 = 65_535;

/// `iiif-dir` tile width: one entry of the `tiles` block in `info.json`.
pub const IIIF_TILE_WIDTH: u32 = 512;
/// What to do when required tiles still fail after retries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PartialPolicy {
    /// Fail the job with `tile.download-failed` and write no output.
    #[default]
    Fail,
    /// Encode the acquired tiles with missing regions left blank and
    /// report success with `partial: true`.
    Keep,
}

/// Pipeline configuration: fetch limits, tile bounds, concurrency.
#[derive(Clone, Debug)]
pub struct PipelineConfig {
    /// Trusted user headers (`-H`). May carry cookies; sent to the input
    /// origin and same-host redirects only. Never persisted or logged.
    pub user_headers: BTreeMap<String, String>,
    pub fetch: FetchLimits,
    pub max_tiles: usize,
    /// Max concurrent tile fetches (scoped-thread equivalent of the
    /// reference async `buffer_unordered(parallelism)`; default 16).
    pub max_concurrent: usize,
    /// Tile retry budget owned by the job engine. `0` means no retries:
    /// the first failure fails the tile (generic-probing parity).
    pub max_retries: u32,
    /// Delay before the first tile retry; each subsequent retry doubles
    /// (`retry_delay`, `2*retry_delay`, ...) plus deterministic per-tile
    /// jitter from the tile position, mirroring `network.rs`. Default 2s.
    pub retry_delay: Duration,
    /// Minimum interval between tile request starts (per-tile throttle).
    /// `ZERO` disables the sleep (the CLI default); the reference default
    /// is 50ms. Applied as start staggering, not as a post-completion wait.
    pub min_interval: Duration,
    /// Hard cap on composed canvas bytes (RGBA, 4 bytes/pixel, plus
    /// transient encode buffers). Default 8 GiB: jobs needing more fail with
    /// typed `output.canvas-limit` before any allocation.
    pub max_canvas_bytes: u64,
    /// JPEG quality for `.jpg` output and `iiif-dir` tiles (default 92).
    pub jpeg_quality: u8,
    /// Tile resume cache: when set, each successfully fetched tile body is
    /// stored under `<cache_dir>/<job>/<key>` (see [`crate::cache`]) and a
    /// later run of the same job skips the fetch when the stored bytes still
    /// decode. `None` keeps no tile bytes between runs.
    pub cache_dir: Option<PathBuf>,
    /// Legacy parity: cap the output width. The largest level whose width
    /// fits is downloaded; when none fits, the smallest level is used.
    /// `None` (including `--largest` or bulk-implied largest mapped to
    /// uncapped width by the CLI) downloads the largest level.
    pub max_width: Option<u32>,
    /// Legacy parity: cap the output height, combined with [`Self::max_width`]
    /// as a width+height filter (largest fitting area wins). Unknown (0)
    /// extents never satisfy a cap. Parsed by the CLI; `None` disables.
    pub max_height: Option<u32>,
    /// Legacy parity: exact level index, 0 is the smallest level (catalog
    /// order); out-of-range uses the last level. Wins over
    /// [`Self::largest`] and the size caps, mirroring `choose_level`.
    pub zoom_level: Option<usize>,
    /// Legacy parity: 0-based image selection when several are found;
    /// out-of-range uses the last image. `None` keeps the first entry
    /// (bulk auto-first parity).
    pub image_index: Option<usize>,
    /// Legacy parity: select the largest level regardless of the size caps.
    /// The CLI also sets this implicitly in bulk mode when no
    /// level-specifying arg was given (`should_use_largest`); uncapped width
    /// already selects the largest level emergently.
    pub largest: bool,
    /// What to do when required tiles still fail after retries.
    pub partial_policy: PartialPolicy,
    /// Cooperative cancellation: when set, the driver stops issuing new
    /// work at the next effect boundary, cleans up, and reports
    /// `job.cancelled` without writing output. Clones share the flag.
    pub cancel_flag: Arc<AtomicBool>,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            user_headers: BTreeMap::new(),
            fetch: FetchLimits::default(),
            max_tiles: 1 << 20,
            max_concurrent: 16,
            max_retries: 3,
            retry_delay: Duration::from_secs(2),
            min_interval: Duration::ZERO,
            max_canvas_bytes: 8 << 30,
            jpeg_quality: JPEG_QUALITY,
            cache_dir: None,
            max_width: None,
            max_height: None,
            zoom_level: None,
            image_index: None,
            largest: false,
            partial_policy: PartialPolicy::Fail,
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Progress event emitted by the pipeline. Kinds: `discovery`, `downloading`,
/// `encoding`. Details carry counts; nothing is fabricated.
#[derive(Clone, Debug)]
pub struct PipelineEvent {
    pub kind: String,
    pub detail: BTreeMap<String, String>,
}

/// Successful pipeline result with the digest of the bytes actually written.
#[derive(Clone, Debug)]
pub struct PipelineOutcome {
    pub output_path: PathBuf,
    pub output_hash: String,
    pub tile_count: usize,
    pub image_size: Vec2d,
    /// Stable id of the detected format (e.g. `zoomify`, `iiif`).
    pub format: String,
    /// True when missing tiles were left blank under [`PartialPolicy::Keep`].
    pub partial: bool,
}

fn user_headers_for(input_url: &str, config: &PipelineConfig) -> UserHeaders {
    let origin_host = url::Url::parse(input_url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string));
    UserHeaders::new(config.user_headers.clone(), origin_host)
}

pub fn run(
    input_url: &str,
    output_path: &str,
    overwrite: bool,
    config: &PipelineConfig,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<PipelineOutcome, NativeError> {
    let format = OutputFormat::infer_from_path(std::path::Path::new(output_path))
        .map_err(NativeError::from)?;
    validate_destination(std::path::Path::new(output_path), &format, overwrite)
        .map_err(NativeError::from)?;

    let user = user_headers_for(input_url, config);
    crate::job_driver::drive(input_url, output_path, overwrite, config, &user, on_event)
}

// ---------------------------------------------------------------------------
// Effect executors (pure I/O + pixels; lifecycle stays in the job engine)
// ---------------------------------------------------------------------------

pub(crate) fn merge_headers(request: &Request) -> BTreeMap<String, String> {
    let mut merged: BTreeMap<String, String> = dezoomify_core::default_headers()
        .into_iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value))
        .collect();
    for (name, value) in &request.headers {
        merged.insert(name.to_ascii_lowercase(), value.clone());
    }
    merged
}

/// Fetch one tile with resume-cache support. When `cache` carries
/// `(cache_dir, job_namespace)`, stored bytes that still decode skip the
/// fetch; a fresh fetch stores its processed body for later runs. Stored
/// entries hold response bodies only, never headers or cookies. A corrupt
/// entry quietly falls back to a fresh fetch, and a failed store never fails
/// the tile: the cache stays best-effort.
pub(crate) fn fetch_and_decode_cached(
    uri: &str,
    headers: &BTreeMap<String, String>,
    processing: &ProcessingRecipe,
    config: &PipelineConfig,
    user: &UserHeaders,
    cache: Option<(&std::path::Path, &str)>,
) -> Result<image::RgbaImage, NativeError> {
    if let Some((dir, namespace)) = cache {
        if let Some(bytes) = crate::cache::load(dir, namespace, uri) {
            if let Ok(decoded) = image::load_from_memory(&bytes) {
                return Ok(decoded.to_rgba8());
            }
        }
    }
    let mut request = Request::new(uri);
    request.headers = headers.clone();
    let merged = merge_headers(&request);
    let outcome = fetch(uri, &merged, Some(user), None, &config.fetch)?;
    if !outcome.ok() {
        return Err(NativeError::new(
            "tile.http-error",
            format!("tile request returned http status {}", outcome.status),
        ));
    }
    let bytes = processing.apply(outcome.body).map_err(NativeError::from)?;
    if let Some((dir, namespace)) = cache {
        let _ = crate::cache::store(dir, namespace, uri, &bytes);
    }
    let decoded = image::load_from_memory(&bytes)
        .map_err(|e| NativeError::new("tile.decode-failed", format!("tile decode failed: {e}")))?;
    Ok(decoded.to_rgba8())
}

pub(crate) struct ProbeRead {
    pub observation: ObservationResult,
}

pub(crate) fn probe_tile_bytes(
    uri: &str,
    headers: &BTreeMap<String, String>,
    processing: &ProcessingRecipe,
    config: &PipelineConfig,
    user: &UserHeaders,
) -> ProbeRead {
    let missing = || ProbeRead {
        observation: ObservationResult::Missing,
    };
    let mut request = Request::new(uri);
    request.headers = headers.clone();
    let merged = merge_headers(&request);
    let Ok(outcome) = fetch(uri, &merged, Some(user), None, &config.fetch) else {
        return missing();
    };
    if !outcome.ok() || outcome.body.is_empty() {
        return missing();
    }
    let Ok(bytes) = processing.apply(outcome.body) else {
        return missing();
    };
    match image::load_from_memory(&bytes) {
        Ok(decoded) => ProbeRead {
            observation: ObservationResult::Available {
                size: Vec2d {
                    x: decoded.width(),
                    y: decoded.height(),
                },
            },
        },
        Err(_) => missing(),
    }
}

pub(crate) fn blit_onto(
    target: &mut image::RgbaImage,
    destination: Vec2d,
    extent: Option<Vec2d>,
    tile: &image::RgbaImage,
) {
    let extent = extent.unwrap_or(Vec2d {
        x: tile.width(),
        y: tile.height(),
    });
    let max_w = target.width().saturating_sub(destination.x);
    let max_h = target.height().saturating_sub(destination.y);
    let copy_w = extent.x.min(tile.width()).min(max_w);
    let copy_h = extent.y.min(tile.height()).min(max_h);
    if copy_w == 0 || copy_h == 0 {
        return;
    }
    let cropped = image::imageops::crop_imm(tile, 0, 0, copy_w, copy_h).to_image();
    image::imageops::overlay(
        target,
        &cropped,
        i64::from(destination.x),
        i64::from(destination.y),
    );
}

pub(crate) fn encode_png(image: &image::RgbaImage) -> Result<Vec<u8>, NativeError> {
    let mut bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| NativeError::new("output.encode-failed", format!("png encode failed: {e}")))?;
    Ok(bytes)
}

/// Encode the assembled canvas as JPEG at `quality` (native default
/// [`JPEG_QUALITY`]). Sides beyond [`JPEG_MAX_SIDE`] fail with typed
/// `output.encode-failed`: JPEG cannot address them. JPEG carries no alpha,
/// so transparent canvas regions (kept-partial holes) save as black.
pub fn encode_jpeg(image: &image::RgbaImage, quality: u8) -> Result<Vec<u8>, NativeError> {
    if image.width() > JPEG_MAX_SIDE || image.height() > JPEG_MAX_SIDE {
        return Err(NativeError::new(
            "output.encode-failed",
            format!(
                "jpeg output {}x{} exceeds the 65535px per-side jpeg limit; save as png, tiff, or iiif-dir",
                image.width(),
                image.height()
            ),
        ));
    }
    let mut bytes = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
    let rgb = image::RgbImage::from_fn(image.width(), image.height(), |x, y| {
        let pixel = image.get_pixel(x, y);
        image::Rgb([pixel[0], pixel[1], pixel[2]])
    });
    image::ImageEncoder::write_image(
        encoder,
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| NativeError::new("output.encode-failed", format!("jpeg encode failed: {e}")))?;
    Ok(bytes)
}

/// Encode the assembled canvas as TIFF (lossless, no side limit).
pub fn encode_tiff(image: &image::RgbaImage) -> Result<Vec<u8>, NativeError> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let encoder = image::codecs::tiff::TiffEncoder::new(&mut cursor);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| NativeError::new("output.encode-failed", format!("tiff encode failed: {e}")))?;
    Ok(cursor.into_inner())
}

/// Powers of two covering the pyramid: 1 always, then doubling while the
/// downscaled canvas still exceeds one tile side.
pub(crate) fn iiif_scale_factors(width: u32, height: u32) -> Vec<u32> {
    let mut factors = vec![1u32];
    let mut scale = 1u32;
    while width.div_ceil(scale) > IIIF_TILE_WIDTH || height.div_ceil(scale) > IIIF_TILE_WIDTH {
        scale = scale.saturating_mul(2);
        factors.push(scale);
    }
    factors
}

/// Minimal IIIF Image API v2 `info.json` for a static directory: the tile
/// width and scale factors match the files [`render_iiif_dir`] writes, so a
/// plain static file server answers each tile's IIIF URL. `id` names the
/// image (the destination directory name); deployments serving the directory
/// under a public URL replace it with that URL.
pub(crate) fn iiif_info_json(id: &str, width: u32, height: u32) -> Vec<u8> {
    let factors = iiif_scale_factors(width, height);
    let sizes: Vec<serde_json::Value> = factors
        .iter()
        .map(|scale| {
            serde_json::json!({
                "width": width.div_ceil(*scale),
                "height": height.div_ceil(*scale),
            })
        })
        .collect();
    serde_json::to_vec_pretty(&serde_json::json!({
        "@context": "http://iiif.io/api/image/2/context.json",
        "@id": id,
        "protocol": "http://iiif.io/api/image",
        "width": width,
        "height": height,
        "sizes": sizes,
        "tiles": [{ "width": IIIF_TILE_WIDTH, "scaleFactors": factors }],
        "profile": ["http://iiif.io/api/image/2/level1.json"],
    }))
    .unwrap_or_default()
}

/// Render one `iiif-dir` destination from the assembled canvas: the manifest
/// plus JPEG tiles, each stored at its real IIIF request path
/// (`{x},{y},{w},{h}/{tw},/0/default.jpg`, size-by-width) with one
/// `full/max/0/default.jpg` overview. Files arrive sorted by relative path
/// for a deterministic digest; tiles encode at `jpeg_quality`.
pub(crate) fn render_iiif_dir(
    image: &image::RgbaImage,
    id: &str,
    jpeg_quality: u8,
) -> Result<(Vec<u8>, crate::output::IiifTiles), NativeError> {
    let (width, height) = (image.width(), image.height());
    let mut files: crate::output::IiifTiles = Vec::new();
    for scale in iiif_scale_factors(width, height) {
        let down_w = width.div_ceil(scale).max(1);
        let down_h = height.div_ceil(scale).max(1);
        let downscaled;
        let view: &image::RgbaImage = if scale == 1 {
            image
        } else {
            downscaled = image::imageops::resize(
                image,
                down_w,
                down_h,
                image::imageops::FilterType::Triangle,
            );
            &downscaled
        };
        let cols = down_w.div_ceil(IIIF_TILE_WIDTH);
        let rows = down_h.div_ceil(IIIF_TILE_WIDTH);
        for row in 0..rows {
            for col in 0..cols {
                let tx = col * IIIF_TILE_WIDTH;
                let ty = row * IIIF_TILE_WIDTH;
                let tw = (down_w - tx).min(IIIF_TILE_WIDTH);
                let th = (down_h - ty).min(IIIF_TILE_WIDTH);
                let tile = image::imageops::crop_imm(view, tx, ty, tw, th).to_image();
                let bytes = encode_jpeg(&tile, jpeg_quality)?;
                let relative = format!(
                    "{},{},{},{}/{},/0/default.jpg",
                    u64::from(tx) * u64::from(scale),
                    u64::from(ty) * u64::from(scale),
                    u64::from(tw) * u64::from(scale),
                    u64::from(th) * u64::from(scale),
                    tw,
                );
                files.push((relative, bytes));
            }
        }
    }
    files.push((
        "full/max/0/default.jpg".to_string(),
        encode_jpeg(image, jpeg_quality)?,
    ));
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((iiif_info_json(id, width, height), files))
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Retry wait for a tile with `failures` prior failures: the base
/// `retry_delay` plus deterministic position jitter (`idx = (x + y) % 100`
/// of one hundredth each), doubled per retry. Mirrors `network.rs`:
/// the first retry waits the base delay, the next twice that, and so on.
/// `failures == 0` (first attempt) waits nothing.
pub(crate) fn retry_wait(
    retry_delay: Duration,
    destination_x: u32,
    destination_y: u32,
    failures: u32,
) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    let idx = destination_x.wrapping_add(destination_y) % 100;
    let jitter = retry_delay
        .checked_div(100)
        .and_then(|unit| unit.checked_mul(idx))
        .unwrap_or(Duration::ZERO);
    let mut wait = retry_delay + jitter;
    for _ in 1..failures {
        wait = wait.checked_mul(2).unwrap_or(Duration::MAX);
    }
    wait
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_attempt_never_waits() {
        assert_eq!(
            retry_wait(Duration::from_secs(2), 10, 20, 0),
            Duration::ZERO
        );
    }

    #[test]
    fn first_retry_waits_base_plus_position_jitter() {
        // idx = (10 + 20) % 100 = 30 → 2s + 30 * 20ms = 2.6s.
        assert_eq!(
            retry_wait(Duration::from_secs(2), 10, 20, 1),
            Duration::from_millis(2600)
        );
        // Origin tiles carry no jitter.
        assert_eq!(
            retry_wait(Duration::from_secs(2), 0, 0, 1),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn retries_double_each_time() {
        let first = retry_wait(Duration::from_secs(2), 10, 20, 1);
        assert_eq!(
            retry_wait(Duration::from_secs(2), 10, 20, 2),
            first.checked_mul(2).unwrap()
        );
        assert_eq!(
            retry_wait(Duration::from_secs(2), 10, 20, 3),
            first.checked_mul(4).unwrap()
        );
    }
}
