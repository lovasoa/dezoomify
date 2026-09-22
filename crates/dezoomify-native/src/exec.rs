//! Completion-driven native execution: one engine, bounded async tasks.
//!
//! This module drives one [`dezoomify::engine::EngineJob`] to its terminal without
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

use dezoomify::core::discovery::{FetchCause, FetchCode, TransportKind};
use dezoomify::core::model::{ProcessingRecipe, Request};
use dezoomify::engine::{
    EffectId as EngineEffectId, EffectResult as EngineEffectResult, EngineError as EngineJobError,
    EngineJob, JobOptions as EngineOptions, ResponseMetadata as EngineResponseMetadata,
    Update as EngineUpdate, UserCommand as EngineUserCommand,
};
use dezoomify::model::{
    CatalogEntry, HostEffect as EngineEffect, JobState as EngineLifecycle, OutputDisposition,
    ProbeOutcome, RecoveryChoice as EnginePartialDecision, RequestPurpose,
    Snapshot as EngineSnapshot, Terminal as EngineTerminal,
};
use dezoomify::Vec2d;

use crate::error::NativeError;
use crate::http::{FetchLimits, FetchOutcome, UserHeaders};
use crate::output::OutputFormat;
use crate::pipeline::{load_image_with_metadata, merge_headers, DecodedTile, PartialPolicy};
use crate::sink::{Published, Sink, SinkOptions};
use crate::transport::NativeTransport;

/// Native-only settings consumed by the effect executor. Engine policy is
/// passed separately as canonical `dezoomify::engine::JobOptions`.
#[derive(Clone, Debug)]
pub(crate) struct NativeHostSettings {
    pub fetch: FetchLimits,
    pub min_interval: Duration,
    pub cache_dir: PathBuf,
    pub partial_policy: PartialPolicy,
    pub max_retries: u32,
    pub sink: SinkOptions,
}

/// Per-run control handles. These are process-local capabilities and never
/// enter the serializable domain model.
pub(crate) struct JobControl {
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    pub commands: Arc<Mutex<mpsc::Receiver<EngineUserCommand>>>,
}

/// Honest execution accounting, reported with every terminal result.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
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

/// Honest native publication record: what was actually written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputSummary {
    pub path: PathBuf,
    pub tile_count: usize,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub partial: bool,
    pub missing: Vec<String>,
    pub instrumentation: Instrumentation,
}

pub(crate) struct OutputSpec {
    pub output_path: PathBuf,
    pub overwrite: bool,
    pub format: OutputFormat,
    pub auto_output_dir: Option<PathBuf>,
}

