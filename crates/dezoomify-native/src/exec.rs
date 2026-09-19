//! Completion-driven native execution: one engine, bounded async tasks.
//!
//! This module drives one [`dezoomify_engine::EngineJob`] to its terminal without
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
//!   handle plus every tracked blocking decode tail before cleanup, so
//!   cancel reports only after quiescence. Aborting a task that is inside
//!   a blocking decode detaches that sub-100ms tail (cancelling a future
//!   cannot stop blocking work); the tail is tracked by permit, its bytes
//!   stay counted against the retain cap until it releases, its result is
//!   dropped, and nothing publishes.
//! * Output is owned end to end by [`crate::sink::Sink`]: streaming paint,
//!   bounded retention/spool, one commit point, job-owned-temp-only
//!   cleanup. This module never writes output itself.
//!
//! Correlation uses the engine's own tile/request ordinals with no
//! remapping: late, duplicate, and out-of-order completions die inside the
//! engine exactly like late host responses.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};

use dezoomify_core::core::discovery::{FetchCause, FetchCode, TransportKind};
use dezoomify_core::core::model::{ProcessingRecipe, Request};
use dezoomify_core::Vec2d;
use dezoomify_engine::{
    DiscoveryInput, Effect as EngineEffect, EffectId as EngineEffectId,
    EffectResult as EngineEffectResult, EngineError as EngineJobError, EngineJob,
    JobOptions as EngineOptions, JobSnapshot as EngineSnapshot, OutputDisposition,
    RecoveryChoice as EnginePartialDecision, ResponseMetadata as EngineResponseMetadata,
    SelectionPolicy as EngineSelectionPolicy, Update as EngineUpdate,
    UserCommand as EngineUserCommand,
};
use dezoomify_protocol::dto::{
    CatalogDto, CatalogEntryDto, JobState as EngineLifecycle, ProbeOutcome,
    SnapshotTerminalDto as EngineTerminal,
};

use crate::error::NativeError;
use crate::http::{FetchOutcome, UserHeaders};
use crate::output::OutputFormat;
use crate::pipeline::{
    effective_cache_dir, load_image_with_metadata, merge_headers, DecodedTile, PartialGate,
    PartialPolicy, PartialRequest, PipelineConfig,
};
use crate::sink::{Published, Sink};
use crate::transport::NativeTransport;

/// Deferred-resolution bound for same-job follows, owned by the engine
/// (`JobOptions::max_deferred_follows`). The host never spawns replacement
/// jobs: deferred entries resolve via `FollowDeferred` on the same job.
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
    /// Peak in-flight decode bytes: encoded bodies held by blocking decode
    /// tails (including tails detached by cancelling their parent task).
    /// Bounded by the engine slot budget times the fetch byte limit; counted
    /// against the retain cap alongside sink retention.
    pub peak_decode_inflight_bytes: u64,
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

/// Drive one input URL end to end on the authoritative engine. Deferred
/// catalog entries resolve in place via `FollowDeferred` on the same job
/// (engine-bounded, no host recursive replacement jobs).
pub fn execute(
    input_url: &str,
    output: &OutputSpec,
    config: &PipelineConfig,
    user: &UserHeaders,
    on_snapshot: &mut dyn FnMut(&EngineSnapshot),
) -> Result<ExecResult, NativeError> {
    execute_attempt(input_url, output, config, user, on_snapshot)
}

/// Completions from spawned tasks back to the pump. Each settles exactly
/// one outstanding engine effect; late ones die inside the engine.
enum Completion {
    Metadata {
        effect: EngineEffectId,
        result: Result<(Vec<u8>, String), FetchCause>,
        bytes: usize,
    },
    Probe {
        effect: EngineEffectId,
        ordinal: u32,
        outcome: ProbeOutcome,
        decoded: Option<ProbeDecoded>,
        bytes: usize,
    },
    Tile {
        effect: EngineEffectId,
        ordinal: u32,
        id: String,
        destination: Vec2d,
        extent: Option<Vec2d>,
        canvas: Option<Vec2d>,
        result: Result<DecodedTile, TileAttemptFailure>,
        bytes: usize,
    },
    Timer {
        effect: EngineEffectId,
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
    catalog: Vec<CatalogImage>,
    selected_image: Option<usize>,
    /// Last snapshot (revision, paused) reported to the host (sparse reporting).
    reported: (u32, bool),
    progress_emitted: (u64, Option<u64>),
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
    command_rx: Option<Arc<Mutex<mpsc::Receiver<EngineUserCommand>>>>,
    instrumentation: Instrumentation,
    in_flight: usize,
    /// Tracked blocking decode tails: reserved before every `spawn_blocking`
    /// decode, released when the blocking closure finishes (even when the
    /// parent task was aborted and the tail detached). The pump counts these
    /// bytes against the retain cap and waits them out before reporting the
    /// terminal.
    decode_tails: Arc<DecodeTails>,
}

/// Tracked blocking decode work (permits, not handles): cancelling a future
/// cannot stop blocking work, so each blocking decode reserves its encoded
/// body bytes up front and releases them when its closure finishes. The
/// release runs inside the blocking closure itself, which always runs to
/// completion even after the parent task is aborted -- so detached tails
/// stay counted and the terminal wait observes their quiescence.
#[derive(Debug, Default)]
pub(crate) struct DecodeTails {
    active: AtomicUsize,
    bytes: AtomicU64,
    peak_bytes: AtomicU64,
}

impl DecodeTails {
    fn reserve(&self, bytes: usize) {
        self.active.fetch_add(1, Ordering::SeqCst);
        let bytes = bytes as u64;
        let current = self
            .bytes
            .fetch_add(bytes, Ordering::SeqCst)
            .saturating_add(bytes);
        self.peak_bytes.fetch_max(current, Ordering::SeqCst);
    }

