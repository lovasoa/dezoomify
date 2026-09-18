//! Typed native runner: one real engine job per request.
//!
//! [`NativeRunner::start`] validates [`JobOptions`], spawns one background
//! driver thread running the real engine plus driver (`pipeline::run`), and
//! returns a [`RunningJob`] owning three things: the command sender, the
//! typed snapshot stream, and the join handle that owns completion and
//! cleanup. CLI and desktop run the same runner; there is no extra
//! scheduling layer and no string-map routing.
//!
//! Commands are deliberately narrow: [`UserCommand`] carries cancellation and
//! partial-output decisions only. It can never supply bytes or claim
//! publication -- the driver assembles, encodes, and publishes output itself,
//! and completion is reported only after finalization. Pause/resume stays an
//! engine overlay driven through the engine job handle; this runner does not
//! fake it.
//!
//! Cancellation is honest: [`UserCommand::Cancel`] sets the shared flag the
//! driver polls at every effect boundary. Work already in flight finishes,
//! nothing new starts, and the commit point refuses to publish once
//! cancellation was requested, so cancel can never delete or replace a
//! pre-existing destination.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use crate::error::NativeError;
use crate::http::{FetchLimits, TlsPolicy};
use crate::output::OutputFormat;
use crate::pipeline::{
    self, PartialDecision, PartialGate, PartialPolicy, PipelineConfig, PipelineEvent,
};

/// Where the finished output goes.
#[derive(Clone, Debug)]
pub enum OutputTarget {
    /// Save to this exact file (the extension selects the encoder).
    File(PathBuf),
    /// Derive the basename from the catalog title inside this directory.
    AutoDir { dir: PathBuf, format: OutputFormat },
}

/// Validated options for one native job. Hosts map their own args/settings
/// onto this struct; validation is typed and happens before any effect.
#[derive(Clone, Debug)]
pub struct JobOptions {
    pub input_url: String,
    pub output: OutputTarget,
    pub overwrite: bool,
    /// Engine format selector (`None` auto-detects; named picks one program;
    /// unknown names fail typed before any work).
    pub format: Option<String>,
    pub image_index: Option<usize>,
    pub zoom_level: Option<usize>,
    pub largest: bool,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_retries: u32,
    pub keep_partial: bool,
    pub compression: u8,
    pub headers: BTreeMap<String, String>,
    pub cache_dir: Option<PathBuf>,
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub max_idle_per_host: usize,
    pub accept_invalid_certs: bool,
    /// Max concurrent tile fetches (default 16, the reference async
    /// `buffer_unordered(parallelism)` width). Bounds one engine slot per
    /// tile covering the full fetch/decode/place path.
    pub max_concurrent: usize,
    /// Minimum interval between tile request starts (per-tile throttle).
    /// `ZERO` disables staggering (the CLI default); bulk image pacing stays
    /// in the caller.
    pub min_interval: Duration,
    /// Pause v1 demonstration: pause the engine after this many tiles are
    /// acquired, then resume and complete. `None` disables.
    pub pause_after: Option<usize>,
}

impl Default for JobOptions {
    fn default() -> Self {
        Self {
            input_url: String::new(),
            output: OutputTarget::File(PathBuf::from("out.png")),
            overwrite: false,
            format: None,
            image_index: None,
            zoom_level: None,
            largest: false,
            max_width: None,
            max_height: None,
            max_retries: 3,
            keep_partial: true,
            compression: 5,
            headers: BTreeMap::new(),
            cache_dir: None,
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(6),
            max_idle_per_host: 32,
            accept_invalid_certs: false,
            max_concurrent: crate::pipeline::MAX_CONCURRENT,
            min_interval: Duration::ZERO,
            pause_after: None,
        }
    }
}

impl JobOptions {
    /// Typed pre-flight validation: input shape plus output-format support.
    /// Destination existence/overwrite stays a finalize-time check (the
    /// driver owns the commit point), so this never touches the filesystem.
    fn validate(&self) -> Result<(), NativeError> {
        if self.input_url.is_empty() || self.input_url.len() > 2048 {
            return Err(NativeError::new(
                "job.invalid-input",
                "input must be 1..2048 bytes",
            ));
        }
        if let Some(after_scheme) = self
            .input_url
            .split("://")
            .nth(1)
            .filter(|_| self.input_url.starts_with("http"))
        {
            let authority = after_scheme
                .split('/')
                .next()
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap_or("");
            if authority.contains('@') {
                return Err(NativeError::new(
                    "job.invalid-input",
                    "input must not contain userinfo",
                ));
            }
        }
        match &self.output {
            OutputTarget::File(path) => {
                OutputFormat::infer_from_path(path)?;
            }
            OutputTarget::AutoDir { dir: _, format: _ } => {}
        }
        Ok(())
    }

