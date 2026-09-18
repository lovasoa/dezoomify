//! Completion-driven native execution: one engine, bounded async tasks.
//!
//! This module drives one [`dezoomify_job::Job`] to its terminal without
//! batch scopes: every engine effect spawns exactly one bounded task whose
//! single completion is fed back to the engine. There is no competing
//! retry loop, no scheduler, and no per-batch thread pool:
//!
//! * The engine's own concurrency budget bounds outstanding work: effects
//!   are issued only for free engine slots, so at most `max_concurrent`
//!   fetches plus their chained decodes are ever in flight. One engine
//!   slot covers the full acquire/process/decode/place path -- tasks hold
//!   no other queue.
//! * Metadata and tile fetches run as async tasks on the job-scoped
//!   transport (one reusable reqwest client, connection reuse across
//!   tiles). Pixel decode runs on bounded `spawn_blocking` workers inside
//!   the same task. Retry timers run as abortable async sleeps with the
//!   engine-computed delay.
//! * Completions arrive in completion order over one channel; the pump
//!   feeds each to the engine immediately, so one slow tile never blocks
//!   unrelated tiles (their completions paint as they land).
//! * Cancellation is tracked, not faked: the flag stops new spawns, the
//!   commit point refuses publication once set, in-flight async tasks are
//!   aborted (dropping their requests), and the pump awaits every tracked
//!   handle before cleanup, so cancel reports only after quiescence.
//!   Aborting a task that is inside a blocking decode detaches that
//!   sub-100ms tail (cancelling a future cannot stop blocking work); its
//!   result is dropped and nothing publishes.
//! * Output is owned end to end by [`crate::sink::Sink`]: streaming paint,
//!   bounded retention/spool, one commit point, job-owned-temp-only
//!   cleanup. This module never writes output itself.
//!
//! Correlation uses the engine's own tile/request ordinals with no
//! remapping: late, duplicate, and out-of-order completions die inside the
//! engine exactly like late host responses. (The canonical
//! `EngineJob` facade is the planned driver surface, but its effects are
//! lossy for native execution today -- no tile placement, processing
//! recipe, headers, or canvas, and no catalog counts for headless
//! selection fallback. This loop is shaped to map onto it 1:1 once those
//! cross the facade: acquire→complete/provide_metadata, timer→complete,
//! finalize→complete. See R-B1/R-B2 in the workstream report.)

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use dezoomify_core::core::discovery::{FetchCause, FetchCode, TransportKind};
use dezoomify_core::core::model::{ProcessingRecipe, Request};
use dezoomify_core::Vec2d;
use dezoomify_job::{
    Config as JobConfig, Job, JobCommand, JobEffect, JobEvent, JobMessageBody, RecoveryChoice,
    State as JobState, TileFailure,
};
use dezoomify_protocol::dto::{CatalogEntryDto, ProbeOutcome};

use crate::error::NativeError;
use crate::http::{FetchOutcome, UserHeaders};
use crate::output::OutputFormat;
use crate::pipeline::{
    effective_cache_dir, load_image_with_metadata, merge_headers, DecodedTile, ExecCommand,
    PartialDecision, PartialGate, PartialPolicy, PartialRequest, PipelineConfig, PipelineEvent,
};
use crate::sink::{Published, Sink};
use crate::transport::NativeTransport;

/// Deferred-resolution bound: the initial discovery plus this many deferred
/// follows, matching the legacy loop limit.
const MAX_DEFERRED_FOLLOWS: u32 = 10;

/// Honest execution accounting, reported with every terminal result.
#[derive(Clone, Debug, Default)]
pub struct Instrumentation {
    /// Tile/probe/metadata effects attempted.
    pub attempts: u64,
    /// Tiles acquired (decoded and placed).
    pub acquired: u64,
    /// Failures classified transient by the engine.
    pub failed_transient: u64,
    /// Failures classified permanent by the engine.
    pub failed_permanent: u64,
    /// Explicit retry timers the engine scheduled.
    pub retries_scheduled: u64,
    /// Total timer wait served (ms).
    pub timer_wait_ms: u64,
    /// Response body bytes fetched (metadata plus tiles).
    pub bytes_fetched: u64,
    /// Peak concurrent in-flight tasks.
    pub peak_inflight: usize,
    /// Peak retained (overlapping, unpainted) tile bytes in the sink.
    pub peak_retained_bytes: u64,
    /// Canvas bytes (4 bytes per pixel, zero until allocated).
    pub canvas_bytes: u64,
    /// Transient encoded bytes for the committed output.
    pub encoded_bytes: u64,
    /// Peak spooled (on-disk) tile bytes.
    pub peak_spool_bytes: u64,
    /// Late paints below the painted frontier (same-tile retries).
    pub late_repaints: u64,
    /// Accounted peak: canvas plus peak retained plus encoded. This is the
    /// deterministic peak model for the shipped pipeline: canvas,
    /// outstanding decode buffers, and codec buffers.
    pub accounted_peak_bytes: u64,
}

/// Terminal result of one job attempt: finished output or a deferred URI to
/// follow with a fresh bounded job.
pub enum AttemptDone {
    Done(ExecResult),
    Deferred(String),
}

/// Successful execution: the honest published record plus accounting.
pub struct ExecResult {
    pub output_path: PathBuf,
    pub tile_count: usize,
    pub image_size: Vec2d,
    pub format: String,
    pub partial: bool,
    pub missing: Vec<String>,
    pub instrumentation: Instrumentation,
}

/// Output destination for one attempt.
pub struct OutputSpec {
    pub output_path: PathBuf,
    pub overwrite: bool,
    pub format: OutputFormat,
    pub auto_output_dir: Option<PathBuf>,
}

