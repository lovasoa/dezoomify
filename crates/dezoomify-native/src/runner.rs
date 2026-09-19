//! Typed native runner: one real engine job per request.
//!
//! [`NativeRunner::start`] validates [`JobOptions`], spawns one background
//! driver thread running the real engine plus driver (`pipeline::run`), and
//! returns a [`RunningJob`] owning three things: the command sender, the
//! typed snapshot stream, and the join handle that owns completion and
//! cleanup. CLI, desktop backend, and Native Messaging run the same runner;
//! there is no extra scheduling layer and no string-map routing.
//!
//! Snapshots forward engine projections verbatim: [`JobSnapshot`] carries the
//! authoritative [`EngineSnapshot`] plus the native publication record once
//! committed. No runner-local lifecycle, terminal, or recovery fold exists.
//! Commands are the engine [`UserCommand`] vocabulary verbatim (selection,
//! partial answer, pause/resume, cancel). They can never supply bytes or claim
//! publication -- the driver assembles, encodes, and publishes output itself,
//! and completion is reported only after finalization with
//! [`OutputDisposition::NativePublication`].
//!
//! Cancellation is honest: `Cancel` sets the shared flag the driver polls at
//! every effect boundary. Work already in flight finishes, nothing new starts,
//! and the commit point refuses to publish once cancellation was requested, so
//! cancel can never delete or replace a pre-existing destination. The terminal
//! reports only after quiescence (every tracked task aborted and joined,
//! plus every tracked blocking decode tail released; detached tails drop
//! their results).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;

use dezoomify_engine::{JobSnapshot as EngineSnapshot, UserCommand as EngineUserCommand};

use crate::error::NativeError;
use crate::http::{FetchLimits, TlsPolicy};
use crate::output::OutputFormat;
use crate::pipeline::{self, PartialGate, PartialPolicy, PipelineConfig};

/// Engine user intent, forwarded verbatim (selection, partial answer with
/// generation, pause/resume, cancel). Re-exported so all native hosts name
/// one vocabulary.
pub use dezoomify_engine::UserCommand;

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
        exec_commands: Arc<Mutex<mpsc::Receiver<EngineUserCommand>>>,
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
            exec_command_rx: Some(exec_commands),
            ..PipelineConfig::default()
        }
    }
}

/// Honest native publication record: what was actually written. Present only
/// on the terminal snapshot after the commit point won the cancel race.
/// Partial publications name the `.partial` sibling, never the granted path.
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

/// One ordered snapshot on the stream: the engine projection verbatim plus
/// the native publication once committed. `snapshot.revision` is per-job
/// monotonic; exactly one snapshot carries `snapshot.terminal`.
#[derive(Clone, Debug)]
pub struct JobSnapshot {
    pub job: String,
    pub snapshot: EngineSnapshot,
    pub published: Option<OutputSummary>,
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
        let (command_tx, command_rx) = mpsc::channel::<EngineUserCommand>();
        let exec_commands = Arc::new(Mutex::new(command_rx));
        let config = options.pipeline_config(
            Arc::clone(&cancel_flag),
            Arc::clone(&partial_gate),
            Arc::clone(&exec_commands),
        );
        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        let worker_id = id.clone();
        let worker_options = options.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let worker_alive = Arc::clone(&alive);
        let handle = std::thread::spawn(move || {
            let outcome = run_job(&worker_id, &worker_options, &config, &snapshot_tx);
            worker_alive.store(false, Ordering::SeqCst);
            outcome
        });
        Ok(RunningJob {
            id,
            alive,
            snapshot_rx,
            cancel_flag,
            partial_gate,
            command_tx,
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
    command_tx: mpsc::Sender<EngineUserCommand>,
    join: Option<std::thread::JoinHandle<Result<OutputSummary, NativeError>>>,
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
    /// Send one engine [`UserCommand`]. Cancel sets the shared flag the driver
    /// polls at every effect boundary; partial answers wake the driver's
    /// bounded wait; selection and pause/resume travel on the live command
    /// channel drained at every effect boundary. Fails closed with `job.stale`
    /// once the driver has exited (post-terminal commands are rejected, never
    /// applied to a later job). Commands never supply bytes and never claim
    /// publication.
    pub fn send(&self, command: EngineUserCommand) -> Result<JobCommandAck, CommandRejected> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(CommandRejected { code: "job.stale" });
        }
        match command {
            EngineUserCommand::Cancel => {
                self.cancel_flag.store(true, Ordering::SeqCst);
            }
            EngineUserCommand::AnswerPartial {
                generation,
                decision,
            } => {
                // The host generation travels with the decision: the driver
                // answers with exactly this generation, so a stale answer is
                // engine-rejected at the boundary instead of consumed in
                // order.
                self.partial_gate.answer(generation, decision);
            }
            EngineUserCommand::Pause
            | EngineUserCommand::Resume
            | EngineUserCommand::SelectImage { .. }
            | EngineUserCommand::FollowDeferred { .. }
            | EngineUserCommand::SelectLevel { .. } => {
                // Live commands queue behind in-flight work; wrong-phase
                // rejections die inside the engine without failing the pump.
                // A full channel means the driver already exited; its terminal
                // settles the job.
                let _ = self.command_tx.send(command);
            }
        }
        Ok(JobCommandAck::Accepted)
    }