    fn pipeline_config(
        &self,
        cancel_flag: Arc<AtomicBool>,
        partial_gate: Arc<PartialGate>,
    ) -> PipelineConfig {
        PipelineConfig {
            user_headers: self.headers.clone(),
            fetch: FetchLimits {
                timeout: self.timeout,
                connect_timeout: self.connect_timeout,
                max_idle_per_host: self.max_idle_per_host,
                tls: TlsPolicy {
                    accept_invalid_certs: self.accept_invalid_certs,
                },
                ..FetchLimits::default()
            },
            max_concurrent: self.max_concurrent.clamp(1, 64),
            max_retries: self.max_retries.min(1024),
            retry_delay: Duration::from_secs(2),
            min_interval: self.min_interval,
            compression: self.compression.min(100),
            cache_dir: Some(
                self.cache_dir
                    .clone()
                    .unwrap_or_else(crate::pipeline::default_tile_cache_dir),
            ),
            max_width: self.max_width,
            max_height: self.max_height,
            zoom_level: self.zoom_level,
            image_index: self.image_index,
            largest: self.largest,
            format: self.format.clone(),
            partial_policy: if self.keep_partial {
                PartialPolicy::Keep
            } else {
                PartialPolicy::Fail
            },
            partial_gate: Some(partial_gate),
            cancel_flag,
            pause_after: self.pause_after,
            ..PipelineConfig::default()
        }
    }
}

/// Narrow host commands. Cancellation plus partial-output decisions only:
///
/// * `Cancel` stops new work; in-flight finishes; the commit point refuses to
///   publish, so no output (partial or complete) appears on the cancel path.
/// * `KeepPartial` / `DiscardPartial` / `RetryPartial` answer the pending
///   partial request announced as [`Lifecycle::AwaitingPartialDecision`].
///   Unanswered requests fail closed to the job's partial policy after the
///   driver's bounded wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserCommand {
    Cancel,
    KeepPartial,
    DiscardPartial,
    RetryPartial,
}

/// Observable lifecycle of the running job, projected from driver events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    Discovering,
    AcquiringTiles,
    Finalizing,
    AwaitingPartialDecision,
}

/// Honest output summary for a published job: what was actually written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputSummary {
    pub path: PathBuf,
    pub tile_count: usize,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub partial: bool,
    pub missing: Vec<String>,
}

/// Terminal outcome. `Completed` arrives only after successful finalization;
/// `Cancelled` arrives only after quiescence with nothing published.
#[derive(Clone, Debug)]
pub enum Terminal {
    Completed(OutputSummary),
    Cancelled,
    Failed(NativeError),
}

/// One ordered snapshot on the stream. `seq` is per-job monotonic starting
/// at 1 (`Started`); exactly one snapshot carries a `terminal`.
#[derive(Clone, Debug)]
pub struct JobSnapshot {
    pub job: String,
    pub seq: u64,
    pub lifecycle: Lifecycle,
    pub acquired: u64,
    pub total: u64,
    pub terminal: Option<Terminal>,
}

/// Failure to deliver a command: the job already reached its terminal and
/// the driver is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandRejected {
    pub code: &'static str,
}

static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

/// Factory for native jobs. Holds no per-job state; every job owns its
/// thread, transport, temp files, and completion.
pub struct NativeRunner;

impl NativeRunner {
    /// Validate options and start one real engine job on a background thread.
    /// Returns the typed handle immediately, before any network or file
    /// effect beyond validation.
    pub fn start(options: JobOptions) -> Result<RunningJob, NativeError> {
        options.validate()?;
        let id = format!("job:native-{}", NEXT_JOB.fetch_add(1, Ordering::SeqCst));
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let partial_gate = Arc::new(PartialGate::new());
        let config = options.pipeline_config(Arc::clone(&cancel_flag), Arc::clone(&partial_gate));
        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        let worker_id = id.clone();
        let worker_options = options.clone();
        let worker_cancel = Arc::clone(&cancel_flag);
        let worker_gate = Arc::clone(&partial_gate);
        let alive = Arc::new(AtomicBool::new(true));
        let worker_alive = Arc::clone(&alive);
        let handle = std::thread::spawn(move || {
            let terminal = run_job(
                &worker_id,
                &worker_options,
                &config,
                &snapshot_tx,
                &worker_cancel,
                &worker_gate,
            );
            worker_alive.store(false, Ordering::SeqCst);
            terminal
        });
        Ok(RunningJob {
            id,
            alive,
            snapshot_rx,
            cancel_flag,
            partial_gate,
            join: Some(handle),
        })
    }
}

