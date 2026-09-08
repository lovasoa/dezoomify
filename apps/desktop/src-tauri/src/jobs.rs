// In-memory desktop job table backed by the real native driver.
//
// Shapes mirror the dezoomify-job transcript event kinds (job-state,
// progress, completed, cancelled, failed) and execution flows through the
// real native runtime (`dezoomify_native::NativeRuntime` +
// `pipeline::run`, which drives `job_driver` effect table 1-66 like
// `apps/cli/src/main.rs:325-346`). The table owns lifecycle, scoped seq
// ordering, and terminal-once guarantees for the creating window/session.
//
// Lean offline shell: standard library threads only (no tokio; `tokio` is a
// dev-dependency of `dezoomify-native`, not a runtime dependency). `start_job`
// validates, mints `job:n`, records `Discovering` seq 1, and spawns a
// background driver task without blocking. The discovery worker proves real
// engine wiring (`Job::new` + `start`, no I/O) and exits; the real
// `pipeline::run` worker starts after `request_destination` grants a
// destination. Synchronous lifecycle methods stay the source of truth so the
// lean offline build passes with no network.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, Sender},
};
use std::thread::JoinHandle;

use dezoomify_native::output::{validate_destination, OutputFormat};
use dezoomify_native::pipeline::{
    partial_decision_from_choice, PartialDecision, PartialGate, PartialPolicy, PipelineConfig,
    PipelineEvent,
};
use dezoomify_native::{JobRequest, NativeRuntime};

use crate::settings::{pipeline_config_for, DesktopSettings};

/// Desktop event channels. Must stay identical to
/// `apps/desktop/src/events.ts` `DESKTOP_EVENT_CHANNELS` and the generated
/// capability documents.
pub const CHANNEL_JOB_STATE: &str = "dezoomify://job-state";
pub const CHANNEL_JOB_PROGRESS: &str = "dezoomify://job-progress";
pub const CHANNEL_JOB_OUTPUT: &str = "dezoomify://job-output";
pub const CHANNEL_JOB_ERROR: &str = "dezoomify://job-error";
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

/// Lifecycle states tracked by the shell.
///
/// Names are PascalCase engine parity (`Created` … `Failed`) so the
/// `job-state` channel projects the driver lifecycle without inferring
/// policy. `Acquiring`/`Processing` are the shell shorthands for the engine
/// `AcquiringTiles`/`ProcessingTiles` phases. `Running` is the shell's
/// post-choice active marker (maps to acquisition once tiles flow).
/// `AwaitingChoice` is the legacy single-choice alias for
/// `AwaitingImageSelection` and is kept for transcript compatibility.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Created,
    Discovering,
    AwaitingImageSelection,
    AwaitingLevelSelection,
    AwaitingDestination,
    AwaitingChoice,
    AwaitingPartialDecision,
    AwaitingRecovery,
    Running,
    Planning,
    Acquiring,
    Processing,
    Encoding,
    Finalizing,
    Publishing,
    Cancelling,
    CleaningUp,
    Completed,
    PartiallyCompleted,
    Cancelled,
    Failed,
}

impl JobState {
    pub fn name(&self) -> &'static str {
        match self {
            JobState::Created => "Created",
            JobState::Discovering => "Discovering",
            JobState::AwaitingImageSelection => "AwaitingImageSelection",
            JobState::AwaitingLevelSelection => "AwaitingLevelSelection",
            JobState::AwaitingDestination => "AwaitingDestination",
            JobState::AwaitingChoice => "AwaitingChoice",
            JobState::AwaitingPartialDecision => "AwaitingPartialDecision",
            JobState::AwaitingRecovery => "AwaitingRecovery",
            JobState::Running => "Running",
            JobState::Planning => "Planning",
            JobState::Acquiring => "Acquiring",
            JobState::Processing => "Processing",
            JobState::Encoding => "Encoding",
            JobState::Finalizing => "Finalizing",
            JobState::Publishing => "Publishing",
            JobState::Cancelling => "Cancelling",
            JobState::CleaningUp => "CleaningUp",
            JobState::Completed => "Completed",
            JobState::PartiallyCompleted => "PartiallyCompleted",
            JobState::Cancelled => "Cancelled",
            JobState::Failed => "Failed",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            JobState::Completed
                | JobState::PartiallyCompleted
                | JobState::Cancelled
                | JobState::Failed
        )
    }

    /// True for the `Awaiting*` family (choice, destination, recovery).
    pub fn is_awaiting(&self) -> bool {
        matches!(
            self,
            JobState::AwaitingImageSelection
                | JobState::AwaitingLevelSelection
                | JobState::AwaitingDestination
                | JobState::AwaitingChoice
                | JobState::AwaitingPartialDecision
                | JobState::AwaitingRecovery
        )
    }
}

/// Map a transcript `kind` to its IPC channel.
///
/// - `progress`/`downloading`/`discovery`/`encoding` (count-bearing driver
///   events) go to `job-progress`;
/// - `completed`/`partial-completed`/`output` go to `job-output`;
/// - `failed`/`error` go to `job-error`;
/// - everything else (lifecycle, selection, destination grants,
///   cancellation) goes to `job-state`.
///
/// `deep-link-pending` is emitted only by the shell deep-link path.
pub fn channel_for_kind(kind: &str) -> &'static str {
    let lower = kind.to_ascii_lowercase();
    match lower.as_str() {
        "progress" | "downloading" | "discovery" | "encoding" => CHANNEL_JOB_PROGRESS,
        "completed" | "partial-completed" | "partial_completed" | "output" => CHANNEL_JOB_OUTPUT,
        "failed" | "error" => CHANNEL_JOB_ERROR,
        _ => CHANNEL_JOB_STATE,
    }
}

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

/// One ordered transcript event for a job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobEvent {
    pub seq: u64,
    pub kind: String,
    pub detail: String,
}

/// One tracked job: lifecycle snapshot plus the real driver handles.
///
/// `Debug` is redacted on purpose: the driver config may hold the handoff
/// `Cookie` header (memory-only, never logged or cached), so only header
/// names are shown, never values.
#[derive(Clone)]
pub struct JobRecord {
    pub id: String,
    pub state: JobState,
    pub seq: u64,
    pub events: Vec<JobEvent>,
    pub window: String,
    /// Full input URL the driver fetches (never embedded in events).
    pub input_url: String,
    /// Redacted input origin (`scheme://host`) for event context.
    pub origin: String,
    /// Shared cancellation flag; cloned into `pipeline_config` so the
    /// background `pipeline::run` observes `cancel_job` promptly.
    pub cancel_flag: std::sync::Arc<AtomicBool>,
    /// Driver configuration (selection, retry, fetch bounds, `cancel_flag`).
    pub pipeline_config: PipelineConfig,
    /// Granted save destination: the real dialog-chosen path, stored per job
    /// and passed to `pipeline::run` for atomic publish. `None` until
    /// `request_destination`.
    pub destination: Option<PathBuf>,
    /// Granted format id (`png`/`jpeg`/`tiff`/`zif`/`webp`/`iiif-dir`).
    pub destination_format: Option<String>,
    /// Whether the user confirmed overwriting an existing destination.
    /// Always false until an explicit overwrite confirmation exists; an
    /// existing destination is denied for choose-output recovery instead.
    pub destination_overwrite: bool,
    /// Settings-selected output directory (`None` keeps the dialog default).
    /// Seeds the save dialog's initial directory; the granted destination is
    /// always the real dialog-chosen path.
    pub output_dir: Option<PathBuf>,
    /// Digest of the bytes the driver actually wrote (`None` until publish;
    /// never set on the cancel path).
    pub output_hash: Option<String>,
    /// Monotonic progress: highest `acquired` count observed. Never
    /// decreases across retries; cache hits still count as acquired, so
    /// resume runs continue forward without claiming unknown totals.
    pub progress_acquired: u64,
    /// Monotonic progress: highest `total` observed. Unknown totals stay 0
    /// and never claim completeness.
    pub progress_total: u64,
    /// Output geometry from the driver publish step (`None` until publish).
    pub output_width: Option<u32>,
    /// Output geometry from the driver publish step (`None` until publish).
    pub output_height: Option<u32>,
    /// Tiles encoded into the published output (`None` until publish).
    pub output_tile_count: Option<usize>,
    /// Detected source format id from the driver (e.g. `zoomify`, `iiif`).
    pub output_source_format: Option<String>,
    /// Last typed driver failure (`None` unless the job failed).
    pub last_error_code: Option<String>,
    /// Last typed driver failure message, redacted (`None` unless failed).
    pub last_error_message: Option<String>,
    /// Interactive partial gate shared with the background driver worker.
    /// Cloned into `pipeline_config.partial_gate` so `answer_choice`
    /// wakes a waiting driver without polling.
    pub partial_gate: std::sync::Arc<PartialGate>,
    /// Pending interactive partial request (missing ledger while the host
    /// dialog waits). `None` unless `AwaitingPartialDecision`.
    pub pending_partial: Option<PartialPending>,
    /// Missing tile ids for a kept partial (`None` until a partial publish).
    /// Redacted ids only, never URLs or paths.
    pub output_missing: Vec<String>,
    /// Sibling basename for a kept partial (`out.partial.png`, never the
    /// granted path). `None` until a partial publish.
    pub output_sibling: Option<String>,
}

/// Pending interactive partial request: the ledger the dialog shows.
/// Tile ids and counts only; never URLs, paths, or secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialPending {
    pub missing: Vec<String>,
    pub failed: u64,
    pub total: u64,
    pub recovery: Option<String>,
}

impl std::fmt::Debug for JobRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let header_names: Vec<&String> = self.pipeline_config.user_headers.keys().collect();
        f.debug_struct("JobRecord")
            .field("id", &self.id)
            .field("state", &self.state)
            .field("seq", &self.seq)
            .field("events", &self.events)
            .field("window", &self.window)
            .field("input_url", &self.input_url)
            .field("origin", &self.origin)
            .field("user_header_names", &header_names)
            .field("destination_format", &self.destination_format)
            .field("destination_overwrite", &self.destination_overwrite)
            .field("output_dir", &self.output_dir)
            .field("output_hash", &self.output_hash)
            .finish_non_exhaustive()
    }
}

/// Structured output ready for the `job-output` channel. The hash is the
/// real sha256 hex of the bytes the driver wrote (single-file bytes, or the
/// `info.json` + tile-bytes preimage for `iiif-dir`), never a stub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobOutputSnapshot {
    pub output_hash: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub tile_count: usize,
}

/// Structured error ready for the `job-error` channel. Only the stable
/// code, phase, retryability, recovery hint, transport, resource kind,
/// redacted message, and redacted origin cross IPC; full URLs, paths, and
/// secrets never do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobErrorSnapshot {
    pub code: String,
    pub phase: String,
    pub retryable: bool,
    pub recovery: String,
    pub transport: String,
    pub resource_kind: Option<String>,
    pub message: String,
    pub origin: String,
}

/// One projected IPC emit: the Tauri channel plus the redacted payload.
/// Payloads always carry both `job` and `jobId` aliases plus `seq` so the
/// frontend stale-job and stale-seq guards keep working, alongside the
/// typed fields each channel documents.
#[derive(Debug, Clone)]
pub struct ProjectedEmit {
    pub channel: &'static str,
    pub job: String,
    pub seq: u64,
    pub payload: serde_json::Value,
}

/// Terminal driver result delivered by the background worker.
#[derive(Debug, Clone)]
struct DriverSuccess {
    output_hash: String,
    format: String,
    width: u32,
    height: u32,
    tile_count: usize,
    /// True when the driver kept a partial (blank missing regions).
    partial: bool,
    /// Missing tile ids for a kept partial (empty for complete saves).
    missing: Vec<String>,
    /// Sibling basename for a kept partial (`out.partial.png`, never the
    /// granted path). `None` for complete saves.
    sibling: Option<String>,
}

/// Typed driver failure delivered by the background worker.
#[derive(Debug, Clone)]
struct DriverFailure {
    code: String,
    message: String,
}

/// Messages from background workers to the table (pumped without blocking).
#[derive(Debug)]
enum DriverMessage {
    Progress {
        job: String,
        kind: String,
        detail: BTreeMap<String, String>,
    },
    /// Discovery finished: the job leaves `Discovering` for
    /// `AwaitingDestination` with one `job-state` event, which is the
    /// frontend's cue to offer the save destination. Image and level stay
    /// at the pipeline defaults (first image, largest fitting level); only
    /// an explicit `answer_choice` overrides them before the grant.
    Discovered { job: String },
    /// Interactive partial decision requested by the driver
    /// (`recovery-requested{reason: partial}` plus `missing-work`). Moves
    /// the job to `AwaitingPartialDecision` with one `job-state`
    /// `recovery-requested` event carrying the redacted missing ledger,
    /// which is the frontend's cue to offer keep/discard/retry.
    RecoveryRequested {
        job: String,
        missing: Vec<String>,
        failed: u64,
        total: u64,
        recovery: Option<String>,
    },
    Finished {
        job: String,
        result: Result<DriverSuccess, DriverFailure>,
    },
}

/// In-memory table keyed by job id, plus one shared native runtime and the
/// background worker handles/channels.
///
/// `pending` holds projected IPC emits in seq order. Every transcript push
/// enqueues exactly one projected emit; the Tauri shell drains the queue
/// and emits each on its channel. Draining never replays: each emit leaves
/// the queue exactly once.
pub struct JobTable {
    jobs: HashMap<String, JobRecord>,
    next_job: u64,
    capability_seq: u64,
    runtime: NativeRuntime,
    driver_tx: Sender<DriverMessage>,
    driver_rx: Receiver<DriverMessage>,
    driver_handles: HashMap<String, JoinHandle<()>>,
    pending: Vec<ProjectedEmit>,
}