    fn release(&self, bytes: usize) {
        self.bytes.fetch_sub(bytes as u64, Ordering::SeqCst);
        self.active.fetch_sub(1, Ordering::SeqCst);
    }

    fn quiescent(&self) -> bool {
        self.active.load(Ordering::SeqCst) == 0
    }

    /// Wait for every tracked tail to release, polling so a hung decoder
    /// can never wedge cleanup forever. Returns whether quiescence was
    /// observed before the timeout.
    fn wait_quiescent(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        while !self.quiescent() {
            if start.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        true
    }
}

/// Whether placing one more decoded tile stays within the retain cap once
/// in-flight (not yet placed) decode bytes are counted: sink retention plus
/// tracked tails plus the tile about to be placed. Pure so the bound is
/// testable without a sink.
fn decode_budget_exceeded(
    retained_bytes: u64,
    inflight_bytes: u64,
    tile_bytes: u64,
    cap: u64,
) -> bool {
    retained_bytes
        .saturating_add(inflight_bytes)
        .saturating_add(tile_bytes)
        > cap
}

impl<'a> Attempt<'a> {
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
    on_snapshot: &mut dyn FnMut(&EngineSnapshot),
) -> Result<ExecResult, NativeError> {
    let options = engine_options_for(input_url, config)?;
    let (mut job, update) = EngineJob::start(options).map_err(map_setup_error)?;
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
        catalog: Vec::new(),
        selected_image: None,
        order: Vec::new(),
        settled: HashSet::new(),
        acquired: 0,
        reported: (0, false),
        progress_emitted: (0, None),
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
        decode_tails: Arc::new(DecodeTails::default()),
    };
    let mut sink = Sink::new(config, output.format);
    let mut pump = Pump::new(update);