/// One running native job: command sender, snapshot stream, and the join
/// handle owning completion/cleanup. Dropping without `join` detaches the
/// stream; the driver still runs to its honest terminal (cancel first via
/// [`RunningJob::send`] when abandoning).
pub struct RunningJob {
    /// Opaque job id (`job:native-N`); safe to log and to correlate snapshots.
    pub id: String,
    alive: Arc<AtomicBool>,
    snapshot_rx: mpsc::Receiver<JobSnapshot>,
    cancel_flag: Arc<AtomicBool>,
    partial_gate: Arc<PartialGate>,
    join: Option<std::thread::JoinHandle<Terminal>>,
}

/// Ack for a delivered command; kept minimal on purpose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobCommandAck {
    Accepted,
}

impl std::fmt::Debug for RunningJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunningJob")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl RunningJob {
    /// Send one [`UserCommand`]. Cancellation sets the shared flag the
    /// driver polls at every effect boundary; partial answers wake the
    /// driver's bounded wait. Fails closed with `job.stale` once the driver
    /// has exited (post-terminal commands are rejected, never applied to a
    /// later job).
    pub fn send(&self, command: UserCommand) -> Result<JobCommandAck, CommandRejected> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(CommandRejected { code: "job.stale" });
        }
        match command {
            UserCommand::Cancel => {
                self.cancel_flag.store(true, Ordering::SeqCst);
            }
            UserCommand::KeepPartial => self.partial_gate.answer(PartialDecision::Keep),
            UserCommand::DiscardPartial => self.partial_gate.answer(PartialDecision::Discard),
            UserCommand::RetryPartial => self.partial_gate.answer(PartialDecision::Retry),
        }
        Ok(JobCommandAck::Accepted)
    }

    /// Borrow the snapshot stream. Snapshots arrive in seq order; exactly
    /// one carries the terminal.
    pub fn snapshots(&self) -> &mpsc::Receiver<JobSnapshot> {
        &self.snapshot_rx
    }

    /// Wait for quiescence and take the terminal. Joins the driver thread,
    /// so cleanup (uncommitted temp files, gate state) is owned here.
    pub fn join(mut self) -> Terminal {
        self.join
            .take()
            .map(|handle| {
                handle.join().unwrap_or(Terminal::Failed(NativeError::new(
                    "native.internal",
                    "native job thread failed",
                )))
            })
            .unwrap_or(Terminal::Failed(NativeError::new(
                "native.internal",
                "native job already joined",
            )))
    }
}