/// Drive one input URL end to end on the authoritative engine. Deferred
/// catalog entries resolve in place via `FollowDeferred` on the same job
/// (engine-bounded, no host recursive replacement jobs).
pub(crate) fn execute(
    engine_options: EngineOptions,
    input_url: &str,
    output: OutputSpec,
    settings: &NativeHostSettings,
    control: JobControl,
    user: &UserHeaders,
    on_snapshot: &mut dyn FnMut(&EngineSnapshot),
) -> Result<OutputSummary, NativeError> {
    execute_attempt(
        engine_options,
        input_url,
        output,
        settings,
        control,
        user,
        on_snapshot,
    )
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
    settings: &'a NativeHostSettings,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    user: &'a UserHeaders,
    transport: Arc<NativeTransport>,
    output_path: PathBuf,
    overwrite: bool,
    format: OutputFormat,
    auto_output_dir: Option<PathBuf>,
    cache: Option<(PathBuf, String)>,
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
    engine_options: EngineOptions,
    input_url: &str,
    output: OutputSpec,
    settings: &NativeHostSettings,
    control: JobControl,
    user: &UserHeaders,
    on_snapshot: &mut dyn FnMut(&EngineSnapshot),
) -> Result<OutputSummary, NativeError> {
    let (mut job, update) = EngineJob::start(engine_options).map_err(map_setup_error)?;
    let transport = Arc::new(NativeTransport::new(&settings.fetch)?);
    let (completion_tx, completion_rx) = mpsc::channel::<Completion>();
    let mut handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    let mut attempt = Attempt {
        settings,
        cancel: control.cancel,
        user,
        transport,
        output_path: output.output_path,
        overwrite: output.overwrite,
        format: output.format,
        auto_output_dir: output.auto_output_dir,
        cache: Some((
            settings.cache_dir.clone(),
            crate::cache::job_namespace(input_url),
        )),
        order: Vec::new(),
        settled: HashSet::new(),
        acquired: 0,
        reported: (0, false),
        progress_emitted: (0, None),
        throttle_last: None,
        failure: None,
        published: None,
        cancel_sent: false,
        pending_missing: Vec::new(),
        command_rx: Some(control.commands),
        instrumentation: Instrumentation::default(),
        in_flight: 0,
        decode_tails: Arc::new(DecodeTails::default()),
    };
    let mut sink = Sink::new(&settings.sink, output.format);
    let mut pump = Pump::new(update);

    loop {
        drain_commands(&mut job, &mut pump, &mut attempt);
        report_snapshot(&mut job, &mut attempt, on_snapshot);
        if attempt.cancel.load(Ordering::SeqCst)
            && pump.snapshot.terminal.is_none()
            && !attempt.cancel_sent
        {
            apply_update(&mut pump, cancel_job(&mut job)?);
            attempt.cancel_sent = true;
        }
        fold_snapshot(&mut attempt, &pump.snapshot);
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
            let format = selected_catalog_image(&pump.snapshot)
                .map(|image| image.format.clone())
                .unwrap_or_default();
            Ok(OutputSummary {
                path: published.output_path,
                tile_count: published.tile_count,
                width: published.image_size.x,
                height: published.image_size.y,
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
        // Cancel uses the shared flag; partial answers are consumed only
        // while the matching decision effect is pending.
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
                    unacquired, attempt.settings.max_retries,
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

/// Cancel is idempotent at the host boundary. The engine can terminalize
/// between the host's last snapshot projection and its cancel command; in
/// that case its terminal snapshot is authoritative and must not become a
/// native internal error.
fn cancel_job(job: &mut EngineJob) -> Result<EngineUpdate, NativeError> {
    match job.command(EngineUserCommand::Cancel) {
        Ok(update) => Ok(update),
        Err(error) if error.code == "job.post-terminal" => Ok(job.snapshot_update()),
        Err(error) => Err(NativeError::new(
            "native.internal",
            format!("cancel rejected ({}): {}", error.code, error.message),
        )),
    }
}

/// Fold one canonical snapshot into the attempt: the kept catalog, the
/// monotonic progress, the pending decision ledger, and the terminal
/// failure facts. Lifecycle moves need no branch: selection and quiescence
/// read the snapshot directly at the loop top.
fn fold_snapshot(attempt: &mut Attempt<'_>, snapshot: &EngineSnapshot) {
    let (completed, total) = (snapshot.progress.completed, snapshot.progress.total);
    if completed > attempt.progress_emitted.0 || total != attempt.progress_emitted.1 {
        attempt.progress_emitted = (completed, total);
    }
    if let Some(decision) = &snapshot.decision {
        let missing: Vec<String> = decision
            .missing
            .iter()
            .map(|missing| missing.tile.to_string())
            .collect();
        if !missing.is_empty() {
            attempt.pending_missing = missing;
        }
    }
    if let Some(EngineTerminal::Failed { error }) = &snapshot.terminal {
        attempt.failure = Some((error.code.clone(), error.message.clone()));
    }
}

fn selected_catalog_image(snapshot: &EngineSnapshot) -> Option<&dezoomify::model::Image> {
    let position = usize::try_from(snapshot.selection.image?).ok()?;
    let catalog = snapshot.selection.catalog.as_ref()?;
    let CatalogEntry::Image(image) = catalog.entries.get(position)? else {
        return None;
    };
    Some(image)
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
            EngineEffect::AcquireResource { request } => {
                if pump.snapshot.lifecycle != EngineLifecycle::Discovering {
                    continue;
                }
                let id = EngineEffectId(request.id);
                let uri = request.uri;
                let merged = merge_headers(&Request::new(&uri));
                attempt.instrumentation.attempts += 1;
                spawn_metadata(attempt, completion_tx, handles, id, uri, merged);
            }
            EngineEffect::AcquireTile {
                request,
                tile,
                placement,
            } => {
                let id = EngineEffectId(request.id);
                let uri = request.uri;
                let probe = request.purpose == RequestPurpose::Probe;
                let headers = request
                    .headers
                    .into_iter()
                    .map(|header| (header.name.to_ascii_lowercase(), header.value))
                    .collect::<BTreeMap<_, _>>();
                let destination = Vec2d {
                    x: placement.position.x,
                    y: placement.position.y,
                };
                let expected_size = placement.expected_size.map(|size| Vec2d {
                    x: size.width,
                    y: size.height,
                });
                let canvas = placement.canvas.map(|size| Vec2d {
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
                        placement.processing,
                        destination,
                        expected_size,
                        canvas,
                        placement.probe_output,
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
                if !attempt.settings.min_interval.is_zero() {
                    if let Some(last) = attempt.throttle_last {
                        let next = last + attempt.settings.min_interval;
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
                        processing: placement.processing,
                        destination,
                        extent: expected_size,
                    },
                );
            }
            EngineEffect::WaitRetryTimer {
                effect,
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
                    EngineEffectId(effect),
                    tile,
                    retry_attempt,
                    delay_ms,
                );
            }
            EngineEffect::FinalizeOutput {
                effect, partial, ..
            } => {
                // The engine awaits finalization only after every free slot
                // settled; defensively drain any straggler first so the
                // commit below observes the full canvas.
                let update = finalize_output(job, attempt, sink, EngineEffectId(effect), partial)?;
                apply_update(pump, update);
            }
            EngineEffect::RequestDecision { generation } => {
                let Some((answered_generation, decision)) =
                    await_partial_choice(attempt, generation)
                else {
                    let update = cancel_job(job)?;
                    apply_update(pump, update);
                    attempt.cancel_sent = true;
                    continue;
                };
                let choice = decision;
                if choice == EnginePartialDecision::Retry {
                    attempt.pending_missing.clear();
                }
                // The answering generation comes from the host command,
                // never re-applied from this effect: a stale host
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
            EngineEffect::CancelWork => sink.release(),
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
    let limits = attempt.settings.fetch.clone();
    let tx = completion_tx.clone();
    let cancel = Arc::clone(&attempt.cancel);
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
    let limits = attempt.settings.fetch.clone();
    let tx = completion_tx.clone();
    let tails = Arc::clone(&attempt.decode_tails);
    attempt.note_flight();
    handles.push(transport.spawn(async move {
        let mut request = Request::new(&uri);
        request.headers = headers
            .into_iter()
            .map(|(name, value)| dezoomify::model::Header { name, value })
            .collect();
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
    let config_fetch = attempt.settings.fetch.clone();
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
    request.headers = need
        .headers
        .iter()
        .map(|(name, value)| dezoomify::model::Header {
            name: name.clone(),
            value: value.clone(),
        })
        .collect();
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
    if attempt.cancel.load(Ordering::SeqCst) || job.snapshot().terminal.is_some() {
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
                    EngineEffectResult::MetadataFailed(dezoomify::engine::Failure {
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
                    let tile_failure = dezoomify::engine::retry::TileFailure::new(
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
                        EngineEffectResult::TileFailed(dezoomify::engine::Failure {
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
            if attempt.cancel.load(Ordering::SeqCst) {
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
        let snapshot = job.snapshot();
        let title = selected_catalog_image(&snapshot).and_then(|image| image.title.as_deref());
        attempt.output_path = auto_output_path(&output_dir, title, attempt.format);
    }
    let _ = partial;
    let dest = attempt.output_path.clone();
    let overwrite = attempt.overwrite;
    let format = attempt.format;
    let cancel = Arc::clone(&attempt.cancel);
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

/// Wait for the canonical command channel's partial answer, falling back to
/// the configured non-interactive policy after 60 seconds. Cancellation uses
/// the shared flag so it remains prompt while no command is arriving.
fn await_partial_choice(
    attempt: &mut Attempt<'_>,
    generation: u32,
) -> Option<(u32, EnginePartialDecision)> {
    let policy = || {
        if attempt.settings.partial_policy == PartialPolicy::Keep {
            EnginePartialDecision::Keep
        } else {
            EnginePartialDecision::Discard
        }
    };
    let Some(rx) = attempt.command_rx.clone() else {
        return Some((generation, policy()));
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if attempt.cancel.load(Ordering::SeqCst) {
            return None;
        }
        let wait = deadline.saturating_duration_since(Instant::now());
        if wait.is_zero() {
            return Some((generation, policy()));
        }
        let command = match rx.lock() {
            Ok(guard) => guard.recv_timeout(wait.min(Duration::from_millis(20))),
            Err(poisoned) => poisoned
                .into_inner()
                .recv_timeout(wait.min(Duration::from_millis(20))),
        };
        match command {
            Ok(EngineUserCommand::AnswerPartial {
                generation,
                decision,
            }) => return Some((generation, decision)),
            Ok(EngineUserCommand::Cancel) => return None,
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Some((generation, policy()));
            }
        }
    }
}

fn map_setup_error(error: EngineJobError) -> NativeError {
    match error.code.as_str() {
        "job.unknown-format" => NativeError::new("discovery.unknown-format", error.message.clone()),
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
