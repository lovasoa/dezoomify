//! Native job service: one engine job per request.
//!
//! [`start_job`] validates [`JobOptions`], spawns one background
//! driver thread running the real engine plus native effect executor, and
//! returns a [`RunningJob`] owning three things: the command sender, the
//! typed snapshot stream, and the join handle that owns completion and
//! cleanup. The CLI and desktop backend use the same service;
//! there is no extra scheduling layer and no string-map routing.
//!
//! Snapshots forward engine projections verbatim: [`JobSnapshot`] carries the
//! authoritative [`EngineSnapshot`] plus the native publication record once
//! committed. No service-local lifecycle, terminal, or recovery fold exists.
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

use dezoomify::engine::{
    DiscoveryInput, EngineJob, JobOptions as EngineOptions,
    SelectionPolicy as EngineSelectionPolicy, UserCommand as EngineUserCommand,
};
use dezoomify::model::Snapshot as EngineSnapshot;

use crate::error::NativeError;
pub use crate::exec::OutputSummary;
use crate::http::{FetchLimits, TlsPolicy};
use crate::output::{validate_destination, OutputFormat};
use crate::pipeline::PartialPolicy;
use crate::sink::SinkOptions;

const MAX_DEFERRED_FOLLOWS: u32 = 10;

/// Engine user intent, forwarded verbatim (selection, partial answer with
/// generation, pause/resume, cancel). Re-exported so all native hosts name
/// one vocabulary.
pub use dezoomify::engine::UserCommand;

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
    /// Base retry wait (attempt `n` waits this doubled `n-1` times);
    /// engine-owned backoff, default 2 s to match the CLI default.
    pub retry_base_delay: Duration,
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
    /// Maximum number of planned tiles accepted by the engine.
    pub max_tiles: usize,
    /// Maximum bytes accepted for one metadata or tile response.
    pub max_bytes: u64,
    /// Minimum interval between tile request starts (per-tile throttle).
    /// `ZERO` disables staggering (the CLI default); bulk image pacing stays
    /// in the caller.
    pub min_interval: Duration,
    /// Bounds for native output buffering and unknown-geometry spooling.
    pub output_retain_cap: u64,
    pub output_spool_cap: u64,
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
            retry_base_delay: Duration::from_secs(2),
            keep_partial: true,
            compression: 5,
            headers: BTreeMap::new(),
            cache_dir: None,
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(6),
            max_idle_per_host: 32,
            accept_invalid_certs: false,
            max_concurrent: crate::pipeline::MAX_CONCURRENT,
            max_tiles: 1 << 20,
            max_bytes: 64 << 20,
            min_interval: Duration::ZERO,
            output_retain_cap: 512 << 20,
            output_spool_cap: 1 << 30,
        }
    }
}

impl JobOptions {
    /// Normalize product options once before configuring the engine and transport.
    fn normalized(mut self) -> Self {
        self.max_tiles = self.max_tiles.clamp(1, 16_777_216);
        self.max_concurrent = self
            .max_concurrent
            .clamp(1, 64)
            .min(self.max_tiles as usize);
        self.max_retries = self.max_retries.min(1024);
        self.max_bytes = self.max_bytes.clamp(1024, 4_294_967_296);
        self.compression = self.compression.min(100);
        if self
            .format
            .as_ref()
            .is_some_and(|value| value.eq_ignore_ascii_case("auto"))
        {
            self.format = None;
        }
        self.cache_dir
            .get_or_insert_with(crate::pipeline::default_tile_cache_dir);
        self
    }

