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
//! * `catalog` → first-entry selection mirroring the legacy
//!   `choose_image` rule (first ready image wins; a leading deferred entry
//!   is followed with a fresh bounded job), replying `SelectedImage`.
//! * `levels` → legacy `choose_level` rule over declared sizes (largest
//!   area fitting `max_width`, else the narrowest), replying
//!   `SelectedLevel`.
//! * `request-destination` → [`validate_destination`] + overwrite policy,
//!   replying `DestinationGranted`/`DestinationDenied`.
//! * `acquire-tile{probe:true}` → [`probe_tile_bytes`], replying
//!   `ProbeOutcome` with observed geometry.
//! * `acquire-tile` → [`fetch_and_decode`] under the job's concurrency
//!   gate (one [`std::thread::scope`] pool per drained batch), replying
//!   `TileOutcome`; the job owns retry counting and partial decisions.
//! * `decode-pixels`/`open-encoder`/`finalize-encoder` → acknowledged from
//!   the tiles already decoded during acquisition (PNG encodes one-shot).
//! * `publish-output` → canvas-limit check, assemble with [`blit_onto`],
//!   [`encode_png`], atomic [`write_atomic`], real [`sha256_hex`] digest.
//! * `release-bytes`/`cancel-work` → drop decoded buffers; no output is
//!   written on the cancel path.
//! * `request-decision{partial}` → [`PartialPolicy`]: fail (discard, honest
//!   `tile.download-failed`) or keep (blank missing regions, marked
//!   partial output).
//!
//! [`fetch`]: crate::http::fetch
//! [`merge_headers`]: crate::pipeline::merge_headers
//! [`validate_destination`]: crate::output::validate_destination
//! [`probe_tile_bytes`]: crate::pipeline::probe_tile_bytes
//! [`fetch_and_decode`]: crate::pipeline::fetch_and_decode
//! [`blit_onto`]: crate::pipeline::blit_onto
//! [`encode_png`]: crate::pipeline::encode_png
//! [`write_atomic`]: crate::output::write_atomic
//! [`sha256_hex`]: crate::pipeline::sha256_hex

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use dezoomify_core::core::adaptive::ObservationResult;
use dezoomify_core::core::model::{ProcessingRecipe, Request};
use dezoomify_core::Vec2d;
use dezoomify_job::{Config as JobConfig, Job, JobResponse, State as JobState};

