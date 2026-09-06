//! Job-driven native download: one [`dezoomify_job::Job`] owns discovery,
//! selection, planning, retry, and lifecycle policy. This driver only
//! executes the job's effects with the existing native fns and projects its
//! events onto [`PipelineEvent`]s, so CLI/desktop output is unchanged.
//!
//! Drive loop: `job.start()` → drain effects → execute → `job.on_response()`
//! → repeat until terminal. Effect mapping:
//!
//! * `acquire-resource{uri}` → [`fetch`] + [`merge_headers`], replying
//!   `ResourceBytes` (with the post-redirect URL) or `FetchFailure`.
//! * `catalog` → legacy `choose_image`/`choose_level` parity: exact
//!   `image_index` (out-of-range uses the last image; a deferred selection
//!   is followed with a fresh bounded job), then exact `zoom_level`
//!   (out-of-range uses the last level), then `largest`, then the
//!   width+height `best_size` filter (largest fitting area, else the
//!   narrowest), replying `SelectedImage`/`SelectedLevel`.
//! * `levels` → legacy `choose_level` rule over declared sizes (exact index,
//!   then largest, then the width+height filter, else the largest area),
//!   replying `SelectedLevel`.
//! * `request-destination` → [`validate_destination`] + overwrite policy,
//!   replying `DestinationGranted`/`DestinationDenied`.
//! * `acquire-tile{probe:true}` → [`probe_tile_bytes`], replying
//!   `ProbeOutcome` with observed geometry.
//! * `acquire-tile` → [`fetch_and_decode_cached`] under the job's concurrency
//!   gate (one [`std::thread::scope`] pool per drained batch, sized by
//!   `max_concurrent`), replying `TileOutcome`; the job owns retry counting
//!   and partial decisions while the driver paces request starts by
//!   `min_interval` and sleeps the reference `retry_delay` + position jitter
//!   with doubling before refetches. With `max_retries: 0` the first failure
//!   fails the tile immediately with no refetch (first attempt only).
//!   With `PipelineConfig::cache_dir` set, tile bodies persist under the job
//!   namespace and later runs skip refetching tiles whose bytes still decode.
//! * `decode-pixels`/`open-encoder`/`finalize-encoder` → acknowledged from
//!   the tiles already decoded during acquisition (encoders run one-shot).
//!   Encoded-tile passthrough is intentionally not ported: the engine plans
//!   one level and reports decoded-tile outcomes only, so no encoded bytes
//!   or source-pyramid levels ever reach the runtime and the protocol has
//!   no encoded-tile effect. `.zif` output re-encodes the assembled canvas
//!   at every pyramid resolution instead (see [`OutputFormat::Zif`]).
//! * `publish-output` → canvas-limit check, assemble with [`blit_onto`],
//!   encode per the inferred [`OutputFormat`] (PNG at the configured deflate
//!   tier, JPEG at quality `100 - compression`, single-image TIFF or ZIF
//!   pyramid deflate-compressed at the configured level, or an `iiif-dir` tile
//!   digest (over the file bytes, or over `info.json` plus tile bytes in
//!   sorted path order for directories).
//! * `release-bytes`/`cancel-work` → drop decoded buffers; no output is
//!   written on the cancel path.
//! * `request-decision{partial}` → [`PartialPolicy`]: fail (discard, honest
//!   `tile.download-failed`) or keep (blank missing regions, marked
//!   partial output).
//!
//! The output format is inferred once from the destination path extension
//! ([`OutputFormat::infer_from_path`]): `.png`, `.jpg`/`.jpeg`,
//! `.tif`/`.tiff` (single deflate-compressed image), `.zif` (a
//! TIFF-compatible multi-directory pyramid), `.iiif` (an
//! `iiif-dir` tree at that path), or an extensionless path (or existing
//! directory) for `iiif-dir`.
//!
//! [`fetch`]: crate::http::fetch
//! [`merge_headers`]: crate::pipeline::merge_headers
//! [`validate_destination`]: crate::output::validate_destination
//! [`probe_tile_bytes`]: crate::pipeline::probe_tile_bytes
//! [`fetch_and_decode_cached`]: crate::pipeline::fetch_and_decode_cached
//! [`blit_onto`]: crate::pipeline::blit_onto
//! [`OutputFormat`]: crate::output::OutputFormat
//! [`OutputFormat::infer_from_path`]: crate::output::OutputFormat::infer_from_path
//! [`render_iiif_dir`]: crate::pipeline::render_iiif_dir
//! [`write_atomic`]: crate::output::write_atomic
//! [`sha256_hex`]: crate::pipeline::sha256_hex

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dezoomify_core::core::adaptive::ObservationResult;
use dezoomify_core::core::model::{ProcessingRecipe, Request};
use dezoomify_core::Vec2d;
use dezoomify_job::{Config as JobConfig, Job, JobResponse, State as JobState};

use crate::error::NativeError;
use crate::http::{fetch, UserHeaders};
use crate::output::{validate_destination, write_atomic, write_iiif_dir, OutputFormat};
use crate::pipeline::{
    blit_onto, encode_jpeg, encode_png, encode_tiff, encode_zif_pyramid, fetch_and_decode_cached,
    merge_headers, probe_tile_bytes, render_iiif_dir, sha256_hex, PartialPolicy, PipelineConfig,
    PipelineEvent, PipelineOutcome,
};