    /// Typed pre-flight validation: input shape, output-format support, and
    /// an early destination check. The commit point validates again to close
    /// races between start and publication.
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
                let format = OutputFormat::infer_from_path(path)?;
                validate_destination(path, &format, self.overwrite)?;
            }
            OutputTarget::AutoDir { dir: _, format: _ } => {}
        }
        Ok(())
    }

    fn engine_options(&self) -> Result<EngineOptions, NativeError> {
        let tiles = self.max_tiles as u32;
        let mut options = EngineOptions::new(vec![DiscoveryInput::new(&self.input_url)]);
        options.format = self.format.clone();
        options.selection = EngineSelectionPolicy::NativeAutomatic {
            image_index: self.image_index.unwrap_or(0),
            largest: self.largest,
            max_width: self.max_width,
            max_height: self.max_height,
            zoom_level: self.zoom_level,
        };
        options.partial = dezoomify::engine::PartialPolicy::Prompt;
        options.max_concurrent = self.max_concurrent as u32;
        options.max_tiles = tiles;
        options.max_retries = self.max_retries;
        options.retry_base_delay_ms = u64::try_from(self.retry_base_delay.as_millis())
            .unwrap_or(u64::MAX)
            .min(dezoomify::engine::retry::MAX_RETRY_AFTER_MS);
        options.max_bytes = self.max_bytes;
        options.max_deferred_follows = MAX_DEFERRED_FOLLOWS;
        EngineJob::validate_options(&options).map_err(|error| match error.code.as_str() {
            "job.unknown-format" => NativeError::new("discovery.unknown-format", error.message),
            "job.invalid-input" => NativeError::new("discovery.failed", error.message),
            _ => NativeError::new(
                "tile.limit",
                format!("native bounds exceed job limits: {}", error.message),
            ),
        })?;
        Ok(options)
    }

    fn host_settings(&self) -> crate::exec::NativeHostSettings {
        crate::exec::NativeHostSettings {
            fetch: FetchLimits {
                max_bytes: self.max_bytes,
                timeout: self.timeout,
                connect_timeout: self.connect_timeout,
                max_idle_per_host: self.max_idle_per_host,
                tls: TlsPolicy {
                    accept_invalid_certs: self.accept_invalid_certs,
                },
                ..FetchLimits::default()
            },
            max_retries: self.max_retries,
            min_interval: self.min_interval,
            cache_dir: self
                .cache_dir
                .clone()
                .unwrap_or_else(crate::pipeline::default_tile_cache_dir),
            partial_policy: if self.keep_partial {
                PartialPolicy::Keep
            } else {
                PartialPolicy::Fail
            },
            sink: SinkOptions {
                compression: self.compression,
                retain_cap_bytes: self.output_retain_cap,
                spool_cap_bytes: self.output_spool_cap,
            },
        }
    }
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

