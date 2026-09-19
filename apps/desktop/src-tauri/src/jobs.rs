// In-memory desktop job map backed by the shared native runner.
//
// Snapshot-only transport: the `dezoomify://job-snapshot` channel is the
// only job-state transport. Every emit is the canonical
// `EngineSnapshotDto` verbatim (revision, lifecycle, paused, progress,
// selection with catalog, decision, terminal, output) plus the `job`/`jobId`
// routing aliases, which the frontend forwards untouched to its observer.
// No transcript is stored, no legacy `job-state`/`job-progress`/
// `job-output`/`job-error` lines exist, and no per-job lifecycle, seq,
// progress, output, or terminal mirrors live here: the DTO is serialized,
// never rebuilt.
//
// The table is an id registry only: `id -> RunningJob + destination +
// options`, plus the redacted origin, the settings-selected output dir,
// the published output handle for explicit open/reveal, and the host
// `settled` boolean for exactly-once terminals. All execution (engine,
// completion-driven effects, partial gate, cancellation flag, output
// publication) lives in the runner and the pipeline it drives.
//
// Manual jobs emit the same canonical `Created` snapshot as automatic
// ones; the destination grant gates the runner start, never the payload.
// There is no `AwaitingDestination` state and no `choose-output` cue on the
// wire. Automatic (settings) starts launch the runner immediately.
//
// Error codes travel as typed fields (never string-encoded into `k=v` or
// JSON details); only the DTO crosses IPC, never tile bytes, pixels, paths,
// full URLs, or secrets.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use dezoomify_native::output::{validate_destination, OutputFormat};
use dezoomify_native::runner::{
    JobOptions, JobSnapshot as RunnerSnapshot, NativeRunner, OutputTarget, RunningJob,
    UserCommand as RunnerCommand,
};
use dezoomify_protocol::dto::{
    EngineSnapshotDto, JobState as ProtocolState, SnapshotProgressDto, SnapshotSelectionDto,
    SnapshotTerminalDto,
};

use crate::settings::{job_options_for, DesktopSettings};

/// Desktop event channels. Only the snapshot transport plus the deep-link
/// cue exist. Must stay identical to `apps/desktop/src/events.ts`
/// `DESKTOP_EVENT_CHANNELS` and the generated capability documents.
pub const CHANNEL_JOB_SNAPSHOT: &str = "dezoomify://job-snapshot";
pub const CHANNEL_DEEP_LINK: &str = "dezoomify://deep-link-pending";

/// Keys that must never cross IPC. Mirrors the frontend `FORBIDDEN_IPC_KEYS`
/// set; payloads carry only counts, hashes, and redacted context, never
/// tile bytes, pixels, or buffers.
const FORBIDDEN_IPC_SUBSTRINGS: &[&str] = &[
    "tilebytes",
    "tiledata",
    "pixels",
    "pixeldata",
    "imagebytes",
    "imagedata",
];

/// Stable phase for a native error code. Single boundary projection: delegates
/// to `dezoomify_native::error` so every host failure maps once by stable
/// code, never by display strings.
pub fn error_phase(code: &str) -> &'static str {
    dezoomify_native::error::error_phase(code)
}

/// Whether a native error code is retryable without user edits. True only
/// for transient transport/service failures; never for auth,
/// invalid-metadata, deterministic decode, limits, output, validation,
/// security, or internal errors.
pub fn error_retryable(code: &str) -> bool {
    dezoomify_native::error::error_retryable(code)
}

/// Typed recovery hint for a native error code. The frontend surfaces
/// typed choices from this (never by parsing messages). Security failures
/// never offer a weakening recovery.
pub fn error_recovery(code: &str) -> &'static str {
    dezoomify_native::error::error_recovery(code)
}

/// Attempted transport for a native error code (`native` on this runtime).
pub fn error_transport(code: &str) -> &'static str {
    dezoomify_native::error::error_transport(code)
}

/// Affected resource kind for a native error code, when safe to name.
pub fn error_resource_kind(code: &str) -> Option<&'static str> {
    dezoomify_native::error::error_resource_kind(code)
}

/// Redact credential-bearing text from messages before emit, using the
/// protocol redactor (case-insensitive key match, values replaced).
pub fn redact_message(text: &str) -> String {
    dezoomify_protocol::dto::redact_error_text(text)
}

/// Redacted job origin: scheme + host (+ port if non-default), never the
/// path, query, or fragment, which may carry credentials or tokens.
/// Pure string parsing (no network); `unknown-origin` on malformed input.
fn redact_origin(input_url: &str) -> String {
    let Some((scheme, rest)) = input_url.split_once("://") else {
        return "unknown-origin".to_string();
    };
    if scheme != "http" && scheme != "https" {
        return "unknown-origin".to_string();
    }
    let authority = rest
        .split('/')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    // Strip userinfo (rejected upstream, but it must never reach the
    // snapshot even if validation order changes).
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.is_empty() {
        return "unknown-origin".to_string();
    }
    format!("{scheme}://{host}")
}

/// True when a payload value tree contains a forbidden tile-byte key.
/// Payloads must carry only counts, hashes, and redacted context.
pub fn payload_has_forbidden_keys(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            for (key, nested) in map {
                let flat = key.to_ascii_lowercase().replace(['-', '_'], "");
                for needle in FORBIDDEN_IPC_SUBSTRINGS {
                    if flat.contains(needle) {
                        return true;
                    }
                }
                if payload_has_forbidden_keys(nested) {
                    return true;
                }
            }
            false
        }
        serde_json::Value::Array(items) => items.iter().any(payload_has_forbidden_keys),
        _ => false,
    }
}

/// Typed user choice for a live desktop job, decoded from JSON at the
/// command boundary and matched directly. Unknown shapes are rejected
/// before any effect, so no string parsing is involved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Choice {
    /// Choose a catalog image by position (pre-start option, plus live
    /// `SelectImage` when the runner is already awaiting selection).
    Image { index: usize },
    /// Choose a level of the chosen image by position (pre-start option, plus
    /// live `SelectLevel` when awaiting level selection).
    Level { index: usize },
    /// Answer a pending partial decision (keep, retry, or discard) with the
    /// engine generation when known (`generation` omitted answers the latest
    /// pending decision; stale generations are rejected by the engine).
    Partial {
        decision: dezoomify_protocol::dto::RecoveryChoice,
        #[serde(default)]
        generation: Option<u32>,
    },
    /// Pause tile acquisition (engine overlay; wrong-phase rejections are safe
    /// no-ops).
    Pause,
    /// Resume tile acquisition.
    Resume,
}

/// One tracked job: host handles only. No stored lifecycle, seq,
/// transcript, progress, output, or terminal mirrors: snapshots flow
/// verbatim from the runner and the revision rides each emit.
///
/// `Debug` is redacted on purpose: the runner options may hold the handoff
/// `Cookie` header (memory-only, never logged or cached), so only header
/// names are shown, never values.
pub struct JobEntry {
    pub id: String,
    /// Full input URL the runner fetches (never embedded in emits).
    pub input_url: String,
    /// Redacted input origin (`scheme://host`) for emit context.
    pub origin: String,
    /// Runner options: settings, handoff headers, and pre-start selections.
    /// Cloned into the runner at start; later edits never affect a live job.
    pub options: JobOptions,
    /// Live runner handle (None until a destination exists). The runner owns
    /// the engine, the partial gate, the cancel flag, and publication.
    pub runner: Option<RunningJob>,
    /// Granted save destination: the real dialog-chosen path, stored per job
    /// and passed to the runner for atomic publish. `None` until
    /// `request_destination` (or an automatic settings start).
    pub destination: Option<PathBuf>,
    /// Settings-selected output directory (`None` keeps the temp fallback
    /// for automatic saves). A host cue for the save dialog, not job state.
    pub output_dir: Option<PathBuf>,
    /// Actual published output, retained natively for explicit open/reveal
    /// actions. Set once from the runner publication; `None` until publish.
    pub saved_path: Option<PathBuf>,
    /// Terminal already forwarded exactly once. Guards stale dispatches and
    /// drops late runner snapshots; never a lifecycle mirror.
    pub settled: bool,
    /// Latest pending partial-decision generation from the verbatim engine
    /// snapshot (`None` until `AwaitingPartialDecision`). Used to answer with
    /// the engine generation; never a lifecycle mirror.
    pub pending_generation: Option<u32>,
}

impl std::fmt::Debug for JobEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let header_names: Vec<&String> = self.options.headers.keys().collect();
        f.debug_struct("JobEntry")
            .field("id", &self.id)
            .field("origin", &self.origin)
            .field("user_header_names", &header_names)
            .field("settled", &self.settled)
            .field("has_runner", &self.runner.is_some())
            .finish_non_exhaustive()
    }
}

/// One projected IPC emit: always the snapshot channel plus the
/// self-describing `JobSnapshot` payload. `seq` is the payload revision
/// (verbatim runner seq; 0/1 for synchronous host transitions).
#[derive(Debug, Clone)]
pub struct SnapshotEmit {
    pub channel: &'static str,
    pub job: String,
    pub seq: u64,
    pub payload: serde_json::Value,
}

/// In-memory map keyed by job id: the id registry plus the live runner
/// handles. No pending queue exists: mutating calls return their
/// synchronous emits directly and `poll_drivers` returns runner emits.
/// Draining never replays: each emit leaves its call exactly once.
pub struct JobTable {
    jobs: HashMap<String, JobEntry>,
    next_job: u64,
    capability_seq: u64,
}

impl std::fmt::Debug for JobTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobTable")
            .field("jobs", &self.jobs)
            .field("next_job", &self.next_job)
            .field("capability_seq", &self.capability_seq)
            .finish_non_exhaustive()
    }
}