/// Deferred-resolution bound: the initial discovery plus this many deferred
/// follows, matching the legacy loop limit.
const MAX_DEFERRED_FOLLOWS: u32 = 10;

static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

/// Terminal outcome of one job attempt: finished output or a deferred URI to
/// follow with a fresh job.
enum AttemptDone {
    Done(PipelineOutcome),
    Deferred(String),
}

pub(crate) fn drive(
    input_url: &str,
    output_path: &str,
    overwrite: bool,
    config: &PipelineConfig,
    user: &UserHeaders,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<PipelineOutcome, NativeError> {
    let mut url = input_url.to_string();
    let format = OutputFormat::infer_from_path(std::path::Path::new(output_path))
        .map_err(NativeError::from)?;
    for _ in 0..=MAX_DEFERRED_FOLLOWS {
        match drive_job(&url, output_path, overwrite, format, config, user, on_event)? {
            AttemptDone::Done(outcome) => return Ok(outcome),
            AttemptDone::Deferred(next) => url = next,
        }
    }
    Err(NativeError::new(
        "discovery.deferred",
        "image metadata stayed deferred after the resolution limit",
    ))
}

fn mint_job_id() -> String {
    let n = NEXT_JOB.fetch_add(1, Ordering::SeqCst);
    format!("job:native-{n}")
}

/// Map pipeline bounds onto validated job bounds. Transport byte limits stay
/// identical on both sides so the fetch layer, not the engine, reports
/// oversize resources; probe planning stays enabled for native.
fn job_config_for(config: &PipelineConfig) -> Result<JobConfig, NativeError> {
    let tiles = config.max_tiles.clamp(1, 16_777_216) as u32;
    // The engine requires concurrency within the tile budget; the legacy
    // loop simply ran smaller plans through the same pool.
    let fetches = (config.max_concurrent.clamp(1, 64) as u32).min(tiles);
    // Zero retries is real: the first failure fails the tile with no
    // refetch (first attempt only, immediate typed failure). The engine
    // retry counting (`next <= max_retries`) handles `0` directly, which
    // speeds up generic probing that relies on failed loads for geometry.
    let retries = config.max_retries.clamp(0, 1024);
    let max_bytes = config.fetch.max_bytes.clamp(1024, 4_294_967_296);
    let buffers = fetches.clamp(16, 65_536);
    let job = JobConfig {
        max_concurrent_fetches: fetches,
        max_concurrent_decodes: fetches,
        max_tiles: tiles,
        max_retries: retries,
        max_buffers: buffers,
        max_bytes,
        plan_probes: true,
    };
    job.validate().map_err(|e| {
        NativeError::new(
            "tile.limit",
            format!("native bounds exceed job limits: {}", e.message),
        )
    })?;
    Ok(job)
}

// ---------------------------------------------------------------------------
// Selection rules (legacy parity over projected catalog data)
// ---------------------------------------------------------------------------

/// First catalog entry wins: ready entries are selected, a leading deferred
/// entry is followed. Width `0` means unknown (never fits a cap, sorts last
/// as narrowest), mirroring the legacy `None` handling.
///
/// Level selection mirrors the reference `choose_level` priority: exact
/// `zoom_level` index first (out-of-range uses the last level), then
/// explicit `largest`, then the width+height `best_size` filter (largest
/// fitting area; unknown extents never fit), else the largest area.
/// Nothing fitting a cap falls back to the narrowest level rather than
/// exceeding the cap (the reference would prompt; the non-interactive
/// driver stays fail-closed on the cap).
pub(crate) struct LevelSelection {
    pub largest: bool,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub zoom_level: Option<usize>,
}

impl LevelSelection {
    fn from_config(config: &PipelineConfig) -> Self {
        Self {
            largest: config.largest,
            max_width: config.max_width,
            max_height: config.max_height,
            zoom_level: config.zoom_level,
        }
    }
}

fn max_area_id(levels: &[&(String, u64, u64)]) -> Option<String> {
    levels
        .iter()
        .max_by_key(|(_, width, height)| u128::from(*width) * u128::from(*height))
        .map(|(id, _, _)| (*id).clone())
}

/// Image selection mirrors the reference `choose_image` rule: the exact
/// `image_index` wins with out-of-range falling back to the last image;
/// `None` keeps the first entry (bulk auto-first parity).
pub(crate) fn select_image_index(count: usize, image_index: Option<usize>) -> Option<usize> {
    if count == 0 {
        return None;
    }
    Some(image_index.map_or(0, |requested| requested.min(count - 1)))
}

pub(crate) fn select_level_id(
    levels: &[(String, u64, u64)],
    selection: &LevelSelection,
) -> Option<String> {
    if levels.is_empty() {
        return None;
    }
    if let Some(requested) = selection.zoom_level {
        let index = requested.min(levels.len() - 1);
        return Some(levels[index].0.clone());
    }
    if selection.largest {
        let refs: Vec<&(String, u64, u64)> = levels.iter().collect();
        return max_area_id(&refs);
    }
    if selection.max_width.is_some() || selection.max_height.is_some() {
        const UNKNOWN: u64 = u64::MAX;
        let width_of = |width: u64| {
            if width == 0 {
                UNKNOWN
            } else {
                width
            }
        };
        let fitting: Vec<&(String, u64, u64)> = levels
            .iter()
            .filter(|(_, width, height)| {
                let width_ok = selection
                    .max_width
                    .is_none_or(|cap| *width != 0 && *width <= u64::from(cap));
                let height_ok = selection
                    .max_height
                    .is_none_or(|cap| *height != 0 && *height <= u64::from(cap));
                width_ok && height_ok
            })
            .collect();
        if fitting.is_empty() {
            // No level fits: honestly take the narrowest one rather
            // than silently exceeding the cap.
            return levels
                .iter()
                .min_by_key(|(_, width, _)| width_of(*width))
                .map(|(id, _, _)| id.clone());
        }
        return max_area_id(&fitting);
    }
    let refs: Vec<&(String, u64, u64)> = levels.iter().collect();
    max_area_id(&refs)
}

/// Map a terminal job failure onto the stable native code the same failure
/// had before the migration, preserving the engine message.
pub(crate) fn map_failure_code(code: &str) -> &'static str {
    match code {
        "job.discovery-failed" | "job.catalog-invalid" | "job.empty-resource" => "discovery.failed",
        "job.no-images" => "discovery.no-image",
        "job.unknown-dezoomer" => "discovery.unknown-dezoomer",
        "job.resource-limit" => "tile.limit",
        "job.plan-invalid" | "job.probe-unsupported" => "discovery.tile-plan",
        "job.plan-empty" => "discovery.no-level",
        "job.partial-discarded" => "tile.download-failed",
        _ => "native.internal",
    }
}

