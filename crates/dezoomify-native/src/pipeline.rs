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

use dezoomify_core::core::adaptive::ObservationResult;
use dezoomify_core::core::model::{ProcessingRecipe, Request};
use dezoomify_core::Vec2d;

use crate::error::NativeError;
use crate::http::{fetch, FetchLimits, UserHeaders};
use crate::output::{validate_destination, OutputFormat};

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
    pub max_concurrent: usize,
    pub max_retries: u32,
    /// Hard cap on composed canvas bytes (RGBA, 4 bytes/pixel).
    pub max_canvas_bytes: u64,
    /// Legacy parity: cap the output width. The largest level whose width
    /// fits is downloaded; when none fits, the smallest level is used.
    pub max_width: Option<u32>,
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
            max_concurrent: 6,
            max_retries: 3,
            max_canvas_bytes: 1 << 30,
            max_width: None,
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
    validate_destination(
        std::path::Path::new(output_path),
        &OutputFormat::Png,
        overwrite,
    )
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

pub(crate) fn fetch_and_decode(
    uri: &str,
    headers: &BTreeMap<String, String>,
    processing: &ProcessingRecipe,
    config: &PipelineConfig,
    user: &UserHeaders,
) -> Result<image::RgbaImage, NativeError> {
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

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
