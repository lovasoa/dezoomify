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

/// Default JPEG quality for `.jpg` output and `iiif-dir` tiles: `100`
/// minus the default compression 5, matching the reference default.
pub const JPEG_QUALITY: u8 = 95;

/// JPEG (ISO 10918-1) caps both dimensions at 65535 px; larger canvases must
/// use PNG, TIFF, or `iiif-dir`.
///
/// WebP (VP8L lossless) caps both dimensions at 16383 px; larger canvases
/// must use PNG, TIFF, ZIF, or `iiif-dir`.
pub const JPEG_MAX_SIDE: u32 = 65_535;

/// WebP lossless caps both dimensions at 16383 px.
pub const WEBP_MAX_SIDE: u32 = 16_383;

/// `iiif-dir` tile width: one entry of the `tiles` block in `info.json`.
pub const IIIF_TILE_WIDTH: u32 = 512;
/// What to do when required tiles still fail after retries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PartialPolicy {
    /// Fail the job with `tile.download-failed` and write no output.
    Fail,
    /// Encode the acquired tiles with missing regions left blank and
    /// report success with `partial: true`. This matches the reference
    /// `PartialDownload` file behavior (partial output kept) and is the
    /// default; `--no-partial` selects `Fail`.
    #[default]
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
    /// Output compression, 0 is less, 100 is more (reference `--compression`,
    /// default 5). JPEG quality is `100 - compression` (see
    /// [`PipelineConfig::jpeg_quality`]); PNG and TIFF deflate tiers map
    /// below (see [`PipelineConfig::png_compression`] and
    /// [`tiff_compression_for`]). TIFF stays lossless at every level:
    /// higher compression only trades slower encodes for smaller files,
    /// never quality.
    pub compression: u8,
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
    /// Format selector (`--dezoomer`): `None` auto-detects via
    /// `default_registry`; `Some(name)` selects the single named program via
    /// `registry_for` (case-insensitive, `auto` also means auto-detect).
    /// Unknown names fail with typed `discovery.unknown-dezoomer`.
    pub format: Option<String>,
    /// What to do when required tiles still fail after retries.
    /// Default `Keep` matches the reference `PartialDownload` file behavior
    /// (partial output kept, blank regions, `partial: true`).
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
            compression: 5,
            cache_dir: None,
            max_width: None,
            max_height: None,
            zoom_level: None,
            image_index: None,
            largest: false,
            format: None,
            partial_policy: PartialPolicy::Keep,
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl PipelineConfig {
    /// Effective JPEG quality for `.jpg` output and `iiif-dir` tiles:
    /// `100 - compression` (reference `encoder/mod.rs:60`; default 5 maps
    /// to [`JPEG_QUALITY`]).
    #[must_use]
    pub fn jpeg_quality(&self) -> u8 {
        100u8.saturating_sub(self.compression)
    }

    /// PNG deflate tier from `--compression` (reference
    /// `png_encoder.rs:30-34`): 0-19 fast, 20-60 balanced, above high.
    /// The default compression 5 selects fast, matching the previous
    /// fixed encoder byte for byte.
    #[must_use]
    pub(crate) fn png_compression(&self) -> image::codecs::png::CompressionType {
        png_compression_for(self.compression)
    }
}

/// PNG deflate tier for a `--compression` value (reference
/// `png_encoder.rs:30-34`).
pub(crate) fn png_compression_for(compression: u8) -> image::codecs::png::CompressionType {
    use image::codecs::png::CompressionType;
    match compression {
        0..=19 => CompressionType::Fast,
        20..=60 => CompressionType::Default,
        _ => CompressionType::Best,
    }
}