/// Drive one input URL end to end (with bounded deferred follows).
pub fn execute(
    input_url: &str,
    output: &OutputSpec,
    config: &PipelineConfig,
    user: &UserHeaders,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<ExecResult, NativeError> {
    let mut url = input_url.to_string();
    for _ in 0..=MAX_DEFERRED_FOLLOWS {
        match execute_attempt(&url, output, config, user, on_event)? {
            AttemptDone::Done(result) => return Ok(result),
            AttemptDone::Deferred(next) => url = next,
        }
    }
    Err(NativeError::new(
        "discovery.deferred",
        "image metadata stayed deferred after the resolution limit",
    ))
}

/// Completions from spawned tasks back to the pump. Each settles exactly
/// one outstanding engine effect; late ones die inside the engine.
enum Completion {
    Metadata {
        request: u32,
        result: Result<(Vec<u8>, String), FetchCause>,
        bytes: usize,
    },
    Probe {
        ordinal: u32,
        outcome: ProbeOutcome,
        decoded: Option<ProbeDecoded>,
        bytes: usize,
    },
    Tile {
        ordinal: u32,
        id: String,
        destination: Vec2d,
        extent: Option<Vec2d>,
        canvas: Option<Vec2d>,
        result: Result<DecodedTile, TileAttemptFailure>,
        bytes: usize,
    },
    Timer {
        tile: u32,
        attempt: u32,
        waited_ms: u64,
    },
}

struct ProbeDecoded {
    tile: DecodedTile,
    destination: Vec2d,
    extent: Option<Vec2d>,
    canvas: Option<Vec2d>,
}

pub(crate) struct TileAttemptFailure {
    pub error: NativeError,
    pub http: Option<u16>,
    pub retry_after_ms: Option<u64>,
}

impl TileAttemptFailure {
    fn transport(error: NativeError) -> Self {
        Self {
            error,
            http: None,
            retry_after_ms: None,
        }
    }
}

struct Attempt<'a> {
    config: &'a PipelineConfig,
    user: &'a UserHeaders,
    transport: Arc<NativeTransport>,
    output_path: PathBuf,
    overwrite: bool,
    format: OutputFormat,
    auto_output_dir: Option<PathBuf>,
    cache: Option<(PathBuf, String)>,
    on_event: &'a mut dyn FnMut(PipelineEvent),
    catalog: Vec<CatalogImage>,
    selected_image: Option<usize>,
    /// Plan-order tile ids (first-seen order matches plan order).
    order: Vec<String>,
    /// Tile ids holding pixels somewhere (painted, retained, or spooled).
    settled: HashSet<String>,
    acquired: usize,
    throttle_last: Option<Instant>,
    failure: Option<(String, String)>,
    published: Option<Published>,
    cancel_sent: bool,
    pause_demonstrated: bool,
    partial_gate: Option<Arc<PartialGate>>,
    pending_missing: Vec<String>,
    command_rx: Option<Arc<Mutex<mpsc::Receiver<ExecCommand>>>>,
    instrumentation: Instrumentation,
    in_flight: usize,
}

impl<'a> Attempt<'a> {
    fn emit(&mut self, kind: &str, detail: BTreeMap<String, String>) {
        (self.on_event)(PipelineEvent {
            kind: kind.to_string(),
            detail,
        });
    }

    fn note_flight(&mut self) {
        self.in_flight += 1;
        self.instrumentation.peak_inflight = self.instrumentation.peak_inflight.max(self.in_flight);
    }

    fn settle_flight(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
    }
}