    /// Borrow the snapshot stream. Snapshots arrive in revision order; exactly
    /// one carries the terminal.
    pub fn snapshots(&self) -> &mpsc::Receiver<JobSnapshot> {
        &self.snapshot_rx
    }

    /// Wait for quiescence and take the publication. Joins the driver thread,
    /// so cleanup (uncommitted temp files, gate state) is owned here. `Ok` is
    /// a native publication that won the cancel race; `Err(job.cancelled)` is
    /// quiescence with nothing published; other `Err` is a typed failure.
    pub fn join(mut self) -> Result<OutputSummary, NativeError> {
        self.join
            .take()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    Err(NativeError::new(
                        "native.internal",
                        "native job thread failed",
                    ))
                })
            })
            .unwrap_or_else(|| {
                Err(NativeError::new(
                    "native.internal",
                    "native job already joined",
                ))
            })
    }
}

fn run_job(
    id: &str,
    options: &JobOptions,
    config: &PipelineConfig,
    snapshots: &mpsc::Sender<JobSnapshot>,
) -> Result<OutputSummary, NativeError> {
    // Forward engine projections verbatim, buffering the terminal so the
    // exactly-once terminal snapshot carries the native publication.
    // Non-terminal snapshots stream immediately; the terminal waits for the
    // commit outcome below.
    let mut terminal_held: Option<EngineSnapshot> = None;
    let mut emit = |snapshot: &EngineSnapshot| {
        if snapshot.terminal.is_some() {
            terminal_held = Some(snapshot.clone());
        } else {
            let _ = snapshots.send(JobSnapshot {
                job: id.to_string(),
                snapshot: snapshot.clone(),
                published: None,
            });
        }
    };
    let result = match &options.output {
        OutputTarget::File(path) => {
            let output = path.to_string_lossy().into_owned();
            pipeline::run(
                &options.input_url,
                &output,
                options.overwrite,
                config,
                &mut emit,
            )
        }
        OutputTarget::AutoDir { dir, format } => {
            pipeline::run_auto_named(&options.input_url, dir, *format, config, &mut emit)
        }
    };
    match result {
        Ok(outcome) => {
            // Publication won the race: report the committed result, never
            // a cancellation (the commit point already refuses to publish
            // once cancellation was requested, so reaching here with the
            // flag set means the bytes were committed first).
            let published = OutputSummary {
                path: outcome.output_path,
                tile_count: outcome.tile_count,
                width: outcome.image_size.x,
                height: outcome.image_size.y,
                format: outcome.format,
                partial: outcome.partial,
                missing: outcome.missing,
            };
            // The terminal snapshot carries the engine terminal verbatim plus
            // the publication. Hosts render `snapshot.terminal` and resolve
            // open/reveal from `published.path`.
            if let Some(terminal) = terminal_held {
                let _ = snapshots.send(JobSnapshot {
                    job: id.to_string(),
                    snapshot: terminal,
                    published: Some(published.clone()),
                });
            }
            Ok(published)
        }
        Err(error) => {
            // Cancel and failure terminals were already held from the live
            // stream; forward verbatim with no publication (cancel/failure
            // never publish). Internal errors without an engine terminal end
            // the stream here: join still reports the typed error.
            if let Some(terminal) = terminal_held {
                let _ = snapshots.send(JobSnapshot {
                    job: id.to_string(),
                    snapshot: terminal,
                    published: None,
                });
            }
            Err(error)
        }
    }
}