/// Map a job setup error (`Job::new`/`Job::start`) onto a typed native error
/// by stable code, never by display-string matching.
fn map_setup_error(error: &dezoomify_job::JobError) -> NativeError {
    match error.code.as_str() {
        "job.unknown-dezoomer" => {
            NativeError::new("discovery.unknown-dezoomer", error.message.clone())
        }
        "job.invalid-input" => NativeError::new("discovery.failed", error.message.clone()),
        _ => NativeError::new(
            "native.internal",
            format!("{}: {}", error.code, error.message),
        ),
    }
}

// ---------------------------------------------------------------------------
// One job attempt
// ---------------------------------------------------------------------------

struct CatalogImage {
    id: String,
    ready: bool,
    format: String,
    levels: Vec<(String, u64, u64)>,
}

#[derive(Clone, Copy)]
struct TileGeom {
    destination: Vec2d,
    extent: Option<Vec2d>,
}

struct Published {
    output_hash: String,
    tile_count: usize,
    image_size: Vec2d,
    partial: bool,
}

struct Attempt<'a> {
    config: &'a PipelineConfig,
    user: &'a UserHeaders,
    output_path: PathBuf,
    overwrite: bool,
    format: OutputFormat,
    /// Resume cache as `(cache_dir, job_namespace)`; `None` refetches all
    /// tiles every run.
    cache: Option<(PathBuf, String)>,
    on_event: &'a mut dyn FnMut(PipelineEvent),
    discovery_resources: usize,
    catalog: Vec<CatalogImage>,
    /// Index into `catalog` chosen by [`select_image_index`]; level
    /// selection and the reported format follow this entry, not entry 0.
    selected_image: Option<usize>,
    canvas: Option<Vec2d>,
    /// Plan-order tile ids (first-seen order matches plan order).
    order: Vec<String>,
    geoms: HashMap<String, TileGeom>,
    decoded: HashMap<String, crate::pipeline::DecodedTile>,
    /// Tiles acquired overall (never cleared by `release-bytes`, unlike
    /// the pixel buffers above).
    acquired: usize,
    /// Prior failure counts per tile id: drives the retry backoff
    /// (`retry_delay` + jitter + doubling).
    tile_failures: HashMap<String, u32>,
    /// Start of the most recent tile request: `--min-interval` staggering
    /// sleeps until `throttle_last + min_interval` before starting the next
    /// request. `None` before the first request.
    throttle_last: Option<Instant>,
    failure: Option<(String, String)>,
    published: Option<Published>,
    destination_error: Option<String>,
    recovery_attempts: u32,
    cancel_sent: bool,
}

impl<'a> Attempt<'a> {
    fn emit(&mut self, kind: &str, detail: BTreeMap<String, String>) {
        (self.on_event)(PipelineEvent {
            kind: kind.to_string(),
            detail,
        });
    }
}