fn run_job(
    id: &str,
    options: &JobOptions,
    config: &PipelineConfig,
    snapshots: &mpsc::Sender<JobSnapshot>,
    cancel_flag: &AtomicBool,
    _gate: &PartialGate,
) -> Terminal {
    let mut seq: u64 = 0;
    let mut lifecycle = Lifecycle::Discovering;
    let mut acquired: u64 = 0;
    let mut total: u64 = 0;
    let mut emit = |lifecycle_next: Lifecycle,
                    acquired_next: u64,
                    total_next: u64,
                    terminal: Option<Terminal>| {
        seq = seq.saturating_add(1);
        lifecycle = lifecycle_next.clone();
        acquired = acquired_next;
        total = total_next;
        let _ = snapshots.send(JobSnapshot {
            job: id.to_string(),
            seq,
            lifecycle: lifecycle_next,
            acquired: acquired_next,
            total: total_next,
            terminal,
        });
    };
    emit(Lifecycle::Discovering, 0, 0, None);
    let result = match &options.output {
        OutputTarget::File(path) => {
            let output = path.to_string_lossy().into_owned();
            pipeline::run(
                &options.input_url,
                &output,
                options.overwrite,
                config,
                &mut |event: PipelineEvent| {
                    project_event(&event, &mut lifecycle, &mut acquired, &mut total);
                    seq = seq.saturating_add(1);
                    let _ = snapshots.send(JobSnapshot {
                        job: id.to_string(),
                        seq,
                        lifecycle: lifecycle.clone(),
                        acquired,
                        total,
                        terminal: None,
                    });
                },
            )
        }
        OutputTarget::AutoDir { dir, format } => pipeline::run_auto_named(
            &options.input_url,
            dir,
            *format,
            config,
            &mut |event: PipelineEvent| {
                project_event(&event, &mut lifecycle, &mut acquired, &mut total);
                seq = seq.saturating_add(1);
                let _ = snapshots.send(JobSnapshot {
                    job: id.to_string(),
                    seq,
                    lifecycle: lifecycle.clone(),
                    acquired,
                    total,
                    terminal: None,
                });
            },
        ),
    };
    let terminal = match result {
        Ok(outcome) => {
            if cancel_flag.load(Ordering::SeqCst) {
                // The commit point already refuses to publish once
                // cancellation was requested; reaching here with the flag set
                // means the race resolved before commit, so report cancel.
                Terminal::Cancelled
            } else {
                Terminal::Completed(OutputSummary {
                    path: outcome.output_path,
                    tile_count: outcome.tile_count,
                    width: outcome.image_size.x,
                    height: outcome.image_size.y,
                    format: outcome.format,
                    partial: outcome.partial,
                    missing: outcome.missing,
                })
            }
        }
        Err(error) if error.code == "job.cancelled" => Terminal::Cancelled,
        Err(error) => {
            if cancel_flag.load(Ordering::SeqCst) {
                Terminal::Cancelled
            } else {
                Terminal::Failed(error)
            }
        }
    };
    seq = seq.saturating_add(1);
    let _ = snapshots.send(JobSnapshot {
        job: id.to_string(),
        seq,
        lifecycle: lifecycle.clone(),
        acquired,
        total,
        terminal: Some(terminal.clone()),
    });
    terminal
}