fn execute_attempt(
    input_url: &str,
    output: &OutputSpec,
    config: &PipelineConfig,
    user: &UserHeaders,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<AttemptDone, NativeError> {
    let job_config = job_config_for(config)?;
    let mut job = Job::new(input_url, job_config).map_err(map_setup_error)?;
    job.set_format(config.format.clone());
    job.start().map_err(map_setup_error)?;
    let transport = Arc::new(NativeTransport::new(&config.fetch)?);
    let (completion_tx, completion_rx) = mpsc::channel::<Completion>();
    let mut handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    let mut attempt = Attempt {
        config,
        user,
        transport,
        output_path: output.output_path.clone(),
        overwrite: output.overwrite,
        format: output.format,
        auto_output_dir: output.auto_output_dir.clone(),
        cache: Some((
            effective_cache_dir(config),
            crate::cache::job_namespace(input_url),
        )),
        on_event,
        catalog: Vec::new(),
        selected_image: None,
        order: Vec::new(),
        settled: HashSet::new(),
        acquired: 0,
        throttle_last: None,
        failure: None,
        published: None,
        cancel_sent: false,
        pause_demonstrated: false,
        partial_gate: config.partial_gate.clone(),
        pending_missing: Vec::new(),
        command_rx: config.exec_command_rx.clone(),
        instrumentation: Instrumentation::default(),
        in_flight: 0,
    };
    let mut sink = Sink::new(config, output.format);

    loop {
        drain_commands(&mut job, &mut attempt);
        if attempt.config.cancel_flag.load(Ordering::SeqCst)
            && !job.is_terminal()
            && !attempt.cancel_sent
        {
            let _ = job.on_command(JobCommand::Cancel);
            attempt.cancel_sent = true;
        }
        let mut effects = Vec::new();
        for message in job.drain_messages() {
            match message.body {
                JobMessageBody::Event(event) => handle_event(&mut attempt, event)?,
                JobMessageBody::Effect(effect) => effects.push(effect),
            }
        }
        if job.state() == JobState::AwaitingImageSelection && !attempt.catalog.is_empty() {
            let selected =
                select_image_index(attempt.catalog.len(), attempt.config.image_index).unwrap_or(0);
            if attempt.catalog[selected].ready {
                attempt.selected_image = Some(selected);
                reply(
                    &mut job,
                    JobCommand::SelectImage {
                        image: u32::try_from(selected).map_err(|_| {
                            NativeError::new("native.internal", "image position overflow")
                        })?,
                    },
                )?;
            } else {
                abort_and_join(&attempt.transport, &mut handles);
                sink.rollback();
                let uri = job
                    .deferred_uri(u32::try_from(selected).map_err(|_| {
                        NativeError::new("native.internal", "image position overflow")
                    })?)
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
            let level = select_level_index(&attempt.catalog[selected].levels, &selection)
                .ok_or_else(|| {
                    NativeError::new("discovery.no-level", "image has no zoom levels")
                })?;
            reply(&mut job, JobCommand::SelectLevel { level })?;
            continue;
        }
        if effects.is_empty() {
            if attempt.in_flight > 0 {
                // Work outstanding: block for the next completion, feed it,
                // and re-drive. This is the only blocking wait in the pump.
                let completion = completion_rx.recv().map_err(|_| {
                    NativeError::new(
                        "native.internal",
                        "completion channel closed with work outstanding",
                    )
                })?;
                feed_completion(&mut job, &mut attempt, &mut sink, completion)?;
                continue;
            }
            if job.is_terminal() {
                break;
            }
            abort_and_join(&attempt.transport, &mut handles);
            sink.rollback();
            return Err(NativeError::new(
                "native.internal",
                "job stalled with no effects",
            ));
        }
        execute_effects(
            &mut job,
            &mut attempt,
            &mut sink,
            &completion_tx,
            &mut handles,
            effects,
        )?;
        // Opportunistic completions: feed whatever already landed before
        // the next drain so pipelining never waits a full round trip.
        while let Ok(completion) = completion_rx.try_recv() {
            feed_completion(&mut job, &mut attempt, &mut sink, completion)?;
        }
        // Pause v1 demonstration (`--pause-after N`): same overlay proof as
        // the legacy driver, now against the completion-driven pump.
        if let Some(threshold) = attempt.config.pause_after {
            if !attempt.pause_demonstrated
                && attempt.acquired >= threshold
                && job.state() == JobState::AcquiringTiles
                && !job.is_terminal()
                && !job.is_paused()
            {
                attempt.pause_demonstrated = true;
                job.on_command(JobCommand::Pause).map_err(|e| {
                    NativeError::new(
                        "native.internal",
                        format!("pause rejected ({}): {}", e.code, e.message),
                    )
                })?;
                debug_assert!(job.is_paused());
                attempt.emit(
                    "paused",
                    BTreeMap::from([("acquired".to_string(), attempt.acquired.to_string())]),
                );
                job.on_command(JobCommand::Resume).map_err(|e| {
                    NativeError::new(
                        "native.internal",
                        format!("resume rejected ({}): {}", e.code, e.message),
                    )
                })?;
                debug_assert!(!job.is_paused());
                attempt.emit(
                    "resumed",
                    BTreeMap::from([("acquired".to_string(), attempt.acquired.to_string())]),
                );
            }
        }
    }

    // Terminal: stop new work, await every tracked handle (aborted async
    // tasks resolve promptly; detached blocking decode tails drop their
    // results), then map the terminal honestly.
    abort_and_join(&attempt.transport, &mut handles);
    // Any completion that landed after the terminal is dropped, never fed.
    let terminal = match job.terminal_kind() {
        Some("completed" | "partial-completed") => {
            let partial = job.terminal_kind() == Some("partial-completed");
            match attempt.published.take() {
                Some(published) => {
                    debug_assert_eq!(published.partial, partial);
                    Terminal::Output(published)
                }
                None => {
                    sink.rollback();
                    return Err(NativeError::new(
                        "native.internal",
                        "job completed without output",
                    ));
                }
            }
        }
        Some("cancelled") => {
            sink.rollback();
            Terminal::Error(NativeError::new(
                "job.cancelled",
                "job cancelled before completion",
            ))
        }
        Some("failed") => {
            sink.rollback();
            Terminal::Error(failure_error(&attempt))
        }
        _ => {
            sink.rollback();
            return Err(NativeError::new(
                "native.internal",
                "job ended without a terminal state",
            ));
        }
    };
    finish_sink_stats(&mut attempt, &sink);
    match terminal {
        Terminal::Output(published) => {
            let format = attempt
                .selected_image
                .and_then(|index| attempt.catalog.get(index))
                .or_else(|| attempt.catalog.first())
                .map(|image| image.format.clone())
                .unwrap_or_default();
            Ok(AttemptDone::Done(ExecResult {
                output_path: published.output_path,
                tile_count: published.tile_count,
                image_size: published.image_size,
                format,
                partial: published.partial,
                missing: published.missing,
                instrumentation: attempt.instrumentation,
            }))
        }
        Terminal::Error(error) => Err(error),
    }
}

enum Terminal {
    Output(Published),
    Error(NativeError),
}

/// Abort every tracked task (in-flight requests drop; detached blocking
/// decode tails finish unseen with dropped results) and await the handles
/// so cleanup owns quiescence, never a still-running task.
fn abort_and_join(transport: &NativeTransport, handles: &mut Vec<tokio::task::JoinHandle<()>>) {
    for handle in handles.iter() {
        handle.abort();
    }
    for handle in handles.drain(..) {
        let _ = transport.block_on(handle);
    }
}

/// Apply host-side external commands (Pause/Resume; Cancel rides the flag).
fn drain_commands(job: &mut Job, attempt: &mut Attempt<'_>) {
    let rx = match attempt.command_rx.clone() {
        Some(rx) => rx,
        None => return,
    };
    let commands: Vec<ExecCommand> = match rx.lock() {
        Ok(guard) => guard.try_iter().collect(),
        Err(poisoned) => poisoned.into_inner().try_iter().collect(),
    };
    for command in commands {
        if job.is_terminal() {
            break;
        }
        match command {
            ExecCommand::Pause => {
                let _ = job.on_command(JobCommand::Pause);
            }
            ExecCommand::Resume => {
                let _ = job.on_command(JobCommand::Resume);
            }
        }
    }
}

/// Fold sink accounting into the job instrumentation and derive the
/// accounted peak (canvas plus peak retained plus encoded).
fn finish_sink_stats(attempt: &mut Attempt<'_>, sink: &Sink) {
    let stats = sink.stats();
    attempt.instrumentation.peak_retained_bytes = stats.peak_retained_bytes;
    attempt.instrumentation.canvas_bytes = stats.canvas_bytes;
    attempt.instrumentation.encoded_bytes = stats.encoded_bytes;
    attempt.instrumentation.peak_spool_bytes = stats.peak_spool_bytes;
    attempt.instrumentation.late_repaints = stats.late_repaints;
    attempt.instrumentation.accounted_peak_bytes = stats
        .canvas_bytes
        .saturating_add(stats.peak_retained_bytes)
        .saturating_add(stats.encoded_bytes);
}

fn failure_error(attempt: &Attempt<'_>) -> NativeError {
    let (code, message) = attempt.failure.clone().unwrap_or_else(|| {
        (
            "native.internal".to_string(),
            "job failed without diagnostics".to_string(),
        )
    });
    if code == "job.partial-discarded" {
        let unacquired = attempt.order.len().saturating_sub(attempt.acquired);
        if unacquired > 0 {
            return NativeError::new(
                "tile.download-failed",
                format!(
                    "{} tile(s) still failing after {} retries",
                    unacquired, attempt.config.max_retries,
                ),
            );
        }
    }
    let native_code = if code.starts_with("job.") {
        map_failure_code(&code).to_string()
    } else {
        code
    };
    NativeError::new(native_code, message)
}

fn reply(job: &mut Job, response: JobCommand) -> Result<(), NativeError> {
    job.on_command(response).map_err(|e| {
        NativeError::new(
            "native.internal",
            format!("effect reply rejected ({}): {}", e.code, e.message),
        )
    })?;
    Ok(())
}

fn handle_event(attempt: &mut Attempt<'_>, event: JobEvent) -> Result<(), NativeError> {
    match event {
        JobEvent::Catalog { catalog } => {
            attempt.catalog = catalog
                .entries
                .into_iter()
                .map(|entry| match entry {
                    CatalogEntryDto::Image(image) => CatalogImage {
                        ready: true,
                        format: image.format,
                        title: image.title,
                        levels: image
                            .levels
                            .into_iter()
                            .map(|level| (level.width, level.height))
                            .collect(),
                    },
                    CatalogEntryDto::ImageRequest(request) => CatalogImage {
                        ready: false,
                        format: String::new(),
                        title: request.title,
                        levels: Vec::new(),
                    },
                })
                .collect();
        }
        JobEvent::Progress { acquired, total } => {
            attempt.emit(
                "downloading",
                BTreeMap::from([
                    ("acquired".to_string(), acquired.to_string()),
                    ("total".to_string(), total.to_string()),
                ]),
            );
        }
        JobEvent::Failed { code, message } => attempt.failure = Some((code, message)),
        JobEvent::MissingWork { failed } => {
            let missing: Vec<String> = failed.into_iter().map(|tile| tile.to_string()).collect();
            if !missing.is_empty() {
                attempt.pending_missing = missing;
            }
        }
        _ => {}
    }
    Ok(())
}

struct TileFetch {
    ordinal: u32,
    tile: String,
    uri: String,
    headers: BTreeMap<String, String>,
    processing: ProcessingRecipe,
    destination: Vec2d,
    extent: Option<Vec2d>,
}

fn execute_effects(
    job: &mut Job,
    attempt: &mut Attempt<'_>,
    sink: &mut Sink,
    completion_tx: &mpsc::Sender<Completion>,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
    effects: Vec<JobEffect>,
) -> Result<(), NativeError> {
    for effect in effects {
        match effect {
            JobEffect::AcquireResource { request, uri, .. } => {
                if job.state() != JobState::Discovering {
                    continue;
                }
                let merged = merge_headers(&Request::new(&uri));
                attempt.instrumentation.attempts += 1;
                attempt.emit(
                    "discovery",
                    BTreeMap::from([(
                        "resources".to_string(),
                        attempt.instrumentation.attempts.to_string(),
                    )]),
                );
                spawn_metadata(attempt, completion_tx, handles, request, uri, merged);
            }
            JobEffect::AcquireTile {
                tile,
                uri,
                headers,
                processing,
                destination,
                expected_size,
                canvas,
                probe,
                probe_output,
            } => {
                let headers = headers
                    .into_iter()
                    .map(|(name, value)| (name.to_ascii_lowercase(), value))
                    .collect::<BTreeMap<_, _>>();
                if probe {
                    attempt.instrumentation.attempts += 1;
                    spawn_probe(
                        attempt,
                        completion_tx,
                        handles,
                        tile,
                        uri,
                        headers,
                        processing,
                        destination,
                        expected_size,
                        canvas,
                        probe_output,
                    );
                    continue;
                }
                sink.note_declared(canvas);
                let id = tile.to_string();
                if !attempt.order.contains(&id) {
                    attempt.order.push(id.clone());
                }
                // Stagger request starts by `min_interval` (per-tile
                // throttle); ZERO disables the sleep entirely.
                if !attempt.config.min_interval.is_zero() {
                    if let Some(last) = attempt.throttle_last {
                        let next = last + attempt.config.min_interval;
                        let now = Instant::now();
                        if next > now {
                            std::thread::sleep(next - now);
                        }
                    }
                    attempt.throttle_last = Some(Instant::now());
                }
                attempt.instrumentation.attempts += 1;
                spawn_tile(
                    attempt,
                    completion_tx,
                    handles,
                    TileFetch {
                        ordinal: tile,
                        tile: id,
                        uri,
                        headers,
                        processing,
                        destination,
                        extent: expected_size,
                    },
                );
            }
            JobEffect::WaitForRetry {
                tile,
                attempt: retry_attempt,
                delay_ms,
            } => {
                attempt.instrumentation.retries_scheduled += 1;
                attempt.instrumentation.timer_wait_ms += delay_ms;
                spawn_timer(
                    attempt,
                    completion_tx,
                    handles,
                    tile,
                    retry_attempt,
                    delay_ms,
                );
            }
            JobEffect::FinalizeOutput { .. } => {
                // The engine awaits finalization only after every free slot
                // settled; defensively drain any straggler first so the
                // commit below observes the full canvas.
                finalize_output(job, attempt, sink)?;
            }
            JobEffect::RequestDecision { generation } => {
                let Some(decision) = await_partial_choice(attempt, generation) else {
                    if let Some(gate) = attempt.partial_gate.clone() {
                        gate.clear_pending();
                    }
                    let _ = job.on_command(JobCommand::Cancel);
                    attempt.cancel_sent = true;
                    continue;
                };
                match decision {
                    PartialDecision::Retry => {
                        attempt.pending_missing.clear();
                        if let Some(gate) = attempt.partial_gate.clone() {
                            gate.clear_pending();
                        }
                        reply(
                            job,
                            JobCommand::RecoveryChoice {
                                generation,
                                choice: RecoveryChoice::Retry,
                            },
                        )?;
                    }
                    PartialDecision::Keep => {
                        if let Some(gate) = attempt.partial_gate.clone() {
                            gate.clear_pending();
                        }
                        reply(
                            job,
                            JobCommand::RecoveryChoice {
                                generation,
                                choice: RecoveryChoice::Keep,
                            },
                        )?;
                    }
                    PartialDecision::Discard => {
                        if let Some(gate) = attempt.partial_gate.clone() {
                            gate.clear_pending();
                        }
                        reply(
                            job,
                            JobCommand::RecoveryChoice {
                                generation,
                                choice: RecoveryChoice::Discard,
                            },
                        )?;
                    }
                }
            }
            JobEffect::CancelWork => sink.release(),
        }
    }
    Ok(())
}

/// Spawn one metadata fetch task. Single attempt, bounded by the engine
/// slot; the completion carries bytes or the typed cause.
fn spawn_metadata(
    attempt: &mut Attempt<'_>,
    completion_tx: &mpsc::Sender<Completion>,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
    request: u32,
    uri: String,
    merged: BTreeMap<String, String>,
) {
    let transport = Arc::clone(&attempt.transport);
    let task_transport = Arc::clone(&transport);
    let user = attempt.user.clone();
    let limits = attempt.config.fetch.clone();
    let tx = completion_tx.clone();
    let cancel = Arc::clone(&attempt.config.cancel_flag);
    attempt.note_flight();
    handles.push(transport.spawn(async move {
        // A cancelled wait still delivers: the pump settles every tracked
        // flight and drops the completion (cancel guard in
        // `feed_completion`), so a silent return can never wedge the pump
        // in its blocking wait with work outstanding.
        let result = if cancel.load(Ordering::SeqCst) {
            Err(FetchCause::new(
                FetchCode::from_string("NATIVE_CANCELLED"),
                TransportKind::Native,
            ))
        } else {
            match task_transport
                .fetch_async(&uri, &merged, Some(&user), None, &limits)
                .await
            {
                Ok(outcome) if outcome.ok() => Ok((outcome.body, outcome.final_uri)),
                Ok(outcome) => Err(fetch_failure_cause(&outcome)),
                Err(error) => Err(transport_failure_cause(&error)),
            }
        };
        let bytes = match &result {
            Ok((body, _)) => body.len(),
            Err(_) => 0,
        };
        let _ = tx.send(Completion::Metadata {
            request,
            result,
            bytes,
        });
    }));
}

/// Spawn one probe task: fetch plus bounded decode for geometry only.
/// Decoded bytes are kept only for `probe_output` tiles the plan reuses.
#[allow(clippy::too_many_arguments)]
fn spawn_probe(
    attempt: &mut Attempt<'_>,
    completion_tx: &mpsc::Sender<Completion>,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
    ordinal: u32,
    uri: String,
    headers: BTreeMap<String, String>,
    processing: ProcessingRecipe,
    destination: Vec2d,
    extent: Option<Vec2d>,
    canvas: Option<Vec2d>,
    probe_output: bool,
) {
    let transport = Arc::clone(&attempt.transport);
    let task_transport = Arc::clone(&transport);
    let user = attempt.user.clone();
    let limits = attempt.config.fetch.clone();
    let tx = completion_tx.clone();
    attempt.note_flight();
    handles.push(transport.spawn(async move {
        let mut request = Request::new(&uri);
        request.headers = headers;
        let merged = merge_headers(&request);
        let fetched = task_transport
            .fetch_async(&uri, &merged, Some(&user), None, &limits)
            .await;
        let bytes = fetched.as_ref().map_or(0, |o| o.body.len());
        let read = match fetched {
            Ok(outcome) if outcome.ok() && !outcome.body.is_empty() => {
                let decoded = tokio::task::spawn_blocking(move || {
                    processing
                        .apply(outcome.body)
                        .ok()
                        .and_then(|bytes| load_image_with_metadata(&bytes).ok())
                })
                .await
                .ok()
                .flatten();
                match decoded {
                    Some(loaded) => {
                        let size = Vec2d {
                            x: loaded.image.width(),
                            y: loaded.image.height(),
                        };
                        let decoded = (size.x > 0 && size.y > 0).then(|| ProbeDecoded {
                            tile: DecodedTile {
                                image: loaded.image.to_rgba8(),
                                icc_profile: loaded.icc_profile,
                                exif_metadata: loaded.exif_metadata,
                            },
                            destination,
                            extent,
                            canvas,
                        });
                        let outcome = match decoded.as_ref() {
                            Some(_) => match (
                                std::num::NonZeroU64::new(u64::from(size.x)),
                                std::num::NonZeroU64::new(u64::from(size.y)),
                            ) {
                                (Some(width), Some(height)) => {
                                    ProbeOutcome::Available { width, height }
                                }
                                _ => ProbeOutcome::Missing,
                            },
                            None => ProbeOutcome::Missing,
                        };
                        (outcome, if probe_output { decoded } else { None })
                    }
                    None => (ProbeOutcome::Missing, None),
                }
            }
            _ => (ProbeOutcome::Missing, None),
        };
        let _ = tx.send(Completion::Probe {
            ordinal,
            outcome: read.0,
            decoded: read.1,
            bytes,
        });
    }));
}

/// Spawn one tile task covering the full engine slot: fetch, bounded
/// decode, cache store, and completion delivery. Placement into the sink
/// happens on the pump thread when the completion lands.
fn spawn_tile(
    attempt: &mut Attempt<'_>,
    completion_tx: &mpsc::Sender<Completion>,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
    need: TileFetch,
) {
    let transport = Arc::clone(&attempt.transport);
    let task_transport = Arc::clone(&transport);
    let user = attempt.user.clone();
    let config_fetch = attempt.config.fetch.clone();
    let cache = attempt.cache.clone();
    let tx = completion_tx.clone();
    attempt.note_flight();
    handles.push(transport.spawn(async move {
        let result = fetch_and_decode(&need, &task_transport, &user, &config_fetch, &cache).await;
        let bytes = result.as_ref().map(|ok| ok.1).unwrap_or(0);
        let _ = tx.send(Completion::Tile {
            ordinal: need.ordinal,
            id: need.tile,
            destination: need.destination,
            extent: need.extent,
            canvas: None,
            result: result.map(|ok| ok.0),
            bytes,
        });
    }));
}

/// Fetch plus bounded decode for one tile, with resume-cache support.
/// Returns the decoded tile and the fetched body length for accounting.
/// A cached body that no longer decodes is corrupt (or from an older
/// encoder): it is dropped and the tile falls through to a fresh fetch, so
/// one bad entry can never poison the tile or the retry budget.
async fn fetch_and_decode(
    need: &TileFetch,
    transport: &NativeTransport,
    user: &UserHeaders,
    fetch_limits: &crate::http::FetchLimits,
    cache: &Option<(PathBuf, String)>,
) -> Result<(DecodedTile, usize), TileAttemptFailure> {
    if let Some((dir, namespace)) = cache {
        if let Some(bytes) = crate::cache::load(dir, namespace, &need.uri) {
            let bytes_len = bytes.len();
            let decoded =
                tokio::task::spawn_blocking(move || load_image_with_metadata(&bytes)).await;
            match decoded {
                Ok(Ok(loaded)) => {
                    return Ok((
                        DecodedTile {
                            image: loaded.image.to_rgba8(),
                            icc_profile: loaded.icc_profile,
                            exif_metadata: loaded.exif_metadata,
                        },
                        bytes_len,
                    ));
                }
                // Corrupt entry: best-effort remove so retries and later
                // runs refetch instead of re-reading bad bytes, then fall
                // through to the fresh fetch below.
                _ => {
                    let _ = std::fs::remove_file(
                        dir.join(namespace).join(crate::cache::cache_key(&need.uri)),
                    );
                }
            }
        }
    }
    let mut request = Request::new(&need.uri);
    request.headers = need.headers.clone();
    let merged = merge_headers(&request);
    let outcome = transport
        .fetch_async(&need.uri, &merged, Some(user), None, fetch_limits)
        .await
        .map_err(TileAttemptFailure::transport)?;
    if !outcome.ok() {
        return Err(TileAttemptFailure {
            error: NativeError::new("tile.http-error", describe_http_failure(&outcome)),
            http: Some(outcome.status),
            retry_after_ms: outcome.retry_after_ms,
        });
    }
    let body_len = outcome.body.len();
    let processing = need.processing;
    let cache_store = cache.clone();
    let uri = need.uri.clone();
    let decoded = tokio::task::spawn_blocking(move || {
        let bytes = processing.apply(outcome.body).map_err(NativeError::from)?;
        if let Some((dir, namespace)) = cache_store.as_ref() {
            let _ = crate::cache::store(dir, namespace, &uri, &bytes);
        }
        load_image_with_metadata(&bytes)
            .map_err(|e| NativeError::new("tile.decode-failed", format!("tile decode failed: {e}")))
    })
    .await
    .map_err(|_| {
        TileAttemptFailure::transport(NativeError::new(
            "native.internal",
            "tile decode task failed",
        ))
    })?
    .map_err(TileAttemptFailure::transport)?;
    Ok((
        DecodedTile {
            image: decoded.image.to_rgba8(),
            icc_profile: decoded.icc_profile,
            exif_metadata: decoded.exif_metadata,
        },
        body_len,
    ))
}

/// Spawn one abortable retry-timer task with the engine-computed delay.
/// A cancelled wait delivers nothing; the pump's loop-top Cancel owns the
/// transition and the engine ignores stale completions.
fn spawn_timer(
    attempt: &mut Attempt<'_>,
    completion_tx: &mpsc::Sender<Completion>,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
    tile: u32,
    retry_attempt: u32,
    delay_ms: u64,
) {
    let tx = completion_tx.clone();
    attempt.note_flight();
    handles.push(attempt.transport.spawn(async move {
        // Abortable sleep: a cancelled wait still delivers so the pump
        // settles the flight (the cancel guard in `feed_completion` drops
        // it); the loop-top Cancel owns the transition and the engine
        // ignores stale completions.
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let _ = tx.send(Completion::Timer {
            tile,
            attempt: retry_attempt,
            waited_ms: delay_ms,
        });
    }));
}

fn feed_completion(
    job: &mut Job,
    attempt: &mut Attempt<'_>,
    sink: &mut Sink,
    completion: Completion,
) -> Result<(), NativeError> {
    attempt.settle_flight();
    // Cancel/terminal guard: once cancellation was requested or the engine
    // reached its terminal, completions settle their flight and die here --
    // never painted, never replied -- exactly like late host responses. The
    // loop-top Cancel owns the transition and the commit point refuses
    // publication once set, so dropping is always honest.
    if attempt.config.cancel_flag.load(Ordering::SeqCst) || job.is_terminal() {
        return Ok(());
    }
    match completion {
        Completion::Metadata {
            request,
            result,
            bytes,
        } => {
            attempt.instrumentation.bytes_fetched += bytes as u64;
            match result {
                Ok((body, final_uri)) => reply(
                    job,
                    JobCommand::ResourceBytes {
                        request,
                        bytes: body,
                        final_uri: Some(final_uri),
                    },
                )?,
                Err(cause) => reply(job, JobCommand::FetchFailure { request, cause })?,
            }
        }
        Completion::Probe {
            ordinal,
            outcome,
            decoded,
            bytes,
        } => {
            attempt.instrumentation.bytes_fetched += bytes as u64;
            let available = matches!(outcome, ProbeOutcome::Available { .. });
            if let Some(decoded) = decoded {
                debug_assert!(available);
                sink.note_declared(decoded.canvas);
                let id = ordinal.to_string();
                if !attempt.order.contains(&id) {
                    attempt.order.push(id.clone());
                }
                sink.place(ordinal, decoded.destination, decoded.extent, decoded.tile)?;
                attempt.settled.insert(id);
                attempt.acquired += 1;
            }
            let _ = available;
            reply(
                job,
                JobCommand::ProbeOutcome {
                    tile: ordinal,
                    outcome,
                },
            )?;
        }
        Completion::Tile {
            ordinal,
            id,
            destination,
            extent,
            canvas,
            result,
            bytes,
        } => {
            attempt.instrumentation.bytes_fetched += bytes as u64;
            if job.state() != JobState::AcquiringTiles {
                // Stale: the engine already moved on (partial decision or
                // finalization). Drop without reply, like any late host
                // response after a transition.
                return Ok(());
            }
            match result {
                Ok(decoded) => {
                    attempt.acquired += 1;
                    attempt.instrumentation.acquired += 1;
                    attempt.settled.insert(id.clone());
                    sink.note_declared(canvas);
                    sink.place(ordinal, destination, extent, decoded)?;
                    reply(
                        job,
                        JobCommand::TileOutcome {
                            tile: ordinal,
                            ok: true,
                        },
                    )?;
                }
                Err(failure) => {
                    let tile_failure = TileFailure::new(
                        canonical_failure_code(&failure.error.code),
                        failure.http,
                        failure.retry_after_ms,
                        Some(failure.error.message.clone()),
                    );
                    if tile_failure.is_retryable() {
                        attempt.instrumentation.failed_transient += 1;
                    } else {
                        attempt.instrumentation.failed_permanent += 1;
                    }
                    attempt.emit(
                        "tile-failed",
                        BTreeMap::from([
                            ("tile".to_string(), id),
                            (
                                "error".to_string(),
                                format!("{} ({})", failure.error.message, failure.error.code),
                            ),
                        ]),
                    );
                    reply(
                        job,
                        JobCommand::TileFailed {
                            tile: ordinal,
                            failure: tile_failure,
                        },
                    )?;
                }
            }
        }
        Completion::Timer {
            tile,
            attempt: retry_attempt,
            waited_ms,
        } => {
            let _ = waited_ms;
            // Stale-safe: a cancelled wait delivers nothing (the task
            // checks the flag), and a terminal race resolves inside the
            // engine as ignored rather than failing the pump.
            if attempt.config.cancel_flag.load(Ordering::SeqCst) {
                return Ok(());
            }
            let _ = job.on_command(JobCommand::RetryTimerElapsed {
                tile,
                attempt: retry_attempt,
            });
        }
    }
    Ok(())
}

fn finalize_output(
    job: &mut Job,
    attempt: &mut Attempt<'_>,
    sink: &mut Sink,
) -> Result<(), NativeError> {
    if let Some(output_dir) = attempt.auto_output_dir.clone() {
        let title = attempt
            .selected_image
            .and_then(|index| attempt.catalog.get(index))
            .or_else(|| attempt.catalog.first())
            .and_then(|image| image.title.as_deref());
        attempt.output_path = auto_output_path(&output_dir, title, attempt.format);
    }
    let dest = attempt.output_path.clone();
    let overwrite = attempt.overwrite;
    let format = attempt.format;
    let cancel = Arc::clone(&attempt.config.cancel_flag);
    let (image_size, partial, mut missing) =
        sink.assemble(&attempt.order, &|id| attempt.settled.contains(id))?;
    // Union with the engine ledger when it names the same holes; the
    // plan-minus-settled set is authoritative for the bytes written.
    if !attempt.pending_missing.is_empty() {
        let mut ledger = attempt.pending_missing.clone();
        ledger.sort();
        ledger.dedup();
        for id in &missing {
            if !ledger.contains(id) {
                ledger.push(id.clone());
            }
        }
        ledger.sort();
        missing = ledger;
    }
    let tile_count = attempt.settled.len();
    let on_event = &mut *attempt.on_event;
    match sink.commit(crate::sink::CommitParams {
        dest: &dest,
        format,
        overwrite,
        cancelled: &cancel,
        partial,
        missing: missing.clone(),
        tile_count,
        image_size,
        on_event,
    }) {
        Ok(published) => {
            attempt.published = Some(crate::sink::Published {
                output_path: published.output_path,
                tile_count: published.tile_count,
                image_size: published.image_size,
                partial: published.partial,
                missing: published.missing,
                encoded_bytes: published.encoded_bytes,
            });
            reply(job, JobCommand::FinalizationSucceeded)
        }
        Err(error) => reply(
            job,
            JobCommand::FinalizationFailed {
                code: error.code,
                message: error.message,
            },
        ),
    }
}

/// Interactive partial choice: announce the missing ledger for the host
/// dialog, wait up to 60s for [`PartialGate::answer`], fail-closed to
/// [`PartialPolicy`]. Returns `None` only when cancelled while waiting.
fn await_partial_choice(attempt: &mut Attempt<'_>, generation: u32) -> Option<PartialDecision> {
    let mut missing: Vec<String> = attempt.pending_missing.clone();
    if missing.is_empty() {
        for tile in &attempt.order {
            if !attempt.settled.contains(tile) {
                missing.push(tile.clone());
            }
        }
    }
    missing.sort();
    missing.dedup();
    let total = attempt.order.len();
    let failed = missing.len().max(1);
    let joined = missing.join(",");
    let mut requested = BTreeMap::new();
    requested.insert("reason".to_string(), "partial".to_string());
    requested.insert("failed".to_string(), failed.to_string());
    requested.insert("total".to_string(), total.to_string());
    if !joined.is_empty() {
        requested.insert("missing".to_string(), joined.clone());
    }
    requested.insert("generation".to_string(), generation.to_string());
    attempt.emit("recovery-requested", requested.clone());
    let mut work = BTreeMap::new();
    work.insert("failed".to_string(), failed.to_string());
    work.insert("total".to_string(), total.to_string());
    if !joined.is_empty() {
        work.insert("missing".to_string(), joined);
    }
    attempt.emit("missing-work", work);
    let Some(gate) = attempt.partial_gate.clone() else {
        return Some(if attempt.config.partial_policy == PartialPolicy::Keep {
            PartialDecision::Keep
        } else {
            PartialDecision::Discard
        });
    };
    gate.announce(PartialRequest {
        missing,
        failed,
        total,
    });
    const WAIT: Duration = Duration::from_secs(60);
    if let Some(decision) = gate.wait_for_decision(WAIT, &attempt.config.cancel_flag) {
        return Some(decision);
    }
    if attempt.config.cancel_flag.load(Ordering::SeqCst) {
        return None;
    }
    Some(if attempt.config.partial_policy == PartialPolicy::Keep {
        PartialDecision::Keep
    } else {
        PartialDecision::Discard
    })
}

/// Map pipeline bounds onto validated job bounds. Transport byte limits stay
/// identical on both sides so the fetch layer, not the engine, reports
/// oversize resources.
fn job_config_for(config: &PipelineConfig) -> Result<JobConfig, NativeError> {
    let tiles = config.max_tiles.clamp(1, 16_777_216) as u32;
    let fetches = (config.max_concurrent.clamp(1, 64) as u32).min(tiles);
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
        max_deferred_follows: MAX_DEFERRED_FOLLOWS,
    };
    job.validate().map_err(|e| {
        NativeError::new(
            "tile.limit",
            format!("native bounds exceed job limits: {}", e.message),
        )
    })?;
    Ok(job)
}

fn map_setup_error(error: dezoomify_job::JobError) -> NativeError {
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

/// Map a terminal job failure onto the stable native product code while
/// preserving the engine message.
fn map_failure_code(code: &str) -> &'static str {
    match code {
        "job.discovery-failed" | "job.catalog-invalid" | "job.empty-resource" => "discovery.failed",
        "job.no-images" => "discovery.no-image",
        "job.unknown-dezoomer" => "discovery.unknown-dezoomer",
        "job.resource-limit" => "tile.limit",
        "job.plan-invalid" => "discovery.tile-plan",
        "job.plan-empty" => "discovery.no-level",
        "job.partial-discarded" => "tile.download-failed",
        _ => "native.internal",
    }
}

/// Typed fetch cause for the engine. Native HTTP refusals carry their
/// status; transport-level failures decode their stable code. The engine
/// renders the diagnostics; the request URL and any server signal stay
/// host-side, out of the engine path.
fn fetch_failure_cause(outcome: &FetchOutcome) -> FetchCause {
    FetchCause::new(FetchCode::TransportHttpError, TransportKind::Native).with_http(outcome.status)
}

fn transport_failure_cause(error: &NativeError) -> FetchCause {
    let code = match error.code.as_str() {
        "transport.timeout" => FetchCode::TransportTimeout,
        "transport.network-error" => FetchCode::TransportNetworkError,
        "transport.bad-url" => FetchCode::TransportBadUrl,
        "transport.bad-redirect" => FetchCode::TransportBadRedirect,
        "transport.redirect-limit" => FetchCode::TransportRedirectLimit,
        "transport.size-limit" => FetchCode::TransportSizeLimit,
        other => FetchCode::from_string(other),
    };
    FetchCause::new(code, TransportKind::Native)
}

/// Map a native tile-attempt error code onto the canonical failure code the
/// engine classifies on. Branches on the stable native code only, never on
/// message text. Unknown codes fail closed as permanent.
fn canonical_failure_code(code: &str) -> &'static str {
    match code {
        "transport.timeout" => "TRANSPORT_TIMEOUT",
        "transport.network-error" => "TRANSPORT_NETWORK_ERROR",
        "tile.http-error" => "TRANSPORT_HTTP_ERROR",
        "tile.decode-failed" => "TILE_DECODE_FAILED",
        "tile.processing-failed" => "TILE_PROCESSING_FAILED",
        "transport.size-limit" => "TRANSPORT_SIZE_LIMIT",
        "transport.bad-url" => "TRANSPORT_BAD_URL",
        "transport.bad-redirect" => "TRANSPORT_BAD_REDIRECT",
        "transport.redirect-limit" => "TRANSPORT_REDIRECT_LIMIT",
        _ => "NATIVE_INTERNAL",
    }
}