fn drive_job(
    input_url: &str,
    output_path: &str,
    overwrite: bool,
    format: OutputFormat,
    config: &PipelineConfig,
    user: &UserHeaders,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<AttemptDone, NativeError> {
    let job_id = mint_job_id();
    let job_config = job_config_for(config)?;
    let mut job = Job::new(&job_id, input_url, job_config).map_err(|e| map_setup_error(&e))?;
    job.set_format(config.format.clone());
    job.start().map_err(|e| map_setup_error(&e))?;
    let mut attempt = Attempt {
        config,
        user,
        output_path: PathBuf::from(output_path),
        overwrite,
        format,
        cache: config
            .cache_dir
            .clone()
            .map(|dir| (dir, crate::cache::job_namespace(input_url))),
        on_event,
        discovery_resources: 0,
        catalog: Vec::new(),
        selected_image: None,
        canvas: None,
        order: Vec::new(),
        geoms: HashMap::new(),
        decoded: HashMap::new(),
        acquired: 0,
        tile_failures: HashMap::new(),
        throttle_last: None,
        failure: None,
        published: None,
        destination_error: None,
        recovery_attempts: 0,
        cancel_sent: false,
    };

    loop {
        if attempt.config.cancel_flag.load(Ordering::SeqCst)
            && !job.is_terminal()
            && !attempt.cancel_sent
        {
            let _ = job.on_response(JobResponse::Cancel {
                job: job_id.clone(),
            });
            attempt.cancel_sent = true;
        }
        for event in job.drain_events() {
            handle_event(&mut attempt, &event)?;
        }
        if job.state() == JobState::AwaitingImageSelection && !attempt.catalog.is_empty() {
            let selected =
                select_image_index(attempt.catalog.len(), attempt.config.image_index).unwrap_or(0);
            if attempt.catalog[selected].ready {
                let image = attempt.catalog[selected].id.clone();
                attempt.selected_image = Some(selected);
                reply(
                    &mut job,
                    JobResponse::SelectedImage {
                        job: job_id.clone(),
                        image,
                    },
                )?;
            } else {
                let uri = job
                    .deferred_uri(&attempt.catalog[selected].id)
                    .ok_or_else(|| {
                        NativeError::new(
                            "discovery.no-image",
                            "no zoomable image found at the input url",
                        )
                    })?;
                return Ok(AttemptDone::Deferred(uri));
            }
            continue;
        }
        if job.state() == JobState::AwaitingLevelSelection && !attempt.catalog.is_empty() {
            let selected = attempt
                .selected_image
                .unwrap_or(0)
                .min(attempt.catalog.len() - 1);
            let selection = LevelSelection::from_config(attempt.config);
            let level = select_level_id(&attempt.catalog[selected].levels, &selection).ok_or_else(
                || NativeError::new("discovery.no-level", "image has no zoom levels"),
            )?;
            reply(
                &mut job,
                JobResponse::SelectedLevel {
                    job: job_id.clone(),
                    level,
                },
            )?;
            continue;
        }
        let effects = job.drain_effects();
        if effects.is_empty() {
            if job.is_terminal() {
                break;
            }
            return Err(NativeError::new(
                "native.internal",
                "job stalled with no effects",
            ));
        }
        execute_effects(&mut job, &mut attempt, effects)?;
    }

    match job.terminal_kind() {
        Some("completed" | "partial-completed") => {
            let partial = job.terminal_kind() == Some("partial-completed");
            let published = attempt.published.ok_or_else(|| {
                NativeError::new("native.internal", "job completed without output")
            })?;
            debug_assert_eq!(published.partial, partial);
            Ok(AttemptDone::Done(PipelineOutcome {
                output_path: attempt.output_path.clone(),
                output_hash: published.output_hash,
                tile_count: published.tile_count,
                image_size: published.image_size,
                format: attempt
                    .selected_image
                    .and_then(|index| attempt.catalog.get(index))
                    .or_else(|| attempt.catalog.first())
                    .map(|image| image.format.clone())
                    .unwrap_or_default(),
                partial: published.partial,
            }))
        }
        Some("cancelled") => {
            if let Some(message) = attempt.destination_error {
                Err(NativeError::new("native.internal", message))
            } else {
                Err(NativeError::new(
                    "job.cancelled",
                    "job cancelled before completion",
                ))
            }
        }
        Some("failed") => {
            let (code, message) = attempt.failure.unwrap_or_else(|| {
                (
                    "native.internal".to_string(),
                    "job failed without diagnostics".to_string(),
                )
            });
            if code == "job.partial-discarded" {
                // Legacy parity: report every tile never acquired (proven
                // failures plus batch mates abandoned at the decision),
                // exactly the set the old retry loop still held pending.
                let unacquired = attempt.order.len().saturating_sub(attempt.acquired);
                if unacquired > 0 {
                    return Err(NativeError::new(
                        "tile.download-failed",
                        format!(
                            "{} tile(s) still failing after {} retries",
                            unacquired, attempt.config.max_retries,
                        ),
                    ));
                }
            }
            Err(NativeError::new(map_failure_code(&code), message))
        }
        _ => Err(NativeError::new(
            "native.internal",
            "job ended without a terminal state",
        )),
    }
}

fn reply(job: &mut Job, response: JobResponse) -> Result<(), NativeError> {
    job.on_response(response).map_err(|e| {
        NativeError::new(
            "native.internal",
            format!("effect reply rejected ({}): {}", e.code, e.message),
        )
    })?;
    Ok(())
}

fn handle_event(attempt: &mut Attempt<'_>, event: &serde_json::Value) -> Result<(), NativeError> {
    let kind = event
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match kind {
        "catalog" => {
            let mut catalog = Vec::new();
            if let Some(images) = event.get("images").and_then(serde_json::Value::as_array) {
                for image in images {
                    let id = image
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let ready =
                        image.get("readiness").and_then(serde_json::Value::as_str) == Some("ready");
                    let format = image
                        .get("format")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let mut levels = Vec::new();
                    if let Some(entries) = image.get("levels").and_then(serde_json::Value::as_array)
                    {
                        for level in entries {
                            levels.push((
                                level
                                    .get("id")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                level
                                    .get("width")
                                    .and_then(serde_json::Value::as_u64)
                                    .unwrap_or(0),
                                level
                                    .get("height")
                                    .and_then(serde_json::Value::as_u64)
                                    .unwrap_or(0),
                            ));
                        }
                    }
                    catalog.push(CatalogImage {
                        id,
                        ready,
                        format,
                        levels,
                    });
                }
            }
            attempt.catalog = catalog;
        }
        "progress" => {
            let acquired = event
                .get("acquired")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
                .to_string();
            let total = event
                .get("total")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
                .to_string();
            attempt.emit(
                "downloading",
                BTreeMap::from([
                    ("acquired".to_string(), acquired),
                    ("total".to_string(), total),
                ]),
            );
        }
        "failed" => {
            attempt.failure = Some((
                event
                    .get("code")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("native.internal")
                    .to_string(),
                event
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("job failed")
                    .to_string(),
            ));
        }
        _ => {}
    }
    Ok(())
}

struct TileFetch {
    tile: String,
    uri: String,
    headers: BTreeMap<String, String>,
    processing: ProcessingRecipe,
    destination: Vec2d,
    extent: Option<Vec2d>,
}

fn point(value: &serde_json::Value) -> Vec2d {
    Vec2d {
        x: value
            .get("x")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0),
        y: value
            .get("y")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0),
    }
}