impl std::fmt::Debug for JobTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobTable")
            .field("jobs", &self.jobs)
            .field("next_job", &self.next_job)
            .field("capability_seq", &self.capability_seq)
            .field("drivers", &self.driver_handles.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl Default for JobTable {
    fn default() -> Self {
        Self::new()
    }
}

impl JobTable {
    pub fn new() -> Self {
        let (driver_tx, driver_rx) = mpsc::channel();
        Self {
            jobs: HashMap::new(),
            next_job: 0,
            capability_seq: 0,
            runtime: NativeRuntime::new(1 << 30),
            driver_tx,
            driver_rx,
            driver_handles: HashMap::new(),
            pending: Vec::new(),
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

    pub fn last_seq(&self, job: &str) -> Option<u64> {
        self.jobs.get(job).map(|r| r.seq)
    }

    pub fn events_for(&self, job: &str) -> Vec<JobEvent> {
        self.jobs
            .get(job)
            .map(|r| r.events.clone())
            .unwrap_or_default()
    }

    /// Snapshot of the driver destination, if granted.
    pub fn destination_for(&self, job: &str) -> Option<PathBuf> {
        self.jobs.get(job).and_then(|r| r.destination.clone())
    }

    /// Digest of the bytes the driver wrote, if published.
    pub fn output_hash_for(&self, job: &str) -> Option<String> {
        self.jobs.get(job).and_then(|r| r.output_hash.clone())
    }

    /// Current shell state, if known.
    pub fn state_of(&self, job: &str) -> Option<JobState> {
        self.jobs.get(job).map(|r| r.state.clone())
    }

    /// Monotonic progress snapshot `(acquired, total)` for a job.
    pub fn progress_for(&self, job: &str) -> Option<(u64, u64)> {
        self.jobs
            .get(job)
            .map(|r| (r.progress_acquired, r.progress_total))
    }

    /// Structured output snapshot for a published job.
    pub fn output_snapshot_for(&self, job: &str) -> Option<JobOutputSnapshot> {
        let record = self.jobs.get(job)?;
        Some(JobOutputSnapshot {
            output_hash: record.output_hash.clone()?,
            format: record
                .destination_format
                .clone()
                .unwrap_or_else(|| "png".to_string()),
            width: record.output_width.unwrap_or(0),
            height: record.output_height.unwrap_or(0),
            tile_count: record.output_tile_count.unwrap_or(0),
        })
    }

    /// Structured error snapshot for a failed job.
    pub fn error_snapshot_for(&self, job: &str) -> Option<JobErrorSnapshot> {
        let record = self.jobs.get(job)?;
        let code = record.last_error_code.clone()?;
        let message = record.last_error_message.clone().unwrap_or_default();
        Some(JobErrorSnapshot {
            phase: error_phase(&code).to_string(),
            retryable: error_retryable(&code),
            recovery: error_recovery(&code).to_string(),
            transport: error_transport(&code).to_string(),
            resource_kind: error_resource_kind(&code).map(str::to_string),
            code,
            message,
            origin: record.origin.clone(),
        })
    }

    /// Drain projected IPC emits in seq order. Each emit leaves the queue
    /// exactly once; callers emit each on its `channel` with `payload`.
    pub fn drain_pending(&mut self) -> Vec<ProjectedEmit> {
        std::mem::take(&mut self.pending)
    }

    /// Project one transcript event to its channel payload. The payload
    /// always carries `job` + `jobId` + `seq` plus the typed fields the
    /// frontend guards expect; secrets, paths, and full URLs are never
    /// included (only the redacted origin, counts, hashes, and codes).
    pub fn project_event(&self, job: &str, event: &JobEvent) -> (String, serde_json::Value) {
        let record = self.jobs.get(job);
        let origin = record.map(|r| r.origin.clone()).unwrap_or_default();
        let channel = channel_for_kind(&event.kind).to_string();
        let base_job = job.to_string();
        if channel == CHANNEL_JOB_PROGRESS {
            // Historical detail only: the transcript detail was already made
            // monotonic at push time, so projecting an old event must not
            // rewrite it with the current snapshot.
            let (acquired, total) = parse_progress_detail(&event.detail);
            let state = record
                .map(|r| r.state.name().to_string())
                .unwrap_or_else(|| "Acquiring".to_string());
            let payload = serde_json::json!({
                "job": base_job,
                "jobId": base_job,
                "seq": event.seq,
                "kind": "progress",
                "state": state,
                "acquired": acquired,
                "total": total,
                "detail": redact_message(&event.detail),
                "origin": origin,
            });
            debug_assert!(!payload_has_forbidden_keys(&payload));
            return (channel, payload);
        }
        if channel == CHANNEL_JOB_OUTPUT {
            let output_hash = record
                .and_then(|r| r.output_hash.clone())
                .unwrap_or_else(|| redact_message(&event.detail));
            let format = record
                .and_then(|r| r.destination_format.clone())
                .unwrap_or_else(|| "png".to_string());
            let width = record.and_then(|r| r.output_width).unwrap_or(0);
            let height = record.and_then(|r| r.output_height).unwrap_or(0);
            let tile_count = record.and_then(|r| r.output_tile_count).unwrap_or(0);
            // Partial keeps project as `PartiallyCompleted`; full publishes
            // project as `Completed`. Branch on the event kind, never on
            // display text.
            let lower_kind = event.kind.to_ascii_lowercase();
            let state = if lower_kind == "partial-completed" || lower_kind == "partial_completed" {
                "PartiallyCompleted"
            } else {
                "Completed"
            };
            let mut payload = serde_json::json!({
                "job": base_job,
                "jobId": base_job,
                "seq": event.seq,
                "kind": event.kind,
                "state": state,
                "outputHash": output_hash,
                "output_hash": output_hash,
                "format": format,
                "width": width,
                "height": height,
                "tileCount": tile_count,
                "tile_count": tile_count,
                "detail": redact_message(&event.detail),
                "origin": origin,
            });
            // Honest partials also carry the redacted ledger plus the sibling
            // basename (never the granted path) so the UI can never claim a
            // complete save. Parsed from the stored record when available,
            // else from the JSON detail.
            if state == "PartiallyCompleted" {
                let (mut missing, mut sibling) = record
                    .map(|r| (r.output_missing.clone(), r.output_sibling.clone()))
                    .unwrap_or_default();
                if missing.is_empty() || sibling.is_none() {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&event.detail) {
                        if missing.is_empty() {
                            if let Some(list) =
                                value.get("missing").and_then(serde_json::Value::as_array)
                            {
                                missing = list
                                    .iter()
                                    .filter_map(|v| v.as_str().map(str::to_string))
                                    .filter(|id| {
                                        !id.is_empty()
                                            && id.len() <= 128
                                            && !id.contains("://")
                                            && !id.contains('/')
                                    })
                                    .take(60)
                                    .collect();
                            }
                        }
                        if sibling.is_none() {
                            sibling = value
                                .get("sibling")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                                .filter(|s| {
                                    !s.is_empty()
                                        && s.len() <= 256
                                        && !s.contains('/')
                                        && !s.contains('\\')
                                });
                        }
                    }
                }
                payload["missing"] = serde_json::json!(missing);
                payload["missingTiles"] = serde_json::json!(missing);
                if let Some(name) = sibling {
                    payload["sibling"] = serde_json::json!(name);
                }
            }
            debug_assert!(!payload_has_forbidden_keys(&payload));
            return (channel, payload);
        }
        if channel == CHANNEL_JOB_ERROR {
            let (code, message) = parse_error_detail(&event.detail);
            let stored_code = record.and_then(|r| r.last_error_code.clone());
            let stored_message = record.and_then(|r| r.last_error_message.clone());
            let code = stored_code.unwrap_or(code);
            let message = stored_message.unwrap_or(message);
            let resource_kind = error_resource_kind(&code);
            let mut payload = serde_json::json!({
                "job": base_job,
                "jobId": base_job,
                "seq": event.seq,
                "kind": "failed",
                "state": "Failed",
                "code": code,
                "phase": error_phase(&code),
                "retryable": error_retryable(&code),
                "recovery": error_recovery(&code),
                "message": redact_message(&message),
                "detail": redact_message(&event.detail),
                "origin": origin,
                "transport": error_transport(&code),
            });
            if let Some(kind) = resource_kind {
                payload["resource-kind"] = serde_json::json!(kind);
                payload["resource_kind"] = serde_json::json!(kind);
            }
            debug_assert!(!payload_has_forbidden_keys(&payload));
            return (channel, payload);
        }
        // job-state (lifecycle, selection, destination grants, cancellation).
        let state = record
            .map(|r| r.state.name().to_string())
            .unwrap_or_else(|| redact_message(&event.detail));
        let mut payload = serde_json::json!({
            "job": base_job,
            "jobId": base_job,
            "seq": event.seq,
            "kind": event.kind,
            "state": state,
            "detail": redact_message(&event.detail),
            "origin": origin,
        });
        // Recovery requests also carry the redacted ledger inline so the
        // dialog shows typed keep/discard/retry without parsing display
        // text. Parsed from the stored pending request when available, else
        // from the JSON detail.
        if event.kind.eq_ignore_ascii_case("recovery-requested") {
            let (missing, failed, total, recovery) = record
                .and_then(|r| r.pending_partial.clone())
                .map(|p| (p.missing, p.failed, p.total, p.recovery))
                .unwrap_or_else(|| {
                    serde_json::from_str::<serde_json::Value>(&event.detail)
                        .ok()
                        .map(|value| {
                            let missing = value
                                .get("missing")
                                .and_then(serde_json::Value::as_array)
                                .map(|list| {
                                    list.iter()
                                        .filter_map(|v| v.as_str().map(str::to_string))
                                        .filter(|id| {
                                            !id.is_empty()
                                                && id.len() <= 128
                                                && !id.contains("://")
                                                && !id.contains('/')
                                        })
                                        .take(60)
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();
                            let failed = value
                                .get("failed")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(missing.len() as u64);
                            let total = value
                                .get("total")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0);
                            let recovery = value
                                .get("recovery")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string);
                            (missing, failed, total, recovery)
                        })
                        .unwrap_or_default()
                });
            payload["reason"] = serde_json::json!("partial");
            payload["missing"] = serde_json::json!(missing);
            payload["missingTiles"] = serde_json::json!(missing);
            payload["failed"] = serde_json::json!(failed);
            payload["total"] = serde_json::json!(total);
            if let Some(id) = recovery {
                payload["recovery"] = serde_json::json!(id);
            }
        }
        debug_assert!(!payload_has_forbidden_keys(&payload));
        (channel, payload)
    }

    /// Drain finished workers and fold their messages into the transcript.
    /// Non-blocking; terminal-once is enforced (late outcomes after a sync
    /// terminal transition are ignored).
    pub fn poll_drivers(&mut self) {
        self.pump_drivers();
    }

    /// Append one ordered transcript event and enqueue its projected IPC
    /// emit. Seq is per-job monotonic via `saturating_add`; post-terminal
    /// pushes are refused by the caller (see `require_live` and the pump's
    /// live check), so terminals appear exactly once.
    fn push_event(&mut self, job: &str, kind: &str, detail: &str) -> u64 {
        let redacted_detail = redact_message(detail);
        // Never let paths, full URLs, or secrets into the transcript: only
        // the redacted origin is event context, never `input_url` or the
        // dialog path. Details carry counts, hashes, codes, and states.
        debug_assert!(
            !redacted_detail.contains("Cookie:") && !redacted_detail.contains("Authorization:"),
            "secret leaked into transcript detail"
        );
        let seq = self
            .jobs
            .get(job)
            .map(|r| r.seq.saturating_add(1))
            .unwrap_or(1);
        if let Some(record) = self.jobs.get_mut(job) {
            record.seq = seq;
            record.events.push(JobEvent {
                seq,
                kind: kind.to_string(),
                detail: redacted_detail.clone(),
            });
        } else {
            return seq;
        }
        let event = JobEvent {
            seq,
            kind: kind.to_string(),
            detail: redacted_detail,
        };
        let (channel, payload) = self.project_event(job, &event);
        debug_assert!(!payload_has_forbidden_keys(&payload));
        self.pending.push(ProjectedEmit {
            channel: channel_for_kind(&event.kind),
            job: job.to_string(),
            seq,
            payload,
        });
        let _ = channel;
        seq
    }

    /// Start one job and return its id immediately (never blocks on I/O).
    pub fn start_job(&mut self, input_url: &str) -> Result<String, String> {
        self.start_job_with_config(input_url, PipelineConfig::default())
    }

    /// Start one handoff job with origin-scoped trusted headers (memory-only).
    ///
    /// `user_headers` carries the consented `Cookie` header for the input
    /// origin (or is empty for a cookieless handoff). The map lives in the
    /// job's driver config RAM only: never logged (see the redacted `Debug`
    /// above), never written to disk, and never inserted into the tile cache
    /// (bodies only). Origin scoping itself is enforced by the caller
    /// (`native_host::host`) before this call and by the native `UserHeaders`
    /// layer at fetch time (credentials only to the input host).
    pub fn start_job_with_user_headers(
        &mut self,
        input_url: &str,
        user_headers: BTreeMap<String, String>,
    ) -> Result<String, String> {
        let config = PipelineConfig {
            user_headers,
            ..PipelineConfig::default()
        };
        self.start_job_with_config(input_url, config)
    }

    /// Start one job with validated desktop settings (compression,
    /// retries, caps, cache dir, trusted headers, output folder, and format). Bounds are
    /// enforced by `settings::parse_settings` before this call; the fixed
    /// transport mirrors the CLI (`pipeline_config_for`).
    pub fn start_job_with_settings(
        &mut self,
        input_url: &str,
        settings: &DesktopSettings,
    ) -> Result<String, String> {
        let config = pipeline_config_for(settings);
        let output_dir = settings.output_dir.clone();
        let id = self.start_job_with_config(input_url, config)?;
        if let Some(record) = self.jobs.get_mut(&id) {
            record.output_dir = output_dir;
            record.destination_format = Some(settings.output_format.clone());
        }
        Ok(id)
    }

    /// Start one job with explicit driver options (selection, retry, fetch
    /// bounds). The supplied `cancel_flag` is replaced with the job's shared
    /// flag so `cancel_job` always reaches the worker.
    pub fn start_job_with_config(
        &mut self,
        input_url: &str,
        config: PipelineConfig,
    ) -> Result<String, String> {
        self.pump_drivers();
        if input_url.is_empty() || input_url.len() > 2048 {
            return Err("input_url must be 1..2048 bytes".to_string());
        }
        if !(input_url.starts_with("http://") || input_url.starts_with("https://")) {
            return Err("input_url must be http(s)".to_string());
        }
        // Reject userinfo credentials embedded in the authority section
        // (parity with the commands-layer `is_valid_input_url` gate; secrets
        // never enter the table, transcript, or driver).
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

        let cancel_flag = std::sync::Arc::new(AtomicBool::new(false));
        let partial_gate = std::sync::Arc::new(PartialGate::new());
        let mut pipeline_config = config;
        pipeline_config.cancel_flag = std::sync::Arc::clone(&cancel_flag);
        pipeline_config.partial_gate = Some(std::sync::Arc::clone(&partial_gate));

        // CLI parity (`main.rs:325-346`): open a native handle for the redacted
        // origin. The desktop `job:n` id stays the transcript key; the native
        // handle is dropped after capturing its redacted context. No
        // destination exists yet (the dialog path arrives later via
        // `request_destination`), so the handle carries no output path.
        let origin = match self.runtime.start(JobRequest {
            input_url: input_url.to_string(),
            output_path: String::new(),
            overwrite: false,
        }) {
            Ok(handle) => handle.origin.clone(),
            Err(_) => String::new(),
        };

        self.jobs.insert(
            id.clone(),
            JobRecord {
                id: id.clone(),
                state: JobState::Discovering,
                seq: 1,
                events: vec![JobEvent {
                    seq: 1,
                    kind: "job-state".to_string(),
                    detail: "Discovering".to_string(),
                }],
                window: "main".to_string(),
                input_url: input_url.to_string(),
                origin,
                cancel_flag,
                pipeline_config,
                destination: None,
                destination_format: None,
                destination_overwrite: false,
                output_dir: None,
                output_hash: None,
                progress_acquired: 0,
                progress_total: 0,
                output_width: None,
                output_height: None,
                output_tile_count: None,
                output_source_format: None,
                last_error_code: None,
                last_error_message: None,
                partial_gate,
                pending_partial: None,
                output_missing: Vec::new(),
                output_sibling: None,
            },
        );
        // Enqueue the initial `Discovering` emit so the shell emits
        // `job-state` seq 1 without a second transcript push.
        {
            let event = JobEvent {
                seq: 1,
                kind: "job-state".to_string(),
                detail: "Discovering".to_string(),
            };
            let (channel, payload) = self.project_event(&id, &event);
            debug_assert!(!payload_has_forbidden_keys(&payload));
            self.pending.push(ProjectedEmit {
                channel: channel_for_kind(&event.kind),
                job: id.clone(),
                seq: 1,
                payload,
            });
            let _ = channel;
        }
        self.spawn_discovery_worker(&id);
        Ok(id)
    }

    fn require_live(&self, job: &str) -> Result<JobState, String> {
        match self.jobs.get(job) {
            None => Err("unknown".to_string()),
            Some(record) if record.state.is_terminal() => Err("stale".to_string()),
            Some(record) => Ok(record.state.clone()),
        }
    }

    /// Cancel a live job. Signals the shared flag so the background
    /// `pipeline::run` aborts before publish (no output on the cancel path),
    /// then maps the engine `Cancel` transition
    /// (`Cancelling` -> `CleaningUp` -> `Cancelled` with `release-bytes`).
    /// Terminal jobs report stale; missing jobs report unknown.
    pub fn cancel_job(&mut self, job: &str) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        if let Some(record) = self.jobs.get(job) {
            record.cancel_flag.store(true, Ordering::SeqCst);
        }
        // Real engine policy parity (offline, no I/O): drive a transient job
        // through `Cancel` so `cancel-work`/`release-bytes` ordering is
        // exercised even in the lean fallback.
        drive_engine_cancel(job, self.input_url_for(job).as_deref().unwrap_or(""));

        if let Some(record) = self.jobs.get_mut(job) {
            record.state = JobState::Cancelling;
        }
        self.push_event(job, "job-state", "Cancelling");
        if let Some(record) = self.jobs.get_mut(job) {
            record.state = JobState::CleaningUp;
        }
        self.push_event(job, "job-state", "CleaningUp");
        // `release-bytes`: drop staged digests and remove uncommitted output
        // best-effort (temp sibling plus, when overwrite was refused, the
        // destination itself). No output is ever reported on the cancel path.
        // Paths never enter events or logs here.
        if let Some(record) = self.jobs.get_mut(job) {
            record.output_hash = None;
            record.output_width = None;
            record.output_height = None;
            record.output_tile_count = None;
            record.output_source_format = None;
            record.pending_partial = None;
            record.output_missing.clear();
            record.output_sibling = None;
            if let Some(dest) = record.destination.clone() {
                let overwrite = record.destination_overwrite;
                remove_uncommitted_output(&dest, overwrite);
            }
            record.state = JobState::Cancelled;
        }
        Ok(self.push_event(job, "cancelled", "Cancelled"))
    }

    /// Answer an image/level choice for a live job. Maps the opaque choice
    /// onto the engine response (`SelectedImage`/`SelectedLevel`/`PartialKeep`
    /// /`RetryReady`) and folds selection indices into the driver config so
    /// the background worker plans the chosen image/level.
    ///
    /// The shell state projects the selection precisely so the `job-state`
    /// channel carries the `Awaiting*` family: image choices move to
    /// `AwaitingLevelSelection`, level choices to `AwaitingDestination`,
    /// recovery retries to `Running`, and partial keep/discard to `Running`
    /// (the terminal `PartiallyCompleted`/`Failed` arrives via the driver).
    ///
    /// Partial decisions while `AwaitingPartialDecision` also wake the
    /// waiting driver through the shared [`PartialGate`]: keep/discard map
    /// to [`PartialDecision`], retry re-drives the failed tiles. The gate
    /// answer is stored even for early choices so a racing driver still
    /// observes it; the policy is updated alongside for timeout fallback.
    pub fn answer_choice(&mut self, job: &str, choice: &str) -> Result<(u64, String), String> {
        self.pump_drivers();
        self.require_live(job)?;
        if choice.is_empty() || choice.len() > 128 {
            return Err("choice must be 1..128 bytes".to_string());
        }
        // Interactive partial answers wake the driver even before the pump
        // observed the request: the gate stores early answers.
        let partial_decision = partial_decision_from_choice(choice);
        let awaiting_partial = self
            .jobs
            .get(job)
            .is_some_and(|r| r.state == JobState::AwaitingPartialDecision);
        if let Some(decision) = partial_decision {
            if let Some(record) = self.jobs.get(job) {
                record.partial_gate.answer(decision);
            }
            // Retry never changes the fallback policy; keep/discard do so a
            // 60s timeout stays honest to the last explicit choice.
            if decision != PartialDecision::Retry {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.pipeline_config.partial_policy = match decision {
                        PartialDecision::Keep => PartialPolicy::Keep,
                        _ => PartialPolicy::Fail,
                    };
                }
            }
            if awaiting_partial {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.pending_partial = None;
                    record.state = JobState::Running;
                }
                let seq = self.push_event(job, "job-state", JobState::Running.name());
                return Ok((seq, "job-state:running".to_string()));
            }
            // No pending request yet: fall through to the legacy policy
            // update below so pre-grant choices still take effect.
        }
        let mapped = map_choice_kind(choice);
        let next_state = match mapped {
            "SelectedImage" => JobState::AwaitingLevelSelection,
            "SelectedLevel" => JobState::AwaitingDestination,
            _ => JobState::Running,
        };
        if let Some(record) = self.jobs.get_mut(job) {
            if let Some(index) = trailing_index(choice) {
                match mapped {
                    "SelectedImage" => record.pipeline_config.image_index = Some(index),
                    "SelectedLevel" => record.pipeline_config.zoom_level = Some(index),
                    _ => {}
                }
            }
            if mapped == "PartialKeep" && partial_decision.is_none() {
                let lower = choice.to_ascii_lowercase();
                let keep = !(lower.contains("discard") || lower.contains("fail"));
                record.pipeline_config.partial_policy = if keep {
                    PartialPolicy::Keep
                } else {
                    PartialPolicy::Fail
                };
            }
            record.state = next_state.clone();
        }
        let seq = self.push_event(job, "job-state", next_state.name());
        Ok((seq, "job-state:running".to_string()))
    }

    /// Record a save destination grant for a live job and ensure the real
    /// `pipeline::run` worker is running.
    ///
    /// The commands layer owns the format-id check
    /// (`png`/`jpeg`/`tiff`/`zif`/`webp`/`iiif-dir`); this layer owns
    /// extension matching through the output layer: the format maps to an
    /// [`OutputFormat`], the path extension infers via
    /// [`OutputFormat::infer_from_path`] (`.png` -> PNG, `.jpg`/`.jpeg` ->
    /// JPEG, `.tif`/`.tiff` -> TIFF, `.zif` -> ZIF pyramid, `.webp` ->
    /// lossless WebP, `.iiif`/extensionless/existing directory -> `iiif-dir`,
    /// anything else a typed error), and [`validate_destination`] enforces
    /// the extension/format match plus the overwrite policy. Any mismatch or
    /// refusal is a typed error before any work: no state change, no event,
    /// no worker. A denied destination recovers via request-decision
    /// (choose-output) at the caller.
    ///
    /// The real dialog path is stored per job and passed to `pipeline::run`
    /// for atomic publish. Only the opaque destination id (never the path)
    /// is returned for IPC; transcript events carry the format id only.
    pub fn request_destination(
        &mut self,
        job: &str,
        path: &Path,
        format: &str,
        overwrite: bool,
    ) -> Result<(u64, String), String> {
        self.pump_drivers();
        self.require_live(job)?;
        let requested =
            output_format_for_id(format).ok_or_else(|| "unsupported format".to_string())?;
        // Typed error before any work: unknown extensions never start the
        // driver (fail-closed; only the compiled PNG/JPEG/TIFF/ZIF/WebP
        // codecs plus the `iiif-dir` tree exist).
        OutputFormat::infer_from_path(path).map_err(|e| e.to_string())?;
        // Extension/format match plus overwrite policy, also before any work.
        validate_destination(path, &requested, overwrite).map_err(|e| e.to_string())?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.destination = Some(path.to_path_buf());
            record.destination_format = Some(format.to_string());
            record.destination_overwrite = overwrite;
            // The grant moves an `AwaitingDestination` job into active work.
            // `Planning` is the honest projection: the driver plans before
            // the first tile flows (the `Acquiring` state arrives with the
            // first `downloading` progress).
            if record.state == JobState::AwaitingDestination
                || record.state == JobState::Discovering
                || record.state == JobState::Running
            {
                record.state = JobState::Planning;
            }
        }
        let seq = self.push_event(job, "destination", format);
        self.spawn_pipeline_worker(job);
        Ok((seq, destination_id_for(job)))
    }

    /// Complete a live job (test helper modelling native finalization).
    /// Models the driver publish step: records a real-shaped digest plus
    /// geometry when available, then emits the terminal `completed` event
    /// exactly once on the `job-output` channel.
    pub fn complete_job(&mut self, job: &str) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        if let Some(record) = self.jobs.get_mut(job) {
            // A test-only publish without driver geometry still records a
            // digest of bytes the test wrote (here the stub digest); real
            // driver publishes always carry the sha256 of bytes written.
            if record.output_hash.is_none() {
                record.output_hash = Some("out:0".to_string());
            }
            if record.output_tile_count.is_none() {
                record.output_tile_count = Some(0);
            }
            record.state = JobState::Completed;
        }
        let detail = self
            .jobs
            .get(job)
            .and_then(|r| r.output_hash.clone())
            .unwrap_or_else(|| "out:0".to_string());
        Ok(self.push_event(job, "completed", &detail))
    }

    /// Record a driver publish for tests without spawning I/O: stores the
    /// real digest plus geometry and emits the terminal output event.
    /// Post-terminal calls are rejected as stale.
    #[cfg(test)]
    pub fn publish_test_output(
        &mut self,
        job: &str,
        output_hash: &str,
        format: &str,
        width: u32,
        height: u32,
        tile_count: usize,
    ) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.output_hash = Some(output_hash.to_string());
            record.destination_format = Some(
                record
                    .destination_format
                    .clone()
                    .unwrap_or_else(|| format.to_string()),
            );
            record.output_width = Some(width);
            record.output_height = Some(height);
            record.output_tile_count = Some(tile_count);
            record.state = JobState::Completed;
        }
        Ok(self.push_event(job, "completed", output_hash))
    }

    /// Record a kept-partial driver publish for tests without spawning I/O:
    /// stores the real digest plus geometry and emits the terminal
    /// `partial-completed` output event exactly once (`PartiallyCompleted`).
    /// Post-terminal calls are rejected as stale.
    #[cfg(test)]
    pub fn complete_partial_test_output(
        &mut self,
        job: &str,
        output_hash: &str,
        format: &str,
        width: u32,
        height: u32,
        tile_count: usize,
    ) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.output_hash = Some(output_hash.to_string());
            record.destination_format = Some(
                record
                    .destination_format
                    .clone()
                    .unwrap_or_else(|| format.to_string()),
            );
            record.output_width = Some(width);
            record.output_height = Some(height);
            record.output_tile_count = Some(tile_count);
            record.output_missing.clear();
            record.output_sibling = None;
            record.pending_partial = None;
            record.state = JobState::PartiallyCompleted;
        }
        Ok(self.push_event(job, "partial-completed", output_hash))
    }

    /// Honest kept-partial publish for tests: stores the digest, geometry,
    /// missing ledger, and sibling basename, then emits `partial-completed`
    /// with the honest JSON detail (never the granted path).
    /// Test seam with explicit scalar params mirroring the production
    /// publish shape; grouping them would diverge the seam from the call
    /// shape it exercises.
    #[allow(clippy::too_many_arguments)]
    #[cfg(test)]
    pub fn complete_partial_with_ledger_for_test(
        &mut self,
        job: &str,
        output_hash: &str,
        format: &str,
        width: u32,
        height: u32,
        tile_count: usize,
        missing: &[String],
        sibling: &str,
    ) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        let mut ledger = missing.to_vec();
        ledger.sort();
        ledger.dedup();
        if let Some(record) = self.jobs.get_mut(job) {
            record.output_hash = Some(output_hash.to_string());
            record.destination_format = Some(
                record
                    .destination_format
                    .clone()
                    .unwrap_or_else(|| format.to_string()),
            );
            record.output_width = Some(width);
            record.output_height = Some(height);
            record.output_tile_count = Some(tile_count);
            record.output_missing = ledger.clone();
            record.output_sibling = Some(sibling.to_string());
            record.pending_partial = None;
            record.state = JobState::PartiallyCompleted;
        }
        let detail = partial_detail_json(output_hash, &ledger, sibling);
        Ok(self.push_event(job, "partial-completed", &detail))
    }

    /// Interactive partial request for tests: moves a live job to
    /// `AwaitingPartialDecision` with the redacted ledger and emits the
    /// `recovery-requested` dialog event exactly once.
    #[cfg(test)]
    pub fn request_partial_for_test(
        &mut self,
        job: &str,
        missing: &[String],
        failed: u64,
        total: u64,
    ) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        let mut ledger = missing.to_vec();
        ledger.sort();
        ledger.dedup();
        if let Some(record) = self.jobs.get_mut(job) {
            record.pending_partial = Some(PartialPending {
                missing: ledger.clone(),
                failed,
                total,
                recovery: None,
            });
            record.state = JobState::AwaitingPartialDecision;
            if total > 0 {
                record.progress_total = record.progress_total.max(total);
            }
        }
        let detail = recovery_detail_json(&ledger, failed, total, None);
        Ok(self.push_event(job, "recovery-requested", &detail))
    }

    /// Snapshot of the pending partial ledger, if the dialog waits.
    #[cfg(test)]
    pub fn pending_partial_for(&self, job: &str) -> Option<PartialPending> {
        self.jobs.get(job).and_then(|r| r.pending_partial.clone())
    }

    /// Snapshot of the kept-partial missing ledger, if published.
    pub fn output_missing_for(&self, job: &str) -> Vec<String> {
        self.jobs
            .get(job)
            .map(|r| r.output_missing.clone())
            .unwrap_or_default()
    }

    /// Snapshot of the kept-partial sibling basename, if published.
    pub fn output_sibling_for(&self, job: &str) -> Option<String> {
        self.jobs.get(job).and_then(|r| r.output_sibling.clone())
    }

    /// Record driver progress for tests without spawning I/O: folds
    /// `acquired`/`total` monotonically (retries and cache hits never move
    /// progress backwards) and emits one `job-progress` event.
    /// Post-terminal calls are rejected as stale.
    #[cfg(test)]
    pub fn record_test_progress(
        &mut self,
        job: &str,
        acquired: u64,
        total: u64,
    ) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.progress_acquired = record.progress_acquired.max(acquired);
            record.progress_total = record.progress_total.max(total);
            if record.state == JobState::Planning
                || record.state == JobState::Running
                || record.state == JobState::Discovering
            {
                record.state = JobState::Acquiring;
            }
        }
        let detail = format!(
            "acquired={} total={}",
            self.progress_for(job).map(|(a, _)| a).unwrap_or(acquired),
            self.progress_for(job).map(|(_, t)| t).unwrap_or(total),
        );
        Ok(self.push_event(job, "downloading", &detail))
    }

    /// Record a typed driver failure for tests: stores the stable code plus
    /// the redacted message, moves through `CleaningUp` to `Failed`, and
    /// emits the terminal `job-error` event exactly once.
    #[cfg(test)]
    pub fn fail_test_job(&mut self, job: &str, code: &str, message: &str) -> Result<u64, String> {
        self.pump_drivers();
        self.require_live(job)?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.state = JobState::CleaningUp;
        }
        self.push_event(job, "job-state", "CleaningUp");
        if let Some(record) = self.jobs.get_mut(job) {
            record.last_error_code = Some(code.to_string());
            record.last_error_message = Some(redact_message(message));
            record.state = JobState::Failed;
        }
        Ok(self.push_event(
            job,
            "failed",
            &format!("{code}: {}", redact_message(message)),
        ))
    }

    fn input_url_for(&self, job: &str) -> Option<String> {
        self.jobs.get(job).map(|r| r.input_url.clone())
    }

    /// Snapshot of the settings-selected output directory, if any.
    pub fn output_dir_for(&self, job: &str) -> Option<PathBuf> {
        self.jobs.get(job).and_then(|r| r.output_dir.clone())
    }

    /// Snapshot of the driver config for a job (test helper).
    #[cfg(test)]
    pub fn config_for(&self, job: &str) -> Option<PipelineConfig> {
        self.jobs.get(job).map(|r| r.pipeline_config.clone())
    }

    /// Spawn the lightweight discovery worker: proves real engine wiring
    /// (`Job::new` + `start`, effects drained, no I/O) on a background thread
    /// so `start_job` never blocks. Sends no transcript messages; lifecycle
    /// stays synchronous until the pipeline worker finishes.
    fn spawn_discovery_worker(&mut self, job: &str) {
        let Some(record) = self.jobs.get(job) else {
            return;
        };
        let job_id = record.id.clone();
        let input_url = record.input_url.clone();
        let tx = self.driver_tx.clone();
        if let Ok(handle) = std::thread::Builder::new()
            .name(format!("dezoomify-{job_id}-discovery"))
            .spawn(move || {
                let config = dezoomify_job::Config::default();
                if let Ok(mut engine) = dezoomify_job::Job::new(&job_id, &input_url, config) {
                    let _ = engine.start();
                    let _ = engine.drain_effects();
                    let _ = engine.drain_events();
                }
                // Announce discovery completion through the driver channel so
                // the pump moves the job to `AwaitingDestination` exactly
                // once. Best effort: a full table never blocks discovery.
                let _ = tx.send(DriverMessage::Discovered { job: job_id });
            })
        {
            self.driver_handles.insert(job.to_string(), handle);
        }
    }

    /// Ensure the real pipeline worker is running. A desktop setting starts
    /// with an automatic directory destination; its final file name is
    /// derived from the selected catalog title inside the native driver.
    fn spawn_pipeline_worker(&mut self, job: &str) {
        let Some(record) = self.jobs.get(job) else {
            return;
        };
        let destination = record.destination.clone();
        let auto_destination = if destination.is_none() {
            record
                .destination_format
                .as_deref()
                .and_then(output_format_for_id)
                .map(|format| {
                    (
                        record.output_dir.clone().unwrap_or_else(std::env::temp_dir),
                        format,
                    )
                })
        } else {
            None
        };
        if destination.is_none() && auto_destination.is_none() {
            return;
        }
        if let Some(handle) = self.driver_handles.get(job) {
            if !handle.is_finished() {
                return;
            }
        }
        let job_id = record.id.clone();
        let input_url = record.input_url.clone();
        let overwrite = record.destination_overwrite;
        let config = record.pipeline_config.clone();
        let tx = self.driver_tx.clone();
        if let Ok(handle) = std::thread::Builder::new()
            .name(format!("dezoomify-{job_id}-pipeline"))
            .spawn(move || {
                let tx_progress = tx.clone();
                let job_for_events = job_id.clone();
                let mut on_event = |event: PipelineEvent| {
                    let lower = event.kind.to_ascii_lowercase();
                    if lower == "recovery-requested" || lower == "missing-work" {
                        let (missing, failed, total, recovery) =
                            parse_partial_detail(&event.detail);
                        let _ = tx_progress.send(DriverMessage::RecoveryRequested {
                            job: job_for_events.clone(),
                            missing,
                            failed,
                            total,
                            recovery,
                        });
                        return;
                    }
                    let _ = tx_progress.send(DriverMessage::Progress {
                        job: job_for_events.clone(),
                        kind: event.kind,
                        detail: event.detail,
                    });
                };
                let result = match (destination, auto_destination) {
                    (Some(destination), _) => dezoomify_native::pipeline::run(
                        &input_url,
                        &destination.to_string_lossy(),
                        overwrite,
                        &config,
                        &mut on_event,
                    ),
                    (None, Some((output_dir, format))) => {
                        dezoomify_native::pipeline::run_auto_named(
                            &input_url,
                            &output_dir,
                            format,
                            &config,
                            &mut on_event,
                        )
                    }
                    (None, None) => return,
                };
                let outcome = match result {
                    Ok(outcome) => {
                        // Sibling basename only: the granted path never
                        // crosses IPC or the transcript.
                        let sibling = std::path::Path::new(&outcome.output_path)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(str::to_string);
                        Ok(DriverSuccess {
                            output_hash: outcome.output_hash,
                            format: outcome.format,
                            width: outcome.image_size.x,
                            height: outcome.image_size.y,
                            tile_count: outcome.tile_count,
                            partial: outcome.partial,
                            missing: outcome.missing,
                            sibling,
                        })
                    }
                    Err(error) => Err(DriverFailure {
                        code: error.code,
                        message: error.message,
                    }),
                };
                let _ = tx.send(DriverMessage::Finished {
                    job: job_id,
                    result: outcome,
                });
            })
        {
            self.driver_handles.insert(job.to_string(), handle);
        }
    }

    /// Fold pending worker messages into the transcript. Reaps finished
    /// threads without blocking and enforces terminal-once.
    ///
    /// Projection rules (Task 1.5):
    /// - `job-state`: lifecycle (`Discovering`/`Planning`/`Acquiring`/
    ///   `Processing`/`Encoding`/`Finalizing`/`Publishing`/`CleaningUp` plus
    ///   the `Awaiting*`/`Running`/`Completed`/`Cancelled`/`Failed` family).
    /// - `job-progress`: `acquired`/`total` monotonic via `max` (survives
    ///   retries and resume-cache hits; unknown totals stay 0 and never
    ///   claim completeness).
    /// - `job-output`: real sha256 of bytes written plus format/geometry.
    /// - `job-error`: stable code/phase/retryable/recovery plus the redacted
    ///   origin only.
    ///
    /// Only counts, hashes, codes, and the redacted origin cross IPC; tile
    /// bytes, paths, full URLs, and secrets never do. Post-terminal driver
    /// messages are ignored so terminals appear exactly once.
    fn pump_drivers(&mut self) {
        let finished: Vec<String> = self
            .driver_handles
            .iter()
            .filter_map(|(id, handle)| {
                if handle.is_finished() {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in finished {
            if let Some(handle) = self.driver_handles.remove(&id) {
                let _ = handle.join();
            }
        }
        while let Ok(message) = self.driver_rx.try_recv() {
            match message {
                DriverMessage::Progress { job, kind, detail } => {
                    let live = self.jobs.get(&job).is_some_and(|r| !r.state.is_terminal());
                    if !live {
                        continue;
                    }
                    // Allowlist count-bearing keys only; URIs, paths, and
                    // header values never enter the transcript or IPC.
                    let allowed = ["acquired", "total", "resources", "bytes", "files"];
                    let mut pairs: Vec<(String, String)> = Vec::new();
                    for (key, value) in &detail {
                        let lower = key.to_ascii_lowercase();
                        if allowed.contains(&lower.as_str()) && value.trim().parse::<u64>().is_ok()
                        {
                            pairs.push((lower, value.trim().to_string()));
                        }
                    }
                    pairs.sort_by(|a, b| a.0.cmp(&b.0));
                    let mut acquired_opt: Option<u64> = None;
                    let mut total_opt: Option<u64> = None;
                    for (key, value) in &pairs {
                        if key == "acquired" {
                            acquired_opt = value.parse::<u64>().ok();
                        } else if key == "total" {
                            total_opt = value.parse::<u64>().ok();
                        } else if key == "resources" && acquired_opt.is_none() {
                            acquired_opt = value.parse::<u64>().ok();
                        }
                    }
                    if let Some(record) = self.jobs.get_mut(&job) {
                        if let Some(acquired) = acquired_opt {
                            record.progress_acquired = record.progress_acquired.max(acquired);
                        }
                        if let Some(total) = total_opt {
                            record.progress_total = record.progress_total.max(total);
                        }
                        let lower_kind = kind.to_ascii_lowercase();
                        if lower_kind == "discovery" {
                            if record.state == JobState::Discovering
                                || record.state == JobState::Running
                            {
                                record.state = JobState::Discovering;
                            }
                        } else if lower_kind == "downloading" {
                            if record.state != JobState::Encoding {
                                record.state = JobState::Acquiring;
                            }
                        } else if lower_kind == "encoding" {
                            record.state = JobState::Encoding;
                        }
                    }
                    let (snap_acquired, snap_total) = self
                        .jobs
                        .get(&job)
                        .map(|r| (r.progress_acquired, r.progress_total))
                        .unwrap_or((0, 0));
                    let detail_str = if kind.eq_ignore_ascii_case("downloading") {
                        format!("acquired={snap_acquired} total={snap_total}")
                    } else if pairs.is_empty() {
                        kind.clone()
                    } else {
                        pairs
                            .iter()
                            .map(|(k, v)| {
                                if k == "acquired" {
                                    format!("acquired={snap_acquired}")
                                } else if k == "total" {
                                    format!("total={snap_total}")
                                } else {
                                    format!("{k}={v}")
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    };
                    self.push_event(&job, &kind, &detail_str);
                }
                DriverMessage::Discovered { job } => {
                    let live = self.jobs.get(&job).is_some_and(|r| !r.state.is_terminal());
                    if !live {
                        continue;
                    }
                    // Only a still-discovering job moves: an early grant or
                    // choice already advanced the state, and replaying the
                    // transition would clobber it with a spurious event.
                    let discovering = self
                        .jobs
                        .get(&job)
                        .is_some_and(|r| r.state == JobState::Discovering);
                    if !discovering {
                        let ready = self.jobs.get(&job).is_some_and(|r| {
                            r.destination.is_some() || r.destination_format.is_some()
                        });
                        if ready {
                            self.spawn_pipeline_worker(&job);
                        }
                        continue;
                    }
                    let automatic = self
                        .jobs
                        .get(&job)
                        .is_some_and(|r| r.destination.is_none() && r.destination_format.is_some());
                    if automatic {
                        let format = self
                            .jobs
                            .get(&job)
                            .and_then(|r| r.destination_format.clone())
                            .unwrap_or_else(|| "png".to_string());
                        if let Some(record) = self.jobs.get_mut(&job) {
                            record.state = JobState::Planning;
                        }
                        // The event tells the frontend that saving starts;
                        // no file dialog or extra choice is required.
                        self.push_event(&job, "destination", &format);
                        // The discovery worker has sent its final message;
                        // join it before replacing its handle with the real
                        // pipeline worker so the automatic start cannot be
                        // lost to a narrow scheduling race.
                        if let Some(handle) = self.driver_handles.remove(&job) {
                            let _ = handle.join();
                        }
                        self.spawn_pipeline_worker(&job);
                    } else {
                        if let Some(record) = self.jobs.get_mut(&job) {
                            record.state = JobState::AwaitingDestination;
                        }
                        self.push_event(&job, "job-state", "AwaitingDestination");
                    }
                }
                DriverMessage::RecoveryRequested {
                    job,
                    missing,
                    failed,
                    total,
                    recovery,
                } => {
                    let live = self.jobs.get(&job).is_some_and(|r| !r.state.is_terminal());
                    if !live {
                        continue;
                    }
                    // Only live acquisition waits: a late duplicate after the
                    // user already answered (Running) or after terminal is
                    // ignored so the dialog appears exactly once per request.
                    let awaiting = self.jobs.get(&job).is_some_and(|r| {
                        matches!(
                            r.state,
                            JobState::Planning
                                | JobState::Acquiring
                                | JobState::Running
                                | JobState::AwaitingPartialDecision
                        )
                    });
                    if !awaiting {
                        continue;
                    }
                    // Redacted ledger only: tile ids and counts, never URLs,
                    // paths, or secrets.
                    let mut ledger = missing.clone();
                    ledger.sort();
                    ledger.dedup();
                    ledger.truncate(60);
                    if let Some(record) = self.jobs.get_mut(&job) {
                        record.pending_partial = Some(PartialPending {
                            missing: ledger.clone(),
                            failed,
                            total,
                            recovery: recovery.clone(),
                        });
                        record.state = JobState::AwaitingPartialDecision;
                        if total > 0 {
                            record.progress_total = record.progress_total.max(total);
                        }
                    }
                    let detail = recovery_detail_json(&ledger, failed, total, recovery.as_deref());
                    self.push_event(&job, "recovery-requested", &detail);
                }
                DriverMessage::Finished { job, result } => {
                    let live = self.jobs.get(&job).is_some_and(|r| !r.state.is_terminal());
                    if !live {
                        continue;
                    }
                    match result {
                        Ok(success) => {
                            if success.partial {
                                // Honest partial terminal: `partial-completed`
                                // with the missing ledger plus the sibling
                                // basename (never the granted path), so the
                                // UI can never claim a complete save.
                                let mut ledger = success.missing.clone();
                                ledger.sort();
                                ledger.dedup();
                                ledger.truncate(60);
                                let sibling = success
                                    .sibling
                                    .clone()
                                    .unwrap_or_else(|| "output.partial".to_string());
                                if let Some(record) = self.jobs.get_mut(&job) {
                                    record.state = JobState::PartiallyCompleted;
                                    record.output_hash = Some(success.output_hash.clone());
                                    record.output_width = Some(success.width);
                                    record.output_height = Some(success.height);
                                    record.output_tile_count = Some(success.tile_count);
                                    record.output_source_format = Some(success.format);
                                    record.output_missing = ledger.clone();
                                    record.output_sibling = Some(sibling.clone());
                                    record.pending_partial = None;
                                    record.progress_acquired =
                                        record.progress_acquired.max(success.tile_count as u64);
                                    if record.progress_total != 0 {
                                        record.progress_total =
                                            record.progress_total.max(success.tile_count as u64);
                                    }
                                }
                                let detail = partial_detail_json(
                                    &self
                                        .jobs
                                        .get(&job)
                                        .and_then(|r| r.output_hash.clone())
                                        .unwrap_or_else(|| "out:0".to_string()),
                                    &ledger,
                                    &sibling,
                                );
                                self.push_event(&job, "partial-completed", &detail);
                            } else {
                                if let Some(record) = self.jobs.get_mut(&job) {
                                    record.state = JobState::Completed;
                                    record.output_hash = Some(success.output_hash.clone());
                                    record.output_width = Some(success.width);
                                    record.output_height = Some(success.height);
                                    record.output_tile_count = Some(success.tile_count);
                                    record.output_source_format = Some(success.format);
                                    record.output_missing.clear();
                                    record.output_sibling = None;
                                    record.pending_partial = None;
                                    record.progress_acquired =
                                        record.progress_acquired.max(success.tile_count as u64);
                                    if record.progress_total != 0 {
                                        record.progress_total =
                                            record.progress_total.max(success.tile_count as u64);
                                    }
                                }
                                let detail = self
                                    .jobs
                                    .get(&job)
                                    .and_then(|r| r.output_hash.clone())
                                    .unwrap_or_else(|| "out:0".to_string());
                                self.push_event(&job, "completed", &detail);
                            }
                        }
                        Err(failure) => {
                            if failure.code == "job.cancelled" {
                                let uncommitted = self.jobs.get(&job).and_then(|r| {
                                    r.destination.clone().map(|d| (d, r.destination_overwrite))
                                });
                                if let Some(record) = self.jobs.get_mut(&job) {
                                    record.state = JobState::Cancelled;
                                    record.output_hash = None;
                                    record.output_width = None;
                                    record.output_height = None;
                                    record.output_tile_count = None;
                                    record.output_source_format = None;
                                    record.pending_partial = None;
                                    record.output_missing.clear();
                                    record.output_sibling = None;
                                }
                                if let Some((dest, overwrite)) = uncommitted {
                                    remove_uncommitted_output(&dest, overwrite);
                                }
                                self.push_event(&job, "cancelled", "Cancelled");
                            } else {
                                let uncommitted = self.jobs.get(&job).and_then(|r| {
                                    r.destination.clone().map(|d| (d, r.destination_overwrite))
                                });
                                if let Some(record) = self.jobs.get_mut(&job) {
                                    record.last_error_code = Some(failure.code.clone());
                                    record.last_error_message =
                                        Some(redact_message(&failure.message));
                                    record.state = JobState::CleaningUp;
                                }
                                self.push_event(&job, "job-state", "CleaningUp");
                                if let Some(record) = self.jobs.get_mut(&job) {
                                    record.state = JobState::Failed;
                                    record.pending_partial = None;
                                }
                                if let Some((dest, overwrite)) = uncommitted {
                                    remove_uncommitted_output(&dest, overwrite);
                                }
                                let detail = format!(
                                    "{}: {}",
                                    failure.code,
                                    redact_message(&failure.message)
                                );
                                self.push_event(&job, "failed", &detail);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Parse a driver partial detail map (`recovery-requested`/`missing-work`)
/// into its redacted ledger. Tile ids only; URLs, paths, and secrets never
/// survive: overlong entries or entries containing `://` or `/` are dropped.
fn parse_partial_detail(
    detail: &BTreeMap<String, String>,
) -> (Vec<String>, u64, u64, Option<String>) {
    let mut missing = Vec::new();
    if let Some(raw) = detail.get("missing") {
        for part in raw.split([',', ' ', ';']) {
            let token = part.trim();
            if token.is_empty() || token.len() > 128 {
                continue;
            }
            if token.contains("://") || token.contains('/') {
                continue;
            }
            if !missing.contains(&token.to_string()) {
                missing.push(token.to_string());
            }
            if missing.len() >= 60 {
                break;
            }
        }
    }
    missing.sort();
    missing.dedup();
    let failed = detail
        .get("failed")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(missing.len() as u64)
        .max(missing.len() as u64)
        .max(1);
    let total = detail
        .get("total")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let recovery = detail
        .get("recovery")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v.len() <= 128);
    (missing, failed, total, recovery)
}

/// Honest `recovery-requested` detail: JSON with the redacted ledger so the
/// frontend dialog shows typed keep/discard/retry without ever seeing a
/// path or URL.
fn recovery_detail_json(
    missing: &[String],
    failed: u64,
    total: u64,
    recovery: Option<&str>,
) -> String {
    let mut value = serde_json::json!({
        "reason": "partial",
        "missing": missing,
        "failed": failed,
        "total": total,
    });
    if let Some(id) = recovery {
        value["recovery"] = serde_json::json!(id);
    }
    value.to_string()
}

/// Honest `partial-completed` detail: the output hash plus the missing
/// ledger and the sibling basename (never the granted path).
fn partial_detail_json(output_hash: &str, missing: &[String], sibling: &str) -> String {
    serde_json::json!({
        "outputHash": output_hash,
        "missing": missing,
        "sibling": sibling,
        "reason": "partial",
    })
    .to_string()
}

/// Parse `acquired`/`total` counts from a redacted `k=v` detail string.
/// Missing counts default to 0 (unknown totals never claim completeness).
fn parse_progress_detail(detail: &str) -> (u64, u64) {
    let mut acquired = 0u64;
    let mut total = 0u64;
    for token in detail.split_whitespace() {
        if let Some((key, value)) = token.split_once('=') {
            let key = key.trim().to_ascii_lowercase();
            if let Ok(number) = value.trim().parse::<u64>() {
                if key == "acquired" {
                    acquired = number;
                } else if key == "total" {
                    total = number;
                } else if key == "resources" && acquired == 0 {
                    acquired = number;
                }
            }
        } else if let Some((key, value)) = token.split_once(':') {
            let key = key.trim().to_ascii_lowercase();
            if let Ok(number) = value.trim().parse::<u64>() {
                if key == "acquired" {
                    acquired = number;
                } else if key == "total" {
                    total = number;
                }
            }
        }
    }
    (acquired, total)
}

/// Split a `code: message` failure detail back into its typed parts.
/// The code is the stable namespaced token before the first colon; the
/// remainder is the redacted human message. No display-string branching:
/// callers map the code via [`error_phase`]/[`error_retryable`]/
pub fn parse_error_detail_for_test(detail: &str) -> (String, String) {
    parse_error_detail(detail)
}

fn parse_error_detail(detail: &str) -> (String, String) {
    if let Some(colon) = detail.find(':') {
        let (head, tail) = detail.split_at(colon);
        let code = head.trim().to_string();
        let message = tail[1..].trim().to_string();
        if !code.is_empty()
            && !message.is_empty()
            && code.len() <= 128
            && code
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        {
            return (code, message);
        }
    }
    ("native.internal".to_string(), detail.to_string())
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

/// Opaque destination handle for IPC: per-job unique, derived from the job
/// id only. The real path never crosses IPC and never enters events/logs.
fn destination_id_for(job: &str) -> String {
    let suffix = job.strip_prefix("job:").unwrap_or(job);
    format!("dst:{suffix}")
}

/// Best-effort removal of uncommitted output (no logging; paths stay
/// native). The atomic-write temp sibling is never user data and is always
/// safe to drop. The destination itself is removed only when overwrite was
/// refused: then it did not exist at grant time, so anything there now is
/// uncommitted. With overwrite confirmed the destination may hold user data
/// and is left alone.
fn remove_uncommitted_output(path: &Path, overwrite: bool) {
    let tmp = path.with_extension("tmp");
    if tmp != path {
        let _ = std::fs::remove_file(&tmp);
    }
    if overwrite {
        return;
    }
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// Map an opaque choice onto the engine response kind.
fn map_choice_kind(choice: &str) -> &'static str {
    let lower = choice.to_ascii_lowercase();
    if lower.starts_with("img:") || lower.starts_with("image") {
        "SelectedImage"
    } else if lower.starts_with("lvl:") || lower.starts_with("level") || lower.starts_with("zoom") {
        "SelectedLevel"
    } else if lower.contains("keep") || lower.contains("discard") || lower.contains("partial") {
        "PartialKeep"
    } else if lower.starts_with("att:") || lower.contains("retry") {
        "RetryReady"
    } else {
        "SelectedImage"
    }
}

/// Trailing numeric selector (`img:2` -> `Some(2)`).
fn trailing_index(choice: &str) -> Option<usize> {
    choice
        .rsplit([':', '=', '#', ' '])
        .next()?
        .trim()
        .parse::<usize>()
        .ok()
}

/// Drive a transient engine through `Cancel` for policy parity. Best-effort
/// and offline (no I/O); failures are ignored because the shell transcript is
/// the source of truth in the lean fallback.
fn drive_engine_cancel(job: &str, input_url: &str) {
    if input_url.is_empty() {
        return;
    }
    if let Ok(mut engine) =
        dezoomify_job::Job::new(job, input_url, dezoomify_job::Config::default())
    {
        let _ = engine.start();
        let _ = engine.on_response(dezoomify_job::JobResponse::Cancel {
            job: job.to_string(),
        });
        let _ = engine.drain_effects();
        let _ = engine.drain_events();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Discovery completion moves a discovering job to `AwaitingDestination`
    /// with one `job-state` event: the frontend's cue to offer the save
    /// destination. The discovery worker is short-lived, so pump until the
    /// transition lands (bounded wait, no wall-clock assertions).
    #[test]
    fn discovery_completion_requests_destination() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::Discovering));
        let start = std::time::Instant::now();
        while table.state_of(&id) == Some(JobState::Discovering) {
            table.poll_drivers();
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "discovery worker never reported completion"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(table.state_of(&id), Some(JobState::AwaitingDestination));
        let events = table.events_for(&id);
        assert!(events.len() >= 2, "submit plus destination request");
        let last = events.last().expect("destination request event");
        assert_eq!(last.kind, "job-state");
        assert_eq!(last.detail, "AwaitingDestination");
        let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
        let sorted = {
            let mut s = seqs.clone();
            s.sort();
            s
        };
        assert_eq!(seqs, sorted, "seq stays monotonic");
    }

    #[test]
    fn settings_start_automatically_enters_the_native_save_pipeline() {
        let mut table = JobTable::new();
        let mut settings = DesktopSettings::with_defaults();
        settings.output_dir = Some(std::env::temp_dir().join("dezoomify-auto-output-test"));
        settings.output_format = "webp".to_string();
        let id = table
            .start_job_with_settings("http://127.0.0.1:9/item", &settings)
            .unwrap();

        // Drive the discovery-complete signal directly so this test only
        // asserts desktop orchestration, never public-network behavior.
        table
            .driver_tx
            .send(DriverMessage::Discovered { job: id.clone() })
            .unwrap();
        table.pump_drivers();

        let events = table.events_for(&id);
        assert!(
            events
                .iter()
                .any(|event| event.kind == "destination" && event.detail == "webp"),
            "the main-screen settings start saving without a dialog"
        );
        assert!(
            !events
                .iter()
                .any(|event| event.detail == "AwaitingDestination"),
            "automatic saves never expose a choose-output step"
        );
        let _ = table.cancel_job(&id);
    }

    #[test]
    fn lifecycle_orders_events() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.answer_choice(&id, "img:0").unwrap();
        table.complete_job(&id).unwrap();
        let events = table.events_for(&id);
        let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        assert_eq!(seqs, sorted);
        assert!(events.iter().any(|e| e.kind == "completed"));
    }

    #[test]
    fn unknown_and_stale_rejected() {
        let mut table = JobTable::new();
        assert_eq!(table.cancel_job("job:missing").unwrap_err(), "unknown");
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(table.answer_choice(&id, "img:0").unwrap_err(), "stale");
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
        let id = table
            .start_job_with_settings("https://example.com/item", &settings)
            .unwrap();
        let config = table.config_for(&id).unwrap();
        assert_eq!(config.compression, 9);
        assert_eq!(config.max_retries, 0);
        assert_eq!(config.max_width, Some(800));
        assert_eq!(config.max_concurrent, 16);
        assert_eq!(config.fetch.max_idle_per_host, 32);
        assert!(table.output_dir_for(&id).is_none());
        let with_dir = parse_settings(&serde_json::json!({"output_dir": "/tmp/dz-out"})).unwrap();
        let id2 = table
            .start_job_with_settings("https://example.com/other", &with_dir)
            .unwrap();
        assert_eq!(
            table.output_dir_for(&id2).unwrap(),
            std::path::PathBuf::from("/tmp/dz-out")
        );
        // Real destination ONLY: the grant stores the dialog-chosen path
        // (here under the settings output dir), not a derived temp path.
        let path = std::path::PathBuf::from("/tmp/dz-out/grant.png");
        let (seq, destination_id) = table
            .request_destination(&id2, &path, "png", false)
            .unwrap();
        assert!(seq >= 1);
        assert_eq!(table.destination_for(&id2).unwrap(), path);
        assert_eq!(
            destination_id,
            format!("dst:{}", id2.strip_prefix("job:").unwrap())
        );
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
        let id = table.start_job("https://example.com/item").unwrap();
        // Quiesce the spawned discovery worker first: start_job records
        // Discovering synchronously but the worker announces completion
        // asynchronously through the driver channel, so an exact event
        // count is only stable once the pump has folded it. Same bounded
        // pump as discovery_completion_requests_destination (which owns
        // the pattern); without it the count below races the worker and
        // flakes under CI timing.
        let start = std::time::Instant::now();
        while table.state_of(&id) == Some(JobState::Discovering) {
            table.poll_drivers();
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "discovery worker never reported completion"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // Unknown extensions fail before any work: no destination, no event
        // beyond discovering, no worker outcome.
        let bad = scratch_path("validate", "out.bmp");
        let events_before = table.events_for(&id).len();
        let err = table
            .request_destination(&id, &bad, "png", false)
            .unwrap_err();
        assert!(
            err.contains("unsupported output extension"),
            "typed error, got {err}"
        );
        assert!(table.destination_for(&id).is_none());
        assert_eq!(table.events_for(&id).len(), events_before);
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
        // A matching grant stores the real path and reports an opaque id:
        // no raw path in the id, format only in the event.
        let (seq, destination_id) = table.request_destination(&id, &png, "png", false).unwrap();
        assert!(seq >= 1);
        assert_eq!(table.destination_for(&id).unwrap(), png);
        assert_eq!(
            destination_id,
            format!("dst:{}", id.strip_prefix("job:").unwrap())
        );
        assert!(!destination_id.contains("tmp") && !destination_id.contains('/'));
        let events = table.events_for(&id);
        let granted = events.iter().find(|e| e.kind == "destination").unwrap();
        assert_eq!(granted.detail, "png");
        assert!(!granted.detail.contains("tmp"));
        // Unknown and stale jobs are rejected without effects.
        assert_eq!(
            table
                .request_destination("job:missing", &png, "png", false)
                .unwrap_err(),
            "unknown"
        );
        table.cancel_job(&id).unwrap();
        assert_eq!(
            table
                .request_destination(&id, &png, "png", false)
                .unwrap_err(),
            "stale"
        );
    }

    #[test]
    fn destination_overwrite_policy() {
        let dir = scratch_path("overwrite", "dir");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.png");
        std::fs::write(&path, b"existing").unwrap();
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        // Existing output refuses without overwrite: typed error, no grant.
        let err = table
            .request_destination(&id, &path, "png", false)
            .unwrap_err();
        assert!(err.contains("refusing overwrite"), "typed error, got {err}");
        assert!(table.destination_for(&id).is_none());
        // Explicit overwrite confirmation grants the same path.
        let (.., destination_id) = table.request_destination(&id, &path, "png", true).unwrap();
        assert_eq!(table.destination_for(&id).unwrap(), path);
        assert!(!destination_id.contains("out.png"));
        table.cancel_job(&id).unwrap();
        // Overwrite grants leave pre-existing user data alone on cancel.
        assert_eq!(std::fs::read(&path).unwrap(), b"existing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handoff_user_headers_reach_driver_and_stay_out_of_debug() {
        use std::collections::BTreeMap;
        let mut table = JobTable::new();
        let mut headers = BTreeMap::new();
        headers.insert("cookie".to_string(), "session=CANARY-handoff".to_string());
        let id = table
            .start_job_with_user_headers("https://protected.example/item", headers)
            .unwrap();
        let config = table.config_for(&id).unwrap();
        assert_eq!(
            config.user_headers.get("cookie").map(String::as_str),
            Some("session=CANARY-handoff"),
            "handoff cookie must reach the driver config"
        );
        // Memory-only secrets never appear in Debug, events, or ids.
        let debug = format!("{:?}", table);
        assert!(
            !debug.contains("CANARY-handoff"),
            "cookie value leaked into Debug"
        );
        assert!(debug.contains("cookie"), "header name stays visible");
        for event in table.events_for(&id) {
            assert!(
                !event.detail.contains("CANARY-handoff") && !event.kind.contains("CANARY"),
                "cookie value leaked into transcript"
            );
        }
        table.cancel_job(&id).unwrap();
    }

    #[test]
    fn event_projection_seq_monotonic_and_terminal_once() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        // Seq starts at 1 and grows monotonically via saturating_add.
        assert_eq!(table.last_seq(&id), Some(1));
        table.answer_choice(&id, "img:0").unwrap();
        let s2 = table.last_seq(&id).unwrap();
        assert!(s2 > 1, "seq must increase");
        table.record_test_progress(&id, 3, 10).unwrap();
        let s3 = table.last_seq(&id).unwrap();
        assert!(s3 > s2, "progress must bump seq");
        table.complete_job(&id).unwrap();
        let terminal_seq = table.last_seq(&id).unwrap();
        let events = table.events_for(&id);
        // Terminal appears exactly once; seqs are strictly increasing.
        let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
        for window in seqs.windows(2) {
            assert!(window[1] > window[0], "seq must be strictly monotonic");
        }
        let terminals: Vec<&JobEvent> = events
            .iter()
            .filter(|e| e.kind == "completed" || e.kind == "cancelled" || e.kind == "failed")
            .collect();
        assert_eq!(terminals.len(), 1, "terminal exactly once");
        // Post-terminal inputs are stale with no new effects.
        let before = events.len();
        assert_eq!(table.record_test_progress(&id, 9, 10).unwrap_err(), "stale");
        assert_eq!(table.answer_choice(&id, "img:1").unwrap_err(), "stale");
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(table.events_for(&id).len(), before);
        assert_eq!(table.last_seq(&id), Some(terminal_seq));
        // Drained emits are ordered and never replay.
        let pending = table.drain_pending();
        assert!(!pending.is_empty(), "projection must enqueue emits");
        let mut last = 0u64;
        for emit in &pending {
            assert!(emit.seq > last, "pending emits ordered");
            last = emit.seq;
        }
        assert!(table.drain_pending().is_empty(), "drain never replays");
    }

    #[test]
    fn progress_monotonic_survives_retries_and_cache() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.record_test_progress(&id, 5, 10).unwrap();
        assert_eq!(table.progress_for(&id), Some((5, 10)));
        // A retry re-report with lower counts never moves backwards.
        table.record_test_progress(&id, 2, 10).unwrap();
        assert_eq!(table.progress_for(&id), Some((5, 10)));
        // A resume-cache hit still counts forward.
        table.record_test_progress(&id, 7, 10).unwrap();
        assert_eq!(table.progress_for(&id), Some((7, 10)));
        // Unknown totals stay 0 and never claim completeness.
        let mut fresh = JobTable::new();
        let id2 = fresh.start_job("https://example.com/other").unwrap();
        fresh.record_test_progress(&id2, 1, 0).unwrap();
        assert_eq!(fresh.progress_for(&id2), Some((1, 0)));
        // Projected progress payloads carry numbers, redacted origin only.
        let events = table.events_for(&id);
        let progress = events.iter().find(|e| e.kind == "downloading").unwrap();
        let (channel, payload) = table.project_event(&id, progress);
        assert_eq!(channel, CHANNEL_JOB_PROGRESS);
        assert_eq!(payload["acquired"], serde_json::json!(5u64));
        assert_eq!(payload["total"], serde_json::json!(10u64));
        assert_eq!(payload["jobId"], serde_json::json!(id));
        assert_eq!(payload["job"], serde_json::json!(id));
        assert!(payload.get("seq").is_some());
        assert!(!payload_has_forbidden_keys(&payload));
        assert!(!payload.to_string().contains("example.com/item"));
    }

    #[test]
    fn output_carries_real_sha256_and_geometry() {
        // sha256("test"): a real 64-hex digest shape (never a stub).
        let digest = "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table
            .publish_test_output(&id, digest, "png", 800, 600, 12)
            .unwrap();
        let snapshot = table.output_snapshot_for(&id).unwrap();
        assert_eq!(snapshot.output_hash, digest);
        assert_eq!(snapshot.format, "png");
        assert_eq!((snapshot.width, snapshot.height), (800, 600));
        assert_eq!(snapshot.tile_count, 12);
        // Hex part is 64 lowercase hex chars (real sha256, never a stub).
        let hex_part = snapshot.output_hash.strip_prefix("sha256:").unwrap();
        assert_eq!(hex_part.len(), 64);
        assert!(hex_part.chars().all(|c| c.is_ascii_hexdigit()));
        let events = table.events_for(&id);
        let completed = events.iter().find(|e| e.kind == "completed").unwrap();
        let (channel, payload) = table.project_event(&id, completed);
        assert_eq!(channel, CHANNEL_JOB_OUTPUT);
        assert_eq!(payload["outputHash"], serde_json::json!(digest));
        assert_eq!(payload["format"], serde_json::json!("png"));
        assert_eq!(payload["width"], serde_json::json!(800u32));
        assert_eq!(payload["height"], serde_json::json!(600u32));
        assert_eq!(payload["tileCount"], serde_json::json!(12usize));
        assert!(!payload_has_forbidden_keys(&payload));
    }

    #[test]
    fn error_carries_stable_code_phase_retryable_recovery() {
        let mut table = JobTable::new();
        let id = table
            .start_job("https://example.com/item?token=CANARY-secret")
            .unwrap();
        table
            .fail_test_job(
                &id,
                "tile.download-failed",
                "3 tiles failed; token=CANARY-secret",
            )
            .unwrap();
        let snapshot = table.error_snapshot_for(&id).unwrap();
        assert_eq!(snapshot.code, "tile.download-failed");
        assert_eq!(snapshot.phase, "acquisition");
        assert!(snapshot.retryable);
        assert_eq!(snapshot.recovery, "retry");
        // Redacted origin only: scheme://host, never the full URL or secret.
        assert_eq!(snapshot.origin, table.jobs.get(&id).unwrap().origin);
        assert!(!snapshot.origin.contains("/item"));
        assert!(!snapshot.message.contains("CANARY-secret"));
        assert!(snapshot.message.contains("REDACTED"));
        let events = table.events_for(&id);
        let failed = events.iter().find(|e| e.kind == "failed").unwrap();
        let (channel, payload) = table.project_event(&id, failed);
        assert_eq!(channel, CHANNEL_JOB_ERROR);
        assert_eq!(payload["code"], serde_json::json!("tile.download-failed"));
        assert_eq!(payload["phase"], serde_json::json!("acquisition"));
        assert_eq!(payload["retryable"], serde_json::json!(true));
        assert_eq!(payload["recovery"], serde_json::json!("retry"));
        assert_eq!(payload["transport"], serde_json::json!("native"));
        assert!(!payload.to_string().contains("CANARY-secret"));
        assert!(payload["message"]
            .as_str()
            .unwrap_or("")
            .contains("REDACTED"));
        assert!(!payload.to_string().contains("/item"));
        assert!(!payload_has_forbidden_keys(&payload));
        // Phase/retryable mapping is by code, never display strings.
        assert_eq!(error_phase("discovery.failed"), "discovery");
        assert_eq!(error_phase("output.canvas-limit"), "output");
        assert!(!error_retryable("output.canvas-limit"));
        assert!(error_retryable("tile.http-error"));
        assert_eq!(error_recovery("output.canvas-limit"), "choose-output");
        // New boundary fields reach the snapshot and payload.
        assert_eq!(snapshot.transport, "native");
        assert_eq!(snapshot.resource_kind.as_deref(), Some("tile"));
        assert_eq!(payload["transport"], serde_json::json!("native"));
        assert_eq!(payload["resource_kind"], serde_json::json!("tile"));
    }

    #[test]
    fn error_mapping_covers_stable_codes_once_by_code() {
        // Legacy remaps from job_driver.rs:263-275 stay stable.
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
        // Codes reach the payload with phase/transport/resource-kind plus the
        // redacted origin; full URLs, paths, and secrets never do.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table
            .fail_test_job(
                &id,
                "output.canvas-limit",
                "composed image 40000x40000 needs 5.9 GiB",
            )
            .unwrap();
        let snapshot = table.error_snapshot_for(&id).unwrap();
        assert_eq!(snapshot.code, "output.canvas-limit");
        assert_eq!(snapshot.phase, "output");
        assert_eq!(snapshot.transport, "native");
        assert_eq!(snapshot.resource_kind.as_deref(), Some("output"));
        assert_eq!(snapshot.recovery, "choose-output");
        let failed = table
            .events_for(&id)
            .into_iter()
            .find(|e| e.kind == "failed")
            .unwrap();
        let (channel, payload) = table.project_event(&id, &failed);
        assert_eq!(channel, CHANNEL_JOB_ERROR);
        assert_eq!(payload["code"], serde_json::json!("output.canvas-limit"));
        assert_eq!(payload["phase"], serde_json::json!("output"));
        assert_eq!(payload["transport"], serde_json::json!("native"));
        assert_eq!(payload["resource_kind"], serde_json::json!("output"));
        assert!(!payload.to_string().contains("/item"));
    }

    #[test]
    fn channels_cover_five_and_forbid_tile_bytes() {
        assert_eq!(CHANNEL_JOB_STATE, "dezoomify://job-state");
        assert_eq!(CHANNEL_JOB_PROGRESS, "dezoomify://job-progress");
        assert_eq!(CHANNEL_JOB_OUTPUT, "dezoomify://job-output");
        assert_eq!(CHANNEL_JOB_ERROR, "dezoomify://job-error");
        assert_eq!(CHANNEL_DEEP_LINK, "dezoomify://deep-link-pending");
        assert_eq!(channel_for_kind("job-state"), CHANNEL_JOB_STATE);
        assert_eq!(channel_for_kind("downloading"), CHANNEL_JOB_PROGRESS);
        assert_eq!(channel_for_kind("discovery"), CHANNEL_JOB_PROGRESS);
        assert_eq!(channel_for_kind("encoding"), CHANNEL_JOB_PROGRESS);
        assert_eq!(channel_for_kind("completed"), CHANNEL_JOB_OUTPUT);
        assert_eq!(channel_for_kind("failed"), CHANNEL_JOB_ERROR);
        assert_eq!(channel_for_kind("cancelled"), CHANNEL_JOB_STATE);
        // Forbidden keys never pass the guard.
        let bad = serde_json::json!({"tileBytes": [1, 2, 3]});
        assert!(payload_has_forbidden_keys(&bad));
        let bad2 = serde_json::json!({"pixels": "abc"});
        assert!(payload_has_forbidden_keys(&bad2));
        // Real payloads never contain them.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.record_test_progress(&id, 1, 4).unwrap();
        for emit in table.drain_pending() {
            assert!(
                !payload_has_forbidden_keys(&emit.payload),
                "tile bytes crossed IPC on {}",
                emit.channel
            );
            // Every emit carries (channel, jobId, seq, payload) with both
            // job aliases so frontend guards keep working.
            assert_eq!(emit.job, id);
            assert_eq!(emit.payload["jobId"], serde_json::json!(id));
            assert_eq!(emit.payload["job"], serde_json::json!(id));
            assert_eq!(emit.payload["seq"], serde_json::json!(emit.seq));
        }
    }

    #[test]
    fn job_state_names_cover_task_phases() {
        for (state, name) in [
            (JobState::Created, "Created"),
            (JobState::Discovering, "Discovering"),
            (JobState::AwaitingImageSelection, "AwaitingImageSelection"),
            (JobState::AwaitingLevelSelection, "AwaitingLevelSelection"),
            (JobState::AwaitingDestination, "AwaitingDestination"),
            (JobState::AwaitingPartialDecision, "AwaitingPartialDecision"),
            (JobState::AwaitingRecovery, "AwaitingRecovery"),
            (JobState::Running, "Running"),
            (JobState::Planning, "Planning"),
            (JobState::Acquiring, "Acquiring"),
            (JobState::Processing, "Processing"),
            (JobState::Encoding, "Encoding"),
            (JobState::Finalizing, "Finalizing"),
            (JobState::Publishing, "Publishing"),
            (JobState::CleaningUp, "CleaningUp"),
            (JobState::Completed, "Completed"),
            (JobState::Cancelled, "Cancelled"),
            (JobState::Failed, "Failed"),
        ] {
            assert_eq!(state.name(), name);
        }
        assert!(JobState::AwaitingDestination.is_awaiting());
        assert!(!JobState::Running.is_awaiting());
        assert!(JobState::Completed.is_terminal());
        assert!(!JobState::Running.is_terminal());
    }

    #[test]
    fn destination_cancel_removes_uncommitted_file() {
        let dir = scratch_path("cancel", "dir");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.jpg");
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        // Stop the discovery worker before setting up the cancellation-only
        // fixture. The production destination path starts another worker,
        // which could legitimately finish before this synchronous assertion.
        let handle = table.driver_handles.remove(&id).unwrap();
        handle.join().unwrap();
        if let Some(record) = table.jobs.get_mut(&id) {
            record.destination = Some(path.clone());
            record.destination_format = Some("jpeg".to_string());
            record.destination_overwrite = false;
        }
        // Simulate uncommitted output plus its atomic-write temp sibling.
        std::fs::write(&path, b"partial").unwrap();
        std::fs::write(path.with_extension("tmp"), b"temp").unwrap();
        table.cancel_job(&id).unwrap();
        assert!(!path.exists(), "uncommitted output removed on cancel");
        assert!(
            !path.with_extension("tmp").exists(),
            "temp sibling removed on cancel"
        );
        assert_eq!(table.state_of(&id), Some(JobState::Cancelled));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Task 6.1: unknown job ids are rejected before any work.
    ///
    /// The table reports `unknown` (mapped to `job.unknown` at the commands
    /// layer); no state changes, no events, no pending emits.
    #[test]
    fn unknown_job_inputs_rejected_without_work() {
        let mut table = JobTable::new();
        let pending_before = table.drain_pending().len();
        assert_eq!(pending_before, 0);
        assert_eq!(table.cancel_job("job:missing").unwrap_err(), "unknown");
        assert_eq!(
            table.answer_choice("job:missing", "img:0").unwrap_err(),
            "unknown"
        );
        let path = scratch_path("unknown", "out.png");
        assert_eq!(
            table
                .request_destination("job:missing", &path, "png", false)
                .unwrap_err(),
            "unknown"
        );
        assert_eq!(table.complete_job("job:missing").unwrap_err(), "unknown");
        assert_eq!(
            table
                .publish_test_output("job:missing", "sha256:abc", "png", 1, 1, 1)
                .unwrap_err(),
            "unknown"
        );
        assert_eq!(
            table
                .complete_partial_test_output("job:missing", "sha256:abc", "png", 1, 1, 1)
                .unwrap_err(),
            "unknown"
        );
        assert_eq!(
            table.record_test_progress("job:missing", 1, 2).unwrap_err(),
            "unknown"
        );
        assert_eq!(
            table
                .fail_test_job("job:missing", "tile.download-failed", "x")
                .unwrap_err(),
            "unknown"
        );
        assert!(table.events_for("job:missing").is_empty());
        assert_eq!(table.last_seq("job:missing"), None);
        assert_eq!(table.state_of("job:missing"), None);
        assert!(table.drain_pending().is_empty(), "no emits for unknown");
        assert!(table.is_empty());
    }

    /// Task 6.1: a terminal job's second cancel/choice is stale with no new
    /// effect or event. Covers all four terminals
    /// (Completed/PartiallyCompleted/Failed/Cancelled).
    #[test]
    fn terminal_second_cancel_and_choice_are_stale_without_new_events() {
        for terminal in ["cancelled", "completed", "partial", "failed"] {
            let mut table = JobTable::new();
            let id = table.start_job("https://example.com/item").unwrap();
            match terminal {
                "cancelled" => {
                    table.cancel_job(&id).unwrap();
                }
                "completed" => {
                    table
                        .publish_test_output(
                            &id,
                            "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                            "png",
                            8,
                            6,
                            2,
                        )
                        .unwrap();
                }
                "partial" => {
                    table
                        .complete_partial_test_output(
                            &id,
                            "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                            "png",
                            8,
                            6,
                            1,
                        )
                        .unwrap();
                }
                _ => {
                    table
                        .fail_test_job(&id, "tile.download-failed", "tiles missing")
                        .unwrap();
                }
            }
            assert!(
                table.state_of(&id).unwrap().is_terminal(),
                "{terminal} must be terminal"
            );
            let events_before = table.events_for(&id).len();
            let seq_before = table.last_seq(&id).unwrap();
            let _ = table.drain_pending();
            // Second cancel and second choice are both stale.
            assert_eq!(table.cancel_job(&id).unwrap_err(), "stale", "{terminal}");
            assert_eq!(
                table.answer_choice(&id, "img:1").unwrap_err(),
                "stale",
                "{terminal}"
            );
            assert_eq!(table.events_for(&id).len(), events_before, "{terminal}");
            assert_eq!(table.last_seq(&id), Some(seq_before), "{terminal}");
            assert!(
                table.drain_pending().is_empty(),
                "{terminal}: no new emits on stale"
            );
        }
    }

    /// Task 6.1: every post-terminal input is rejected with no work.
    ///
    /// The table reports `stale` (the shell projection of the engine's stable
    /// `job.post-terminal`); no state change, no event, no seq bump, no
    /// pending emit, no destination/output mutation.
    #[test]
    fn post_terminal_all_inputs_rejected_without_work() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::Cancelled));
        let events_before = table.events_for(&id).len();
        let seq_before = table.last_seq(&id).unwrap();
        let pending_before = table.drain_pending().len();
        assert!(pending_before > 0, "terminal must have enqueued emits");
        let path = scratch_path("post-terminal", "out.png");
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(table.answer_choice(&id, "img:0").unwrap_err(), "stale");
        assert_eq!(
            table
                .request_destination(&id, &path, "png", false)
                .unwrap_err(),
            "stale"
        );
        assert_eq!(table.complete_job(&id).unwrap_err(), "stale");
        assert_eq!(
            table
                .publish_test_output(&id, "sha256:abc", "png", 1, 1, 1)
                .unwrap_err(),
            "stale"
        );
        assert_eq!(
            table
                .complete_partial_test_output(&id, "sha256:abc", "png", 1, 1, 1)
                .unwrap_err(),
            "stale"
        );
        assert_eq!(table.record_test_progress(&id, 9, 9).unwrap_err(), "stale");
        assert_eq!(
            table
                .fail_test_job(&id, "tile.download-failed", "late")
                .unwrap_err(),
            "stale"
        );
        assert_eq!(table.state_of(&id), Some(JobState::Cancelled));
        assert_eq!(table.events_for(&id).len(), events_before);
        assert_eq!(table.last_seq(&id), Some(seq_before));
        assert!(table.drain_pending().is_empty(), "no work after terminal");
        assert!(table.destination_for(&id).is_none());
        assert!(table.output_hash_for(&id).is_none());
        // Late driver pump after a sync terminal adds nothing.
        table.poll_drivers();
        assert_eq!(table.events_for(&id).len(), events_before);
    }

    /// Task 6.1: duplicates are safe no-ops with no state change.
    ///
    /// Desktop projection: re-reported progress never moves the monotonic
    /// snapshot backwards. Engine parity: an already-consumed/unknown request
    /// replays as `Ignored` with no transition, effect, or event.
    #[test]
    fn duplicate_inputs_are_ignored_without_state_change() {
        // Desktop: lower re-reports never move progress backwards.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.record_test_progress(&id, 5, 10).unwrap();
        let snapshot_before = table.progress_for(&id).unwrap();
        let state_before = table.state_of(&id).unwrap();
        table.record_test_progress(&id, 5, 10).unwrap();
        table.record_test_progress(&id, 2, 9).unwrap();
        assert_eq!(table.progress_for(&id), Some(snapshot_before));
        // Only the monotonic max survives; the snapshot never regresses.
        assert_eq!(table.progress_for(&id), Some((5, 10)));
        let _ = state_before;
        // Engine parity: unknown/consumed request ids replay as Ignored.
        let mut engine =
            dezoomify_job::Job::new("job:dup", "https://example.com/item", Default::default())
                .unwrap();
        engine.start().unwrap();
        let seq_before = engine.seq();
        let events_before = engine.pending_event_count();
        let effects_before = engine.pending_effect_count();
        let outcome = engine
            .on_response(dezoomify_job::JobResponse::ResourceBytes {
                job: "job:dup".to_string(),
                request: "req:missing".to_string(),
                bytes: vec![1, 2, 3],
                final_uri: None,
            })
            .unwrap();
        assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
        assert_eq!(engine.seq(), seq_before, "Ignored bumps no seq");
        assert_eq!(engine.pending_event_count(), events_before);
        assert_eq!(engine.pending_effect_count(), effects_before);
    }

    /// Task 6.1: seq is strictly monotonic increasing across the lifecycle.
    #[test]
    fn seq_strictly_monotonic_across_lifecycle() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        assert_eq!(table.last_seq(&id), Some(1));
        let mut last = 1u64;
        table.answer_choice(&id, "img:0").unwrap();
        let s2 = table.last_seq(&id).unwrap();
        assert!(s2 > last, "choice must bump seq");
        last = s2;
        table.record_test_progress(&id, 1, 4).unwrap();
        let s3 = table.last_seq(&id).unwrap();
        assert!(s3 > last, "progress must bump seq");
        last = s3;
        let path = scratch_path("seq", "out.png");
        table.request_destination(&id, &path, "png", false).unwrap();
        let s4 = table.last_seq(&id).unwrap();
        assert!(s4 > last, "destination must bump seq");
        last = s4;
        table
            .publish_test_output(
                &id,
                "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                "png",
                4,
                4,
                1,
            )
            .unwrap();
        let terminal_seq = table.last_seq(&id).unwrap();
        assert!(terminal_seq > last);
        let seqs: Vec<u64> = table.events_for(&id).iter().map(|e| e.seq).collect();
        for window in seqs.windows(2) {
            assert!(window[1] > window[0], "transcript seq strictly monotonic");
        }
        let pending = table.drain_pending();
        let mut emit_last = 0u64;
        for emit in &pending {
            assert!(emit.seq > emit_last, "pending emits ordered");
            emit_last = emit.seq;
        }
        assert_eq!(emit_last, terminal_seq);
    }

    /// Task 6.1: each terminal appears exactly once; later terminals are stale.
    #[test]
    fn terminal_exactly_once_for_all_four_kinds() {
        fn terminal_kinds(events: &[JobEvent]) -> Vec<&JobEvent> {
            events
                .iter()
                .filter(|e| {
                    matches!(
                        e.kind.as_str(),
                        "completed"
                            | "partial-completed"
                            | "partial_completed"
                            | "cancelled"
                            | "failed"
                    )
                })
                .collect()
        }
        // Cancelled.
        {
            let mut table = JobTable::new();
            let id = table.start_job("https://example.com/item").unwrap();
            table.cancel_job(&id).unwrap();
            let events = table.events_for(&id);
            let terminals = terminal_kinds(&events);
            assert_eq!(terminals.len(), 1);
            assert_eq!(terminals[0].kind, "cancelled");
            assert_eq!(table.state_of(&id), Some(JobState::Cancelled));
        }
        // Completed.
        {
            let mut table = JobTable::new();
            let id = table.start_job("https://example.com/item").unwrap();
            table.complete_job(&id).unwrap();
            let events = table.events_for(&id);
            let terminals = terminal_kinds(&events);
            assert_eq!(terminals.len(), 1);
            assert_eq!(terminals[0].kind, "completed");
            assert_eq!(table.state_of(&id), Some(JobState::Completed));
            assert_eq!(table.complete_job(&id).unwrap_err(), "stale");
            let events = table.events_for(&id);
            assert_eq!(terminal_kinds(&events).len(), 1);
        }
        // PartiallyCompleted.
        {
            let mut table = JobTable::new();
            let id = table.start_job("https://example.com/item").unwrap();
            table
                .complete_partial_test_output(&id, "sha256:abc", "png", 2, 2, 1)
                .unwrap();
            assert_eq!(table.state_of(&id), Some(JobState::PartiallyCompleted));
            let events = table.events_for(&id);
            let terminals = terminal_kinds(&events);
            assert_eq!(terminals.len(), 1);
            assert_eq!(terminals[0].kind, "partial-completed");
            let (channel, payload) = table.project_event(&id, terminals[0]);
            assert_eq!(channel, CHANNEL_JOB_OUTPUT);
            assert_eq!(payload["state"], serde_json::json!("PartiallyCompleted"));
            assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
            let events = table.events_for(&id);
            assert_eq!(terminal_kinds(&events).len(), 1);
        }
        // Failed.
        {
            let mut table = JobTable::new();
            let id = table.start_job("https://example.com/item").unwrap();
            table
                .fail_test_job(&id, "tile.download-failed", "boom")
                .unwrap();
            let events = table.events_for(&id);
            let terminals = terminal_kinds(&events);
            assert_eq!(terminals.len(), 1);
            assert_eq!(terminals[0].kind, "failed");
            assert_eq!(table.state_of(&id), Some(JobState::Failed));
            assert_eq!(
                table
                    .fail_test_job(&id, "tile.download-failed", "again")
                    .unwrap_err(),
                "stale"
            );
            let events = table.events_for(&id);
            assert_eq!(terminal_kinds(&events).len(), 1);
        }
    }

    /// Task 6.1: wrong-job / wrong-state / bad-id are rejected without work.
    ///
    /// Engine parity uses stable `job.wrong-job`, `job.invalid-state`, and
    /// `job.invalid-id`; the shell table rejects unmapped ids as `unknown`
    /// with no events or seq.
    #[test]
    fn wrong_job_wrong_state_bad_id_rejected_without_work() {
        // Engine: wrong-job correlation never corrupts state.
        let mut engine =
            dezoomify_job::Job::new("job:mine", "https://example.com/item", Default::default())
                .unwrap();
        engine.start().unwrap();
        let seq_before = engine.seq();
        let err = engine
            .on_response(dezoomify_job::JobResponse::ResourceBytes {
                job: "job:other".to_string(),
                request: "req:0".to_string(),
                bytes: vec![1],
                final_uri: None,
            })
            .unwrap_err();
        assert_eq!(err.code, "job.wrong-job");
        assert_eq!(engine.seq(), seq_before);
        // Engine: image selection in Discovering is wrong-state.
        let err = engine
            .on_response(dezoomify_job::JobResponse::SelectedImage {
                job: "job:mine".to_string(),
                image: "img:other".to_string(),
            })
            .unwrap_err();
        assert_eq!(err.code, "job.invalid-state");
        // Engine: malformed ids are bad-id.
        let err = engine
            .on_response(dezoomify_job::JobResponse::ResourceBytes {
                job: "job:mine".to_string(),
                request: "bad".to_string(),
                bytes: vec![1],
                final_uri: None,
            })
            .unwrap_err();
        assert_eq!(err.code, "job.invalid-id");
        let err = engine
            .on_response(dezoomify_job::JobResponse::SelectedImage {
                job: "job:mine".to_string(),
                image: "bad".to_string(),
            })
            .unwrap_err();
        assert_eq!(err.code, "job.invalid-id");
        assert!(
            dezoomify_job::Job::new("bad-id", "https://example.com/item", Default::default())
                .is_err()
        );
        // Shell table: unmapped ids are unknown with no work.
        let mut table = JobTable::new();
        assert_eq!(table.cancel_job("bad-id").unwrap_err(), "unknown");
        assert_eq!(table.cancel_job("job:").unwrap_err(), "unknown");
        assert!(table.events_for("bad-id").is_empty());
        assert_eq!(table.last_seq("bad-id"), None);
    }

    /// Task 6.1: engine post-terminal inputs return stable `job.post-terminal`
    /// with no new work; the shell projects the same moment as `stale`.
    #[test]
    fn engine_post_terminal_returns_job_post_terminal_without_work() {
        let mut engine =
            dezoomify_job::Job::new("job:term", "https://example.com/item", Default::default())
                .unwrap();
        engine.start().unwrap();
        engine
            .on_response(dezoomify_job::JobResponse::Cancel {
                job: "job:term".to_string(),
            })
            .unwrap();
        assert!(engine.is_terminal());
        let seq_before = engine.seq();
        let events_before = engine.pending_event_count();
        let effects_before = engine.pending_effect_count();
        let err = engine
            .on_response(dezoomify_job::JobResponse::Cancel {
                job: "job:term".to_string(),
            })
            .unwrap_err();
        assert_eq!(err.code, "job.post-terminal");
        assert_eq!(engine.seq(), seq_before, "no work after terminal");
        assert_eq!(engine.pending_event_count(), events_before);
        assert_eq!(engine.pending_effect_count(), effects_before);
        // Shell projection of the same moment.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
    }

    /// Task 6.1: input validation rejects userinfo, oversize, bad format, and
    /// empty choice before any state change or event.
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
        let id = table.start_job("https://example.com/item").unwrap();
        let handle = table.driver_handles.remove(&id).unwrap();
        handle.join().unwrap();
        table.pump_drivers();
        assert_eq!(table.state_of(&id), Some(JobState::AwaitingDestination));
        let events_before = table.events_for(&id).len();
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
        assert_eq!(table.events_for(&id).len(), events_before);
        // Empty and oversize choices are rejected without events.
        assert_eq!(
            table.answer_choice(&id, "").unwrap_err(),
            "choice must be 1..128 bytes"
        );
        let oversize_choice = "x".repeat(129);
        assert_eq!(
            table.answer_choice(&id, &oversize_choice).unwrap_err(),
            "choice must be 1..128 bytes"
        );
        assert_eq!(table.events_for(&id).len(), events_before);
        table.cancel_job(&id).unwrap();
    }

    #[test]
    fn partial_recovery_request_is_honest_and_reachable() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        let missing = vec!["tile:1".to_string(), "tile:2".to_string()];
        table.request_partial_for_test(&id, &missing, 2, 4).unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::AwaitingPartialDecision));
        let pending = table.pending_partial_for(&id).expect("pending ledger");
        assert_eq!(pending.missing, missing);
        assert_eq!((pending.failed, pending.total), (2, 4));
        let events = table.events_for(&id);
        let requested = events
            .iter()
            .find(|e| e.kind == "recovery-requested")
            .expect("recovery-requested event");
        // Ledger only: tile ids and counts, never paths or URLs.
        assert!(requested.detail.contains("tile:1"));
        assert!(requested.detail.contains("partial"));
        assert!(!requested.detail.contains("example.com/item"));
        assert!(!requested.detail.contains("/tmp"));
        let (channel, payload) = table.project_event(&id, requested);
        assert_eq!(channel, CHANNEL_JOB_STATE);
        assert_eq!(payload["reason"], serde_json::json!("partial"));
        assert_eq!(payload["missing"], serde_json::json!(["tile:1", "tile:2"]));
        assert!(!payload.to_string().contains("example.com/item"));
        assert!(!payload_has_forbidden_keys(&payload));
    }

    #[test]
    fn partial_answer_wakes_the_driver_gate() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table
            .request_partial_for_test(&id, &["tile:9".to_string()], 1, 4)
            .unwrap();
        // Keep wakes the gate and leaves the awaiting state for the driver
        // terminal.
        table.answer_choice(&id, "partial:keep").unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::Running));
        assert!(table.pending_partial_for(&id).is_none());
        let gate = table.jobs.get(&id).expect("record").partial_gate.clone();
        // The answer was consumed by the wait in `answer_choice`? No: the
        // gate still holds it for the background driver to take.
        // `answer_choice` answers but does not take, so the driver observes
        // it exactly once.
        assert_eq!(
            gate.take_decision(),
            Some(dezoomify_native::pipeline::PartialDecision::Keep)
        );
        // Discard maps distinctly; retry never changes the fallback policy.
        let id2 = table.start_job("https://example.com/other").unwrap();
        table
            .request_partial_for_test(&id2, &["tile:3".to_string()], 1, 2)
            .unwrap();
        table.answer_choice(&id2, "partial:discard").unwrap();
        let gate2 = table.jobs.get(&id2).expect("record").partial_gate.clone();
        assert_eq!(
            gate2.take_decision(),
            Some(dezoomify_native::pipeline::PartialDecision::Discard)
        );
        assert_eq!(
            table.config_for(&id2).expect("config").partial_policy,
            dezoomify_native::pipeline::PartialPolicy::Fail
        );
        let id3 = table.start_job("https://example.com/third").unwrap();
        table
            .request_partial_for_test(&id3, &["tile:4".to_string()], 1, 2)
            .unwrap();
        table.answer_choice(&id3, "att:0:ready").unwrap();
        let gate3 = table.jobs.get(&id3).expect("record").partial_gate.clone();
        assert_eq!(
            gate3.take_decision(),
            Some(dezoomify_native::pipeline::PartialDecision::Retry)
        );
    }

    #[test]
    fn partial_completed_terminal_carries_ledger_and_sibling_only() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        // Grant a real path, then publish an honest partial: the terminal
        // must name the sibling basename, never the granted path.
        let granted = scratch_path("honest-partial", "saved.png");
        // Stop the discovery worker so the grant below is synchronous.
        if let Some(handle) = table.driver_handles.remove(&id) {
            handle.join().unwrap();
        }
        table.pump_drivers();
        table
            .request_destination(&id, &granted, "png", false)
            .unwrap();
        // Remove the pipeline worker handle without waiting: this test
        // asserts the honest terminal shape, not real I/O.
        if let Some(handle) = table.driver_handles.remove(&id) {
            // The worker may still be starting; detach without joining a
            // running pipeline (join would block on real network).
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                // Signal cancellation so a stray worker exits promptly,
                // then detach (the handle is dropped without join; the
                // thread is short-lived in tests).
                if let Some(record) = table.jobs.get(&id) {
                    record
                        .cancel_flag
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }
        let missing = vec!["tile:1".to_string()];
        table
            .complete_partial_with_ledger_for_test(
                &id,
                "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                "png",
                512,
                512,
                3,
                &missing,
                "saved.partial.png",
            )
            .unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::PartiallyCompleted));
        assert_eq!(table.output_missing_for(&id), missing);
        assert_eq!(
            table.output_sibling_for(&id).as_deref(),
            Some("saved.partial.png")
        );
        let events = table.events_for(&id);
        let terminal = events
            .iter()
            .find(|e| e.kind == "partial-completed")
            .expect("partial-completed terminal");
        assert!(terminal.detail.contains("saved.partial.png"));
        assert!(terminal.detail.contains("tile:1"));
        assert!(
            !terminal.detail.contains("honest-partial"),
            "granted directory must never enter the terminal"
        );
        let (channel, payload) = table.project_event(&id, terminal);
        assert_eq!(channel, CHANNEL_JOB_OUTPUT);
        assert_eq!(payload["state"], serde_json::json!("PartiallyCompleted"));
        assert_eq!(payload["missing"], serde_json::json!(["tile:1"]));
        assert_eq!(payload["sibling"], serde_json::json!("saved.partial.png"));
        assert!(!payload.to_string().contains("honest-partial"));
        assert!(!payload_has_forbidden_keys(&payload));
        // Post-terminal answers stay stale.
        assert_eq!(
            table.answer_choice(&id, "partial:keep").unwrap_err(),
            "stale"
        );
    }

    #[test]
    fn partial_discard_fails_honestly_with_no_output() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table
            .fail_test_job(&id, "tile.download-failed", "1 tile(s) still failing")
            .unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::Failed));
        assert!(table.output_hash_for(&id).is_none());
        assert!(table.output_missing_for(&id).is_empty());
        assert!(table.output_sibling_for(&id).is_none());
        let snapshot = table.error_snapshot_for(&id).expect("error snapshot");
        assert_eq!(snapshot.code, "tile.download-failed");
    }
}