impl Default for JobTable {
    fn default() -> Self {
        Self::new()
    }
}

/// Serialize one canonical engine DTO verbatim plus the host routing
/// aliases. The payload is exactly the DTO fields (`revision`, `lifecycle`,
/// `paused`, `progress`, `selection`, `decision`, `terminal`, `output`) plus
/// `job`/`jobId`; the DTO carries no job identity, so the aliases are the
/// only host addition. Nothing is rebuilt: the engine catalog rides
/// `selection.catalog` untouched and missing-tile ids stay engine ordinals.
/// The native publication never enters the payload; it only feeds the
/// retained `saved_path` handle for explicit open/reveal.
fn verbatim_payload(job: &str, dto: &EngineSnapshotDto) -> serde_json::Value {
    let mut value = match serde_json::to_value(dto) {
        Ok(value) => value,
        Err(_) => serde_json::Value::Null,
    };
    if let Some(map) = value.as_object_mut() {
        map.insert("job".to_string(), serde_json::json!(job));
        map.insert("jobId".to_string(), serde_json::json!(job));
    } else {
        // Serialization of the DTO is infallible in practice; this keeps the
        // routing aliases on even a degenerate value so the frontend guard
        // still drops it fail-closed instead of misrouting it.
        value = serde_json::json!({"job": job, "jobId": job});
    }
    debug_assert!(!payload_has_forbidden_keys(&value));
    value
}

/// Empty canonical selection: nothing chosen, no catalog yet, no deferred
/// entries. Shared by the synchronous host snapshots below.
fn empty_selection() -> SnapshotSelectionDto {
    SnapshotSelectionDto {
        image: None,
        level: None,
        level_count: 0,
        catalog: None,
        deferred: Vec::new(),
    }
}

/// Canonical `Created` DTO for a fresh job: revision 0, nothing selected, no
/// decision, no terminal, no output. Manual and automatic starts emit the
/// same snapshot; the destination grant gates the runner start, never the
/// payload, so there is no `choose-output` cue and no `AwaitingDestination`
/// state anywhere.
fn initial_dto() -> EngineSnapshotDto {
    EngineSnapshotDto {
        revision: 0,
        lifecycle: ProtocolState::Created,
        paused: false,
        progress: SnapshotProgressDto {
            completed: 0,
            total: None,
        },
        selection: empty_selection(),
        decision: None,
        terminal: None,
        output: None,
    }
}

/// Canonical `Cancelled` DTO for a pre-runner cancel: revision 1, the
/// `Cancelled` lifecycle plus its terminal. The runner path never produces
/// this; a live runner's cancelled terminal arrives on the snapshot stream
/// and is forwarded verbatim.
fn cancelled_dto() -> EngineSnapshotDto {
    EngineSnapshotDto {
        revision: 1,
        lifecycle: ProtocolState::Cancelled,
        paused: false,
        progress: SnapshotProgressDto {
            completed: 0,
            total: None,
        },
        selection: empty_selection(),
        decision: None,
        terminal: Some(SnapshotTerminalDto::Cancelled),
        output: None,
    }
}

impl JobTable {
    pub fn new() -> Self {
        Self {
            jobs: HashMap::new(),
            next_job: 0,
            capability_seq: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    /// Monotonic seq for capability queries (no job scope).
    pub fn capability_seq(&mut self) -> u64 {
        self.capability_seq = self.capability_seq.saturating_add(1);
        self.capability_seq
    }

    /// Snapshot of the granted destination, if any.
    pub fn destination_for(&self, job: &str) -> Option<PathBuf> {
        self.jobs.get(job).and_then(|r| r.destination.clone())
    }

    /// Actual published output for explicit open/reveal. Set once from the
    /// runner terminal; `None` until a completed publish.
    pub fn saved_output_for(&self, job: &str) -> Option<PathBuf> {
        self.jobs.get(job).and_then(|r| r.saved_path.clone())
    }

    /// Snapshot of the settings-selected output directory, if any.
    pub fn output_dir_for(&self, job: &str) -> Option<PathBuf> {
        self.jobs.get(job).and_then(|r| r.output_dir.clone())
    }

    /// Snapshot of the runner options for a job (test helper).
    #[cfg(test)]
    pub fn options_for(&self, job: &str) -> Option<JobOptions> {
        self.jobs.get(job).map(|r| r.options.clone())
    }

    /// Whether the runner is live for a job (test helper).
    #[cfg(test)]
    pub fn has_runner(&self, job: &str) -> bool {
        self.jobs.get(job).is_some_and(|r| r.runner.is_some())
    }

    /// Whether a terminal was already forwarded for a job (test helper).
    #[cfg(test)]
    pub fn is_settled(&self, job: &str) -> bool {
        self.jobs.get(job).is_some_and(|r| r.settled)
    }

    /// Test-only verbatim injection: forward one synthetic runner snapshot
    /// through the production forwarder (no I/O). Used by command tests to
    /// cover terminal kinds without a live driver.
    #[cfg(test)]
    pub fn inject_runner_snapshot(
        &mut self,
        job: &str,
        snapshot: &RunnerSnapshot,
    ) -> Option<SnapshotEmit> {
        self.forward_runner_snapshot(job, snapshot)
    }

    fn require_live(&self, job: &str) -> Result<(), String> {
        match self.jobs.get(job) {
            None => Err("unknown".to_string()),
            Some(record) if record.settled => Err("stale".to_string()),
            Some(_) => Ok(()),
        }
    }

    /// Create one job entry with the given runner options. Validates the
    /// input URL shape and mints `job:n`. Returns the id plus the initial
    /// canonical `Created` snapshot emit. No runner starts here: a
    /// destination (dialog grant or automatic directory) starts it.
    fn start_entry_with_options(
        &mut self,
        input_url: &str,
        mut options: JobOptions,
        output_dir: Option<PathBuf>,
    ) -> Result<(String, SnapshotEmit), String> {
        if input_url.is_empty() || input_url.len() > 2048 {
            return Err("input_url must be 1..2048 bytes".to_string());
        }
        if !(input_url.starts_with("http://") || input_url.starts_with("https://")) {
            return Err("input_url must be http(s)".to_string());
        }
        // Reject userinfo credentials embedded in the authority section
        // (parity with the commands-layer `is_valid_input_url` gate; secrets
        // never enter the table, snapshots, or runner).
        if let Some(after_scheme) = input_url.split("://").nth(1) {
            let authority = after_scheme.split('/').next().unwrap_or("");
            let authority = authority.split('?').next().unwrap_or(authority);
            if authority.contains('@') {
                return Err("input_url must not contain userinfo".to_string());
            }
        }
        let n = self.next_job;
        self.next_job = self.next_job.saturating_add(1);
        let id = format!("job:{n}");

        // The runner fetches the input URL; only the redacted origin
        // (scheme://host) ever reaches emits, never the full URL.
        options.input_url = input_url.to_string();
        let origin = redact_origin(input_url);

        self.jobs.insert(
            id.clone(),
            JobEntry {
                id: id.clone(),
                input_url: input_url.to_string(),
                origin: origin.clone(),
                options,
                runner: None,
                destination: None,
                output_dir,
                saved_path: None,
                settled: false,
                pending_generation: None,
            },
        );
        let payload = verbatim_payload(&id, &initial_dto());
        debug_assert!(!payload_has_forbidden_keys(&payload));
        Ok((
            id.clone(),
            SnapshotEmit {
                channel: CHANNEL_JOB_SNAPSHOT,
                job: id,
                seq: 0,
                payload,
            },
        ))
    }

    /// Start one job and return its id plus the initial canonical `Created`
    /// snapshot emit immediately (never blocks on I/O). The job awaits the
    /// destination grant until `request_destination` supplies a path; the
    /// snapshot itself carries no cue for it.
    pub fn start_job(&mut self, input_url: &str) -> Result<(String, SnapshotEmit), String> {
        self.start_entry_with_options(input_url, JobOptions::default(), None)
    }

    /// Start one handoff job with origin-scoped trusted headers (memory-only).
    ///
    /// `user_headers` carries the consented `Cookie` header for the input
    /// origin (or is empty for a cookieless handoff). The map lives in the
    /// job's runner options RAM only: never logged (see the redacted `Debug`
    /// above), never written to disk, and never inserted into the tile cache
    /// (bodies only). Origin scoping itself is enforced by the caller
    /// (`native_host::host`) before this call and by the native `UserHeaders`
    /// layer at fetch time (credentials only to the input host).
    pub fn start_job_with_user_headers(
        &mut self,
        input_url: &str,
        user_headers: BTreeMap<String, String>,
    ) -> Result<(String, SnapshotEmit), String> {
        let options = JobOptions {
            headers: user_headers,
            ..JobOptions::default()
        };
        self.start_entry_with_options(input_url, options, None)
    }

    /// Start one job with validated desktop settings (compression,
    /// retries, caps, cache dir, trusted headers, output folder, and format).
    /// Bounds are enforced by `settings::parse_settings` before this call;
    /// the fixed transport mirrors the CLI (`job_options_for`).
    pub fn start_job_with_settings(
        &mut self,
        input_url: &str,
        settings: &DesktopSettings,
    ) -> Result<(String, SnapshotEmit), String> {
        let options = job_options_for(settings);
        let output_dir = settings.output_dir.clone();
        let (id, initial) = self.start_entry_with_options(input_url, options, output_dir)?;
        // Automatic settings starts save without a dialog: the runner
        // derives the file name from the selected catalog title inside the
        // native driver.
        let options = {
            let record = self
                .jobs
                .get(&id)
                .ok_or_else(|| "job disappeared before runner start".to_string())?;
            let mut options = record.options.clone();
            options.output = OutputTarget::AutoDir {
                dir: record.output_dir.clone().unwrap_or_else(std::env::temp_dir),
                format: output_format_for_id(&settings.output_format).unwrap_or(OutputFormat::Png),
            };
            options
        };
        // A startup failure is a command failure, before a runner exists or
        // an engine snapshot can be authoritative. Remove the unannounced
        // registry entry so a later command cannot observe a stale phantom.
        let runner = match NativeRunner::start(options.clone()) {
            Ok(runner) => runner,
            Err(error) => {
                self.jobs.remove(&id);
                return Err(error.to_string());
            }
        };
        if let Some(record) = self.jobs.get_mut(&id) {
            record.options = options;
            record.runner = Some(runner);
        }
        Ok((id, initial))
    }

    /// Cancel a live job. Forwards one `Cancel` to the runner (the shared
    /// flag the driver polls at every effect boundary; work in flight
    /// finishes, nothing new starts, and the commit point refuses to
    /// publish, so no output appears on the cancel path). Pre-runner jobs
    /// finish immediately with one `Cancelled` snapshot emit: no pipeline
    /// could have published output before a destination existed. Terminal
    /// jobs report stale; missing jobs report unknown.
    pub fn cancel_job(&mut self, job: &str) -> Result<(u64, Vec<SnapshotEmit>), String> {
        self.poll_snapshots();
        self.require_live(job)?;
        let has_runner = self.jobs.get(job).is_some_and(|r| r.runner.is_some());
        if !has_runner {
            // No runner ever started: nothing to clean up, finish now with
            // exactly one canonical `Cancelled` emit.
            if let Some(record) = self.jobs.get_mut(job) {
                record.settled = true;
            }
            let payload = verbatim_payload(job, &cancelled_dto());
            return Ok((
                1,
                vec![SnapshotEmit {
                    channel: CHANNEL_JOB_SNAPSHOT,
                    job: job.to_string(),
                    seq: 1,
                    payload,
                }],
            ));
        }
        if let Some(record) = self.jobs.get(job) {
            if let Some(runner) = record.runner.as_ref() {
                // A rejected send means the driver already exited; its
                // terminal is on the stream and settles the job below.
                let _ = runner.send(RunnerCommand::Cancel);
            }
        }
        // The runner owns quiescence: the cancelled terminal arrives on the
        // snapshot stream and is forwarded by `poll_drivers`.
        Ok((0, Vec::new()))
    }

    /// Pause tile acquisition for a live job via the engine `Pause` command
    /// (overlay; wrong-phase rejections are safe no-ops). Pre-runner jobs
    /// have nothing to pause yet and resolve silently; the paused flag
    /// arrives on the next verbatim runner snapshot. Terminal jobs report
    /// stale; missing jobs report unknown.
    pub fn pause_job(&mut self, job: &str) -> Result<(u64, Vec<SnapshotEmit>), String> {
        self.answer_choice(job, &Choice::Pause)
    }

    /// Resume tile acquisition for a live job via the engine `Resume`
    /// command. Same routing and staleness rules as [`Self::pause_job`].
    pub fn resume_job(&mut self, job: &str) -> Result<(u64, Vec<SnapshotEmit>), String> {
        self.answer_choice(job, &Choice::Resume)
    }

    /// Answer an image/level choice for a live job, resolve a pending
    /// partial decision, or pause/resume acquisition.
    ///
    /// Image/level selections fold into the runner options so the runner
    /// plans the chosen image/level when it starts, plus a live engine
    /// command when the runner is already awaiting selection (wrong-phase
    /// rejections are safe no-ops). Partial keep/discard/retry forward to the
    /// live runner with the engine generation (early answers survive; stale
    /// generations are rejected by the engine), and the terminal outcome
    /// arrives as the next runner snapshot. Pause/resume forward live
    /// (wrong-phase safe). No snapshot is emitted synchronously: pre-runner
    /// choices update options silently and live answers resolve through the
    /// runner stream.
    pub fn answer_choice(
        &mut self,
        job: &str,
        choice: &Choice,
    ) -> Result<(u64, Vec<SnapshotEmit>), String> {
        self.poll_snapshots();
        self.require_live(job)?;
        match *choice {
            Choice::Partial {
                decision,
                generation,
            } => {
                use dezoomify_protocol::dto::RecoveryChoice as WireDecision;
                let generation = generation.or_else(|| {
                    self.jobs
                        .get(job)
                        .and_then(|record| record.pending_generation)
                });
                if let Some(generation) = generation {
                    if let Some(record) = self.jobs.get(job) {
                        if let Some(runner) = record.runner.as_ref() {
                            let _ = runner.send(RunnerCommand::AnswerPartial {
                                generation,
                                decision,
                            });
                        }
                    }
                }
                // Keep/discard update the fallback policy so a timeout
                // stays honest to the last explicit choice. Retry never
                // changes the fallback policy.
                if let Some(record) = self.jobs.get_mut(job) {
                    if decision != WireDecision::Retry {
                        record.options.keep_partial = decision == WireDecision::Keep;
                    }
                }
            }
            Choice::Image { index } => {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.options.image_index = Some(index);
                }
                if let Some(record) = self.jobs.get(job) {
                    if let Some(runner) = record.runner.as_ref() {
                        let image = u32::try_from(index).unwrap_or(u32::MAX);
                        let _ = runner.send(RunnerCommand::SelectImage { image });
                    }
                }
            }
            Choice::Level { index } => {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.options.zoom_level = Some(index);
                }
                if let Some(record) = self.jobs.get(job) {
                    if let Some(runner) = record.runner.as_ref() {
                        let level = u32::try_from(index).unwrap_or(u32::MAX);
                        let _ = runner.send(RunnerCommand::SelectLevel { level });
                    }
                }
            }
            Choice::Pause => {
                if let Some(record) = self.jobs.get(job) {
                    if let Some(runner) = record.runner.as_ref() {
                        let _ = runner.send(RunnerCommand::Pause);
                    }
                }
            }
            Choice::Resume => {
                if let Some(record) = self.jobs.get(job) {
                    if let Some(runner) = record.runner.as_ref() {
                        let _ = runner.send(RunnerCommand::Resume);
                    }
                }
            }
        }
        Ok((0, Vec::new()))
    }