fn processing_from_name(name: &str) -> ProcessingRecipe {
    match name {
        "google-arts-decrypt" => ProcessingRecipe::GoogleArtsDecrypt,
        _ => ProcessingRecipe::None,
    }
}

fn tile_fetch(effect: &serde_json::Value) -> Option<TileFetch> {
    let tile = effect
        .get("tile")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    let uri = effect
        .get("uri")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    let mut headers = BTreeMap::new();
    if let Some(map) = effect.get("headers").and_then(serde_json::Value::as_object) {
        for (name, value) in map {
            if let Some(value) = value.as_str() {
                headers.insert(name.to_ascii_lowercase(), value.to_string());
            }
        }
    }
    Some(TileFetch {
        tile,
        uri,
        headers,
        processing: processing_from_name(
            effect
                .get("processing")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("none"),
        ),
        destination: effect.get("destination").map(point).unwrap_or_default(),
        extent: effect
            .get("expected_size")
            .filter(|size| !size.is_null())
            .map(point),
    })
}

fn execute_effects(
    job: &mut Job,
    attempt: &mut Attempt<'_>,
    effects: Vec<serde_json::Value>,
) -> Result<(), NativeError> {
    let job_id = job.id().to_string();
    let mut tiles: Vec<TileFetch> = Vec::new();
    for effect in &effects {
        let kind = effect
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        match kind {
            "acquire-resource" => {
                // Batch discovery may hold sibling fetches after a winner
                // already finished discovery; those are moot and skipped
                // so a late answer never masks the winning catalog.
                if job.state() != JobState::Discovering {
                    continue;
                }
                let request = effect
                    .get("request")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let uri = effect
                    .get("uri")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                // Core discovery headers are empty in practice; defaults plus
                // scoped user headers match the legacy merge exactly. The
                // progress event counts attempts, like the legacy loop.
                let merged = merge_headers(&Request::new(&uri));
                attempt.discovery_resources += 1;
                attempt.emit(
                    "discovery",
                    BTreeMap::from([(
                        "resources".to_string(),
                        attempt.discovery_resources.to_string(),
                    )]),
                );
                match fetch(
                    &uri,
                    &merged,
                    Some(attempt.user),
                    None,
                    &attempt.config.fetch,
                ) {
                    Ok(outcome) if outcome.ok() => {
                        reply(
                            job,
                            JobResponse::ResourceBytes {
                                job: job_id.clone(),
                                request,
                                bytes: outcome.body,
                                final_uri: Some(outcome.final_uri),
                            },
                        )?;
                    }
                    Ok(_) => {
                        reply(
                            job,
                            JobResponse::FetchFailure {
                                job: job_id.clone(),
                                request,
                            },
                        )?;
                    }
                    Err(_) => {
                        reply(
                            job,
                            JobResponse::FetchFailure {
                                job: job_id.clone(),
                                request,
                            },
                        )?;
                    }
                }
            }
            "acquire-tile" if is_probe(effect) => {
                let Some(need) = tile_fetch(effect) else {
                    return Err(NativeError::new(
                        "native.internal",
                        "probe effect lacks tile identity",
                    ));
                };
                let read = probe_tile_bytes(
                    &need.uri,
                    &need.headers,
                    &need.processing,
                    attempt.config,
                    attempt.user,
                );
                let (available, width, height) = match read.observation {
                    ObservationResult::Available { size } => {
                        (true, u64::from(size.x), u64::from(size.y))
                    }
                    ObservationResult::Missing => (false, 0, 0),
                };
                reply(
                    job,
                    JobResponse::ProbeOutcome {
                        job: job_id.clone(),
                        tile: need.tile,
                        available,
                        width,
                        height,
                    },
                )?;
            }
            "acquire-tile" => {
                let Some(need) = tile_fetch(effect) else {
                    return Err(NativeError::new(
                        "native.internal",
                        "tile effect lacks tile identity",
                    ));
                };
                if let Some(canvas) = effect.get("canvas").filter(|v| !v.is_null()) {
                    attempt.canvas = attempt.canvas.or(Some(point(canvas)));
                }
                if !attempt.order.contains(&need.tile) {
                    attempt.order.push(need.tile.clone());
                    attempt.geoms.insert(
                        need.tile.clone(),
                        TileGeom {
                            destination: need.destination,
                            extent: need.extent,
                        },
                    );
                }
                tiles.push(need);
            }
            "request-destination" => {
                match validate_destination(&attempt.output_path, &attempt.format, attempt.overwrite)
                {
                    Ok(()) => reply(
                        job,
                        JobResponse::DestinationGranted {
                            job: job_id.clone(),
                            destination: "dst:0".to_string(),
                        },
                    )?,
                    Err(message) => {
                        attempt.destination_error = Some(message);
                        reply(
                            job,
                            JobResponse::DestinationDenied {
                                job: job_id.clone(),
                            },
                        )?;
                    }
                }
            }
            "request-decision" => {
                let reason = effect
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if reason == "partial" {
                    let keep = attempt.config.partial_policy == PartialPolicy::Keep;
                    reply(
                        job,
                        JobResponse::PartialKeep {
                            job: job_id.clone(),
                            keep,
                        },
                    )?;
                } else {
                    // Destination recovery: one retry re-validates (a
                    // concurrent writer may have gone away); a repeat denial
                    // cancels honestly instead of looping forever.
                    attempt.recovery_attempts += 1;
                    if attempt.recovery_attempts > 1 {
                        let _ = job.on_response(JobResponse::Cancel {
                            job: job_id.clone(),
                        });
                        attempt.cancel_sent = true;
                    } else {
                        let number = attempt.recovery_attempts;
                        reply(
                            job,
                            JobResponse::RetryReady {
                                job: job_id.clone(),
                                attempt: format!("att:{number}"),
                            },
                        )?;
                    }
                }
            }
            "decode-pixels" | "open-encoder" | "finalize-encoder" => {}
            "publish-output" => publish(attempt)?,
            "release-bytes" | "cancel-work" => {
                attempt.decoded.clear();
            }
            unknown => {
                return Err(NativeError::new(
                    "native.internal",
                    format!("unknown engine effect kind {unknown}"),
                ));
            }
        }
    }
    if !tiles.is_empty() {
        acquire_tiles(job, attempt, tiles)?;
    }
    Ok(())
}