use crate::error::NativeError;
use crate::http::{fetch, UserHeaders};
use crate::output::{validate_destination, write_atomic, OutputFormat};
use crate::pipeline::{
    blit_onto, encode_png, fetch_and_decode, merge_headers, probe_tile_bytes, sha256_hex,
    PartialPolicy, PipelineConfig, PipelineEvent, PipelineOutcome,
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
    for _ in 0..=MAX_DEFERRED_FOLLOWS {
        match drive_job(&url, output_path, overwrite, config, user, on_event)? {
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
    let retries = config.max_retries.clamp(1, 1024);
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
pub(crate) fn select_level_id(
    levels: &[(String, u64, u64)],
    max_width: Option<u32>,
) -> Option<String> {
    const UNKNOWN: u64 = u64::MAX;
    let width_of = |width: u64| {
        if width == 0 {
            UNKNOWN
        } else {
            width
        }
    };
    let candidates: Vec<&(String, u64, u64)> = match max_width {
        Some(cap) => {
            let cap = u64::from(cap);
            let fitting: Vec<&(String, u64, u64)> = levels
                .iter()
                .filter(|(_, width, _)| *width != 0 && *width <= cap)
                .collect();
            if fitting.is_empty() {
                // No level fits: honestly take the narrowest one rather
                // than silently exceeding the cap.
                levels
                    .iter()
                    .min_by_key(|(_, width, _)| width_of(*width))
                    .into_iter()
                    .collect()
            } else {
                fitting
            }
        }
        None => levels.iter().collect(),
    };
    candidates
        .into_iter()
        .max_by_key(|(_, width, height)| u128::from(*width) * u128::from(*height))
        .map(|(id, _, _)| id.clone())
}

/// Map a terminal job failure onto the stable native code the same failure
/// had before the migration, preserving the engine message.
pub(crate) fn map_failure_code(code: &str) -> &'static str {
    match code {
        "job.discovery-failed" | "job.catalog-invalid" | "job.empty-resource" => "discovery.failed",
        "job.no-images" => "discovery.no-image",
        "job.resource-limit" => "tile.limit",
        "job.plan-invalid" | "job.probe-unsupported" => "discovery.tile-plan",
        "job.plan-empty" => "discovery.no-level",
        "job.partial-discarded" => "tile.download-failed",
        _ => "native.internal",
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
    on_event: &'a mut dyn FnMut(PipelineEvent),
    discovery_resources: usize,
    catalog: Vec<CatalogImage>,
    canvas: Option<Vec2d>,
    /// Plan-order tile ids (first-seen order matches plan order).
    order: Vec<String>,
    geoms: HashMap<String, TileGeom>,
    decoded: HashMap<String, image::RgbaImage>,
    /// Tiles acquired overall (never cleared by `release-bytes`, unlike
    /// the pixel buffers above).
    acquired: usize,
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
    config: &PipelineConfig,
    user: &UserHeaders,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<AttemptDone, NativeError> {
    let job_id = mint_job_id();
    let job_config = job_config_for(config)?;
    let mut job = Job::new(&job_id, input_url, job_config)
        .map_err(|e| NativeError::new("native.internal", format!("{}: {}", e.code, e.message)))?;
    job.start()
        .map_err(|e| NativeError::new("native.internal", format!("{}: {}", e.code, e.message)))?;
    let mut attempt = Attempt {
        config,
        user,
        output_path: PathBuf::from(output_path),
        overwrite,
        on_event,
        discovery_resources: 0,
        catalog: Vec::new(),
        canvas: None,
        order: Vec::new(),
        geoms: HashMap::new(),
        decoded: HashMap::new(),
        acquired: 0,
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
            if attempt.catalog[0].ready {
                let image = attempt.catalog[0].id.clone();
                reply(
                    &mut job,
                    JobResponse::SelectedImage {
                        job: job_id.clone(),
                        image,
                    },
                )?;
            } else {
                let uri = job.deferred_uri(&attempt.catalog[0].id).ok_or_else(|| {
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
            let level = select_level_id(&attempt.catalog[0].levels, attempt.config.max_width)
                .ok_or_else(|| {
                    NativeError::new("discovery.no-level", "image has no zoom levels")
                })?;
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
                    .catalog
                    .first()
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
                match validate_destination(
                    &attempt.output_path,
                    &OutputFormat::Png,
                    attempt.overwrite,
                ) {
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
    let mut outcomes: Vec<(String, bool, Option<image::RgbaImage>)> =
        Vec::with_capacity(tiles.len());
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(tiles.len());
        for need in &tiles {
            handles.push((
                need.tile.clone(),
                scope.spawn(move || {
                    fetch_and_decode(&need.uri, &need.headers, &need.processing, config, user)
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
            let Some(image) = attempt.decoded.get(tile) else {
                continue;
            };
            width = width.max(geom.destination.x.saturating_add(image.width()));
            height = height.max(geom.destination.y.saturating_add(image.height()));
        }
    }
    if u64::from(width) * u64::from(height) * 4 > attempt.config.max_canvas_bytes {
        return Err(NativeError::new(
            "output.canvas-limit",
            "composed image exceeds the canvas size limit",
        ));
    }
    let partial = attempt.decoded.len() != attempt.order.len();
    let mut target = image::RgbaImage::new(width, height);
    for tile in &attempt.order {
        let Some(image) = attempt.decoded.get(tile) else {
            // Kept-partial hole: the blank canvas shows through.
            continue;
        };
        let geom = attempt.geoms.get(tile).copied().unwrap_or(TileGeom {
            destination: Vec2d::default(),
            extent: None,
        });
        blit_onto(&mut target, geom.destination, geom.extent, image);
    }
    let encoded = encode_png(&target)?;
    attempt.emit(
        "encoding",
        BTreeMap::from([("bytes".to_string(), encoded.len().to_string())]),
    );
    write_atomic(&attempt.output_path, &encoded).map_err(NativeError::from)?;
    attempt.published = Some(Published {
        output_hash: format!("sha256:{}", sha256_hex(&encoded)),
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

    #[test]
    fn largest_level_wins_without_a_cap() {
        let picked = select_level_id(&levels(&[("a", 256, 256), ("b", 512, 512)]), None);
        assert_eq!(picked.as_deref(), Some("b"));
    }

    #[test]
    fn cap_selects_the_largest_fitting_level() {
        let picked = select_level_id(
            &levels(&[("small", 128, 128), ("mid", 256, 256), ("big", 512, 512)]),
            Some(300),
        );
        assert_eq!(picked.as_deref(), Some("mid"));
    }

    #[test]
    fn empty_fit_falls_back_to_the_narrowest_level() {
        let picked = select_level_id(&levels(&[("big", 512, 512), ("small", 128, 128)]), Some(64));
        assert_eq!(picked.as_deref(), Some("small"));
    }

    #[test]
    fn unknown_sizes_never_fit_but_lose_narrowest_tiebreaks() {
        // Probe-declared levels (0x0) cannot satisfy a cap, yet stay
        // selectable when nothing else fits.
        let picked = select_level_id(&levels(&[("probe", 0, 0)]), Some(300));
        assert_eq!(picked.as_deref(), Some("probe"));
        let picked = select_level_id(&levels(&[("probe", 0, 0), ("known", 128, 128)]), Some(64));
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