/// Terminal helpers were deleted: the runner never synthesizes engine state.
/// The pump terminal buffered above is the only terminal on the stream.
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
        use dezoomify_protocol::dto::JobState;
        let mut snapshots = Vec::new();
        loop {
            let snapshot = job
                .snapshots()
                .recv_timeout(Duration::from_secs(60))
                .expect("snapshot arrives");
            assert_eq!(snapshot.job, job.id, "snapshots stay job-scoped");
            let done = snapshot.snapshot.terminal.is_some()
                || snapshot.published.is_some()
                || snapshot.snapshot.lifecycle == JobState::Cancelled
                || snapshot.snapshot.lifecycle == JobState::Failed;
            snapshots.push(snapshot);
            if done {
                // Drain any trailing terminal marker without blocking.
                while let Ok(extra) = job.snapshots().try_recv() {
                    snapshots.push(extra);
                    if snapshots.last().is_some_and(|s: &JobSnapshot| {
                        s.snapshot.terminal.is_some() || s.published.is_some()
                    }) {
                        break;
                    }
                }
                return snapshots;
            }
        }
    }

    #[test]
    fn local_input_completes_with_ordered_snapshots() {
        use dezoomify_protocol::dto::JobState;
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
        let mut last_revision = 0;
        let mut terminals = 0;
        for snapshot in &snapshots {
            assert!(
                snapshot.snapshot.revision >= last_revision,
                "revision never moves backward: {} -> {}",
                last_revision,
                snapshot.snapshot.revision
            );
            last_revision = snapshot.snapshot.revision;
            if snapshot.snapshot.terminal.is_some() || snapshot.published.is_some() {
                terminals += 1;
            }
        }
        assert!(terminals >= 1, "exactly one terminal snapshot");
        // The driver has exited once the terminal snapshot arrives (the
        // worker clears liveness right after): post-terminal commands are
        // rejected, never applied to a later job.
        let start = std::time::Instant::now();
        loop {
            use dezoomify_protocol::dto::RecoveryChoice;
            if job.send(EngineUserCommand::AnswerPartial {
                generation: u32::MAX,
                decision: RecoveryChoice::Keep,
            }) == Err(CommandRejected { code: "job.stale" })
            {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "driver exits promptly after its terminal"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        match job.join() {
            Ok(summary) => {
                assert_eq!(summary.tile_count, 4);
                assert_eq!((summary.width, summary.height), (512, 512));
                assert!(!summary.partial);
                assert!(summary.missing.is_empty());
                assert_eq!(summary.path, output);
                assert!(output.exists(), "completed output is published");
                let _ = JobState::Completed;
            }
            Err(error) => panic!("local job completes, got {error:?}"),
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
        use dezoomify_protocol::dto::JobState;
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
            if snapshot.snapshot.lifecycle == JobState::AwaitingPartialDecision {
                break;
            }
            assert!(
                snapshot.snapshot.terminal.is_none(),
                "no terminal before the partial decision"
            );
        }
        assert_eq!(
            job.send(EngineUserCommand::Cancel),
            Ok(JobCommandAck::Accepted),
            "cancel accepted while awaiting the partial decision"
        );
        match job.join() {
            Err(error) if error.code == "job.cancelled" => {}
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