fn is_probe(effect: &serde_json::Value) -> bool {
    effect
        .get("probe")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn acquire_tiles(
    job: &mut Job,
    attempt: &mut Attempt<'_>,
    tiles: Vec<TileFetch>,
) -> Result<(), NativeError> {
    let job_id = job.id().to_string();
    let config = attempt.config;
    let user = attempt.user;
    let cache = attempt
        .cache
        .as_ref()
        .map(|(dir, namespace)| (dir.as_path(), namespace.as_str()));
    // Per-tile plan for this batch: backoff sleeps run inside the worker
    // threads (concurrent, like the reference async loop). With
    // `max_retries: 0` the engine never issues a retry, so every effect
    // here is a first attempt that always fetches.
    struct Planned {
        tile: String,
        backoff: Duration,
    }
    let mut planned = Vec::with_capacity(tiles.len());
    for need in &tiles {
        let failures = attempt.tile_failures.get(&need.tile).copied().unwrap_or(0);
        let backoff = crate::pipeline::retry_wait(
            config.retry_delay,
            need.destination.x,
            need.destination.y,
            failures,
        );
        planned.push(Planned {
            tile: need.tile.clone(),
            backoff,
        });
    }
    let mut outcomes: Vec<(String, bool, Option<crate::pipeline::DecodedTile>)> =
        Vec::with_capacity(tiles.len());
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(tiles.len());
        for (need, plan) in tiles.iter().zip(planned) {
            // Stagger request starts by `min_interval` (reference per-tile
            // throttle); ZERO disables the sleep entirely.
            if !config.min_interval.is_zero() {
                if let Some(last) = attempt.throttle_last {
                    let next = last + config.min_interval;
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    }
                }
                attempt.throttle_last = Some(Instant::now());
            }
            handles.push((
                plan.tile,
                scope.spawn(move || {
                    if !plan.backoff.is_zero() {
                        std::thread::sleep(plan.backoff);
                    }
                    fetch_and_decode_cached(
                        &need.uri,
                        &need.headers,
                        &need.processing,
                        config,
                        user,
                        cache,
                    )
                }),
            ));
        }
        for (tile, handle) in handles {
            match handle.join() {
                Ok(Ok(image)) => outcomes.push((tile, true, Some(image))),
                Ok(Err(_)) | Err(_) => outcomes.push((tile, false, None)),
            }
        }
    });
    for (tile, ok, image) in outcomes {
        if job.state() != JobState::AcquiringTiles {
            // An earlier outcome in this batch already moved the job on
            // (retry-exhausted tile → partial decision): later outcomes are
            // moot, exactly as late host responses are after a transition.
            break;
        }
        if ok {
            attempt.acquired += 1;
            attempt.tile_failures.remove(&tile);
        } else {
            let failures = attempt.tile_failures.get(&tile).copied().unwrap_or(0);
            attempt
                .tile_failures
                .insert(tile.clone(), failures.saturating_add(1));
        }
        if let Some(image) = image {
            attempt.decoded.insert(tile.clone(), image);
        }
        reply(
            job,
            JobResponse::TileOutcome {
                job: job_id.clone(),
                tile,
                ok,
            },
        )?;
    }
    Ok(())
}