    loop {
        drain_commands(&mut job, &mut pump, &mut attempt);
        report_snapshot(&mut job, &mut attempt, on_snapshot);
        if attempt.config.cancel_flag.load(Ordering::SeqCst)
            && pump.snapshot.terminal.is_none()
            && !attempt.cancel_sent
        {
            apply_update(
                &mut pump,
                job.command(EngineUserCommand::Cancel).map_err(|e| {
                    NativeError::new(
                        "native.internal",
                        format!("cancel rejected ({}): {}", e.code, e.message),
                    )
                })?,
            );
            attempt.cancel_sent = true;
        }
        fold_snapshot(&mut attempt, &pump.snapshot)?;
        if pump.snapshot.lifecycle == EngineLifecycle::AwaitingImageSelection
            && !attempt.catalog.is_empty()
        {
            let selected =
                select_image_index(attempt.catalog.len(), attempt.config.image_index).unwrap_or(0);
            if attempt.catalog[selected].ready {
                attempt.selected_image = Some(selected);
                apply_update(
                    &mut pump,
                    job.command(EngineUserCommand::SelectImage {
                        image: u32::try_from(selected).map_err(|_| {
                            NativeError::new("native.internal", "image position overflow")
                        })?,
                    })
                    .map_err(|e| {
                        NativeError::new(
                            "native.internal",
                            format!("selection rejected ({}): {}", e.code, e.message),
                        )
                    })?,
                );
            } else {
                // Same-job deferred follow: the catalog is replaced in place
                // with no new job ID (engine-bounded, cycle-guarded). A
                // rejected follow (cycle, budget exhausted) ends the job with
                // the stable deferred code the host loop used to own.
                apply_update(
                    &mut pump,
                    job.command(EngineUserCommand::FollowDeferred {
                        image: u32::try_from(selected).map_err(|_| {
                            NativeError::new("native.internal", "image position overflow")
                        })?,
                    })
                    .map_err(|e| {
                        NativeError::new(
                            "discovery.deferred",
                            format!("deferred follow rejected ({}): {}", e.code, e.message),
                        )
                    })?,
                );
            }
            continue;
        }
        if pump.snapshot.lifecycle == EngineLifecycle::AwaitingLevelSelection
            && !attempt.catalog.is_empty()
        {
            let selected = attempt
                .selected_image
                .unwrap_or(0)
                .min(attempt.catalog.len() - 1);
            let selection = LevelSelection::from_config(attempt.config);
            let level = select_level_index(&attempt.catalog[selected].levels, &selection)
                .ok_or_else(|| {
                    NativeError::new("discovery.no-level", "image has no zoom levels")
                })?;
            apply_update(
                &mut pump,
                job.command(EngineUserCommand::SelectLevel { level })
                    .map_err(|e| {
                        NativeError::new(
                            "native.internal",
                            format!("selection rejected ({}): {}", e.code, e.message),
                        )
                    })?,
            );
            continue;
        }
        report_snapshot(&mut job, &mut attempt, on_snapshot);
        let effects = pump.take_effects();
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
                // Pump failures (e.g. the retain cap with tails counted, or
                // a stale partial answer the engine rejected) still own
                // quiescence and rollback: nothing publishes on the way out.
                let update = match feed_completion(&mut job, &mut attempt, &mut sink, completion) {
                    Ok(update) => update,
                    Err(error) => {
                        abort_and_join(&attempt.transport, &mut handles, &attempt.decode_tails);
                        sink.rollback();
                        return Err(error);
                    }
                };
                apply_update(&mut pump, update);
                continue;
            }
            if pump.snapshot.terminal.is_some() {
                break;
            }
            abort_and_join(&attempt.transport, &mut handles, &attempt.decode_tails);
            sink.rollback();
            return Err(NativeError::new(
                "native.internal",
                "job stalled with no effects",
            ));
        }
        if let Err(error) = execute_effects(
            &mut job,
            &mut pump,
            &mut attempt,
            &mut sink,
            &completion_tx,
            &mut handles,
            effects,
        ) {
            abort_and_join(&attempt.transport, &mut handles, &attempt.decode_tails);
            sink.rollback();
            return Err(error);
        }
        report_snapshot(&mut job, &mut attempt, on_snapshot);
        // Opportunistic completions: feed whatever already landed before
        // the next drain so pipelining never waits a full round trip.
        while let Ok(completion) = completion_rx.try_recv() {
            let update = match feed_completion(&mut job, &mut attempt, &mut sink, completion) {
                Ok(update) => update,
                Err(error) => {
                    abort_and_join(&attempt.transport, &mut handles, &attempt.decode_tails);
                    sink.rollback();
                    return Err(error);
                }
            };
            apply_update(&mut pump, update);
        }
        // Pause v1 demonstration (`--pause-after N`): same overlay proof as
        // the legacy driver, now against the completion-driven pump. The
        // paused and resumed snapshots report so the paused=true state is
        // observable on the stream.
        if let Some(threshold) = attempt.config.pause_after {
            if !attempt.pause_demonstrated
                && attempt.acquired >= threshold
                && pump.snapshot.lifecycle == EngineLifecycle::AcquiringTiles
                && pump.snapshot.terminal.is_none()
                && !pump.snapshot.paused
            {
                attempt.pause_demonstrated = true;
                apply_update(
                    &mut pump,
                    job.command(EngineUserCommand::Pause).map_err(|e| {
                        NativeError::new(
                            "native.internal",
                            format!("pause rejected ({}): {}", e.code, e.message),
                        )
                    })?,
                );
                debug_assert!(pump.snapshot.paused);
                report_snapshot(&mut job, &mut attempt, on_snapshot);
                apply_update(
                    &mut pump,
                    job.command(EngineUserCommand::Resume).map_err(|e| {
                        NativeError::new(
                            "native.internal",
                            format!("resume rejected ({}): {}", e.code, e.message),
                        )
                    })?,
                );
                debug_assert!(!pump.snapshot.paused);
            }
        }
    }

    // Terminal: stop new work, await every tracked handle plus every
    // tracked blocking decode tail (aborted async tasks resolve promptly;
    // detached tails release their permits when their closures finish and
    // their results are dropped), then map the terminal honestly.
    abort_and_join(&attempt.transport, &mut handles, &attempt.decode_tails);
    // Any completion that landed after the terminal is dropped, never fed.
    let terminal = match pump.snapshot.terminal.clone() {
        Some(EngineTerminal::Completed) | Some(EngineTerminal::PartialCompleted { .. }) => {
            let partial = matches!(
                pump.snapshot.terminal,
                Some(EngineTerminal::PartialCompleted { .. })
            );
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
        Some(EngineTerminal::Cancelled) => {
            sink.rollback();
            Terminal::Error(NativeError::new(
                "job.cancelled",
                "job cancelled before completion",
            ))
        }
        Some(EngineTerminal::Failed { .. }) => {
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
            Ok(ExecResult {
                output_path: published.output_path,
                tile_count: published.tile_count,
                image_size: published.image_size,
                format,
                partial: published.partial,
                missing: published.missing,
                instrumentation: attempt.instrumentation,
            })
        }
        Terminal::Error(error) => Err(error),
    }
}

enum Terminal {
    Output(Published),
    Error(NativeError),
}