fn describe_http_failure(outcome: &FetchOutcome) -> String {
    crate::pipeline::describe_http_failure(outcome)
}

struct CatalogImage {
    ready: bool,
    format: String,
    title: Option<String>,
    levels: Vec<(u64, u64)>,
}

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

fn max_area_index(levels: &[&(u64, u64)]) -> Option<u32> {
    levels
        .iter()
        .enumerate()
        .max_by_key(|(_, level)| u128::from(level.0) * u128::from(level.1))
        .and_then(|(index, _)| u32::try_from(index).ok())
}

pub(crate) fn select_image_index(count: usize, image_index: Option<usize>) -> Option<usize> {
    if count == 0 {
        return None;
    }
    Some(image_index.map_or(0, |requested| requested.min(count - 1)))
}

pub(crate) fn select_level_index(levels: &[(u64, u64)], selection: &LevelSelection) -> Option<u32> {
    if levels.is_empty() {
        return None;
    }
    if let Some(requested) = selection.zoom_level {
        let index = requested.min(levels.len() - 1);
        return u32::try_from(index).ok();
    }
    if selection.largest {
        let refs: Vec<&(u64, u64)> = levels.iter().collect();
        return max_area_index(&refs);
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
        let fitting: Vec<(usize, &(u64, u64))> = levels
            .iter()
            .enumerate()
            .filter(|(_, (width, height))| {
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
            return levels
                .iter()
                .enumerate()
                .min_by_key(|(_, (width, _))| width_of(*width))
                .and_then(|(index, _)| u32::try_from(index).ok());
        }
        return fitting
            .into_iter()
            .max_by_key(|(_, (width, height))| u128::from(*width) * u128::from(*height))
            .and_then(|(index, _)| u32::try_from(index).ok());
    }
    let refs: Vec<&(u64, u64)> = levels.iter().collect();
    max_area_index(&refs)
}

fn extension_for(format: OutputFormat) -> &'static str {
    match format {
        OutputFormat::Png => "png",
        OutputFormat::Jpeg => "jpg",
        OutputFormat::Tiff => "tif",
        OutputFormat::Zif => "zif",
        OutputFormat::Webp => "webp",
        OutputFormat::IiifDir => "iiif",
    }
}

fn safe_output_stem(title: Option<&str>) -> String {
    let mut stem = String::new();
    let mut previous_separator = false;
    for character in title.unwrap_or("dezoomify").chars() {
        if character.is_alphanumeric() {
            stem.push(character);
            previous_separator = false;
        } else if !previous_separator {
            stem.push('-');
            previous_separator = true;
        }
        if stem.len() >= 120 {
            break;
        }
    }
    let stem = stem.trim_matches('-');
    let lower = stem.to_ascii_lowercase();
    let reserved_windows_name = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && lower
                .as_bytes()
                .last()
                .is_some_and(|byte| matches!(byte, b'1'..=b'9')));
    if stem.is_empty() || reserved_windows_name {
        "dezoomify".to_string()
    } else {
        stem.to_string()
    }
}

fn auto_output_path(output_dir: &Path, title: Option<&str>, format: OutputFormat) -> PathBuf {
    let stem = safe_output_stem(title);
    let extension = extension_for(format);
    let first = output_dir.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    for suffix in 2..=9_999 {
        let candidate = output_dir.join(format!("{stem}-{suffix}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}