/// Human-readable byte counts for the canvas-limit error (exact bytes plus
/// a GiB/MiB approximation); never carries paths or credentials.
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

fn publish(attempt: &mut Attempt<'_>) -> Result<(), NativeError> {
    if attempt.config.cancel_flag.load(Ordering::SeqCst) {
        return Err(NativeError::new(
            "job.cancelled",
            "job cancelled before completion",
        ));
    }
    let declared = attempt.canvas;
    let mut width = declared.map_or(1u32, |size| size.x.max(1));
    let mut height = declared.map_or(1u32, |size| size.y.max(1));
    if declared.is_none() {
        for (tile, geom) in &attempt.geoms {
            let Some(decoded) = attempt.decoded.get(tile) else {
                continue;
            };
            width = width.max(geom.destination.x.saturating_add(decoded.image.width()));
            height = height.max(geom.destination.y.saturating_add(decoded.image.height()));
        }
    }
    // Explicit memory check before allocating: the canvas holds 4 bytes per
    // pixel plus transient encode buffers, so the required bytes (checked
    // against overflow) must fit the configured budget. The default budget
    // is 8 GiB; jobs beyond it fail with typed `output.canvas-limit` naming
    // the required memory, never with an allocation crash.
    let required = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4));
    let over_budget = match required {
        Some(bytes) => bytes > attempt.config.max_canvas_bytes,
        None => true,
    };
    if over_budget {
        let required_text = required
            .map(describe_bytes)
            .unwrap_or_else(|| "over 16 EiB".to_string());
        return Err(NativeError::new(
            "output.canvas-limit",
            format!(
                "composed image {width}x{height} needs {required_text} of canvas memory (limit {}); save a smaller level with --max-width or raise the canvas budget",
                describe_bytes(attempt.config.max_canvas_bytes),
            ),
        ));
    }
    let partial = attempt.decoded.len() != attempt.order.len();
    // First-seen output metadata in plan order, mirroring the reference
    // first-tile capture (`canvas.rs:69-76`, `png_encoder.rs:97-119`): the
    // reference winner is completion order, which is nondeterministic under
    // concurrency, so plan order is the honest deterministic rule.
    let icc_profile = attempt
        .order
        .iter()
        .filter_map(|tile| attempt.decoded.get(tile))
        .find_map(|decoded| decoded.icc_profile.as_deref());
    let exif_metadata = attempt
        .order
        .iter()
        .filter_map(|tile| attempt.decoded.get(tile))
        .find_map(|decoded| decoded.exif_metadata.as_deref());
    let mut target = image::RgbaImage::new(width, height);
    for tile in &attempt.order {
        let Some(decoded) = attempt.decoded.get(tile) else {
            // Kept-partial hole: the blank canvas shows through.
            continue;
        };
        let geom = attempt.geoms.get(tile).copied().unwrap_or(TileGeom {
            destination: Vec2d::default(),
            extent: None,
        });
        blit_onto(&mut target, geom.destination, geom.extent, &decoded.image);
    }
    let output_hash = match attempt.format {
        OutputFormat::Png => {
            let encoded = encode_png(
                &target,
                attempt.config.png_compression(),
                icc_profile,
                exif_metadata,
            )?;
            attempt.emit(
                "encoding",
                BTreeMap::from([("bytes".to_string(), encoded.len().to_string())]),
            );
            write_atomic(&attempt.output_path, &encoded).map_err(NativeError::from)?;
            format!("sha256:{}", sha256_hex(&encoded))
        }
        OutputFormat::Jpeg => {
            let encoded = encode_jpeg(&target, attempt.config.jpeg_quality(), icc_profile)?;
            attempt.emit(
                "encoding",
                BTreeMap::from([("bytes".to_string(), encoded.len().to_string())]),
            );
            write_atomic(&attempt.output_path, &encoded).map_err(NativeError::from)?;
            format!("sha256:{}", sha256_hex(&encoded))
        }
        OutputFormat::Tiff => {
            let encoded = encode_tiff(&target, attempt.config.compression, icc_profile)?;
            attempt.emit(
                "encoding",
                BTreeMap::from([("bytes".to_string(), encoded.len().to_string())]),
            );
            write_atomic(&attempt.output_path, &encoded).map_err(NativeError::from)?;
            format!("sha256:{}", sha256_hex(&encoded))
        }
        OutputFormat::Zif => {
            let encoded = encode_zif_pyramid(&target, attempt.config.compression, icc_profile)?;
            attempt.emit(
                "encoding",
                BTreeMap::from([("bytes".to_string(), encoded.len().to_string())]),
            );
            write_atomic(&attempt.output_path, &encoded).map_err(NativeError::from)?;
            format!("sha256:{}", sha256_hex(&encoded))
        }
        OutputFormat::IiifDir => {
            let id = attempt
                .output_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("image");
            let (info_json, tiles) = render_iiif_dir(&target, id, attempt.config.jpeg_quality())?;
            attempt.emit(
                "encoding",
                BTreeMap::from([
                    ("bytes".to_string(), info_json.len().to_string()),
                    ("files".to_string(), (tiles.len() + 1).to_string()),
                ]),
            );
            let preimage = write_iiif_dir(&attempt.output_path, &info_json, &tiles)
                .map_err(NativeError::from)?;
            format!("sha256:{}", sha256_hex(&preimage))
        }
    };
    attempt.published = Some(Published {
        output_hash,
        tile_count: attempt.decoded.len(),
        image_size: Vec2d {
            x: width,
            y: height,
        },
        partial,
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn levels(entries: &[(&str, u64, u64)]) -> Vec<(String, u64, u64)> {
        entries
            .iter()
            .map(|(id, width, height)| ((*id).to_string(), *width, *height))
            .collect()
    }

    fn uncapped() -> LevelSelection {
        LevelSelection {
            largest: false,
            max_width: None,
            max_height: None,
            zoom_level: None,
        }
    }

    fn capped(width: Option<u32>, height: Option<u32>) -> LevelSelection {
        LevelSelection {
            largest: false,
            max_width: width,
            max_height: height,
            zoom_level: None,
        }
    }

    #[test]
    fn largest_level_wins_without_a_cap() {
        let picked = select_level_id(&levels(&[("a", 256, 256), ("b", 512, 512)]), &uncapped());
        assert_eq!(picked.as_deref(), Some("b"));
    }

    #[test]
    fn cap_selects_the_largest_fitting_level() {
        let picked = select_level_id(
            &levels(&[("small", 128, 128), ("mid", 256, 256), ("big", 512, 512)]),
            &capped(Some(300), None),
        );
        assert_eq!(picked.as_deref(), Some("mid"));
    }

    #[test]
    fn height_cap_filters_alongside_width() {
        // Wide but short vs narrow but tall: without a height cap the tall
        // level has the largest fitting area; the height cap excludes it.
        let all = levels(&[("wide", 512, 128), ("tall", 256, 512), ("small", 128, 128)]);
        let picked = select_level_id(&all, &capped(Some(600), None));
        assert_eq!(picked.as_deref(), Some("tall"));
        let picked = select_level_id(&all, &capped(Some(600), Some(256)));
        assert_eq!(picked.as_deref(), Some("wide"));
        let picked = select_level_id(&all, &capped(None, Some(200)));
        assert_eq!(picked.as_deref(), Some("wide"));
    }

    #[test]
    fn largest_flag_ignores_size_caps() {
        let all = levels(&[("small", 128, 128), ("big", 512, 512)]);
        let selection = LevelSelection {
            largest: true,
            max_width: Some(200),
            max_height: Some(200),
            zoom_level: None,
        };
        let picked = select_level_id(&all, &selection);
        assert_eq!(picked.as_deref(), Some("big"));
    }

    #[test]
    fn zoom_level_selects_exact_index_with_last_fallback() {
        let all = levels(&[("small", 100, 100), ("mid", 200, 200), ("big", 400, 400)]);
        for (requested, expected) in [(0, "small"), (1, "mid"), (2, "big"), (10, "big")] {
            let selection = LevelSelection {
                largest: false,
                max_width: None,
                max_height: None,
                zoom_level: Some(requested),
            };
            assert_eq!(
                select_level_id(&all, &selection).as_deref(),
                Some(expected),
                "zoom_level {requested}"
            );
        }
    }

    #[test]
    fn zoom_level_wins_over_largest_and_caps() {
        let all = levels(&[("small", 128, 128), ("big", 512, 512)]);
        let selection = LevelSelection {
            largest: true,
            max_width: Some(200),
            max_height: Some(200),
            zoom_level: Some(0),
        };
        assert_eq!(select_level_id(&all, &selection).as_deref(), Some("small"));
    }

    #[test]
    fn image_index_selects_exact_entry_with_last_fallback() {
        assert_eq!(select_image_index(0, None), None);
        assert_eq!(select_image_index(3, None), Some(0));
        assert_eq!(select_image_index(3, Some(0)), Some(0));
        assert_eq!(select_image_index(3, Some(2)), Some(2));
        assert_eq!(select_image_index(3, Some(10)), Some(2));
        assert_eq!(select_image_index(1, Some(100)), Some(0));
    }

    #[test]
    fn empty_fit_falls_back_to_the_narrowest_level() {
        let picked = select_level_id(
            &levels(&[("big", 512, 512), ("small", 128, 128)]),
            &capped(Some(64), None),
        );
        assert_eq!(picked.as_deref(), Some("small"));
    }

    #[test]
    fn unknown_sizes_never_fit_but_lose_narrowest_tiebreaks() {
        // Probe-declared levels (0x0) cannot satisfy a cap, yet stay
        // selectable when nothing else fits.
        let picked = select_level_id(&levels(&[("probe", 0, 0)]), &capped(Some(300), None));
        assert_eq!(picked.as_deref(), Some("probe"));
        let picked = select_level_id(
            &levels(&[("probe", 0, 0), ("known", 128, 128)]),
            &capped(Some(64), None),
        );
        assert_eq!(picked.as_deref(), Some("known"));
    }

    #[test]
    fn failure_codes_keep_their_legacy_names() {
        assert_eq!(map_failure_code("job.discovery-failed"), "discovery.failed");
        assert_eq!(map_failure_code("job.no-images"), "discovery.no-image");
        assert_eq!(map_failure_code("job.resource-limit"), "tile.limit");
        assert_eq!(map_failure_code("job.plan-invalid"), "discovery.tile-plan");
        assert_eq!(map_failure_code("job.plan-empty"), "discovery.no-level");
        assert_eq!(
            map_failure_code("job.partial-discarded"),
            "tile.download-failed"
        );
    }
}