/// Abort every tracked task (in-flight requests drop) and await the handles
/// so cleanup owns quiescence, never a still-running task. Blocking decode
/// tails outlive their aborted parents, so the terminal additionally waits
/// for every tracked tail permit: cancellation is terminal only after
/// cleanup/quiescence acknowledgment including blocking work. Tails finish
/// in milliseconds; the generous timeout only guards against a hung decoder
/// and never publishes anything either way.
fn abort_and_join(
    transport: &NativeTransport,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
    tails: &DecodeTails,
) {
    for handle in handles.iter() {
        handle.abort();
    }
    for handle in handles.drain(..) {
        let _ = transport.block_on(handle);
    }
    let _ = tails.wait_quiescent(Duration::from_secs(30));
}

/// Apply host-side external commands (Pause/Resume; Cancel rides the flag).
/// One canonical answer applied to the pump: newly issued effects queue
/// behind the in-flight ones; the snapshot becomes the current projection.
struct Pump {
    effects: std::collections::VecDeque<EngineEffect>,
    snapshot: EngineSnapshot,
}

impl Pump {
    fn new(update: EngineUpdate) -> Self {
        Self {
            effects: update.effects.into(),
            snapshot: update.snapshot,
        }
    }

    fn apply(&mut self, update: EngineUpdate) {
        self.effects.extend(update.effects);
        self.snapshot = update.snapshot;
    }

    fn take_effects(&mut self) -> Vec<EngineEffect> {
        self.effects.drain(..).collect()
    }
}

fn apply_update(pump: &mut Pump, update: EngineUpdate) {
    pump.apply(update);
}

/// Report the current snapshot to the host when it advanced.
fn report_snapshot(
    job: &mut EngineJob,
    attempt: &mut Attempt<'_>,
    on_snapshot: &mut dyn FnMut(&EngineSnapshot),
) {
    let snapshot = job.snapshot();
    if (snapshot.revision, snapshot.paused) != attempt.reported {
        attempt.reported = (snapshot.revision, snapshot.paused);
        on_snapshot(&snapshot);
    }
}

/// Apply host-side live commands (selection, pause/resume). Cancel rides
/// the flag, partial answers ride the gate. One canonical answer applied to
/// the pump: newly issued effects queue behind the in-flight ones. Wrong-phase
/// rejections (e.g. resume-without-pause, select-after-plan) never fail the
/// pump; post-terminal commands are dropped.
fn drain_commands(job: &mut EngineJob, pump: &mut Pump, attempt: &mut Attempt<'_>) {
    let rx = match attempt.command_rx.clone() {
        Some(rx) => rx,
        None => return,
    };
    let commands: Vec<EngineUserCommand> = match rx.lock() {
        Ok(guard) => guard.try_iter().collect(),
        Err(poisoned) => poisoned.into_inner().try_iter().collect(),
    };
    for command in commands {
        if pump.snapshot.terminal.is_some() {
            break;
        }
        // Cancel/AnswerPartial never arrive here (flag/gate own them).
        if matches!(
            command,
            EngineUserCommand::Cancel | EngineUserCommand::AnswerPartial { .. }
        ) {
            continue;
        }
        if let Ok(update) = job.command(command) {
            apply_update(pump, update);
        }
    }
}

/// Fold sink accounting into the job instrumentation and derive the
/// accounted peak (canvas plus peak retained plus encoded).
fn finish_sink_stats(attempt: &mut Attempt<'_>, sink: &Sink) {
    let stats = sink.stats();
    attempt.instrumentation.peak_retained_bytes = stats.peak_retained_bytes;
    attempt.instrumentation.peak_decode_inflight_bytes =
        attempt.decode_tails.peak_bytes.load(Ordering::SeqCst);
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
        crate::error::map_engine_failure_to_native(&code).to_string()
    } else {
        code
    };
    NativeError::new(native_code, message)
}

/// Complete one outstanding effect and return the canonical answer for
/// the pump to fold. Effect rejections (stale ids, wrong result kinds)
/// fail the pump: the pump never invents correlation.
fn complete_effect(
    job: &mut EngineJob,
    effect: EngineEffectId,
    result: EngineEffectResult,
) -> Result<EngineUpdate, NativeError> {
    job.complete(effect, result).map_err(|e| {
        NativeError::new(
            "native.internal",
            format!("effect completion rejected ({}): {}", e.code, e.message),
        )
    })
}

/// Fold one canonical snapshot into the attempt: the kept catalog, the
/// monotonic progress, the pending decision ledger, and the terminal
/// failure facts. Lifecycle moves need no branch: selection and quiescence
/// read the snapshot directly at the loop top.
fn fold_snapshot(attempt: &mut Attempt<'_>, snapshot: &EngineSnapshot) -> Result<(), NativeError> {
    if let Some(catalog) = &snapshot.selection.catalog {
        attempt.catalog = catalog_entries_of(catalog);
    }
    let (completed, total) = (snapshot.progress.completed, snapshot.progress.total);
    if completed > attempt.progress_emitted.0 || total != attempt.progress_emitted.1 {
        attempt.progress_emitted = (completed, total);
    }
    if let Some(decision) = &snapshot.decision {
        let missing: Vec<String> = decision
            .missing
            .iter()
            .map(|(tile, _)| tile.to_string())
            .collect();
        if !missing.is_empty() {
            attempt.pending_missing = missing;
        }
    }
    if let Some(EngineTerminal::Failed { error }) = &snapshot.terminal {
        attempt.failure = Some((error.code.clone(), error.message.clone()));
    }
    Ok(())
}