    /// Record a save destination grant for a live job and ensure the real
    /// runner is running.
    ///
    /// The commands layer owns the format-id check
    /// (`png`/`jpeg`/`tiff`/`zif`/`webp`/`iiif-dir`); this layer owns
    /// extension matching through the output layer: the format maps to an
    /// [`OutputFormat`], the path extension infers via
    /// [`OutputFormat::infer_from_path`], and [`validate_destination`]
    /// enforces the match plus the overwrite policy, all before any work.
    /// A grant for a job with a live runner only records the destination.
    pub fn request_destination(
        &mut self,
        job: &str,
        path: &Path,
        format: &str,
        overwrite: bool,
    ) -> Result<(u64, Vec<SnapshotEmit>), String> {
        self.poll_snapshots();
        self.require_live(job)?;
        let requested =
            output_format_for_id(format).ok_or_else(|| "unsupported format".to_string())?;
        // Typed error before any work: unknown extensions never start the
        // runner (fail-closed; only the compiled PNG/JPEG/TIFF/ZIF/WebP
        // codecs plus the `iiif-dir` tree exist).
        OutputFormat::infer_from_path(path).map_err(|e| e.to_string())?;
        // Extension/format match plus overwrite policy, also before any work.
        validate_destination(path, &requested, overwrite).map_err(|e| e.to_string())?;
        let has_runner = self.jobs.get(job).is_some_and(|r| r.runner.is_some());
        if has_runner {
            if let Some(record) = self.jobs.get_mut(job) {
                record.destination = Some(path.to_path_buf());
            }
            return Ok((0, Vec::new()));
        }
        let mut options = self
            .jobs
            .get(job)
            .ok_or_else(|| "unknown".to_string())?
            .options
            .clone();
        options.output = OutputTarget::File(path.to_path_buf());
        options.overwrite = overwrite;
        // Do not update the registry until the runner accepted the options:
        // a startup validation failure stays a command error and the job can
        // still receive a corrected destination grant.
        let runner = NativeRunner::start(options.clone()).map_err(|error| error.to_string())?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.destination = Some(path.to_path_buf());
            record.options = options;
            record.runner = Some(runner);
        }
        Ok((0, Vec::new()))
    }

    /// Drain live runner snapshots without emitting: advances settled and
    /// saved handles so `require_live` stays honest between commands.
    fn poll_snapshots(&mut self) {
        let _ = self.collect_runner_emits();
    }

    /// Drain live runner snapshots and forward each verbatim as one
    /// `job-snapshot` emit. Non-blocking; terminal-once is enforced (the
    /// runner handle is dropped once its terminal is forwarded, and
    /// `settled` drops any late stragglers) and progress stays monotonic
    /// because runner seq and counts flow through untouched.
    pub fn poll_drivers(&mut self) -> Vec<SnapshotEmit> {
        self.collect_runner_emits()
    }

    fn collect_runner_emits(&mut self) -> Vec<SnapshotEmit> {
        let live: Vec<String> = self
            .jobs
            .iter()
            .filter(|(_, record)| record.runner.is_some() && !record.settled)
            .map(|(id, _)| id.clone())
            .collect();
        let mut emits = Vec::new();
        for id in live {
            let runner = match self.jobs.get_mut(&id).and_then(|r| r.runner.take()) {
                Some(runner) => runner,
                None => continue,
            };
            let mut terminal_seen = false;
            while let Ok(snapshot) = runner.snapshots().try_recv() {
                // Settled jobs never forward twice: drop stragglers.
                if self.jobs.get(&id).is_some_and(|r| r.settled) {
                    terminal_seen = true;
                    break;
                }
                let is_terminal = snapshot.snapshot.terminal.is_some();
                if let Some(emit) = self.forward_runner_snapshot(&id, &snapshot) {
                    emits.push(emit);
                }
                if is_terminal {
                    terminal_seen = true;
                    break;
                }
            }
            if !terminal_seen {
                if let Some(record) = self.jobs.get_mut(&id) {
                    record.runner = Some(runner);
                }
            }
            // With a terminal forwarded, the handle is dropped: the driver
            // thread has finished its sends and exits on its own.
        }
        emits
    }

    /// Forward one runner snapshot verbatim as a `job-snapshot` emit and
    /// record the host handles (settled + saved path). Returns `None` only
    /// for stragglers after a terminal, which are dropped to preserve
    /// exactly-once delivery.
    fn forward_runner_snapshot(
        &mut self,
        job: &str,
        snapshot: &RunnerSnapshot,
    ) -> Option<SnapshotEmit> {
        if self.jobs.get(job).is_none_or(|record| record.settled) {
            return None;
        }
        // Verbatim forward: the engine DTO is serialized untouched (revision,
        // lifecycle, paused, progress, selection with catalog, decision with
        // ordinal missing tiles, terminal, output). The native publication
        // only feeds the retained `saved_path` handle below, never the
        // payload.
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload(job, &dto);
        let seq = u64::from(snapshot.snapshot.revision);
        if let Some(decision) = snapshot.snapshot.decision.as_ref() {
            if let Some(record) = self.jobs.get_mut(job) {
                record.pending_generation = Some(decision.generation);
            }
        }
        if snapshot.snapshot.terminal.is_some() {
            if let Some(record) = self.jobs.get_mut(job) {
                record.settled = true;
                record.pending_generation = None;
                if let Some(published) = snapshot.published.as_ref() {
                    record.saved_path = Some(published.path.clone());
                    if record.destination.is_none() {
                        record.destination = Some(published.path.clone());
                    }
                }
            }
        }
        Some(SnapshotEmit {
            channel: CHANNEL_JOB_SNAPSHOT,
            job: job.to_string(),
            seq,
            payload,
        })
    }
}