/// TIFF deflate level for a `--compression` value: the same tiers as
/// [`png_compression_for`] (0-19 fast, 20-60 balanced, above best), so one
/// flag drives every lossless encoder identically. The `tiff` encoder has
/// no inner-JPEG quality knob, and native never re-encodes lossy inside
/// TIFF: higher compression only trades slower encodes for smaller files.
pub(crate) fn tiff_compression_for(compression: u8) -> tiff::encoder::compression::DeflateLevel {
    use tiff::encoder::compression::DeflateLevel;
    match compression {
        0..=19 => DeflateLevel::Fast,
        20..=60 => DeflateLevel::Balanced,
        _ => DeflateLevel::Best,
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
    let format = OutputFormat::infer_from_path(std::path::Path::new(output_path))?;
    validate_destination(std::path::Path::new(output_path), &format, overwrite)?;

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
///
/// The decoded tile carries the first-seen ICC profile and EXIF metadata
/// alongside the pixels (reference `tile.rs:186-219`); metadata extraction
/// failures fall back to `None` while decode failures fail the tile.
pub(crate) struct DecodedTile {
    pub image: image::RgbaImage,
    pub icc_profile: Option<Vec<u8>>,
    pub exif_metadata: Option<Vec<u8>>,
}

/// Decode image bytes while preserving the available ICC profile and EXIF
/// metadata, mirroring `load_image_with_metadata` in the reference.
pub(crate) struct ImageWithMetadata {
    pub image: image::DynamicImage,
    pub icc_profile: Option<Vec<u8>>,
    pub exif_metadata: Option<Vec<u8>>,
}

pub(crate) fn load_image_with_metadata(
    bytes: &[u8],
) -> Result<ImageWithMetadata, image::ImageError> {
    use image::ImageDecoder as _;
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let icc_profile = decoder.icc_profile().unwrap_or(None);
    let exif_metadata = decoder.exif_metadata().unwrap_or(None);
    let image = image::DynamicImage::from_decoder(decoder)?;
    Ok(ImageWithMetadata {
        image,
        icc_profile,
        exif_metadata,
    })
}

pub(crate) fn fetch_and_decode_cached(
    uri: &str,
    headers: &BTreeMap<String, String>,
    processing: &ProcessingRecipe,
    config: &PipelineConfig,
    user: &UserHeaders,
    cache: Option<(&std::path::Path, &str)>,
) -> Result<DecodedTile, NativeError> {
    if let Some((dir, namespace)) = cache {
        if let Some(bytes) = crate::cache::load(dir, namespace, uri) {
            if let Ok(loaded) = load_image_with_metadata(&bytes) {
                return Ok(DecodedTile {
                    image: loaded.image.to_rgba8(),
                    icc_profile: loaded.icc_profile,
                    exif_metadata: loaded.exif_metadata,
                });
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
    let loaded = load_image_with_metadata(&bytes)
        .map_err(|e| NativeError::new("tile.decode-failed", format!("tile decode failed: {e}")))?;
    Ok(DecodedTile {
        image: loaded.image.to_rgba8(),
        icc_profile: loaded.icc_profile,
        exif_metadata: loaded.exif_metadata,
    })
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

/// Encode the assembled canvas as PNG at the configured deflate tier.
/// The default tier is fast, matching the previous fixed encoder byte for
/// byte; higher `--compression` values trade smaller files for slower
/// encodes (reference `png_encoder.rs:30-34`). The first tile's ICC profile
/// and EXIF metadata ride in the header when present (reference
/// `png_encoder.rs:45-117`); tiles without metadata encode identically to
/// before.
pub(crate) fn encode_png(
    image: &image::RgbaImage,
    compression: image::codecs::png::CompressionType,
    icc_profile: Option<&[u8]>,
    exif_metadata: Option<&[u8]>,
) -> Result<Vec<u8>, NativeError> {
    use image::codecs::png::FilterType;
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new_with_quality(
        &mut bytes,
        compression,
        FilterType::Adaptive,
    );
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
    if let Some(exif) = exif_metadata {
        let _ = image::ImageEncoder::set_exif_metadata(&mut encoder, exif.to_vec());
    }
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
/// so transparent canvas regions (kept-partial holes) save as black. The
/// first tile's ICC profile is embedded when present (reference
/// `canvas.rs:124-137`); EXIF is not written to JPEG output, matching the
/// reference canvas writer.
pub fn encode_jpeg(
    image: &image::RgbaImage,
    quality: u8,
    icc_profile: Option<&[u8]>,
) -> Result<Vec<u8>, NativeError> {
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
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
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

/// Encode the assembled canvas as TIFF: one deflate-compressed image at the
/// level selected by `compression` (see [`tiff_compression_for`]; the
/// default 5 selects fast), with no side limit. The output stays lossless
/// at every level: higher compression only trades slower encodes for
/// smaller files, never quality. The first tile's ICC profile is embedded
/// when present (reference `canvas.rs:180-189`).
pub fn encode_tiff(
    image: &image::RgbaImage,
    compression: u8,
    icc_profile: Option<&[u8]>,
) -> Result<Vec<u8>, NativeError> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut encoder = tiff::encoder::TiffEncoder::new(&mut cursor)
            .map_err(tiff_failed)?
            .with_compression(tiff::encoder::Compression::Deflate(tiff_compression_for(
                compression,
            )));
        write_tiff_directory(&mut encoder, image, icc_profile)?;
    }
    Ok(cursor.into_inner())
}

/// Smallest pyramid side kept in [`encode_zif_pyramid`]: levels halve until
/// both sides fit, so every directory is a real downscaled resolution of
/// the canvas rather than padding.
pub(crate) const ZIF_PYRAMID_MIN_SIDE: u32 = 256;

/// Pyramid sizes for [`encode_zif_pyramid`]: the full canvas followed by
/// halved (rounding up) levels until both sides fit in
/// [`ZIF_PYRAMID_MIN_SIDE`]. A canvas that already fits yields a single
/// level; larger canvases yield real multi-resolution output.
pub(crate) fn tiff_pyramid_sizes(width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut sizes = vec![(width.max(1), height.max(1))];
    while sizes
        .last()
        .is_some_and(|(w, h)| *w > ZIF_PYRAMID_MIN_SIDE || *h > ZIF_PYRAMID_MIN_SIDE)
    {
        let (w, h) = sizes.last().copied().unwrap_or((1, 1));
        sizes.push((w.div_ceil(2).max(1), h.div_ceil(2).max(1)));
    }
    sizes
}

/// Encode the assembled canvas as ZIF: a TIFF-compatible multi-directory
/// pyramid holding the full-resolution image plus the halved levels from
/// [`tiff_pyramid_sizes`], each deflate-compressed at the level selected by
/// `compression` (see [`tiff_compression_for`]) with the first tile's ICC
/// profile embedded in every directory.
///
/// This is the clean equivalent of the reference `ZifTiffEncoder`
/// passthrough (`zif_tiff_encoder.rs`): byte-preserving encoded-tile
/// passthrough cannot cross the job-engine boundary (the engine plans one
/// level and reports only decoded-tile outcomes, so no encoded bytes or
/// source-pyramid levels ever reach the runtime), and the engine's effects
/// are fixed by the protocol. Instead of renaming a single image, native
/// re-encodes the assembled canvas at every pyramid resolution, so `.zif`
/// output carries real multi-resolution data readable by any TIFF reader
/// (first directory) and by pyramid-aware readers (all directories).
pub fn encode_zif_pyramid(
    image: &image::RgbaImage,
    compression: u8,
    icc_profile: Option<&[u8]>,
) -> Result<Vec<u8>, NativeError> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut encoder = tiff::encoder::TiffEncoder::new(&mut cursor)
            .map_err(tiff_failed)?
            .with_compression(tiff::encoder::Compression::Deflate(tiff_compression_for(
                compression,
            )));
        for (width, height) in tiff_pyramid_sizes(image.width(), image.height()) {
            let downscaled;
            let view: &image::RgbaImage = if width == image.width() && height == image.height() {
                image
            } else {
                downscaled = image::imageops::resize(
                    image,
                    width,
                    height,
                    image::imageops::FilterType::Triangle,
                );
                &downscaled
            };
            write_tiff_directory(&mut encoder, view, icc_profile)?;
        }
    }
    Ok(cursor.into_inner())
}

fn tiff_failed(error: tiff::TiffError) -> NativeError {
    NativeError::new(
        "output.encode-failed",
        format!("tiff encode failed: {error}"),
    )
}

/// Write one RGBA image as a single directory of an open TIFF encoder,
/// embedding the ICC profile when present. Shared by the single-image
/// [`encode_tiff`] and multi-directory [`encode_zif_pyramid`] paths so both
/// stay byte-consistent per level.
fn write_tiff_directory<W: std::io::Write + std::io::Seek>(
    encoder: &mut tiff::encoder::TiffEncoder<W>,
    image: &image::RgbaImage,
    icc_profile: Option<&[u8]>,
) -> Result<(), NativeError> {
    let mut directory = encoder
        .new_image::<tiff::encoder::colortype::RGBA8>(image.width(), image.height())
        .map_err(tiff_failed)?;
    if let Some(profile) = icc_profile {
        let _ = directory
            .encoder()
            .write_tag(tiff::tags::Tag::IccProfile, profile);
    }
    directory.write_data(image.as_raw()).map_err(tiff_failed)
}

/// Encode the assembled canvas as lossless WebP (no side limit beyond
/// [`WEBP_MAX_SIDE`]; sides beyond it fail with typed
/// `output.encode-failed`). WebP lossless has no quality knob, so
/// `--compression` does not apply here; the first tile's ICC profile is
/// embedded when present (reference `canvas.rs:190-199`).
pub fn encode_webp(
    image: &image::RgbaImage,
    icc_profile: Option<&[u8]>,
) -> Result<Vec<u8>, NativeError> {
    if image.width() > WEBP_MAX_SIDE || image.height() > WEBP_MAX_SIDE {
        return Err(NativeError::new(
            "output.encode-failed",
            format!(
                "webp output {}x{} exceeds the 16383px per-side webp limit; save as png, tiff, zif, or iiif-dir",
                image.width(),
                image.height()
            ),
        ));
    }
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut bytes);
    if let Some(profile) = icc_profile {
        let _ = image::ImageEncoder::set_icc_profile(&mut encoder, profile.to_vec());
    }
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| NativeError::new("output.encode-failed", format!("webp encode failed: {e}")))?;
    Ok(bytes)
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
/// for a deterministic digest; tiles encode at `jpeg_quality` without
/// embedded profiles (retiled output, matching the reference tile saver).
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
                let bytes = encode_jpeg(&tile, jpeg_quality, None)?;
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
        encode_jpeg(image, jpeg_quality, None)?,
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

    #[test]
    fn compression_maps_to_jpeg_quality_and_png_tiers() {
        use image::codecs::png::CompressionType;
        use tiff::encoder::compression::DeflateLevel;
        let config = PipelineConfig {
            compression: 5,
            ..Default::default()
        };
        assert_eq!(config.jpeg_quality(), 95);
        assert_eq!(config.jpeg_quality(), JPEG_QUALITY);
        assert_eq!(png_compression_for(0), CompressionType::Fast);
        assert_eq!(png_compression_for(19), CompressionType::Fast);
        assert_eq!(png_compression_for(20), CompressionType::Default);
        assert_eq!(png_compression_for(60), CompressionType::Default);
        assert_eq!(png_compression_for(61), CompressionType::Best);
        assert_eq!(png_compression_for(100), CompressionType::Best);
        // TIFF deflate follows the same tiers: one flag drives every
        // lossless encoder identically.
        assert_eq!(tiff_compression_for(0), DeflateLevel::Fast);
        assert_eq!(tiff_compression_for(5), DeflateLevel::Fast);
        assert_eq!(tiff_compression_for(20), DeflateLevel::Balanced);
        assert_eq!(tiff_compression_for(60), DeflateLevel::Balanced);
        assert_eq!(tiff_compression_for(61), DeflateLevel::Best);
        assert_eq!(tiff_compression_for(100), DeflateLevel::Best);
        let max = PipelineConfig {
            compression: 100,
            ..Default::default()
        };
        assert_eq!(max.jpeg_quality(), 0);
    }

    #[test]
    fn tiff_deflate_levels_decode_pixel_exact() {
        let mut image = image::RgbaImage::new(16, 16);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x * 16) as u8, (y * 16) as u8, 128, 255]);
        }
        // Every compression level writes a real little-endian TIFF and
        // decodes back pixel-exact: deflate trades size for time, never
        // quality.
        for compression in [0, 5, 20, 60, 61, 100] {
            let tiff = encode_tiff(&image, compression, None).expect("tiff encodes");
            assert!(
                tiff.starts_with(&[0x49, 0x49, 0x2A, 0x00]),
                "tiff output carries the little-endian magic at compression {compression}"
            );
            let decoded = image::load_from_memory(&tiff)
                .expect("tiff decodes")
                .to_rgba8();
            assert_eq!((decoded.width(), decoded.height()), (16, 16));
            assert_eq!(
                decoded.as_raw(),
                image.as_raw(),
                "deflate must be lossless at compression {compression}"
            );
        }
    }

    #[test]
    fn tiff_embeds_icc_profile() {
        let icc = vec![
            0x00, 0x00, 0x02, 0x0C, 0x61, 0x64, 0x73, 0x70, 0x00, 0x00, 0x00, 0x00, 0x6D, 0x6E,
            0x74, 0x72, 0x52, 0x47, 0x42, 0x20,
        ];
        let image = image::RgbaImage::from_pixel(4, 4, image::Rgba([9, 9, 9, 255]));
        let tiff = encode_tiff(&image, 5, Some(&icc)).expect("tiff encodes");
        // Assert through the TIFF decoder: the tag is present with the exact
        // profile bytes. (`load_image_with_metadata` applies the image
        // crate's default decode limits, under which its TIFF ICC accessor
        // reports `None` even for a conformant tag, so it cannot observe
        // this; the PNG/JPEG ICC round-trip above covers that path.)
        let mut decoder =
            tiff::decoder::Decoder::new(std::io::Cursor::new(&tiff)).expect("tiff decodes");
        assert_eq!(
            decoder
                .get_tag_u8_vec(tiff::tags::Tag::IccProfile)
                .expect("icc tag present"),
            icc,
        );
    }

    #[test]
    fn zif_pyramid_sizes_halve_to_the_minimum_side() {
        assert_eq!(tiff_pyramid_sizes(16, 16), vec![(16, 16)]);
        assert_eq!(tiff_pyramid_sizes(256, 256), vec![(256, 256)]);
        assert_eq!(tiff_pyramid_sizes(512, 512), vec![(512, 512), (256, 256)]);
        assert_eq!(
            tiff_pyramid_sizes(1024, 768),
            vec![(1024, 768), (512, 384), (256, 192)]
        );
        // Odd sides round up so no level collapses to zero.
        assert_eq!(
            tiff_pyramid_sizes(513, 100),
            vec![(513, 100), (257, 50), (129, 25)]
        );
    }

    #[test]
    fn zif_pyramid_holds_real_downscaled_levels() {
        let mut image = image::RgbaImage::new(512, 512);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x / 2) as u8, (y / 2) as u8, 128, 255]);
        }
        let zif = encode_zif_pyramid(&image, 5, None).expect("zif encodes");
        assert!(
            zif.starts_with(&[0x49, 0x49, 0x2A, 0x00]),
            "zif output is TIFF-compatible"
        );
        // Every directory decodes with the advertised dimensions; the first
        // matches the canvas pixel-exact (lossless deflate).
        let mut decoder =
            tiff::decoder::Decoder::new(std::io::Cursor::new(&zif)).expect("zif decodes");
        let mut level = 0;
        loop {
            let (width, height) = decoder.dimensions().expect("level dims");
            assert_eq!(
                (width, height),
                tiff_pyramid_sizes(512, 512)[level],
                "level {level} carries its own resolution"
            );
            if level == 0 {
                let decoded = image::load_from_memory(&zif)
                    .expect("first level decodes")
                    .to_rgba8();
                assert_eq!(decoded.as_raw(), image.as_raw());
            }
            level += 1;
            if decoder.more_images() {
                decoder.next_image().expect("next level");
            } else {
                break;
            }
        }
        assert_eq!(level, 2, "512px canvas yields two pyramid levels");
    }

    #[test]
    fn webp_lossless_round_trip_is_pixel_exact() {
        let mut image = image::RgbaImage::new(16, 16);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x * 16) as u8, (y * 16) as u8, 128, 255]);
        }
        let webp = encode_webp(&image, None).expect("webp encodes");
        assert!(
            webp.starts_with(b"RIFF") && webp.get(8..12) == Some(b"WEBP".as_slice()),
            "webp output carries the RIFF/WEBP container markers"
        );
        let decoded = image::load_from_memory(&webp)
            .expect("webp decodes")
            .to_rgba8();
        assert_eq!((decoded.width(), decoded.height()), (16, 16));
        assert_eq!(decoded.as_raw(), image.as_raw());
        // An ICC profile never breaks the lossless path.
        let icc = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        let tagged = encode_webp(&image, Some(&icc)).expect("webp encodes with icc");
        let back = image::load_from_memory(&tagged)
            .expect("tagged webp decodes")
            .to_rgba8();
        assert_eq!(back.as_raw(), image.as_raw());
    }

    #[test]
    fn webp_rejects_canvases_beyond_its_side_limit() {
        let wide = image::RgbaImage::new(WEBP_MAX_SIDE + 1, 1);
        let error = encode_webp(&wide, None).expect_err("webp side limit applies");
        assert_eq!(error.code, "output.encode-failed");
    }

    #[test]
    fn tile_metadata_survives_decode_and_reencode() {
        use image::codecs::png::CompressionType;
        let icc = vec![
            0x00, 0x00, 0x02, 0x0C, 0x61, 0x64, 0x73, 0x70, 0x00, 0x00, 0x00, 0x00, 0x6D, 0x6E,
            0x74, 0x72, 0x52, 0x47, 0x42, 0x20,
        ];
        let exif = vec![0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D, 0x00, 0x2A];
        // A PNG carrying both blocks decodes with its metadata attached.
        let mut tagged = Vec::new();
        {
            use image::ImageEncoder as _;
            let mut encoder = image::codecs::png::PngEncoder::new(&mut tagged);
            encoder.set_icc_profile(icc.clone()).unwrap();
            encoder.set_exif_metadata(exif.clone()).unwrap();
            encoder
                .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
                .unwrap();
        }
        let loaded = load_image_with_metadata(&tagged).expect("decodes");
        assert_eq!(loaded.image.width(), 1);
        assert_eq!(loaded.icc_profile.as_deref(), Some(icc.as_slice()));
        assert_eq!(loaded.exif_metadata.as_deref(), Some(exif.as_slice()));
        // Re-encoding through the pipeline encoders preserves the blocks.
        let rgba = loaded.image.to_rgba8();
        let png =
            encode_png(&rgba, CompressionType::Fast, Some(&icc), Some(&exif)).expect("png encodes");
        let png_back = load_image_with_metadata(&png).expect("png decodes");
        assert_eq!(png_back.icc_profile.as_deref(), Some(icc.as_slice()));
        assert_eq!(png_back.exif_metadata.as_deref(), Some(exif.as_slice()));
        let jpeg = encode_jpeg(&rgba, 95, Some(&icc)).expect("jpeg encodes");
        let jpeg_back = load_image_with_metadata(&jpeg).expect("jpeg decodes");
        assert_eq!(jpeg_back.icc_profile.as_deref(), Some(icc.as_slice()));
        // No metadata in, no metadata out: byte-identical to the plain path.
        let plain_png = encode_png(&rgba, CompressionType::Fast, None, None).expect("png encodes");
        let plain_back = load_image_with_metadata(&plain_png).expect("decodes");
        assert_eq!(plain_back.icc_profile, None);
        assert_eq!(plain_back.exif_metadata, None);
    }
}