/// Project one kept catalog onto the attempt's planning entries.
fn catalog_entries_of(catalog: &CatalogDto) -> Vec<CatalogImage> {
    catalog
        .entries
        .iter()
        .map(|entry| match entry {
            CatalogEntryDto::Image(image) => CatalogImage {
                ready: true,
                format: image.format.clone(),
                title: image.title.clone(),
                levels: image
                    .levels
                    .iter()
                    .map(|level| (level.width, level.height))
                    .collect(),
            },
            CatalogEntryDto::ImageRequest(request) => CatalogImage {
                ready: false,
                format: String::new(),
                title: request.title.clone(),
                levels: Vec::new(),
            },
        })
        .collect()
}

struct TileFetch {
    effect: EngineEffectId,
    ordinal: u32,
    tile: String,
    uri: String,
    headers: BTreeMap<String, String>,
    processing: ProcessingRecipe,
    destination: Vec2d,
    extent: Option<Vec2d>,
}

fn execute_effects(
    job: &mut EngineJob,
    pump: &mut Pump,
    attempt: &mut Attempt<'_>,
    sink: &mut Sink,
    completion_tx: &mpsc::Sender<Completion>,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
    effects: Vec<EngineEffect>,
) -> Result<(), NativeError> {
    for effect in effects {
        match effect {
            EngineEffect::AcquireMetadata { id, uri } => {
                if pump.snapshot.lifecycle != EngineLifecycle::Discovering {
                    continue;
                }
                let merged = merge_headers(&Request::new(&uri));
                attempt.instrumentation.attempts += 1;
                spawn_metadata(attempt, completion_tx, handles, id, uri, merged);
            }
            EngineEffect::AcquireTile {
                id,
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
                    .map(|header| (header.name.to_ascii_lowercase(), header.value))
                    .collect::<BTreeMap<_, _>>();
                let destination = Vec2d {
                    x: destination.x,
                    y: destination.y,
                };
                let expected_size = expected_size.map(|size| Vec2d {
                    x: size.width,
                    y: size.height,
                });
                let canvas = canvas.map(|size| Vec2d {
                    x: size.width,
                    y: size.height,
                });
                attempt.instrumentation.attempts += 1;
                if probe {
                    spawn_probe(
                        attempt,
                        completion_tx,
                        handles,
                        id,
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
                let tile_id = tile.to_string();
                if !attempt.order.contains(&tile_id) {
                    attempt.order.push(tile_id.clone());
                }
                // Stagger request starts by `min_interval` (per-tile
                // throttle); ZERO disables the sleep entirely.
                // (The attempt counter bumped once above covers both
                // ordinary and probe acquisitions.)
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
                spawn_tile(
                    attempt,
                    completion_tx,
                    handles,
                    TileFetch {
                        effect: id,
                        ordinal: tile,
                        tile: tile_id,
                        uri,
                        headers,
                        processing,
                        destination,
                        extent: expected_size,
                    },
                );
            }
            EngineEffect::WaitRetryTimer {
                id,
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
                    id,
                    tile,
                    retry_attempt,
                    delay_ms,
                );
            }
            EngineEffect::FinalizeOutput { id, partial, .. } => {
                // The engine awaits finalization only after every free slot
                // settled; defensively drain any straggler first so the
                // commit below observes the full canvas.
                let update = finalize_output(job, attempt, sink, id, partial)?;
                apply_update(pump, update);
            }
            EngineEffect::RequestPartialDecision { generation, .. } => {
                let Some((answered_generation, decision)) =
                    await_partial_choice(attempt, generation)
                else {
                    if let Some(gate) = attempt.partial_gate.clone() {
                        gate.clear_pending();
                    }
                    let update = job.command(EngineUserCommand::Cancel).map_err(|e| {
                        NativeError::new(
                            "native.internal",
                            format!("cancel rejected ({}): {}", e.code, e.message),
                        )
                    })?;
                    apply_update(pump, update);
                    attempt.cancel_sent = true;
                    continue;
                };
                let choice = decision;
                if choice == EnginePartialDecision::Retry {
                    attempt.pending_missing.clear();
                }
                if let Some(gate) = attempt.partial_gate.clone() {
                    gate.clear_pending();
                }
                // The answering generation comes from the host through the
                // gate, never re-applied from this effect: a stale host
                // answer is engine-rejected at the boundary (invalid-state)
                // instead of being consumed in order.
                let update = job
                    .command(EngineUserCommand::AnswerPartial {
                        generation: answered_generation,
                        decision: choice,
                    })
                    .map_err(|e| {
                        NativeError::new(
                            "native.internal",
                            format!("effect reply rejected ({}): {}", e.code, e.message),
                        )
                    })?;
                apply_update(pump, update);
            }
            EngineEffect::CancelRelease { .. } => sink.release(),
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
    effect: EngineEffectId,
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
            effect,
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
    effect: EngineEffectId,
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
    let tails = Arc::clone(&attempt.decode_tails);
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
                // Tracked tail: reserve before the blocking decode, release
                // inside the blocking closure so a detached tail (parent
                // aborted mid-await) stays counted until it really finishes.
                let body_len = outcome.body.len();
                tails.reserve(body_len);
                let tails_release = Arc::clone(&tails);
                let decoded = tokio::task::spawn_blocking(move || {
                    let decoded = processing
                        .apply(outcome.body)
                        .ok()
                        .and_then(|bytes| load_image_with_metadata(&bytes).ok());
                    tails_release.release(body_len);
                    decoded
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
            effect,
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
    let tails = Arc::clone(&attempt.decode_tails);
    attempt.note_flight();
    handles.push(transport.spawn(async move {
        let result =
            fetch_and_decode(&need, &task_transport, &user, &config_fetch, &cache, &tails).await;
        let bytes = result.as_ref().map(|ok| ok.1).unwrap_or(0);
        let _ = tx.send(Completion::Tile {
            effect: need.effect,
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
    tails: &Arc<DecodeTails>,
) -> Result<(DecodedTile, usize), TileAttemptFailure> {
    if let Some((dir, namespace)) = cache {
        if let Some(bytes) = crate::cache::load(dir, namespace, &need.uri) {
            let bytes_len = bytes.len();
            tails.reserve(bytes_len);
            let tails_release = Arc::clone(tails);
            let decoded = tokio::task::spawn_blocking(move || {
                let decoded = load_image_with_metadata(&bytes);
                tails_release.release(bytes_len);
                decoded
            })
            .await;
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
    tails.reserve(body_len);
    let tails_release = Arc::clone(tails);
    let decoded = tokio::task::spawn_blocking(move || {
        let decoded = (|| {
            let bytes = processing.apply(outcome.body).map_err(NativeError::from)?;
            if let Some((dir, namespace)) = cache_store.as_ref() {
                let _ = crate::cache::store(dir, namespace, &uri, &bytes);
            }
            load_image_with_metadata(&bytes).map_err(|e| {
                NativeError::new("tile.decode-failed", format!("tile decode failed: {e}"))
            })
        })();
        tails_release.release(body_len);
        decoded
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
    effect: EngineEffectId,
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
            effect,
            tile,
            attempt: retry_attempt,
            waited_ms: delay_ms,
        });
    }));
}

/// Enforce the retain cap with in-flight decode bytes counted: sink
/// retention plus tracked tails (decode work not yet placed, including
/// detached tails) plus the tile about to be placed must fit. Fails the job
/// with the same `output.canvas-limit` the sink itself reports, so the cap
/// covers decoded bytes from reservation to painting, not just from
/// placement.
fn check_decode_budget(
    attempt: &Attempt<'_>,
    sink: &Sink,
    tile_bytes: u64,
) -> Result<(), NativeError> {
    let inflight = attempt.decode_tails.bytes.load(Ordering::SeqCst);
    if decode_budget_exceeded(
        sink.retained_bytes(),
        inflight,
        tile_bytes,
        sink.retain_cap_bytes(),
    ) {
        return Err(NativeError::canvas_memory_unavailable(
            1,
            1,
            &format!(
                "decoded tiles beyond the retain cap ({} retained, {} in flight)",
                sink.retained_bytes(),
                inflight,
            ),
            "the configured output retention",
        ));
    }
    Ok(())
}

fn feed_completion(
    job: &mut EngineJob,
    attempt: &mut Attempt<'_>,
    sink: &mut Sink,
    completion: Completion,
) -> Result<EngineUpdate, NativeError> {
    attempt.settle_flight();
    // Cancel/terminal guard: once cancellation was requested or the engine
    // reached its terminal, completions settle their flight and die here --
    // never painted, never replied -- exactly like late host responses. The
    // loop-top Cancel owns the transition and the commit point refuses
    // publication once set, so dropping is always honest.
    if attempt.config.cancel_flag.load(Ordering::SeqCst) || job.snapshot().terminal.is_some() {
        return Ok(job.snapshot_update());
    }
    match completion {
        Completion::Metadata {
            effect,
            result,
            bytes,
        } => {
            attempt.instrumentation.bytes_fetched += bytes as u64;
            let update = match result {
                Ok((body, final_uri)) => job
                    .provide_metadata(
                        effect,
                        EngineResponseMetadata {
                            final_uri: Some(final_uri),
                        },
                        &body,
                    )
                    .map_err(|e| {
                        NativeError::new(
                            "native.internal",
                            format!("metadata reply rejected ({}): {}", e.code, e.message),
                        )
                    })?,
                Err(cause) => complete_effect(
                    job,
                    effect,
                    EngineEffectResult::MetadataFailed(dezoomify_engine::Failure {
                        code: cause.code.to_string(),
                        http: cause.http,
                        retry_after_ms: None,
                        transport: Some(cause.transport),
                        detail: None,
                    }),
                )?,
            };
            Ok(update)
        }
        Completion::Probe {
            effect,
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
                check_decode_budget(attempt, sink, crate::sink::tile_bytes(&decoded.tile.image))?;
                sink.place(ordinal, decoded.destination, decoded.extent, decoded.tile)?;
                attempt.settled.insert(id);
                attempt.acquired += 1;
            }
            let _ = available;
            let result = match outcome {
                ProbeOutcome::Available { width, height } => EngineEffectResult::ProbeAvailable {
                    width: u32::try_from(width.get()).unwrap_or(u32::MAX),
                    height: u32::try_from(height.get()).unwrap_or(u32::MAX),
                },
                ProbeOutcome::Missing => EngineEffectResult::ProbeMissing,
            };
            complete_effect(job, effect, result)
        }
        Completion::Tile {
            effect,
            ordinal,
            id,
            destination,
            extent,
            canvas,
            result,
            bytes,
        } => {
            attempt.instrumentation.bytes_fetched += bytes as u64;
            if job.snapshot().lifecycle != EngineLifecycle::AcquiringTiles {
                // Stale: the engine already moved on (partial decision or
                // finalization). Drop without reply, like any late host
                // response after a transition.
                return Ok(job.snapshot_update());
            }
            match result {
                Ok(decoded) => {
                    attempt.acquired += 1;
                    attempt.instrumentation.acquired += 1;
                    attempt.settled.insert(id.clone());
                    sink.note_declared(canvas);
                    // In-flight decode bytes count against the retain cap:
                    // tracked tails plus sink retention plus this tile must
                    // fit, or the job fails closed instead of growing
                    // without bound.
                    check_decode_budget(attempt, sink, crate::sink::tile_bytes(&decoded.image))?;
                    sink.place(ordinal, destination, extent, decoded)?;
                    complete_effect(job, effect, EngineEffectResult::TileAcquired)
                }
                Err(failure) => {
                    let tile_failure = dezoomify_engine::retry::TileFailure::new(
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
                    complete_effect(
                        job,
                        effect,
                        EngineEffectResult::TileFailed(dezoomify_engine::Failure {
                            code: canonical_failure_code(&failure.error.code).to_string(),
                            http: failure.http,
                            retry_after_ms: failure.retry_after_ms,
                            transport: None,
                            detail: Some(failure.error.message.clone()),
                        }),
                    )
                }
            }
        }
        Completion::Timer {
            effect,
            tile,
            attempt: retry_attempt,
            waited_ms,
        } => {
            let _ = waited_ms;
            let _ = (tile, retry_attempt);
            // Stale-safe: a cancelled wait delivers nothing (the task
            // checks the flag), and a terminal race resolves inside the
            // engine rather than failing the pump.
            if attempt.config.cancel_flag.load(Ordering::SeqCst) {
                return Ok(job.snapshot_update());
            }
            match job.complete(effect, EngineEffectResult::TimerElapsed) {
                Ok(update) => Ok(update),
                Err(_) => Ok(job.snapshot_update()),
            }
        }
    }
}

fn finalize_output(
    job: &mut EngineJob,
    attempt: &mut Attempt<'_>,
    sink: &mut Sink,
    effect: EngineEffectId,
    partial: bool,
) -> Result<EngineUpdate, NativeError> {
    if let Some(output_dir) = attempt.auto_output_dir.clone() {
        let title = attempt
            .selected_image
            .and_then(|index| attempt.catalog.get(index))
            .or_else(|| attempt.catalog.first())
            .and_then(|image| image.title.as_deref());
        attempt.output_path = auto_output_path(&output_dir, title, attempt.format);
    }
    let _ = partial;
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
    match sink.commit(crate::sink::CommitParams {
        dest: &dest,
        format,
        overwrite,
        cancelled: &cancel,
        partial,
        missing: missing.clone(),
        tile_count,
        image_size,
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
            complete_effect(
                job,
                effect,
                EngineEffectResult::OutputCommitted {
                    disposition: OutputDisposition::NativePublication,
                },
            )
        }
        Err(error) => complete_effect(
            job,
            effect,
            EngineEffectResult::OutputFailed {
                code: error.code,
                message: error.message,
            },
        ),
    }
}

/// Interactive partial choice: announce the missing ledger for the host
/// dialog, wait up to 60s for [`PartialGate::answer`], fail-closed to
/// [`PartialPolicy`]. Returns the answering generation with the decision,
/// or `None` only when cancelled while waiting. The generation is the
/// host's answer carried through the gate (falling back to the live effect
/// generation only for the non-interactive policy path); the engine
/// rejects a stale one at the boundary. Decisions use the canonical
/// [`RecoveryChoice`] vocabulary verbatim.
fn await_partial_choice(
    attempt: &mut Attempt<'_>,
    generation: u32,
) -> Option<(u32, EnginePartialDecision)> {
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
    let policy = || {
        if attempt.config.partial_policy == PartialPolicy::Keep {
            EnginePartialDecision::Keep
        } else {
            EnginePartialDecision::Discard
        }
    };
    let Some(gate) = attempt.partial_gate.clone() else {
        return Some((generation, policy()));
    };
    gate.announce(PartialRequest {
        missing,
        failed,
        total,
    });
    const WAIT: Duration = Duration::from_secs(60);
    if let Some((answered_generation, decision)) =
        gate.wait_for_decision(WAIT, &attempt.config.cancel_flag)
    {
        return Some((answered_generation, decision));
    }
    if attempt.config.cancel_flag.load(Ordering::SeqCst) {
        return None;
    }
    Some((generation, policy()))
}

/// Map pipeline bounds onto validated canonical job options. Transport
/// byte limits stay identical on both sides so the fetch layer, not the
/// engine, reports oversize resources.
fn engine_options_for(
    input_url: &str,
    config: &PipelineConfig,
) -> Result<EngineOptions, NativeError> {
    let tiles = config.max_tiles.clamp(1, 16_777_216) as u32;
    let fetches = (config.max_concurrent.clamp(1, 64) as u32).min(tiles);
    let retries = config.max_retries.clamp(0, 1024);
    let max_bytes = config.fetch.max_bytes.clamp(1024, 4_294_967_296);
    let mut options = EngineOptions::new(vec![DiscoveryInput::new(input_url)]);
    options.format = config.format.clone();
    options.selection = EngineSelectionPolicy::Manual;
    // The pump owns partial decisions through its gate wait; the facade
    // only surfaces them.
    options.partial = dezoomify_engine::PartialPolicy::Prompt;
    options.max_concurrent = fetches;
    options.max_tiles = tiles;
    options.max_retries = retries;
    options.max_bytes = max_bytes;
    options.max_deferred_follows = MAX_DEFERRED_FOLLOWS;
    // Bounds and inputs validated by the canonical start; oversize budgets
    // fail typed through the same mapping below.
    EngineJob::validate_options(&options).map_err(|e| match e.code.as_str() {
        "job.invalid-input" => map_setup_error(e),
        _ => NativeError::new(
            "tile.limit",
            format!("native bounds exceed job limits: {}", e.message),
        ),
    })?;
    Ok(options)
}

fn map_setup_error(error: EngineJobError) -> NativeError {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::FetchLimits;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn decode_budget_counts_inflight_tails_against_the_cap() {
        assert!(!decode_budget_exceeded(0, 0, 100, 512));
        assert!(!decode_budget_exceeded(400, 100, 12, 512));
        assert!(decode_budget_exceeded(400, 100, 13, 512));
        assert!(decode_budget_exceeded(0, 600, 0, 512));
        assert!(decode_budget_exceeded(512, 0, 1, 512));
        // Saturating arithmetic fails closed on huge values, never wraps
        // around to pass; an exact-cap fit still passes.
        assert!(!decode_budget_exceeded(u64::MAX, 0, 0, u64::MAX));
        assert!(decode_budget_exceeded(
            u64::MAX,
            u64::MAX,
            u64::MAX,
            u64::MAX - 1
        ));
    }

    #[test]
    fn quiescent_wait_times_out_on_a_leaked_permit() {
        let tails = DecodeTails::default();
        assert!(tails.wait_quiescent(Duration::from_millis(10)));
        tails.reserve(8);
        assert!(!tails.wait_quiescent(Duration::from_millis(20)));
        assert!(!tails.quiescent());
        assert_eq!(tails.peak_bytes.load(Ordering::SeqCst), 8);
        tails.release(8);
        assert!(tails.wait_quiescent(Duration::from_millis(20)));
        assert!(tails.quiescent());
    }

    /// Aborting the parent task cannot stop its blocking decode: the tail
    /// releases its own permit when its closure finishes, and the terminal
    /// wait observes that quiescence (result dropped, bytes uncounted only
    /// after the release).
    #[test]
    fn detached_blocking_tail_releases_and_quiesces() {
        let transport = NativeTransport::new(&FetchLimits::default()).expect("transport");
        let tails = Arc::new(DecodeTails::default());
        let started = Arc::new(AtomicBool::new(false));
        let task_tails = Arc::clone(&tails);
        let task_started = Arc::clone(&started);
        let parent = transport.spawn(async move {
            task_tails.reserve(1024);
            let release = Arc::clone(&task_tails);
            let _ = tokio::task::spawn_blocking(move || {
                task_started.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(200));
                release.release(1024);
                42u32
            })
            .await;
        });
        // Wait until the blocking tail really started, then abort the
        // parent: the tail detaches and must still release.
        let start = Instant::now();
        while !started.load(Ordering::SeqCst) {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "blocking tail starts promptly"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        parent.abort();
        assert!(
            tails.wait_quiescent(Duration::from_secs(10)),
            "terminal wait observes the detached tail"
        );
        assert!(
            start.elapsed() >= Duration::from_millis(150),
            "cancel waited for the tail instead of reporting early"
        );
        assert!(tails.quiescent());
        assert_eq!(tails.peak_bytes.load(Ordering::SeqCst), 1024);
        assert_eq!(tails.bytes.load(Ordering::SeqCst), 0);
        let _ = transport.block_on(parent);
    }
}