/// Map a commands-layer format id onto the output-layer format. The commands
/// layer accepts `png`/`jpeg`/`tiff`/`zif`/`webp`/`iiif-dir`; extension
/// matching lives in [`validate_destination`].
fn output_format_for_id(format: &str) -> Option<OutputFormat> {
    match format {
        "png" => Some(OutputFormat::Png),
        "jpeg" => Some(OutputFormat::Jpeg),
        "tiff" => Some(OutputFormat::Tiff),
        "zif" => Some(OutputFormat::Zif),
        "webp" => Some(OutputFormat::Webp),
        "iiif-dir" | "iiif" => Some(OutputFormat::IiifDir),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dezoomify_native::runner::OutputSummary;

    /// Build one verbatim engine snapshot for forwarder tests (no I/O).
    fn engine_snapshot(
        revision: u32,
        lifecycle: ProtocolState,
        acquired: u64,
        total: Option<u64>,
        terminal: Option<SnapshotTerminalDto>,
    ) -> dezoomify_engine::JobSnapshot {
        dezoomify_engine::JobSnapshot {
            revision,
            lifecycle,
            paused: false,
            progress: dezoomify_engine::Progress {
                completed: acquired,
                total,
            },
            selection: dezoomify_engine::Selection {
                image: None,
                level: None,
                level_count: 0,
                catalog: None,
                deferred: Vec::new(),
            },
            decision: None,
            terminal,
            output: None,
            notices: Vec::new(),
        }
    }

    fn runner_snapshot(
        job: &str,
        revision: u32,
        lifecycle: ProtocolState,
        acquired: u64,
        total: Option<u64>,
        terminal: Option<SnapshotTerminalDto>,
        published: Option<OutputSummary>,
    ) -> RunnerSnapshot {
        RunnerSnapshot {
            job: job.to_string(),
            snapshot: engine_snapshot(revision, lifecycle, acquired, total, terminal),
            published,
        }
    }

    fn runner_snapshot_with_decision(
        job: &str,
        revision: u32,
        lifecycle: ProtocolState,
        acquired: u64,
        total: Option<u64>,
        generation: u32,
        missing_tiles: &[u32],
    ) -> RunnerSnapshot {
        let mut snapshot = engine_snapshot(revision, lifecycle, acquired, total, None);
        snapshot.decision = Some(dezoomify_engine::DecisionPayload {
            generation,
            missing: missing_tiles
                .iter()
                .map(|tile| (*tile, Vec::new()))
                .collect(),
        });
        RunnerSnapshot {
            job: job.to_string(),
            snapshot,
            published: None,
        }
    }

    fn failed_terminal(code: &str, message: &str) -> SnapshotTerminalDto {
        SnapshotTerminalDto::Failed {
            error: dezoomify_protocol::dto::ErrorDto {
                code: code.to_string(),
                phase: dezoomify_protocol::dto::ErrorPhase::Acquisition,
                retryable: true,
                message: message.to_string(),
                recovery: Vec::new(),
                request: None,
                transport: Some(dezoomify_protocol::dto::ErrorTransport::Native),
                blocked_reason: None,
                resource_kind: Some(dezoomify_protocol::dto::ResourceKind::Tile),
                http: None,
                preview: None,
                detail: None,
            },
        }
    }

    fn snapshot_revision(payload: &serde_json::Value) -> u64 {
        payload
            .get("revision")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(u64::MAX)
    }

    fn snapshot_lifecycle(payload: &serde_json::Value) -> String {
        payload
            .get("lifecycle")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    fn terminal_type(payload: &serde_json::Value) -> Option<String> {
        payload
            .get("terminal")?
            .get("type")?
            .as_str()
            .map(str::to_string)
    }

    fn decision_tiles(payload: &serde_json::Value) -> Vec<u32> {
        payload
            .get("decision")
            .and_then(|d| d.get("missing"))
            .and_then(|m| m.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| entry.get("tile").and_then(serde_json::Value::as_u64))
                    .filter_map(|tile| u32::try_from(tile).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Folded keys the verbatim contract forbids at the payload top level.
    /// Nested DTO fields (`progress.total`, `output.missing`) are canonical
    /// and stay; these top-level projections must never reappear.
    fn assert_no_folded_keys(payload: &serde_json::Value) {
        for key in [
            "state",
            "acquired",
            "total",
            "catalog",
            "warnings",
            "recovery",
            "displayOnly",
            "updatedAt",
            "origin",
            "seq",
            "kind",
            "jobSnapshot",
        ] {
            assert!(
                payload.get(key).is_none(),
                "folded key {key:?} must not cross IPC"
            );
        }
    }

    /// A fresh manual job emits the canonical `Created` snapshot verbatim:
    /// revision 0, nothing selected, no decision, no terminal, no output, no
    /// destination cue. No runner runs until the destination grant and no
    /// `AwaitingDestination` state is stored anywhere.
    #[test]
    fn discovery_completion_requests_destination() {
        let mut table = JobTable::new();
        let (id, initial) = table.start_job("https://example.com/item").unwrap();
        assert!(!table.has_runner(&id), "no runner before the grant");
        assert!(!table.is_settled(&id));
        assert_eq!(initial.channel, CHANNEL_JOB_SNAPSHOT);
        assert_eq!(snapshot_revision(&initial.payload), 0);
        assert_eq!(snapshot_lifecycle(&initial.payload), "Created");
        assert_eq!(initial.payload["paused"], serde_json::json!(false));
        assert_eq!(
            initial.payload["progress"],
            serde_json::json!({"completed": 0, "total": null})
        );
        assert_eq!(
            initial.payload["selection"],
            serde_json::json!({
                "image": null, "level": null, "level_count": 0,
                "catalog": null, "deferred": [],
            })
        );
        assert!(initial.payload["decision"].is_null());
        assert!(initial.payload["terminal"].is_null());
        assert!(initial.payload["output"].is_null());
        assert_no_folded_keys(&initial.payload);
        assert_eq!(initial.payload["jobId"], serde_json::json!(id));
        assert_eq!(initial.payload["job"], serde_json::json!(id));
    }

    #[test]
    fn settings_start_automatically_enters_the_native_save_pipeline() {
        let mut table = JobTable::new();
        let mut settings = DesktopSettings::with_defaults();
        settings.output_dir = Some(std::env::temp_dir().join("dezoomify-auto-output-test"));
        settings.output_format = "webp".to_string();
        let (id, initial) = table
            .start_job_with_settings("http://127.0.0.1:9/item", &settings)
            .unwrap();

        // Automatic saves carry no decision either: the runner owns the save.
        assert!(initial.payload["decision"].is_null());
        assert!(table.has_runner(&id), "the runner starts automatically");
        let _ = table.cancel_job(&id);
    }

    #[test]
    fn unknown_and_stale_rejected() {
        let mut table = JobTable::new();
        assert_eq!(table.cancel_job("job:missing").unwrap_err(), "unknown");
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(
            table
                .answer_choice(&id, &Choice::Image { index: 0 })
                .unwrap_err(),
            "stale"
        );
    }

    #[test]
    fn settings_wire_cli_parity_and_output_dir() {
        use crate::settings::parse_settings;
        let settings = parse_settings(&serde_json::json!({
            "compression": 9,
            "retries": 0,
            "max_width": 800,
            "cache_dir": "/tmp/dz-cache",
            "headers": {"X-Test": "v"},
        }))
        .unwrap();
        let mut table = JobTable::new();
        let (id, _) = table
            .start_job_with_settings("https://example.com/item", &settings)
            .unwrap();
        let options = table.options_for(&id).unwrap();
        assert_eq!(options.compression, 9);
        assert_eq!(options.max_retries, 0);
        assert_eq!(options.max_width, Some(800));
        assert_eq!(options.max_concurrent, 16);
        assert_eq!(options.max_idle_per_host, 32);
        assert!(table.output_dir_for(&id).is_none());
        let with_dir = parse_settings(&serde_json::json!({"output_dir": "/tmp/dz-out"})).unwrap();
        let (id2, _) = table
            .start_job_with_settings("https://example.com/other", &with_dir)
            .unwrap();
        assert_eq!(
            table.output_dir_for(&id2).unwrap(),
            std::path::PathBuf::from("/tmp/dz-out")
        );
        table.cancel_job(&id).unwrap();
        table.cancel_job(&id2).unwrap();
    }

    /// Unique scratch path per test (Rust tests share one process/pid, so
    /// the test name scopes the file).
    #[cfg(test)]
    fn scratch_path(test: &str, name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dz-dest-{test}-{name}"))
    }

    #[test]
    fn destination_grant_validates_path_before_any_work() {
        let mut table = JobTable::new();
        let (id, initial) = table.start_job("https://example.com/item").unwrap();
        // The initial snapshot is the canonical `Created` DTO.
        assert_eq!(snapshot_lifecycle(&initial.payload), "Created");
        // Unknown extensions fail before any work: no destination, no runner.
        let bad = scratch_path("validate", "out.bmp");
        let err = table
            .request_destination(&id, &bad, "png", false)
            .unwrap_err();
        assert!(
            err.contains("unsupported output extension"),
            "typed error, got {err}"
        );
        assert!(table.destination_for(&id).is_none());
        assert!(!table.has_runner(&id), "no runner on refused grant");
        // Extension/format mismatch fails before any work.
        let mismatch = scratch_path("validate", "out.jpg");
        let err = table
            .request_destination(&id, &mismatch, "png", false)
            .unwrap_err();
        assert!(
            err.contains("extension does not match"),
            "typed error, got {err}"
        );
        assert!(table.destination_for(&id).is_none());
        // Unknown format ids fail at the commands-layer check.
        let png = scratch_path("validate", "out.png");
        let err = table
            .request_destination(&id, &png, "exe", false)
            .unwrap_err();
        assert_eq!(err, "unsupported format");
        assert!(table.destination_for(&id).is_none());
        // A matching grant stores the real path and starts the runner.
        let (seq, emits) = table.request_destination(&id, &png, "png", false).unwrap();
        assert_eq!(seq, 0);
        assert!(emits.is_empty(), "grants resolve through runner snapshots");
        assert_eq!(table.destination_for(&id).unwrap(), png);
        assert!(table.has_runner(&id), "the grant starts the runner");
        // Unknown and stale jobs are rejected without effects.
        assert_eq!(
            table
                .request_destination("job:missing", &png, "png", false)
                .unwrap_err(),
            "unknown"
        );
        table.cancel_job(&id).unwrap();
        // The runner owns quiescence: poll until the cancelled terminal is
        // forwarded (bounded wait), then post-terminal grants are stale.
        for _ in 0..200 {
            if table.is_settled(&id) {
                break;
            }
            let _ = table.poll_drivers();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            table
                .request_destination(&id, &png, "png", false)
                .unwrap_err(),
            "stale"
        );
    }

    #[test]
    fn runner_start_failure_is_a_retriable_destination_command_error() {
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        // Simulate an invalid option reaching the otherwise validated
        // boundary. NativeRunner rejects it before spawning any work.
        table.jobs.get_mut(&id).unwrap().options.input_url.clear();
        let path = scratch_path("runner-start-failure", "out.png");
        let error = table
            .request_destination(&id, &path, "png", false)
            .unwrap_err();
        assert!(error.starts_with("job.invalid-input:"), "{error}");
        assert!(table.destination_for(&id).is_none());
        assert!(!table.has_runner(&id));
        assert!(!table.is_settled(&id));

        // No terminal or phantom state was created, so a corrected grant
        // starts the one real runner normally.
        table.jobs.get_mut(&id).unwrap().options.input_url =
            "file:///nonexistent/dezoomify-test".into();
        table.request_destination(&id, &path, "png", false).unwrap();
        assert!(table.has_runner(&id));
        let _ = table.cancel_job(&id);
    }

    #[test]
    fn destination_overwrite_policy() {
        let dir = scratch_path("overwrite", "dir");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.png");
        std::fs::write(&path, b"existing").unwrap();
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        // Existing output refuses without overwrite: typed error, no grant.
        let err = table
            .request_destination(&id, &path, "png", false)
            .unwrap_err();
        assert!(err.contains("refusing overwrite"), "typed error, got {err}");
        assert!(table.destination_for(&id).is_none());
        // Explicit overwrite confirmation grants the same path.
        table.request_destination(&id, &path, "png", true).unwrap();
        assert_eq!(table.destination_for(&id).unwrap(), path);
        table.cancel_job(&id).unwrap();
        // Overwrite grants leave pre-existing user data alone on cancel:
        // the runner never publishes on the cancel path and the desktop
        // never removes a confirmed-overwrite destination.
        assert_eq!(std::fs::read(&path).unwrap(), b"existing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handoff_user_headers_reach_runner_and_stay_out_of_debug() {
        use std::collections::BTreeMap;
        let mut table = JobTable::new();
        let mut headers = BTreeMap::new();
        headers.insert("cookie".to_string(), "session=CANARY-handoff".to_string());
        let (id, initial) = table
            .start_job_with_user_headers("https://protected.example/item", headers)
            .unwrap();
        let options = table.options_for(&id).unwrap();
        assert_eq!(
            options.headers.get("cookie").map(String::as_str),
            Some("session=CANARY-handoff"),
            "handoff cookie must reach the runner options"
        );
        // Memory-only secrets never appear in Debug, emits, or ids.
        let debug = format!("{:?}", table);
        assert!(
            !debug.contains("CANARY-handoff"),
            "cookie value leaked into Debug"
        );
        assert!(debug.contains("cookie"), "header name stays visible");
        assert!(!initial.payload.to_string().contains("CANARY-handoff"));
        table.cancel_job(&id).unwrap();
    }

    #[test]
    fn runner_terminal_forwards_exactly_once_with_monotonic_seq() {
        let mut table = JobTable::new();
        let (id, initial) = table.start_job("https://example.com/item").unwrap();
        assert_eq!(snapshot_revision(&initial.payload), 0);
        table
            .answer_choice(&id, &Choice::Image { index: 0 })
            .unwrap();
        // Progress and terminal flow verbatim from the runner: forward one
        // synthetic terminal through the forwarder (no I/O).
        table
            .request_destination(&id, &scratch_path("terminal-once", "out.png"), "png", false)
            .unwrap();
        // Inject a terminal by polling a real runner is racy; instead drive
        // the verbatim forwarder directly through a synthetic snapshot. The
        // native publication feeds the retained saved path only, never the
        // payload.
        let terminal_snapshot = runner_snapshot(
            "job:test",
            7,
            ProtocolState::Finalizing,
            2,
            Some(2),
            Some(SnapshotTerminalDto::Completed),
            Some(published("png", 4, 4, 1)),
        );
        let emit = table
            .forward_runner_snapshot(&id, &terminal_snapshot)
            .expect("terminal forwards");
        assert_eq!(emit.channel, CHANNEL_JOB_SNAPSHOT);
        assert_eq!(snapshot_revision(&emit.payload), 7);
        assert_eq!(terminal_type(&emit.payload).as_deref(), Some("completed"));
        // Verbatim means the engine lifecycle stands: a `Completed` terminal
        // on a `Finalizing` snapshot does not rewrite the lifecycle.
        assert_eq!(snapshot_lifecycle(&emit.payload), "Finalizing");
        assert_eq!(emit.payload["job"], serde_json::json!(id));
        assert_eq!(emit.payload["jobId"], serde_json::json!(id));
        assert_no_folded_keys(&emit.payload);
        assert!(table.is_settled(&id));
        assert_eq!(
            table.saved_output_for(&id).unwrap(),
            PathBuf::from("/tmp/dz-published.png")
        );
        // A straggler after the terminal is dropped: exactly-once.
        let mut straggler = terminal_snapshot.clone();
        straggler.snapshot.revision = 8;
        assert!(table.forward_runner_snapshot(&id, &straggler).is_none());
        // Post-terminal inputs are stale with no new effects.
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(
            table
                .answer_choice(&id, &Choice::Image { index: 1 })
                .unwrap_err(),
            "stale"
        );
    }

    #[test]
    fn progress_flows_verbatim_and_never_claims_unknown_totals() {
        // Unknown totals stay null and never claim completeness: the engine
        // `None` serializes to JSON null inside `progress`.
        let snapshot = runner_snapshot(
            "job:test",
            3,
            ProtocolState::AcquiringTiles,
            1,
            None,
            None,
            None,
        );
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        assert!(payload["progress"]["total"].is_null());
        assert_eq!(payload["progress"]["completed"], serde_json::json!(1u64));
        assert_eq!(snapshot_lifecycle(&payload), "AcquiringTiles");
        assert_no_folded_keys(&payload);
        assert!(!payload_has_forbidden_keys(&payload));
        assert!(!payload.to_string().contains("example.com/item"));
    }

    #[test]
    fn output_carries_geometry_verbatim() {
        // The engine output account (canvas, format, completeness, ordinal
        // missing tiles, disposition) serializes untouched; the native
        // publication never enters the payload.
        let mut snapshot = runner_snapshot(
            "job:test",
            4,
            ProtocolState::Finalizing,
            12,
            Some(12),
            Some(SnapshotTerminalDto::Completed),
            Some(published("png", 800, 600, 12)),
        );
        snapshot.snapshot.output = Some(dezoomify_engine::OutputSummary {
            canvas: Some((800, 600)),
            format: dezoomify_engine::OutputFormat::Png,
            complete: true,
            missing: Vec::new(),
            disposition: None,
        });
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        assert_eq!(terminal_type(&payload).as_deref(), Some("completed"));
        assert_eq!(snapshot_lifecycle(&payload), "Finalizing");
        assert_eq!(
            payload["output"],
            serde_json::json!({
                "canvas": {"width": 800, "height": 600},
                "format": "png",
                "complete": true,
                "missing": [],
                "disposition": null,
            })
        );
        assert_no_folded_keys(&payload);
        assert!(!payload_has_forbidden_keys(&payload));
    }

    #[test]
    fn engine_catalog_rides_selection_verbatim() {
        // The engine catalog reaches IPC inside `selection.catalog`; the old
        // top-level `catalog: null` fold is gone.
        let mut snapshot = runner_snapshot(
            "job:test",
            2,
            ProtocolState::AwaitingImageSelection,
            0,
            None,
            None,
            None,
        );
        snapshot.snapshot.selection.catalog = Some(dezoomify_protocol::dto::CatalogDto {
            entries: vec![dezoomify_protocol::dto::CatalogEntryDto::Image(
                dezoomify_protocol::dto::ImageDto {
                    title: Some("plate".to_string()),
                    format: "iiif".to_string(),
                    width: 800,
                    height: 600,
                    source_kind: "iiif".to_string(),
                    levels: vec![dezoomify_protocol::dto::LevelDto {
                        label: "full".to_string(),
                        width: 800,
                        height: 600,
                        tile_width: 256,
                        tile_height: 256,
                    }],
                },
            )],
        });
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        let catalog = &payload["selection"]["catalog"];
        assert!(catalog.is_object(), "catalog must ride selection");
        // `CatalogEntryDto` is internally tagged (`kind: image`), with the
        // image fields flattened alongside the tag.
        assert_eq!(catalog["entries"][0]["kind"], serde_json::json!("image"));
        assert_eq!(catalog["entries"][0]["title"], serde_json::json!("plate"));
        assert_eq!(
            catalog["entries"][0]["levels"][0]["width"],
            serde_json::json!(800u64)
        );
        assert_no_folded_keys(&payload);
    }

    #[test]
    fn error_carries_stable_code_phase_retryable_recovery() {
        // The engine failure DTO serializes untouched: stable code, phase,
        // retryable flag, message, transport, and resource kind are the
        // engine's own typed fields, never a host rebuild.
        let snapshot = runner_snapshot(
            "job:test",
            5,
            ProtocolState::AcquiringTiles,
            1,
            Some(4),
            Some(failed_terminal("tile.download-failed", "3 tiles failed")),
            None,
        );
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        assert_eq!(terminal_type(&payload).as_deref(), Some("failed"));
        assert_eq!(snapshot_lifecycle(&payload), "AcquiringTiles");
        let error = &payload["terminal"]["error"];
        assert_eq!(error["code"], serde_json::json!("tile.download-failed"));
        assert_eq!(error["phase"], serde_json::json!("acquisition"));
        assert_eq!(error["retryable"], serde_json::json!(true));
        assert_eq!(error["message"], serde_json::json!("3 tiles failed"));
        assert_eq!(error["transport"], serde_json::json!("native"));
        assert_no_folded_keys(&payload);
        assert!(!payload.to_string().contains("/item"));
        assert!(!payload_has_forbidden_keys(&payload));
        // Phase/retryable mapping is by code, never display strings.
        assert_eq!(error_phase("discovery.failed"), "discovery");
        assert_eq!(error_phase("output.canvas-limit"), "output");
        assert!(!error_retryable("output.canvas-limit"));
        assert!(error_retryable("tile.http-error"));
        assert_eq!(error_recovery("output.canvas-limit"), "choose-output");
        // New boundary fields reach the snapshot.
        assert_eq!(error["resource_kind"], serde_json::json!("tile"));
    }

    #[test]
    fn error_mapping_covers_stable_codes_once_by_code() {
        // Failure-code remaps from `exec::map_failure_code` stay stable.
        for (code, phase) in [
            ("discovery.failed", "discovery"),
            ("discovery.no-image", "discovery"),
            ("tile.limit", "acquisition"),
            ("discovery.tile-plan", "discovery"),
            ("discovery.no-level", "discovery"),
            ("tile.download-failed", "acquisition"),
        ] {
            assert_eq!(error_phase(code), phase, "phase for {code}");
            assert_eq!(error_transport(code), "native", "transport for {code}");
            assert!(
                error_resource_kind(code).is_some(),
                "resource-kind for {code}"
            );
        }
        // Canvas-limit carries required memory plus max-width hint; JPEG
        // side-limit falls back to PNG. Both are output, non-retryable,
        // choose-output.
        for code in ["output.canvas-limit", "output.encode-failed"] {
            assert_eq!(error_phase(code), "output");
            assert!(!error_retryable(code));
            assert_eq!(error_recovery(code), "choose-output");
            assert_eq!(error_resource_kind(code), Some("output"));
        }
        // Output exists and destination denied recover via choose-output.
        for code in [
            "output.exists",
            "output.destination-denied",
            "output.unsupported-extension",
            "output.write-failed",
        ] {
            assert_eq!(error_phase(code), "output", "phase for {code}");
            assert!(!error_retryable(code), "retryable for {code}");
            assert_eq!(error_recovery(code), "choose-output", "recovery for {code}");
        }
        // Protocol and handoff map once by code.
        assert_eq!(error_phase("protocol.incompatible"), "handshake");
        assert!(!error_retryable("protocol.incompatible"));
        assert_eq!(error_phase("handoff.rejected"), "validation");
        assert!(!error_retryable("handoff.rejected"));
        // Lifecycle rejections map to validation without retry.
        for code in ["job.post-terminal", "job.unknown", "job.stale"] {
            assert_eq!(error_phase(code), "validation", "phase for {code}");
            assert!(!error_retryable(code), "retryable for {code}");
            assert_eq!(error_recovery(code), "edit-input", "recovery for {code}");
        }
        // Retryable only for transient transport/service.
        for code in [
            "transport.network-error",
            "transport.timeout",
            "tile.http-error",
            "tile.download-failed",
        ] {
            assert!(error_retryable(code), "{code} must be retryable");
        }
        for code in [
            "auth.too-many-cookies",
            "auth.forbidden-header",
            "transport.tls",
            "transport.bad-url",
            "discovery.failed",
            "discovery.no-image",
            "tile.decode-failed",
            "tile.processing-failed",
            "output.canvas-limit",
            "handoff.rejected",
            "protocol.incompatible",
            "job.post-terminal",
            "native.internal",
        ] {
            assert!(!error_retryable(code), "{code} must not be retryable");
        }
        // Partial policy only after retries: the terminal tile failure stays
        // retryable for a user retry, while decode-deterministic never is.
        assert!(error_retryable("tile.download-failed"));
        assert!(!error_retryable("tile.decode-failed"));
        // Security failures never offer a weakening recovery.
        for code in [
            "auth.too-many-cookies",
            "auth.forbidden-header",
            "transport.tls",
            "handoff.rejected",
            "protocol.incompatible",
        ] {
            let recovery = error_recovery(code);
            assert!(
                recovery != "change-transport"
                    && recovery != "grant-permission"
                    && recovery != "retry",
                "{code} must not weaken via {recovery}"
            );
        }
    }

    #[test]
    fn snapshot_channel_is_the_only_job_transport_and_forbids_tile_bytes() {
        assert_eq!(CHANNEL_JOB_SNAPSHOT, "dezoomify://job-snapshot");
        assert_eq!(CHANNEL_DEEP_LINK, "dezoomify://deep-link-pending");
        // Forbidden keys never pass the guard.
        let bad = serde_json::json!({"tileBytes": [1, 2, 3]});
        assert!(payload_has_forbidden_keys(&bad));
        let bad2 = serde_json::json!({"pixels": "abc"});
        assert!(payload_has_forbidden_keys(&bad2));
        // Real emits never contain them and carry both job aliases.
        let mut table = JobTable::new();
        let (id, initial) = table.start_job("https://example.com/item").unwrap();
        assert_eq!(initial.channel, CHANNEL_JOB_SNAPSHOT);
        assert_eq!(initial.job, id);
        assert_eq!(initial.payload["jobId"], serde_json::json!(id));
        assert_eq!(initial.payload["job"], serde_json::json!(id));
        assert!(!payload_has_forbidden_keys(&initial.payload));
    }

    #[test]
    fn snapshot_emit_is_self_describing_and_typed() {
        // The payload is the canonical DTO plus routing aliases: revision,
        // lifecycle, paused, progress, selection, decision, terminal, output.
        let progress = runner_snapshot(
            "job:test",
            2,
            ProtocolState::AcquiringTiles,
            3,
            Some(10),
            None,
            None,
        );
        let dto = EngineSnapshotDto::from(&progress.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        assert_eq!(snapshot_revision(&payload), 2);
        assert_eq!(payload["lifecycle"], serde_json::json!("AcquiringTiles"));
        assert_eq!(payload["paused"], serde_json::json!(false));
        assert_eq!(
            payload["progress"],
            serde_json::json!({"completed": 3, "total": 10})
        );
        assert!(payload["terminal"].is_null());
        assert!(payload["decision"].is_null());
        assert_eq!(payload["job"], serde_json::json!("job:1"));
        assert_eq!(payload["jobId"], serde_json::json!("job:1"));
        assert_no_folded_keys(&payload);
        // The outstanding partial decision rides `decision` with engine
        // ordinal tile ids, never legacy `tile:N` labels.
        let decision_snapshot = runner_snapshot_with_decision(
            "job:test",
            3,
            ProtocolState::AwaitingPartialDecision,
            9,
            Some(12),
            1,
            &[1],
        );
        let dto = EngineSnapshotDto::from(&decision_snapshot.snapshot);
        let decision_payload = verbatim_payload("job:1", &dto);
        assert_eq!(
            snapshot_lifecycle(&decision_payload),
            "AwaitingPartialDecision"
        );
        assert_eq!(
            decision_payload["decision"]["generation"],
            serde_json::json!(1u32)
        );
        assert_eq!(decision_tiles(&decision_payload), vec![1u32]);
        assert!(!payload_has_forbidden_keys(&decision_payload));
    }

    #[test]
    fn protocol_states_cover_engine_phases_without_divergence() {
        // The desktop stores no divergent enum: engine lifecycles serialize
        // onto protocol `JobState` names verbatim through the DTO.
        for lifecycle in [
            ProtocolState::Discovering,
            ProtocolState::AcquiringTiles,
            ProtocolState::Finalizing,
            ProtocolState::AwaitingPartialDecision,
        ] {
            let dto = EngineSnapshotDto::from(&engine_snapshot(0, lifecycle, 0, None, None));
            let payload = verbatim_payload("job:1", &dto);
            assert_eq!(
                snapshot_lifecycle(&payload),
                format!("{lifecycle:?}"),
                "lifecycle must serialize as its protocol name"
            );
        }
    }

    /// Task 6.1: unknown job ids are rejected before any work.
    ///
    /// The table reports `unknown` (mapped to `job.unknown` at the commands
    /// layer); no state changes and no emits.
    #[test]
    fn unknown_job_inputs_rejected_without_work() {
        let mut table = JobTable::new();
        assert_eq!(table.cancel_job("job:missing").unwrap_err(), "unknown");
        assert_eq!(
            table
                .answer_choice("job:missing", &Choice::Image { index: 0 })
                .unwrap_err(),
            "unknown"
        );
        let path = scratch_path("unknown", "out.png");
        assert_eq!(
            table
                .request_destination("job:missing", &path, "png", false)
                .unwrap_err(),
            "unknown"
        );
        assert!(table.is_empty());
        assert!(table.poll_drivers().is_empty(), "no emits for unknown");
    }

    /// Task 6.1: a terminal job's second cancel/choice is stale with no new
    /// effect or emit. Covers all four terminals
    /// (Completed/PartiallyCompleted/Failed/Cancelled).
    #[test]
    fn terminal_second_cancel_and_choice_are_stale_without_new_emits() {
        for terminal in ["cancelled", "completed", "partial", "failed"] {
            let mut table = JobTable::new();
            let (id, _) = table.start_job("https://example.com/item").unwrap();
            match terminal {
                "cancelled" => {
                    table.cancel_job(&id).unwrap();
                }
                "completed" => {
                    table
                        .request_destination(&id, &scratch_path("stale", "out.png"), "png", false)
                        .unwrap();
                    let snapshot = runner_snapshot(
                        "job:test",
                        2,
                        ProtocolState::Finalizing,
                        2,
                        Some(2),
                        Some(SnapshotTerminalDto::Completed),
                        Some(published("png", 8, 6, 2)),
                    );
                    table.forward_runner_snapshot(&id, &snapshot);
                }
                "partial" => {
                    table
                        .request_destination(&id, &scratch_path("stale", "out.png"), "png", false)
                        .unwrap();
                    let snapshot = runner_snapshot(
                        "job:test",
                        2,
                        ProtocolState::Finalizing,
                        1,
                        Some(2),
                        Some(SnapshotTerminalDto::PartialCompleted { missing: vec![1] }),
                        Some(published_partial(
                            "png",
                            8,
                            6,
                            1,
                            &["1".to_string()],
                            "out.partial.png",
                        )),
                    );
                    table.forward_runner_snapshot(&id, &snapshot);
                }
                _ => {
                    table
                        .request_destination(&id, &scratch_path("stale", "out.png"), "png", false)
                        .unwrap();
                    let snapshot = runner_snapshot(
                        "job:test",
                        2,
                        ProtocolState::AcquiringTiles,
                        0,
                        Some(2),
                        Some(failed_terminal("tile.download-failed", "tiles missing")),
                        None,
                    );
                    table.forward_runner_snapshot(&id, &snapshot);
                }
            }
            assert!(table.is_settled(&id), "{terminal} must be settled");
            let _ = table.poll_drivers();
            // Second cancel and second choice are both stale.
            assert_eq!(table.cancel_job(&id).unwrap_err(), "stale", "{terminal}");
            assert_eq!(
                table
                    .answer_choice(&id, &Choice::Image { index: 1 })
                    .unwrap_err(),
                "stale",
                "{terminal}"
            );
            assert!(
                table.poll_drivers().is_empty(),
                "{terminal}: no new emits on stale"
            );
        }
    }

    /// Task 6.1: every post-terminal input is rejected with no work.
    #[test]
    fn post_terminal_all_inputs_rejected_without_work() {
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        let (_, emits) = table.cancel_job(&id).unwrap();
        assert_eq!(emits.len(), 1, "terminal emits exactly once");
        assert!(table.is_settled(&id));
        let path = scratch_path("post-terminal", "out.png");
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(
            table
                .answer_choice(&id, &Choice::Image { index: 0 })
                .unwrap_err(),
            "stale"
        );
        assert_eq!(
            table
                .request_destination(&id, &path, "png", false)
                .unwrap_err(),
            "stale"
        );
        assert!(table.poll_drivers().is_empty(), "no work after terminal");
        assert!(table.destination_for(&id).is_none());
    }

    /// Task 6.1: each terminal appears exactly once; later terminals are stale.
    #[test]
    fn terminal_exactly_once_for_all_four_kinds() {
        // Cancelled.
        {
            let mut table = JobTable::new();
            let (id, _) = table.start_job("https://example.com/item").unwrap();
            let (_, emits) = table.cancel_job(&id).unwrap();
            assert_eq!(emits.len(), 1);
            assert_eq!(
                terminal_type(&emits[0].payload).as_deref(),
                Some("cancelled")
            );
            assert_eq!(snapshot_lifecycle(&emits[0].payload), "Cancelled");
            assert_eq!(snapshot_revision(&emits[0].payload), 1);
            assert_no_folded_keys(&emits[0].payload);
            assert!(table.is_settled(&id));
        }
        // Completed.
        {
            let mut table = JobTable::new();
            let (id, _) = table.start_job("https://example.com/item").unwrap();
            table
                .request_destination(&id, &scratch_path("once", "out.png"), "png", false)
                .unwrap();
            let snapshot = runner_snapshot(
                "job:test",
                2,
                ProtocolState::Finalizing,
                2,
                Some(2),
                Some(SnapshotTerminalDto::Completed),
                Some(published("png", 4, 4, 2)),
            );
            let emit = table.forward_runner_snapshot(&id, &snapshot).unwrap();
            assert_eq!(terminal_type(&emit.payload).as_deref(), Some("completed"));
            assert_eq!(snapshot_lifecycle(&emit.payload), "Finalizing");
            // A second terminal snapshot is dropped.
            let mut late = snapshot.clone();
            late.snapshot.revision = 3;
            assert!(table.forward_runner_snapshot(&id, &late).is_none());
        }
        // PartiallyCompleted never reads as Completed.
        {
            let mut table = JobTable::new();
            let (id, _) = table.start_job("https://example.com/item").unwrap();
            table
                .request_destination(&id, &scratch_path("once", "out.png"), "png", false)
                .unwrap();
            let snapshot = runner_snapshot(
                "job:test",
                2,
                ProtocolState::Finalizing,
                1,
                Some(2),
                Some(SnapshotTerminalDto::PartialCompleted { missing: vec![1] }),
                Some(published_partial(
                    "png",
                    2,
                    2,
                    1,
                    &["1".to_string()],
                    "out.partial.png",
                )),
            );
            let emit = table.forward_runner_snapshot(&id, &snapshot).unwrap();
            assert_eq!(
                terminal_type(&emit.payload).as_deref(),
                Some("partial-completed")
            );
            // Verbatim: the engine lifecycle stands even under a partial
            // terminal; the native `.partial` sibling feeds the saved path,
            // never the payload.
            assert_eq!(snapshot_lifecycle(&emit.payload), "Finalizing");
            assert_eq!(
                table.saved_output_for(&id).unwrap(),
                PathBuf::from("/tmp/out.partial.png")
            );
            assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        }
        // Failed.
        {
            let mut table = JobTable::new();
            let (id, _) = table.start_job("https://example.com/item").unwrap();
            table
                .request_destination(&id, &scratch_path("once", "out.png"), "png", false)
                .unwrap();
            let snapshot = runner_snapshot(
                "job:test",
                2,
                ProtocolState::AcquiringTiles,
                0,
                Some(2),
                Some(failed_terminal("tile.download-failed", "boom")),
                None,
            );
            let emit = table.forward_runner_snapshot(&id, &snapshot).unwrap();
            assert_eq!(terminal_type(&emit.payload).as_deref(), Some("failed"));
            assert_eq!(snapshot_lifecycle(&emit.payload), "AcquiringTiles");
        }
    }

    /// Wrong-state shell inputs are rejected without work (engine wrong-state
    /// coverage lives in `dezoomify-engine` tests; this backend never drives
    /// a transient engine).
    #[test]
    fn wrong_state_shell_ids_are_safe() {
        // Shell table: unmapped ids are unknown with no work.
        let mut table = JobTable::new();
        assert_eq!(table.cancel_job("bad-id").unwrap_err(), "unknown");
        assert_eq!(table.cancel_job("job:").unwrap_err(), "unknown");
    }

    /// Post-terminal shell inputs project as `stale` with no new work.
    #[test]
    fn shell_post_terminal_without_work() {
        // Shell projection of the terminal moment.
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
    }

    /// Task 6.1: input validation rejects userinfo, oversize, bad format, and
    /// empty choice before any state change or emit.
    #[test]
    fn validation_rejects_userinfo_oversize_bad_format_empty_choice() {
        let mut table = JobTable::new();
        let before = table.len();
        // Userinfo credentials in the URL are rejected.
        assert!(table.start_job("https://user@example.com/item").is_err());
        assert!(table.start_job("https://user:pass@example.com/x").is_err());
        // Empty, oversize (>2048B), and non-http(s) inputs are rejected.
        assert!(table.start_job("").is_err());
        let oversize = format!("https://example.com/{}", "a".repeat(2048));
        assert!(oversize.len() > 2048);
        assert!(table.start_job(&oversize).is_err());
        assert!(table.start_job("file:///etc/passwd").is_err());
        assert!(table.start_job("ftp://example.com/x").is_err());
        assert_eq!(table.len(), before);
        // Bad formats and mismatched extensions fail before any work.
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        let bad_ext = scratch_path("validation", "out.bmp");
        assert!(table
            .request_destination(&id, &bad_ext, "png", false)
            .unwrap_err()
            .contains("unsupported output extension"));
        let mismatch = scratch_path("validation", "out.jpg");
        assert!(table
            .request_destination(&id, &mismatch, "png", false)
            .unwrap_err()
            .contains("extension does not match"));
        assert_eq!(
            table
                .request_destination(&id, &scratch_path("validation", "out.png"), "exe", false)
                .unwrap_err(),
            "unsupported format"
        );
        assert!(table.destination_for(&id).is_none());
        table.cancel_job(&id).unwrap();
    }

    #[test]
    fn partial_decision_request_is_honest_and_reachable() {
        // The outstanding decision carries the engine generation plus ordinal
        // missing-tile ids with their structured failures; progress totals
        // stay the engine's own.
        let snapshot = runner_snapshot_with_decision(
            "job:test",
            4,
            ProtocolState::AwaitingPartialDecision,
            2,
            Some(4),
            1,
            &[1, 2],
        );
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        assert_eq!(snapshot_lifecycle(&payload), "AwaitingPartialDecision");
        assert_eq!(payload["decision"]["generation"], serde_json::json!(1u32));
        assert_eq!(decision_tiles(&payload), vec![1u32, 2u32]);
        assert_eq!(
            payload["progress"],
            serde_json::json!({"completed": 2, "total": 4})
        );
        assert_no_folded_keys(&payload);
        assert!(!payload.to_string().contains("example.com/item"));
        assert!(!payload_has_forbidden_keys(&payload));
    }

    #[test]
    fn partial_answer_forwards_to_the_runner_gate() {
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        table
            .request_destination(&id, &scratch_path("gate", "out.png"), "png", false)
            .unwrap();
        // Keep updates the fallback policy for an honest gate timeout.
        table
            .answer_choice(
                &id,
                &Choice::Partial {
                    decision: dezoomify_protocol::dto::RecoveryChoice::Keep,
                    generation: Some(1),
                },
            )
            .unwrap();
        assert!(table.options_for(&id).unwrap().keep_partial);
        // Discard maps distinctly; retry never changes the fallback policy.
        let (id2, _) = table.start_job("https://example.com/other").unwrap();
        table
            .request_destination(&id2, &scratch_path("gate", "out2.png"), "png", false)
            .unwrap();
        table
            .answer_choice(
                &id2,
                &Choice::Partial {
                    decision: dezoomify_protocol::dto::RecoveryChoice::Discard,
                    generation: Some(1),
                },
            )
            .unwrap();
        assert!(!table.options_for(&id2).unwrap().keep_partial);
        let (id3, _) = table.start_job("https://example.com/third").unwrap();
        table
            .request_destination(&id3, &scratch_path("gate", "out3.png"), "png", false)
            .unwrap();
        let keep_before = table.options_for(&id3).unwrap().keep_partial;
        table
            .answer_choice(
                &id3,
                &Choice::Partial {
                    decision: dezoomify_protocol::dto::RecoveryChoice::Retry,
                    generation: Some(1),
                },
            )
            .unwrap();
        assert_eq!(
            table.options_for(&id3).unwrap().keep_partial,
            keep_before,
            "retry never changes the fallback policy"
        );
        let _ = table.cancel_job(&id);
        let _ = table.cancel_job(&id2);
        let _ = table.cancel_job(&id3);
    }

    #[test]
    fn partial_completed_terminal_carries_ordinal_ledger() {
        // An honest partial through the runner boundary: the engine terminal
        // names ordinal missing tiles and the engine output account reports
        // incompleteness; the native `.partial` sibling feeds the retained
        // saved path only and its granted path never crosses IPC.
        let missing = vec!["1".to_string()];
        let mut snapshot = runner_snapshot(
            "job:test",
            6,
            ProtocolState::Finalizing,
            3,
            Some(4),
            Some(SnapshotTerminalDto::PartialCompleted { missing: vec![1] }),
            Some(published_partial(
                "png",
                512,
                512,
                3,
                &missing.clone(),
                "saved.partial.png",
            )),
        );
        snapshot.snapshot.output = Some(dezoomify_engine::OutputSummary {
            canvas: Some((512, 512)),
            format: dezoomify_engine::OutputFormat::Png,
            complete: false,
            missing: vec![1],
            disposition: None,
        });
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        assert_eq!(snapshot_lifecycle(&payload), "Finalizing");
        assert_eq!(
            terminal_type(&payload).as_deref(),
            Some("partial-completed")
        );
        assert_eq!(payload["terminal"]["missing"], serde_json::json!([1u32]));
        assert_eq!(payload["output"]["complete"], serde_json::json!(false));
        assert_eq!(payload["output"]["missing"], serde_json::json!([1u32]));
        assert_no_folded_keys(&payload);
        assert!(!payload.to_string().contains("/tmp"));
        assert!(!payload_has_forbidden_keys(&payload));
    }

    #[test]
    fn partial_discard_fails_honestly_with_no_output() {
        let snapshot = runner_snapshot(
            "job:test",
            2,
            ProtocolState::AcquiringTiles,
            0,
            Some(1),
            Some(failed_terminal(
                "tile.download-failed",
                "1 tile(s) still failing",
            )),
            None,
        );
        let dto = EngineSnapshotDto::from(&snapshot.snapshot);
        let payload = verbatim_payload("job:1", &dto);
        assert_eq!(terminal_type(&payload).as_deref(), Some("failed"));
        assert!(payload["output"].is_null());
    }

    #[test]
    fn runner_snapshots_forward_verbatim_through_poll_drivers() {
        let mut table = JobTable::new();
        let mut settings = DesktopSettings::with_defaults();
        settings.output_dir = Some(std::env::temp_dir().join("dezoomify-fold-test"));
        settings.output_format = "png".to_string();
        // 127.0.0.1:9 refuses connections immediately, so the runner reaches
        // a typed Failed terminal without touching any network.
        let (id, _) = table
            .start_job_with_settings("http://127.0.0.1:9/item", &settings)
            .unwrap();
        assert!(table.has_runner(&id));
        // Poll until the runner's terminal is forwarded (bounded wait).
        let mut terminal: Option<SnapshotEmit> = None;
        for _ in 0..200 {
            for emit in table.poll_drivers() {
                assert_eq!(emit.channel, CHANNEL_JOB_SNAPSHOT);
                if emit.payload["terminal"].is_object() {
                    terminal = Some(emit);
                    break;
                }
            }
            if terminal.is_some() || table.is_settled(&id) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let terminal = terminal.expect("runner terminal must forward");
        assert_eq!(terminal_type(&terminal.payload).as_deref(), Some("failed"));
        let code = terminal.payload["terminal"]["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string();
        // Verbatim means the engine code crosses unmapped: the refused
        // loopback connection surfaces as the engine's own `job.no-images`,
        // never a host-rebuilt `discovery.*` alias.
        assert_eq!(code, "job.no-images", "typed engine code, got {code}");
        // The runner handle is released once the terminal forwarded.
        assert!(!table.has_runner(&id));
        assert!(table.saved_output_for(&id).is_none());
    }

    /// Test helper: a complete published output.
    fn published(format: &str, width: u32, height: u32, tile_count: usize) -> OutputSummary {
        OutputSummary {
            path: PathBuf::from("/tmp/dz-published.png"),
            tile_count,
            width,
            height,
            format: format.to_string(),
            partial: false,
            missing: Vec::new(),
        }
    }

    /// Test helper: a kept-partial published output.
    fn published_partial(
        format: &str,
        width: u32,
        height: u32,
        tile_count: usize,
        missing: &[String],
        sibling: &str,
    ) -> OutputSummary {
        OutputSummary {
            path: PathBuf::from(format!("/tmp/{sibling}")),
            tile_count,
            width,
            height,
            format: format.to_string(),
            partial: true,
            missing: missing.to_vec(),
        }
    }
}