fn project_event(
    event: &PipelineEvent,
    lifecycle: &mut Lifecycle,
    acquired: &mut u64,
    total: &mut u64,
) {
    match event {
        PipelineEvent::Discovery { .. } => *lifecycle = Lifecycle::Discovering,
        PipelineEvent::Downloading {
            acquired: next_acquired,
            total: next_total,
        } => {
            *lifecycle = Lifecycle::AcquiringTiles;
            *acquired = (*acquired).max(*next_acquired);
            *total = (*total).max(*next_total);
        }
        PipelineEvent::Encoding { .. } => *lifecycle = Lifecycle::Finalizing,
        PipelineEvent::RecoveryRequested { .. } => {
            *lifecycle = Lifecycle::AwaitingPartialDecision;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dezoomify-native-runner-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn scenario_payload(name: &str) -> Vec<u8> {
        std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli")
                .join(name),
        )
        .unwrap_or_else(|e| panic!("read payload {name}: {e}"))
    }

    /// Local `tiles.yaml` plus `tiles` present: file or `tiles` omitted.
    fn write_local_job(work: &std::path::Path, present: &[&str]) -> PathBuf {
        for tile in present {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            std::fs::write(work.join(format!("tile-{tile}.png")), &bytes).expect("write tile");
        }
        let dir = work.to_str().expect("utf8 dir").to_string();
        let yaml = format!(
            "url_template: \"file://{dir}/tile-{{{{x}}}}_{{{{y}}}}.png\"\n\
             x_template: \"x * tile_size\"\n\
             y_template: \"y * tile_size\"\n\
             variables:\n\
             \x20 - {{ name: x, from: 0, to: 1 }}\n\
             \x20 - {{ name: y, from: 0, to: 1 }}\n\
             \x20 - {{ name: tile_size, value: 256 }}\n\
             width: 512\n\
             height: 512\n\
             title: \"Runner tiles\"\n"
        );
        let manifest = work.join("tiles.yaml");
        std::fs::write(&manifest, yaml.as_bytes()).expect("write manifest");
        manifest
    }

    fn drain_until_terminal(job: &RunningJob) -> Vec<JobSnapshot> {
        let mut snapshots = Vec::new();
        loop {
            let snapshot = job
                .snapshots()
                .recv_timeout(Duration::from_secs(60))
                .expect("snapshot arrives");
            assert_eq!(snapshot.job, job.id, "snapshots stay job-scoped");
            let done = snapshot.terminal.is_some();
            snapshots.push(snapshot);
            if done {
                return snapshots;
            }
        }
    }

    #[test]
    fn local_input_completes_with_ordered_snapshots() {
        let work = temp_dir("complete");
        let manifest = write_local_job(&work, &["0_0", "1_0", "0_1", "1_1"]);
        let output = work.join("runner.png");
        let job = NativeRunner::start(JobOptions {
            input_url: manifest.to_str().expect("utf8").to_string(),
            output: OutputTarget::File(output.clone()),
            ..Default::default()
        })
        .expect("runner starts");
        // Wait for the terminal through the stream, then join for completion.
        let snapshots = drain_until_terminal(&job);
        assert!(snapshots.len() >= 2, "started plus terminal snapshots");
        let mut last_seq = 0;
        let mut terminals = 0;
        for snapshot in &snapshots {
            assert!(
                snapshot.seq > last_seq,
                "seq stays monotonic: {} -> {}",
                last_seq,
                snapshot.seq
            );
            last_seq = snapshot.seq;
            if snapshot.terminal.is_some() {
                terminals += 1;
            }
        }
        assert_eq!(terminals, 1, "exactly one terminal snapshot");
        // The driver has exited once the terminal snapshot arrives (the
        // worker clears liveness right after): post-terminal commands are
        // rejected, never applied to a later job.
        let start = std::time::Instant::now();
        loop {
            if job.send(UserCommand::KeepPartial) == Err(CommandRejected { code: "job.stale" }) {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "driver exits promptly after its terminal"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        match job.join() {
            Terminal::Completed(summary) => {
                assert_eq!(summary.tile_count, 4);
                assert_eq!((summary.width, summary.height), (512, 512));
                assert!(!summary.partial);
                assert!(summary.missing.is_empty());
                assert_eq!(summary.path, output);
                assert!(output.exists(), "completed output is published");
            }
            other => panic!("local job completes, got {other:?}"),
        }
    }

    #[test]
    fn invalid_options_fail_before_any_effect() {
        let bad_input = NativeRunner::start(JobOptions {
            input_url: String::new(),
            ..Default::default()
        })
        .expect_err("empty input rejected");
        assert_eq!(bad_input.code, "job.invalid-input");
        let bad_output = NativeRunner::start(JobOptions {
            input_url: "https://example.com/x.dzi".to_string(),
            output: OutputTarget::File(PathBuf::from("out.bmp")),
            ..Default::default()
        })
        .expect_err("unsupported extension rejected");
        assert_eq!(bad_output.code, "output.unsupported-extension");
        let userinfo = NativeRunner::start(JobOptions {
            input_url: "https://user:pass@example.com/x.dzi".to_string(),
            ..Default::default()
        })
        .expect_err("userinfo rejected");
        assert_eq!(userinfo.code, "job.invalid-input");
    }

    #[test]
    fn cancel_during_partial_wait_publishes_nothing() {
        // One tile missing: the driver announces the partial decision and
        // waits on the gate. Cancelling then must quiesce without publishing
        // anything: no output, no `.partial` sibling, and a pre-existing
        // destination stays byte-identical.
        let work = temp_dir("cancel-partial");
        let manifest = write_local_job(&work, &["0_0", "1_0", "0_1"]);
        let output = work.join("cancel.png");
        std::fs::write(&output, b"pre-existing sentinel").expect("sentinel");
        let job = NativeRunner::start(JobOptions {
            input_url: manifest.to_str().expect("utf8").to_string(),
            output: OutputTarget::File(output.clone()),
            overwrite: true,
            ..Default::default()
        })
        .expect("runner starts");
        // Wait for the partial-decision snapshot, then cancel.
        loop {
            let snapshot = job
                .snapshots()
                .recv_timeout(Duration::from_secs(60))
                .expect("snapshot arrives");
            if snapshot.lifecycle == Lifecycle::AwaitingPartialDecision {
                break;
            }
            assert!(
                snapshot.terminal.is_none(),
                "no terminal before the partial decision"
            );
        }
        assert_eq!(
            job.send(UserCommand::Cancel),
            Ok(JobCommandAck::Accepted),
            "cancel accepted while awaiting the partial decision"
        );
        match job.join() {
            Terminal::Cancelled => {}
            other => panic!("cancel wins, got {other:?}"),
        }
        assert_eq!(
            std::fs::read(&output).expect("sentinel readable"),
            b"pre-existing sentinel",
            "cancel never touches the pre-existing destination"
        );
        assert!(
            !work.join("cancel.partial.png").exists(),
            "cancel publishes no partial sibling either"
        );
    }
}