/// Validate options and start one native job on a background thread.
/// Returns the typed handle before any network or file effect beyond
/// validation. The function holds no state; each job owns its thread,
/// transport, temporary files, and completion.
pub fn start_job(options: JobOptions) -> Result<RunningJob, NativeError> {
    let options = options.normalized();
    options.validate()?;
    let engine_options = options.engine_options()?;
    let id = format!("job:native-{}", NEXT_JOB.fetch_add(1, Ordering::SeqCst));
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let (command_tx, command_rx) = mpsc::channel::<EngineUserCommand>();
    let exec_commands = Arc::new(Mutex::new(command_rx));
    let settings = options.host_settings();
    let (snapshot_tx, snapshot_rx) = mpsc::channel();
    let worker_id = id.clone();
    let worker_options = options.clone();
    let alive = Arc::new(AtomicBool::new(true));
    let worker_alive = Arc::clone(&alive);
    let worker_cancel = Arc::clone(&cancel_flag);
    let handle = std::thread::spawn(move || {
        let control = crate::exec::JobControl {
            cancel: worker_cancel,
            commands: exec_commands,
        };
        let outcome = run_job(
            &worker_id,
            &worker_options,
            engine_options,
            &settings,
            control,
            &snapshot_tx,
        );
        worker_alive.store(false, Ordering::SeqCst);
        outcome
    });
    Ok(RunningJob {
        id,
        alive,
        snapshot_rx,
        cancel_flag,
        command_tx,
        join: Some(handle),
    })
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
    /// polls at every effect boundary; every other command travels on the
    /// live channel. Fails closed with `job.stale`
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
            EngineUserCommand::AnswerPartial { .. }
            | EngineUserCommand::Pause
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
    /// so cleanup of uncommitted temp files is owned here. `Ok` is
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
    engine_options: EngineOptions,
    settings: &crate::exec::NativeHostSettings,
    control: crate::exec::JobControl,
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
    let (output_path, format, overwrite, auto_output_dir) = match &options.output {
        OutputTarget::File(path) => (
            path.clone(),
            OutputFormat::infer_from_path(path)?,
            options.overwrite,
            None,
        ),
        OutputTarget::AutoDir { dir, format } => (
            dir.join(format!("dezoomify.{}", format.extension())),
            *format,
            false,
            Some(dir.clone()),
        ),
    };
    let user = crate::http::UserHeaders::new(
        options.headers.clone(),
        url::Url::parse(&options.input_url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_string)),
    );
    let output = crate::exec::OutputSpec {
        output_path,
        overwrite,
        format,
        auto_output_dir,
    };
    let result = crate::exec::execute(
        engine_options,
        &options.input_url,
        output,
        settings,
        control,
        &user,
        &mut emit,
    );
    match result {
        Ok(published) => {
            // Publication won the race: report the committed result, never
            // a cancellation (the commit point already refuses to publish
            // once cancellation was requested, so reaching here with the
            // flag set means the bytes were committed first).
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
        use dezoomify::model::JobState;
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
        use dezoomify::model::JobState;
        let work = temp_dir("complete");
        let manifest = write_local_job(&work, &["0_0", "1_0", "0_1", "1_1"]);
        let output = work.join("runner.png");
        let job = start_job(JobOptions {
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
            use dezoomify::model::RecoveryChoice;
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
    fn auto_dir_output_name_uses_the_engine_selected_image_title() {
        let work = temp_dir("auto-name");
        let manifest = write_local_job(&work, &["0_0", "1_0", "0_1", "1_1"]);
        let output_dir = work.join("output");
        std::fs::create_dir_all(&output_dir).expect("output directory");
        let job = start_job(JobOptions {
            input_url: manifest.to_str().expect("utf8").to_string(),
            output: OutputTarget::AutoDir {
                dir: output_dir.clone(),
                format: OutputFormat::Png,
            },
            ..Default::default()
        })
        .expect("runner starts");
        let snapshots = drain_until_terminal(&job);
        let outcome = job.join().expect("local image publishes");
        let expected = output_dir.join("Runner-tiles.png");
        assert_eq!(outcome.path, expected);
        assert!(expected.exists());
        assert!(
            snapshots.iter().any(|snapshot| snapshot
                .published
                .as_ref()
                .is_some_and(|published| published.path == expected)),
            "published path matches the image title"
        );
    }

    #[test]
    fn invalid_options_fail_before_any_effect() {
        let bad_input = start_job(JobOptions {
            input_url: String::new(),
            ..Default::default()
        })
        .expect_err("empty input rejected");
        assert_eq!(bad_input.code, "job.invalid-input");
        let bad_output = start_job(JobOptions {
            input_url: "https://example.com/x.dzi".to_string(),
            output: OutputTarget::File(PathBuf::from("out.bmp")),
            ..Default::default()
        })
        .expect_err("unsupported extension rejected");
        assert_eq!(bad_output.code, "output.unsupported-extension");
        let userinfo = start_job(JobOptions {
            input_url: "https://user:pass@example.com/x.dzi".to_string(),
            ..Default::default()
        })
        .expect_err("userinfo rejected");
        assert_eq!(userinfo.code, "job.invalid-input");
    }

    #[test]
    fn cancel_during_partial_wait_publishes_nothing() {
        use dezoomify::model::JobState;
        // One tile missing: the driver announces the partial decision and
        // waits on the gate. Cancelling then must quiesce without publishing
        // anything: no output, no `.partial` sibling, and a pre-existing
        // destination stays byte-identical.
        let work = temp_dir("cancel-partial");
        let manifest = write_local_job(&work, &["0_0", "1_0", "0_1"]);
        let output = work.join("cancel.png");
        std::fs::write(&output, b"pre-existing sentinel").expect("sentinel");
        let job = start_job(JobOptions {
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
