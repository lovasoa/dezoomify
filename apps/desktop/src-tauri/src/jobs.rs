// In-memory desktop job table backed by the shared native runner.
//
// The table is an id registry plus a projection layer: it mints `job:n`,
// keeps per-job monotonic seq and the ordered transcript, routes window
// commands to [`NativeRunner`] handles, and folds the runner's typed
// snapshots into the projected IPC payloads. All execution (engine,
// completion-driven effects, partial gate, cancellation flag, output
// publication) lives in the runner and the pipeline it drives; the table
// owns no lifecycle machine of its own and no scheduling policy.
//
// Lean offline shell: standard library threads only (no tokio; `tokio` is a
// dev-dependency of `dezoomify-native`, not a runtime dependency). A manual
// start rests at the `AwaitingDestination` cue until `request_destination`
// grants a path and starts the runner; a settings start (an output format
// plus directory) launches the runner immediately with the automatic
// directory destination.
//
// Counts, ledgers, and error codes live in the record (never string-encoded
// into `k=v` or JSON details); only counts, hashes, codes, and the redacted
// origin cross IPC.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use dezoomify_native::output::{validate_destination, OutputFormat};
use dezoomify_native::pipeline::PartialDecision;
use dezoomify_native::runner::{
    JobOptions, JobSnapshot as RunnerSnapshot, Lifecycle, NativeRunner, OutputTarget, RunningJob,
    UserCommand,
};

use crate::settings::{job_options_for, DesktopSettings};

/// Desktop event channels. Must stay identical to
/// `apps/desktop/src/events.ts` `DESKTOP_EVENT_CHANNELS` and the generated
/// capability documents.
pub const CHANNEL_JOB_SNAPSHOT: &str = "dezoomify://job-snapshot";
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

/// Shell state: the runner-snapshot projection plus the pre-start rest
/// states. Names are engine parity (`Discovering` … `Failed`) so the
/// `job-state` channel projects the live lifecycle without inferring
/// policy; `Cancelling` marks a requested cancellation awaiting the
/// runner's terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Discovering,
    AwaitingImageSelection,
    AwaitingLevelSelection,
    AwaitingDestination,
    AcquiringTiles,
    Finalizing,
    AwaitingPartialDecision,
    Cancelling,
    Completed,
    PartiallyCompleted,
    Cancelled,
    Failed,
}

impl JobState {
    pub fn name(&self) -> &'static str {
        match self {
            JobState::Discovering => "Discovering",
            JobState::AwaitingImageSelection => "AwaitingImageSelection",
            JobState::AwaitingLevelSelection => "AwaitingLevelSelection",
            JobState::AwaitingDestination => "AwaitingDestination",
            JobState::AcquiringTiles => "AcquiringTiles",
            JobState::Finalizing => "Finalizing",
            JobState::AwaitingPartialDecision => "AwaitingPartialDecision",
            JobState::Cancelling => "Cancelling",
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
}

impl From<Lifecycle> for JobState {
    fn from(lifecycle: Lifecycle) -> Self {
        match lifecycle {
            Lifecycle::Discovering => JobState::Discovering,
            Lifecycle::AcquiringTiles => JobState::AcquiringTiles,
            Lifecycle::Finalizing => JobState::Finalizing,
            Lifecycle::AwaitingPartialDecision => JobState::AwaitingPartialDecision,
        }
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
    // transcript even if validation order changes).
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
    /// Choose a catalog image by position (pre-start option only).
    Image { index: usize },
    /// Choose a level of the chosen image by position (pre-start option only).
    Level { index: usize },
    /// Answer a pending partial decision (keep, retry, or discard).
    Partial {
        decision: dezoomify_protocol::dto::RecoveryChoice,
    },
}

/// One ordered transcript event for a job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobEvent {
    pub seq: u64,
    pub kind: String,
    pub detail: String,
}

/// One tracked job: projection record plus the live runner handle.
///
/// `Debug` is redacted on purpose: the runner options may hold the handoff
/// `Cookie` header (memory-only, never logged or cached), so only header
/// names are shown, never values.
pub struct JobRecord {
    pub id: String,
    pub state: JobState,
    pub seq: u64,
    pub events: Vec<JobEvent>,
    pub window: String,
    /// Full input URL the runner fetches (never embedded in events).
    pub input_url: String,
    /// Redacted input origin (`scheme://host`) for event context.
    pub origin: String,
    /// Runner options: settings, handoff headers, and pre-start selections.
    /// Cloned into the runner at start; later edits never affect a live job.
    pub options: JobOptions,
    /// Live runner handle (None until a destination exists). The runner owns
    /// the engine, the partial gate, the cancel flag, and publication.
    pub runner: Option<RunningJob>,
    /// Cancellation has been requested; the terminal `cancelled` event is
    /// emitted only after the runner reports quiescence.
    pub cancel_requested: bool,
    /// Granted save destination: the real dialog-chosen path, stored per job
    /// and passed to the runner for atomic publish. `None` until
    /// `request_destination`.
    pub destination: Option<PathBuf>,
    /// Actual published output, retained natively for explicit open/reveal actions.
    pub saved_path: Option<PathBuf>,
    /// Granted format id (`png`/`jpeg`/`tiff`/`zif`/`webp`/`iiif-dir`).
    pub destination_format: Option<String>,
    /// Whether the user confirmed overwriting an existing destination.
    /// Always false until an explicit overwrite confirmation exists; an
    /// existing destination is denied for choose-output recovery instead.
    pub destination_overwrite: bool,
    /// Settings-selected output directory (`None` keeps the temp fallback
    /// for automatic saves).
    pub output_dir: Option<PathBuf>,
    /// Monotonic progress: highest `acquired` count observed. Never
    /// decreases across retries; cache hits still count as acquired, so
    /// resume runs continue forward without claiming unknown totals.
    pub progress_acquired: u64,
    /// Monotonic progress: highest `total` observed. Unknown totals stay 0
    /// and never claim completeness.
    pub progress_total: u64,
    /// Output geometry from the runner's published summary (`None` until publish).
    pub output_width: Option<u32>,
    /// Output geometry from the runner's published summary (`None` until publish).
    pub output_height: Option<u32>,
    /// Tiles encoded into the published output (`None` until publish).
    pub output_tile_count: Option<usize>,
    /// Detected source format id from the runner (e.g. `zoomify`, `iiif`).
    pub output_source_format: Option<String>,
    /// Last runner terminal (`None` until the runner reports one).
    pub terminal: Option<dezoomify_native::runner::Terminal>,
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

impl JobRecord {
    /// Stable (code, redacted message) behind a failed runner terminal.
    fn terminal_code(&self) -> Option<(String, String)> {
        match &self.terminal {
            Some(dezoomify_native::runner::Terminal::Failed(error)) => {
                Some((error.code.clone(), redact_message(&error.message)))
            }
            _ => None,
        }
    }
}

impl std::fmt::Debug for JobRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let header_names: Vec<&String> = self.options.headers.keys().collect();
        f.debug_struct("JobRecord")
            .field("id", &self.id)
            .field("state", &self.state)
            .field("seq", &self.seq)
            .field("events", &self.events)
            .field("window", &self.window)
            .field("input_url", &self.input_url)
            .field("origin", &self.origin)
            .field("user_header_names", &header_names)
            .field("cancel_requested", &self.cancel_requested)
            .field("destination_format", &self.destination_format)
            .field("destination_overwrite", &self.destination_overwrite)
            .field("output_dir", &self.output_dir)
            .finish_non_exhaustive()
    }
}

/// Structured output ready for the `job-output` channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobOutputSnapshot {
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
/// typed fields each channel documents. Snapshot emits share the
/// transcript seq of the fold they project; `order_rank` keeps the shared
/// timeline total when seqs tie.
#[derive(Debug, Clone)]
pub struct ProjectedEmit {
    pub channel: &'static str,
    pub job: String,
    pub seq: u64,
    pub order_rank: u64,
    pub payload: serde_json::Value,
}

/// Channel rank for shared-timeline ordering: legacy channel lines first,
/// the snapshot projection last, per transcript seq.
fn channel_rank(channel: &str) -> u64 {
    if channel == CHANNEL_JOB_SNAPSHOT {
        1
    } else {
        0
    }
}

/// In-memory table keyed by job id: the id registry, per-job transcript,
/// and the live runner handles.
///
/// `pending` holds projected IPC emits in seq order. Every transcript push
/// enqueues exactly one projected emit; the Tauri shell drains the queue
/// and emits each on its channel. Draining never replays: each emit leaves
/// the queue exactly once.
pub struct JobTable {
    jobs: HashMap<String, JobRecord>,
    next_job: u64,
    capability_seq: u64,
    pending: Vec<ProjectedEmit>,
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

impl JobTable {
    pub fn new() -> Self {
        Self {
            jobs: HashMap::new(),
            next_job: 0,
            capability_seq: 0,
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

    /// Snapshot of the granted destination, if any.
    pub fn destination_for(&self, job: &str) -> Option<PathBuf> {
        self.jobs.get(job).and_then(|r| r.destination.clone())
    }

    /// Stable (code, redacted message) behind a failed terminal, if any.
    pub fn terminal_code(&self, job: &str) -> Option<(String, String)> {
        self.jobs.get(job)?.terminal_code()
    }

    pub fn saved_output_for(&self, job: &str) -> Option<PathBuf> {
        let record = self.jobs.get(job)?;
        if !matches!(
            record.state,
            JobState::Completed | JobState::PartiallyCompleted
        ) {
            return None;
        }
        record.saved_path.clone()
    }

    /// Current shell state, if known.
    pub fn state_of(&self, job: &str) -> Option<JobState> {
        self.jobs.get(job).map(|r| r.state)
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
        let (code, message) = record.terminal_code()?;
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

    /// Drain projected IPC emits in shared-timeline order: transcript seq
    /// first, legacy lines before snapshot projections on ties. Each emit
    /// leaves the queue exactly once; callers emit each on its `channel`
    /// with `payload`.
    pub fn drain_pending(&mut self) -> Vec<ProjectedEmit> {
        let mut pending = std::mem::take(&mut self.pending);
        pending.sort_by_key(|emit| (emit.seq, emit.order_rank));
        pending
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
            // Counts come from the monotonic record snapshot, never from a
            // detail string: transcript details carry lifecycle kinds only.
            let (acquired, total) = self
                .jobs
                .get(job)
                .map(|r| (r.progress_acquired, r.progress_total))
                .unwrap_or((0, 0));
            let state = record
                .map(|r| r.state.name().to_string())
                .unwrap_or_else(|| "AcquiringTiles".to_string());
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
            // complete save. Both live in the stored record.
            if state == "PartiallyCompleted" {
                let (missing, sibling) = record
                    .map(|r| (r.output_missing.clone(), r.output_sibling.clone()))
                    .unwrap_or_default();
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
            // The typed failure lives in the runner terminal; the transcript
            // detail carries no `code: message` string to split back apart.
            let (code, message) = record.and_then(|r| r.terminal_code()).unwrap_or_else(|| {
                (
                    "native.internal".to_string(),
                    "job failed without diagnostics".to_string(),
                )
            });
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
                "recoveryHint": error_recovery(&code),
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
        // text. The ledger lives in the stored pending request.
        if event.kind.eq_ignore_ascii_case("recovery-requested") {
            let (missing, failed, total, recovery) = record
                .and_then(|r| r.pending_partial.clone())
                .map(|p| (p.missing, p.failed, p.total, p.recovery))
                .unwrap_or_default();
            payload["reason"] = serde_json::json!("partial");
            payload["missing"] = serde_json::json!(missing);
            payload["missingTiles"] = serde_json::json!(missing);
            payload["failed"] = serde_json::json!(failed);
            payload["total"] = serde_json::json!(total);
            if let Some(id) = recovery {
                payload["recoveryId"] = serde_json::json!(id);
            }
        }
        debug_assert!(!payload_has_forbidden_keys(&payload));
        (channel, payload)
    }

    /// Append one ordered transcript line for the debug log and enqueue its
    /// projected IPC emit. Seq is per-job monotonic via `saturating_add`;
    /// post-terminal pushes are refused by the callers (see `require_live`
    /// and the terminal-once guard in `apply_runner_snapshot`), so terminals
    /// appear exactly once.
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
        let (_, payload) = self.project_event(job, &event);
        debug_assert!(!payload_has_forbidden_keys(&payload));
        let channel = channel_for_kind(&event.kind);
        self.pending.push(ProjectedEmit {
            channel,
            job: job.to_string(),
            seq,
            order_rank: channel_rank(channel),
            payload,
        });
        let _ = channel;
        seq
    }

    fn require_live(&self, job: &str) -> Result<JobState, String> {
        match self.jobs.get(job) {
            None => Err("unknown".to_string()),
            Some(record) if record.state.is_terminal() || record.cancel_requested => {
                Err("stale".to_string())
            }
            Some(record) => Ok(record.state),
        }
    }

    /// Create one job record with the given runner options. Validates the
    /// input URL shape, mints `job:n`, records `Discovering` seq 1, and
    /// enqueues the initial `job-state` emit. No runner starts here: a
    /// destination (dialog grant or automatic directory) starts it.
    fn start_job_with_options(
        &mut self,
        input_url: &str,
        mut options: JobOptions,
    ) -> Result<String, String> {
        if input_url.is_empty() || input_url.len() > 2048 {
            return Err("input_url must be 1..2048 bytes".to_string());
        }
        if !(input_url.starts_with("http://") || input_url.starts_with("https://")) {
            return Err("input_url must be http(s)".to_string());
        }
        // Reject userinfo credentials embedded in the authority section
        // (parity with the commands-layer `is_valid_input_url` gate; secrets
        // never enter the table, transcript, or runner).
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
        // (scheme://host) is stored for events, never the full URL.
        options.input_url = input_url.to_string();
        let origin = redact_origin(input_url);

        self.jobs.insert(
            id.clone(),
            JobRecord {
                id: id.clone(),
                state: JobState::Discovering,
                seq: 0,
                events: Vec::new(),
                window: "main".to_string(),
                input_url: input_url.to_string(),
                origin,
                options,
                runner: None,
                cancel_requested: false,
                destination: None,
                saved_path: None,
                destination_format: None,
                destination_overwrite: false,
                output_dir: None,
                progress_acquired: 0,
                progress_total: 0,
                output_width: None,
                output_height: None,
                output_tile_count: None,
                output_source_format: None,
                terminal: None,
                pending_partial: None,
                output_missing: Vec::new(),
                output_sibling: None,
            },
        );
        // Enqueue the initial `Discovering` emit so the shell emits
        // `job-state` seq 1 without a second transcript push.
        self.push_event(&id, "job-state", "Discovering");
        Ok(id)
    }

    /// Start one job and return its id immediately (never blocks on I/O).
    /// The job rests at the `AwaitingDestination` cue until
    /// `request_destination` grants a path.
    pub fn start_job(&mut self, input_url: &str) -> Result<String, String> {
        let id = self.start_job_with_options(input_url, JobOptions::default())?;
        self.cue_awaiting_destination(&id);
        Ok(id)
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
    ) -> Result<String, String> {
        let options = JobOptions {
            headers: user_headers,
            ..JobOptions::default()
        };
        let id = self.start_job_with_options(input_url, options)?;
        self.cue_awaiting_destination(&id);
        Ok(id)
    }

    /// Start one job with validated desktop settings (compression,
    /// retries, caps, cache dir, trusted headers, output folder, and format).
    /// Bounds are enforced by `settings::parse_settings` before this call;
    /// the fixed transport mirrors the CLI (`job_options_for`).
    pub fn start_job_with_settings(
        &mut self,
        input_url: &str,
        settings: &DesktopSettings,
    ) -> Result<String, String> {
        let options = job_options_for(settings);
        let output_dir = settings.output_dir.clone();
        let id = self.start_job_with_options(input_url, options)?;
        if let Some(record) = self.jobs.get_mut(&id) {
            record.output_dir = output_dir;
            record.destination_format = Some(settings.output_format.clone());
        }
        // Automatic settings starts save without a dialog: the `destination`
        // event tells the frontend that saving starts (no choose-output
        // step), and the runner derives the file name from the selected
        // catalog title inside the native driver.
        let automatic = self
            .jobs
            .get(&id)
            .is_some_and(|r| r.destination.is_none() && r.destination_format.is_some());
        if automatic {
            let format = settings.output_format.clone();
            if let Some(record) = self.jobs.get_mut(&id) {
                record.options.output = OutputTarget::AutoDir {
                    dir: record.output_dir.clone().unwrap_or_else(std::env::temp_dir),
                    format: output_format_for_id(&format).unwrap_or(OutputFormat::Png),
                };
            }
            self.push_event(&id, "destination", &format);
            self.start_runner(&id);
        }
        Ok(id)
    }

    /// Move a fresh manual job to `AwaitingDestination`
    /// with one `job-state` event: the frontend's cue to offer the save
    /// destination.
    fn cue_awaiting_destination(&mut self, id: &str) {
        if let Some(record) = self.jobs.get_mut(id) {
            record.state = JobState::AwaitingDestination;
        }
        self.push_event(id, "job-state", "AwaitingDestination");
    }

    /// Start the runner for a job whose options already carry a destination.
    /// Idempotent: a live runner is never replaced.
    fn start_runner(&mut self, job: &str) {
        if self.jobs.get(job).is_some_and(|r| r.runner.is_some()) {
            return;
        }
        let Some(record) = self.jobs.get(job) else {
            return;
        };
        let options = record.options.clone();
        match NativeRunner::start(options) {
            Ok(runner) => {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.runner = Some(runner);
                }
            }
            Err(error) => {
                // Typed failure before any effect: the job fails closed.
                if let Some(record) = self.jobs.get_mut(job) {
                    record.terminal = Some(dezoomify_native::runner::Terminal::Failed(error));
                    record.state = JobState::Failed;
                }
                self.push_event(job, "failed", "");
            }
        }
    }

    /// Cancel a live job. Forwards one `Cancel` to the runner (the shared
    /// flag the driver polls at every effect boundary; work in flight
    /// finishes, nothing new starts, and the commit point refuses to
    /// publish, so no output appears on the cancel path). Pre-runner jobs
    /// finish immediately: no pipeline can have published output before a
    /// destination existed. Terminal jobs report stale; missing jobs
    /// report unknown.
    pub fn cancel_job(&mut self, job: &str) -> Result<u64, String> {
        self.poll_drivers();
        self.require_live(job)?;
        let has_runner = self.jobs.get(job).is_some_and(|r| r.runner.is_some());
        if let Some(record) = self.jobs.get_mut(job) {
            record.cancel_requested = true;
            if let Some(runner) = record.runner.as_ref() {
                // A rejected send means the driver already exited; its
                // terminal is on the stream and settles the job below.
                let _ = runner.send(UserCommand::Cancel);
            }
            record.state = JobState::Cancelling;
        }
        let cancelling = self.push_event(job, "job-state", "Cancelling");
        if !has_runner {
            // No runner ever started: nothing to clean up, finish now.
            if let Some(record) = self.jobs.get_mut(job) {
                record.state = JobState::Cancelled;
            }
            let cancelled = self.push_event(job, "cancelled", "Cancelled");
            return Ok(cancelled.max(cancelling));
        }
        // The runner owns quiescence: the cancelled terminal arrives on the
        // snapshot stream and is folded by `poll_drivers`.
        Ok(cancelling)
    }

    /// Answer an image/level choice for a live job, or resolve a pending
    /// partial decision.
    ///
    /// Image/level selections fold into the runner options so the runner
    /// plans the chosen image/level when it starts; selection states
    /// project the `Awaiting*` family so the `job-state` channel carries
    /// them. Partial keep/discard/retry forward to the live runner's gate
    /// (early answers survive: the gate stores them before the wait
    /// starts), and the terminal outcome arrives as the next snapshot.
    pub fn answer_choice(&mut self, job: &str, choice: &Choice) -> Result<(u64, String), String> {
        self.poll_drivers();
        self.require_live(job)?;
        let has_runner = self.jobs.get(job).is_some_and(|r| r.runner.is_some());
        let next_state = match *choice {
            Choice::Partial { decision } => {
                use dezoomify_native::runner::UserCommand as RunnerCommand;
                use dezoomify_protocol::dto::RecoveryChoice as WireDecision;
                if let Some(record) = self.jobs.get(job) {
                    if let Some(runner) = record.runner.as_ref() {
                        let _ = runner.send(RunnerCommand::AnswerPartial(match decision {
                            WireDecision::Keep => PartialDecision::Keep,
                            WireDecision::Retry => PartialDecision::Retry,
                            WireDecision::Discard => PartialDecision::Discard,
                        }));
                    }
                }
                // Keep/discard update the fallback policy so a timeout
                // stays honest to the last explicit choice. Retry never
                // changes the fallback policy.
                if let Some(record) = self.jobs.get_mut(job) {
                    if decision != WireDecision::Retry {
                        record.options.keep_partial = decision == WireDecision::Keep;
                    }
                    if record.state == JobState::AwaitingPartialDecision {
                        record.pending_partial = None;
                        record.state = JobState::AcquiringTiles;
                    }
                }
                JobState::AcquiringTiles
            }
            Choice::Image { index } => {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.options.image_index = Some(index);
                    // A live runner already selected; the stored choice only
                    // matters for a runner that has not started yet.
                    if !has_runner {
                        record.state = JobState::AwaitingLevelSelection;
                    }
                }
                JobState::AwaitingLevelSelection
            }
            Choice::Level { index } => {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.options.zoom_level = Some(index);
                    if !has_runner {
                        record.state = JobState::AwaitingDestination;
                    }
                }
                JobState::AwaitingDestination
            }
        };
        let seq = self.push_event(job, "job-state", next_state.name());
        Ok((seq, "job-state:running".to_string()))
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
    ) -> Result<u64, String> {
        self.poll_drivers();
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
        if let Some(record) = self.jobs.get_mut(job) {
            record.destination = Some(path.to_path_buf());
            record.destination_format = Some(format.to_string());
            record.destination_overwrite = overwrite;
            if !has_runner {
                record.options.output = OutputTarget::File(path.to_path_buf());
                record.options.overwrite = overwrite;
                // The grant moves an `AwaitingDestination` job into active
                // work.
                if matches!(
                    record.state,
                    JobState::Discovering
                        | JobState::AwaitingDestination
                        | JobState::AwaitingImageSelection
                        | JobState::AwaitingLevelSelection
                ) {
                    record.state = JobState::Discovering;
                }
            }
        }
        let seq = self.push_event(job, "destination", format);
        if !has_runner {
            self.start_runner(job);
        }
        Ok(seq)
    }

    /// Drain live runner snapshots: fold each into the transcript and
    /// project it as one `job-snapshot` emit. Non-blocking; terminal-once
    /// is enforced (snapshots after a terminal are ignored) and the runner
    /// handle is dropped once its terminal is folded.
    pub fn poll_drivers(&mut self) {
        let live: Vec<String> = self
            .jobs
            .iter()
            .filter(|(_, record)| record.runner.is_some() && !record.state.is_terminal())
            .map(|(id, _)| id.clone())
            .collect();
        for id in live {
            let runner = match self.jobs.get_mut(&id).and_then(|r| r.runner.take()) {
                Some(runner) => runner,
                None => continue,
            };
            let mut terminal_seen = false;
            while let Ok(snapshot) = runner.snapshots().try_recv() {
                let is_terminal = snapshot.terminal.is_some();
                self.apply_runner_snapshot(&id, &snapshot);
                self.emit_snapshot(&id, &snapshot);
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
            // With a terminal folded, the handle is dropped: the driver
            // thread has finished its sends and exits on its own.
        }
    }

    /// Project one runner snapshot as a self-describing `job-snapshot`
    /// emit. Counts, ledgers, and error codes travel as typed fields;
    /// secrets, paths, and full URLs never cross (only the redacted
    /// origin). The transcript keeps one legacy line per snapshot for the
    /// debug log only.
    fn emit_snapshot(&mut self, job: &str, snapshot: &RunnerSnapshot) {
        let origin = self
            .jobs
            .get(job)
            .map(|r| r.origin.clone())
            .unwrap_or_default();
        let record = match self.jobs.get(job) {
            Some(record) => record,
            None => return,
        };
        let state_name = record.state.name();
        let (acquired, total) = (record.progress_acquired, record.progress_total);
        let mut payload = serde_json::json!({
            "job": job,
            "jobId": job,
            "seq": record.seq,
            "kind": "snapshot",
            "state": state_name,
            "lifecycle": format!("{:?}", snapshot.lifecycle),
            "acquired": acquired,
            "total": total,
            "origin": origin,
        });
        if let Some(ledger) = &snapshot.recovery {
            payload["recovery"] = serde_json::json!({
                "missing": redact_ledger(&ledger.missing),
                "failed": ledger.failed,
                "total": ledger.total,
            });
        }
        if let Some(terminal) = &snapshot.terminal {
            let (kind, extra) = Self::terminal_payload(terminal);
            payload["terminal"] = serde_json::json!(kind);
            for (key, value) in extra {
                payload[key] = value;
            }
        }
        debug_assert!(!payload_has_forbidden_keys(&payload));
        self.pending.push(ProjectedEmit {
            channel: CHANNEL_JOB_SNAPSHOT,
            job: job.to_string(),
            seq: record.seq,
            order_rank: channel_rank(CHANNEL_JOB_SNAPSHOT),
            payload,
        });
    }

    /// Terminal kind plus the typed output/error fields for a snapshot emit.
    fn terminal_payload(
        terminal: &dezoomify_native::runner::Terminal,
    ) -> (&'static str, Vec<(&'static str, serde_json::Value)>) {
        use dezoomify_native::runner::Terminal as RunnerTerminal;
        match terminal {
            RunnerTerminal::Completed(summary) => {
                let kind = if summary.partial {
                    "partial-completed"
                } else {
                    "completed"
                };
                let sibling = std::path::Path::new(&summary.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                let mut extra = vec![
                    ("format", serde_json::json!(summary.format)),
                    ("width", serde_json::json!(summary.width)),
                    ("height", serde_json::json!(summary.height)),
                    ("tileCount", serde_json::json!(summary.tile_count)),
                    (
                        "missingTiles",
                        serde_json::json!(redact_ledger(&summary.missing)),
                    ),
                ];
                if summary.partial && !sibling.is_empty() {
                    extra.push(("sibling", serde_json::json!(sibling)));
                }
                (kind, extra)
            }
            RunnerTerminal::Cancelled => ("cancelled", Vec::new()),
            RunnerTerminal::Failed(error) => (
                "failed",
                vec![
                    ("code", serde_json::json!(error.code)),
                    ("phase", serde_json::json!(error_phase(&error.code))),
                    ("retryable", serde_json::json!(error_retryable(&error.code))),
                    (
                        "recoveryHint",
                        serde_json::json!(error_recovery(&error.code)),
                    ),
                    ("message", serde_json::json!(redact_message(&error.message))),
                    ("transport", serde_json::json!(error_transport(&error.code))),
                ],
            ),
        }
    }

    /// Fold one runner snapshot into the transcript. Terminal-once: a
    /// snapshot after a terminal is ignored. Lifecycle changes project one
    /// `job-state` event; progress advances project one `downloading`
    /// event carrying the monotonic record counts; recovery ledgers
    /// project one `recovery-requested` event; terminals project exactly
    /// one output/error/cancelled event.
    pub fn apply_runner_snapshot(&mut self, job: &str, snapshot: &RunnerSnapshot) {
        let Some(record) = self.jobs.get(job) else {
            return;
        };
        if record.state.is_terminal() {
            return;
        }
        if self.fold_runner_snapshot(job, snapshot) {
            self.emit_snapshot(job, snapshot);
        }
    }

    /// Fold one runner snapshot into the record and the legacy transcript
    /// line. Returns true when the fold moved the record.
    fn fold_runner_snapshot(&mut self, job: &str, snapshot: &RunnerSnapshot) -> bool {
        use dezoomify_native::runner::Terminal as RunnerTerminal;
        let Some(record) = self.jobs.get(job) else {
            return false;
        };
        if record.state.is_terminal() {
            return false;
        }
        // Recovery ledger: the dialog cue with the redacted ledger.
        if let Some(ledger) = &snapshot.recovery {
            let missing = redact_ledger(&ledger.missing);
            let failed = ledger.failed;
            let total = ledger.total;
            let already = record
                .pending_partial
                .as_ref()
                .is_some_and(|p| p.missing == missing && p.failed == failed && p.total == total);
            if let Some(record) = self.jobs.get_mut(job) {
                record.pending_partial = Some(PartialPending {
                    missing: missing.clone(),
                    failed,
                    total,
                    recovery: None,
                });
                record.state = JobState::AwaitingPartialDecision;
                if total > 0 {
                    record.progress_total = record.progress_total.max(total);
                }
            }
            if !already {
                self.push_event(job, "recovery-requested", "");
            }
            return true;
        }
        if snapshot.terminal.is_none() {
            // Live progression: fold the lifecycle and the monotonic counts.
            let next = JobState::from(snapshot.lifecycle.clone());
            let acquired_advanced = snapshot.acquired > record.progress_acquired;
            let total_advanced = snapshot.total > record.progress_total;
            let lifecycle_changed = record.state != next;
            if let Some(record) = self.jobs.get_mut(job) {
                record.progress_acquired = record.progress_acquired.max(snapshot.acquired);
                record.progress_total = record.progress_total.max(snapshot.total);
                if !matches!(record.state, JobState::Cancelling) {
                    record.state = next;
                }
            }
            if acquired_advanced || total_advanced {
                self.push_event(job, "downloading", "");
            } else if lifecycle_changed {
                let kind = match next {
                    JobState::Finalizing => "encoding",
                    JobState::Discovering => "discovery",
                    _ => "job-state",
                };
                self.push_event(job, kind, next.name());
            }
            return acquired_advanced || total_advanced || lifecycle_changed;
        }
        // Terminal: exactly once, from the runner's honest outcome.
        let Some(terminal) = snapshot.terminal.clone() else {
            return false;
        };
        match terminal {
            RunnerTerminal::Completed(summary) => {
                self.fold_published(job, &summary);
            }
            RunnerTerminal::Cancelled => {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.state = JobState::Cancelled;
                    record.cancel_requested = false;
                    record.pending_partial = None;
                }
                self.push_event(job, "cancelled", "Cancelled");
            }
            terminal @ RunnerTerminal::Failed(_) => {
                if let Some(record) = self.jobs.get_mut(job) {
                    record.terminal = Some(terminal);
                    record.state = JobState::Failed;
                    record.cancel_requested = false;
                    record.pending_partial = None;
                }
                self.push_event(job, "failed", "");
            }
        }
        true
    }

    /// Fold one published output summary into the record and the honest
    /// terminal event (`partial-completed` for kept partials, `completed`
    /// otherwise). The sibling basename is the only path fragment that
    /// ever reaches IPC.
    fn fold_published(&mut self, job: &str, summary: &dezoomify_native::runner::OutputSummary) {
        let partial = summary.partial;
        // Sibling basename only: the granted path never crosses IPC or the
        // transcript.
        let sibling = std::path::Path::new(&summary.path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string);
        if let Some(record) = self.jobs.get_mut(job) {
            record.saved_path = Some(summary.path.clone());
            record.destination_format = Some(
                record
                    .destination_format
                    .clone()
                    .unwrap_or_else(|| summary.format.clone()),
            );
            record.output_width = Some(summary.width);
            record.output_height = Some(summary.height);
            record.output_tile_count = Some(summary.tile_count);
            record.output_source_format = Some(summary.format.clone());
            record.output_missing = summary.missing.clone();
            record.output_sibling = sibling;
            record.pending_partial = None;
            record.cancel_requested = false;
            record.state = if partial {
                JobState::PartiallyCompleted
            } else {
                JobState::Completed
            };
        }
        if partial {
            self.push_event(job, "partial-completed", "");
        } else {
            self.push_event(job, "completed", "");
        }
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
}

/// Redacted partial ledger: tile ids and counts only. Overlong entries and
/// entries containing `://` or `/` (URLs, paths, secrets) never survive; the
/// ledger is sorted, deduplicated, and capped at 60 entries.
fn redact_ledger(missing: &[String]) -> Vec<String> {
    let mut ledger: Vec<String> = missing
        .iter()
        .filter(|id| !id.is_empty() && id.len() <= 128 && !id.contains("://") && !id.contains('/'))
        .cloned()
        .collect();
    ledger.sort();
    ledger.dedup();
    ledger.truncate(60);
    ledger
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
    use dezoomify_native::runner::{OutputSummary, RecoveryLedger, Terminal};

    /// A fresh manual job cues `AwaitingDestination` synchronously with one
    /// `job-state` event: the frontend's cue to offer the save destination.
    /// No runner runs until the destination grant.
    #[test]
    fn discovery_completion_requests_destination() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::AwaitingDestination));
        assert!(!table.has_runner(&id), "no runner before the grant");
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

        // The automatic destination grant is synchronous: this test only
        // asserts desktop orchestration, never public-network behavior.
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
        assert!(table.has_runner(&id), "the runner starts automatically");
        let _ = table.cancel_job(&id);
    }

    #[test]
    fn lifecycle_orders_events() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table
            .answer_choice(&id, &Choice::Image { index: 0 })
            .unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AcquiringTiles,
                1,
                2,
                None,
                Some(Terminal::Completed(published("png", 8, 6, 2))),
            ),
        );
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
        let id = table
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
        let id2 = table
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
        let id = table.start_job("https://example.com/item").unwrap();
        // The destination cue is synchronous, so the event count below is
        // exact with no runner to race.
        assert_eq!(table.state_of(&id), Some(JobState::AwaitingDestination));
        // Unknown extensions fail before any work: no destination, no new
        // event, no runner.
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
        assert!(!table.has_runner(&id), "no runner on refused grant");
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
        // A matching grant stores the real path and starts the runner; the
        // format is the only destination detail that enters the event.
        let seq = table.request_destination(&id, &png, "png", false).unwrap();
        assert!(seq >= 1);
        assert_eq!(table.destination_for(&id).unwrap(), png);
        assert!(table.has_runner(&id), "the grant starts the runner");
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
        let id = table
            .start_job_with_user_headers("https://protected.example/item", headers)
            .unwrap();
        let options = table.options_for(&id).unwrap();
        assert_eq!(
            options.headers.get("cookie").map(String::as_str),
            Some("session=CANARY-handoff"),
            "handoff cookie must reach the runner options"
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
        assert_eq!(table.last_seq(&id), Some(2));
        table
            .answer_choice(&id, &Choice::Image { index: 0 })
            .unwrap();
        let s2 = table.last_seq(&id).unwrap();
        assert!(s2 > 1, "seq must increase");
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 3, 10, None, None),
        );
        let s3 = table.last_seq(&id).unwrap();
        assert!(s3 > s2, "progress must bump seq");
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AcquiringTiles,
                3,
                10,
                None,
                Some(Terminal::Completed(published("png", 4, 4, 1))),
            ),
        );
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
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(
            table
                .answer_choice(&id, &Choice::Image { index: 1 })
                .unwrap_err(),
            "stale"
        );
        // Late runner snapshots after the terminal add nothing.
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 9, 10, None, None),
        );
        table.poll_drivers();
        assert_eq!(table.events_for(&id).len(), before);
        assert_eq!(table.last_seq(&id), Some(terminal_seq));
        // Drained emits are ordered and never replay.
        let pending = table.drain_pending();
        assert!(!pending.is_empty(), "projection must enqueue emits");
        let mut last = (0u64, 0u64);
        for emit in &pending {
            assert!((emit.seq, emit.order_rank) > last, "pending emits ordered");
            last = (emit.seq, emit.order_rank);
        }
        assert!(table.drain_pending().is_empty(), "drain never replays");
    }

    #[test]
    fn progress_monotonic_survives_retries_and_cache() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 5, 10, None, None),
        );
        assert_eq!(table.progress_for(&id), Some((5, 10)));
        // A retry re-report with lower counts never moves backwards.
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 2, 10, None, None),
        );
        assert_eq!(table.progress_for(&id), Some((5, 10)));
        // A resume-cache hit still counts forward.
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 7, 10, None, None),
        );
        assert_eq!(table.progress_for(&id), Some((7, 10)));
        // Unknown totals stay 0 and never claim completeness.
        let mut fresh = JobTable::new();
        let id2 = fresh.start_job("https://example.com/other").unwrap();
        fresh.apply_runner_snapshot(
            &id2,
            &runner_snapshot(Lifecycle::AcquiringTiles, 1, 0, None, None),
        );
        assert_eq!(fresh.progress_for(&id2), Some((1, 0)));
        // Projected progress payloads carry the monotonic record snapshot
        // (counts live in the record, never string-encoded into the event),
        // plus numbers and the redacted origin only.
        let events = table.events_for(&id);
        let progress = events.iter().find(|e| e.kind == "downloading").unwrap();
        let (channel, payload) = table.project_event(&id, progress);
        assert_eq!(channel, CHANNEL_JOB_PROGRESS);
        let (acquired, total) = table.progress_for(&id).unwrap();
        assert_eq!(payload["acquired"], serde_json::json!(acquired));
        assert_eq!(payload["total"], serde_json::json!(total));
        assert_eq!(payload["jobId"], serde_json::json!(id));
        assert_eq!(payload["job"], serde_json::json!(id));
        assert!(payload.get("seq").is_some());
        assert!(!payload_has_forbidden_keys(&payload));
        assert!(!payload.to_string().contains("example.com/item"));
    }

    #[test]
    fn output_carries_geometry() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::Finalizing,
                12,
                12,
                None,
                Some(Terminal::Completed(published("png", 800, 600, 12))),
            ),
        );
        let snapshot = table.output_snapshot_for(&id).unwrap();
        assert_eq!(snapshot.format, "png");
        assert_eq!((snapshot.width, snapshot.height), (800, 600));
        assert_eq!(snapshot.tile_count, 12);
        let events = table.events_for(&id);
        let completed = events.iter().find(|e| e.kind == "completed").unwrap();
        let (channel, payload) = table.project_event(&id, completed);
        assert_eq!(channel, CHANNEL_JOB_OUTPUT);
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
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AcquiringTiles,
                1,
                4,
                None,
                Some(Terminal::Failed(dezoomify_native::error::NativeError::new(
                    "tile.download-failed",
                    "3 tiles failed; token=CANARY-secret",
                ))),
            ),
        );
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
        assert_eq!(payload["recoveryHint"], serde_json::json!("retry"));
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
        // Codes reach the payload with phase/transport/resource-kind plus the
        // redacted origin; full URLs, paths, and secrets never do.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AcquiringTiles,
                1,
                4,
                None,
                Some(Terminal::Failed(dezoomify_native::error::NativeError::new(
                    "output.canvas-limit",
                    "composed image 40000x40000 needs 5.9 GiB",
                ))),
            ),
        );
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
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 1, 4, None, None),
        );
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
    fn snapshot_emit_is_self_describing_and_typed() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 3, 10, None, None),
        );
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AwaitingPartialDecision,
                9,
                12,
                Some(RecoveryLedger {
                    missing: vec!["t-1".to_string()],
                    failed: 3,
                    total: 12,
                }),
                None,
            ),
        );
        let snapshot_emits: Vec<_> = table
            .drain_pending()
            .into_iter()
            .filter(|emit| emit.channel == CHANNEL_JOB_SNAPSHOT)
            .collect();
        assert_eq!(snapshot_emits.len(), 2, "one emit per runner snapshot");
        let progress = &snapshot_emits[0].payload;
        assert_eq!(progress["kind"], serde_json::json!("snapshot"));
        assert_eq!(progress["lifecycle"], serde_json::json!("AcquiringTiles"));
        assert_eq!(progress["acquired"], serde_json::json!(3u64));
        assert_eq!(progress["total"], serde_json::json!(10u64));
        assert!(progress.get("terminal").is_none());
        let recovery = &snapshot_emits[1].payload;
        assert_eq!(recovery["recovery"]["missing"], serde_json::json!(["t-1"]));
        assert_eq!(recovery["recovery"]["failed"], serde_json::json!(3u64));
        assert_eq!(recovery["recovery"]["total"], serde_json::json!(12u64));
        assert!(!payload_has_forbidden_keys(&snapshot_emits[0].payload));
        assert!(!payload_has_forbidden_keys(&snapshot_emits[1].payload));
    }

    #[test]
    fn job_state_names_cover_runner_phases() {
        for (state, name) in [
            (JobState::Discovering, "Discovering"),
            (JobState::AwaitingImageSelection, "AwaitingImageSelection"),
            (JobState::AwaitingLevelSelection, "AwaitingLevelSelection"),
            (JobState::AwaitingDestination, "AwaitingDestination"),
            (JobState::AcquiringTiles, "AcquiringTiles"),
            (JobState::Finalizing, "Finalizing"),
            (JobState::AwaitingPartialDecision, "AwaitingPartialDecision"),
            (JobState::Cancelling, "Cancelling"),
            (JobState::Completed, "Completed"),
            (JobState::Cancelled, "Cancelled"),
            (JobState::Failed, "Failed"),
        ] {
            assert_eq!(state.name(), name);
        }
        assert!(JobState::AwaitingDestination != JobState::AcquiringTiles);
        assert!(JobState::Completed.is_terminal());
        assert!(!JobState::AcquiringTiles.is_terminal());
        // Runner lifecycles project onto the shell states.
        assert_eq!(
            JobState::from(Lifecycle::AcquiringTiles),
            JobState::AcquiringTiles
        );
        assert_eq!(JobState::from(Lifecycle::Finalizing), JobState::Finalizing);
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
                    table.apply_runner_snapshot(
                        &id,
                        &runner_snapshot(
                            Lifecycle::Finalizing,
                            2,
                            2,
                            None,
                            Some(Terminal::Completed(published("png", 8, 6, 2))),
                        ),
                    );
                }
                "partial" => {
                    table.apply_runner_snapshot(
                        &id,
                        &runner_snapshot(
                            Lifecycle::Finalizing,
                            1,
                            2,
                            None,
                            Some(Terminal::Completed(published_partial(
                                "png",
                                8,
                                6,
                                1,
                                &["tile:1".to_string()],
                                "out.partial.png",
                            ))),
                        ),
                    );
                }
                _ => {
                    table.apply_runner_snapshot(
                        &id,
                        &runner_snapshot(
                            Lifecycle::AcquiringTiles,
                            0,
                            2,
                            None,
                            Some(Terminal::Failed(dezoomify_native::error::NativeError::new(
                                "tile.download-failed",
                                "tiles missing",
                            ))),
                        ),
                    );
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
                table
                    .answer_choice(&id, &Choice::Image { index: 1 })
                    .unwrap_err(),
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
        assert_eq!(table.state_of(&id), Some(JobState::Cancelled));
        assert_eq!(table.events_for(&id).len(), events_before);
        assert_eq!(table.last_seq(&id), Some(seq_before));
        assert!(table.drain_pending().is_empty(), "no work after terminal");
        assert!(table.destination_for(&id).is_none());
        // Late runner snapshots after a sync terminal add nothing.
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 9, 9, None, None),
        );
        table.poll_drivers();
        assert_eq!(table.events_for(&id).len(), events_before);
    }

    /// Task 6.1: duplicates are safe no-ops with no state change.
    ///
    /// Desktop projection: re-reported progress never moves the monotonic
    /// snapshot backwards. Engine parity: completing an unknown effect is
    /// rejected with no transition or new work.
    #[test]
    fn duplicate_inputs_are_ignored_without_state_change() {
        // Desktop: lower re-reports never move progress backwards.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 5, 10, None, None),
        );
        let snapshot_before = table.progress_for(&id).unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 5, 10, None, None),
        );
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 2, 9, None, None),
        );
        // Only the monotonic max survives; the snapshot never regresses.
        assert_eq!(table.progress_for(&id), Some(snapshot_before));
        assert_eq!(table.progress_for(&id), Some((5, 10)));
        // Engine parity: unknown effect completions are rejected with no
        // state change.
        let (mut engine, _) =
            dezoomify_engine::EngineJob::start(engine_options(&["https://example.com/item"]))
                .unwrap();
        let revision_before = engine.snapshot().revision;
        let err = engine
            .complete(
                dezoomify_engine::EffectId(u32::MAX),
                dezoomify_engine::EffectResult::TileAcquired,
            )
            .unwrap_err();
        assert_eq!(err.code, "job.stale-effect");
        assert_eq!(
            engine.snapshot().revision,
            revision_before,
            "rejected completions change nothing"
        );
    }

    /// Task 6.1: seq is strictly monotonic increasing across the lifecycle.
    #[test]
    fn seq_strictly_monotonic_across_lifecycle() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        assert_eq!(table.last_seq(&id), Some(2));
        let mut last = 1u64;
        table
            .answer_choice(&id, &Choice::Image { index: 0 })
            .unwrap();
        let s2 = table.last_seq(&id).unwrap();
        assert!(s2 > last, "choice must bump seq");
        last = s2;
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(Lifecycle::AcquiringTiles, 1, 4, None, None),
        );
        let s3 = table.last_seq(&id).unwrap();
        assert!(s3 > last, "progress must bump seq");
        last = s3;
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::Finalizing,
                4,
                4,
                None,
                Some(Terminal::Completed(published("png", 4, 4, 1))),
            ),
        );
        let terminal_seq = table.last_seq(&id).unwrap();
        assert!(terminal_seq > last);
        let seqs: Vec<u64> = table.events_for(&id).iter().map(|e| e.seq).collect();
        for window in seqs.windows(2) {
            assert!(window[1] > window[0], "transcript seq strictly monotonic");
        }
        let pending = table.drain_pending();
        let mut emit_last = (0u64, 0u64);
        for emit in &pending {
            assert!(
                (emit.seq, emit.order_rank) > emit_last,
                "pending emits ordered"
            );
            emit_last = (emit.seq, emit.order_rank);
        }
        assert_eq!(emit_last.0, terminal_seq);
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
            table.apply_runner_snapshot(
                &id,
                &runner_snapshot(
                    Lifecycle::Finalizing,
                    2,
                    2,
                    None,
                    Some(Terminal::Completed(published("png", 4, 4, 2))),
                ),
            );
            let events = table.events_for(&id);
            let terminals = terminal_kinds(&events);
            assert_eq!(terminals.len(), 1);
            assert_eq!(terminals[0].kind, "completed");
            assert_eq!(table.state_of(&id), Some(JobState::Completed));
            // A second terminal snapshot is ignored.
            table.apply_runner_snapshot(
                &id,
                &runner_snapshot(
                    Lifecycle::Finalizing,
                    2,
                    2,
                    None,
                    Some(Terminal::Failed(dezoomify_native::error::NativeError::new(
                        "tile.download-failed",
                        "late",
                    ))),
                ),
            );
            let events = table.events_for(&id);
            assert_eq!(terminal_kinds(&events).len(), 1);
        }
        // PartiallyCompleted.
        {
            let mut table = JobTable::new();
            let id = table.start_job("https://example.com/item").unwrap();
            table.apply_runner_snapshot(
                &id,
                &runner_snapshot(
                    Lifecycle::Finalizing,
                    1,
                    2,
                    None,
                    Some(Terminal::Completed(published_partial(
                        "png",
                        2,
                        2,
                        1,
                        &["tile:1".to_string()],
                        "out.partial.png",
                    ))),
                ),
            );
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
            table.apply_runner_snapshot(
                &id,
                &runner_snapshot(
                    Lifecycle::AcquiringTiles,
                    0,
                    2,
                    None,
                    Some(Terminal::Failed(dezoomify_native::error::NativeError::new(
                        "tile.download-failed",
                        "boom",
                    ))),
                ),
            );
            let events = table.events_for(&id);
            let terminals = terminal_kinds(&events);
            assert_eq!(terminals.len(), 1);
            assert_eq!(terminals[0].kind, "failed");
            assert_eq!(table.state_of(&id), Some(JobState::Failed));
            let events = table.events_for(&id);
            assert_eq!(terminal_kinds(&events).len(), 1);
        }
    }

    /// Wrong-state commands are rejected through the canonical API.
    #[test]
    fn wrong_state_and_unknown_reply_are_safe() {
        let (mut engine, _) =
            dezoomify_engine::EngineJob::start(engine_options(&["https://example.com/item"]))
                .unwrap();
        let revision_before = engine.snapshot().revision;
        // Supplying bytes for an unknown effect is rejected, never applied.
        let err = engine
            .provide_metadata(
                dezoomify_engine::EffectId(u32::MAX),
                dezoomify_engine::ResponseMetadata::new(),
                &[1],
            )
            .unwrap_err();
        assert_eq!(err.code, "job.stale-effect");
        assert_eq!(engine.snapshot().revision, revision_before);
        // Selecting before a catalog exists is a wrong-state rejection.
        let err = engine
            .command(dezoomify_engine::UserCommand::SelectImage { image: 99 })
            .unwrap_err();
        assert_eq!(err.code, "job.invalid-state");
        // Shell table: unmapped ids are unknown with no work.
        let mut table = JobTable::new();
        assert_eq!(table.cancel_job("bad-id").unwrap_err(), "unknown");
        assert_eq!(table.cancel_job("job:").unwrap_err(), "unknown");
        assert!(table.events_for("bad-id").is_empty());
        assert_eq!(table.last_seq("bad-id"), None);
    }

    /// Engine post-terminal inputs return stable `job.post-terminal`
    /// with no new work; the shell projects the same moment as `stale`.
    #[test]
    fn engine_post_terminal_returns_job_post_terminal_without_work() {
        let (mut engine, _) =
            dezoomify_engine::EngineJob::start(engine_options(&["https://example.com/item"]))
                .unwrap();
        engine
            .command(dezoomify_engine::UserCommand::Cancel)
            .unwrap();
        assert!(engine.snapshot().terminal.is_some());
        let revision_before = engine.snapshot().revision;
        let err = engine
            .command(dezoomify_engine::UserCommand::Cancel)
            .unwrap_err();
        assert_eq!(err.code, "job.post-terminal");
        assert_eq!(
            engine.snapshot().revision,
            revision_before,
            "no work after terminal"
        );
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
        // Bad formats and mismatched extensions fail before any work. The
        // destination cue is synchronous, so the job already awaits it.
        let id = table.start_job("https://example.com/item").unwrap();
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
        // Malformed choices never reach the table: the command boundary
        // rejects non-object JSON before any effect (see
        // `commands::dispatch_answer_choice`).
        assert_eq!(table.events_for(&id).len(), events_before);
        table.cancel_job(&id).unwrap();
    }

    #[test]
    fn partial_recovery_request_is_honest_and_reachable() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        let missing = vec!["tile:1".to_string(), "tile:2".to_string()];
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AwaitingPartialDecision,
                2,
                4,
                Some(RecoveryLedger {
                    missing: missing.clone(),
                    failed: 2,
                    total: 4,
                }),
                None,
            ),
        );
        assert_eq!(table.state_of(&id), Some(JobState::AwaitingPartialDecision));
        let pending = table.pending_partial_for(&id).expect("pending ledger");
        assert_eq!(pending.missing, missing);
        assert_eq!((pending.failed, pending.total), (2, 4));
        let events = table.events_for(&id);
        let requested = events
            .iter()
            .find(|e| e.kind == "recovery-requested")
            .expect("recovery-requested event");
        // The event carries the kind only: the ledger lives in the record
        // (asserted above) and reaches the payload below. Transcript details
        // never carry paths or URLs.
        assert!(requested.detail.is_empty());
        assert!(!requested.detail.contains("example.com/item"));
        assert!(!requested.detail.contains("/tmp"));
        let (channel, payload) = table.project_event(&id, requested);
        assert_eq!(channel, CHANNEL_JOB_STATE);
        assert_eq!(payload["reason"], serde_json::json!("partial"));
        assert_eq!(payload["missing"], serde_json::json!(["tile:1", "tile:2"]));
        assert!(!payload.to_string().contains("example.com/item"));
        assert!(!payload_has_forbidden_keys(&payload));
        // A duplicate announcement with the same ledger does not re-cue.
        let events_before = table.events_for(&id).len();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AwaitingPartialDecision,
                2,
                4,
                Some(RecoveryLedger {
                    missing,
                    failed: 2,
                    total: 4,
                }),
                None,
            ),
        );
        assert_eq!(table.events_for(&id).len(), events_before);
    }

    #[test]
    fn partial_answer_forwards_to_the_runner_gate() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AwaitingPartialDecision,
                3,
                4,
                Some(RecoveryLedger {
                    missing: vec!["tile:9".to_string()],
                    failed: 1,
                    total: 4,
                }),
                None,
            ),
        );
        // Keep leaves the awaiting state for the runner terminal.
        table
            .answer_choice(
                &id,
                &Choice::Partial {
                    decision: dezoomify_protocol::dto::RecoveryChoice::Keep,
                },
            )
            .unwrap();
        assert_eq!(table.state_of(&id), Some(JobState::AcquiringTiles));
        assert!(table.pending_partial_for(&id).is_none());
        // The fallback policy tracks the explicit answer for an honest
        // gate timeout.
        assert!(table.options_for(&id).unwrap().keep_partial);
        // Discard maps distinctly; retry never changes the fallback policy.
        let id2 = table.start_job("https://example.com/other").unwrap();
        table.apply_runner_snapshot(
            &id2,
            &runner_snapshot(
                Lifecycle::AwaitingPartialDecision,
                1,
                2,
                Some(RecoveryLedger {
                    missing: vec!["tile:3".to_string()],
                    failed: 1,
                    total: 2,
                }),
                None,
            ),
        );
        table
            .answer_choice(
                &id2,
                &Choice::Partial {
                    decision: dezoomify_protocol::dto::RecoveryChoice::Discard,
                },
            )
            .unwrap();
        assert!(!table.options_for(&id2).unwrap().keep_partial);
        let id3 = table.start_job("https://example.com/third").unwrap();
        table.apply_runner_snapshot(
            &id3,
            &runner_snapshot(
                Lifecycle::AwaitingPartialDecision,
                1,
                2,
                Some(RecoveryLedger {
                    missing: vec!["tile:4".to_string()],
                    failed: 1,
                    total: 2,
                }),
                None,
            ),
        );
        let keep_before = table.options_for(&id3).unwrap().keep_partial;
        table
            .answer_choice(
                &id3,
                &Choice::Partial {
                    decision: dezoomify_protocol::dto::RecoveryChoice::Retry,
                },
            )
            .unwrap();
        assert_eq!(
            table.options_for(&id3).unwrap().keep_partial,
            keep_before,
            "retry never changes the fallback policy"
        );
        assert_eq!(table.state_of(&id3), Some(JobState::AcquiringTiles));
    }

    #[test]
    fn partial_completed_terminal_carries_ledger_and_sibling_only() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        // Publish an honest partial through the runner boundary: the terminal
        // must name the sibling basename, never the granted path.
        let missing = vec!["tile:1".to_string()];
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::Finalizing,
                3,
                4,
                None,
                Some(Terminal::Completed(published_partial(
                    "png",
                    512,
                    512,
                    3,
                    &missing.clone(),
                    "saved.partial.png",
                ))),
            ),
        );
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
        // The terminal carries the kind only: the ledger and sibling live in
        // the record (asserted above) and reach the payload below. The
        // granted directory never enters the transcript or the payload.
        assert!(terminal.detail.is_empty());
        let (channel, payload) = table.project_event(&id, terminal);
        assert_eq!(channel, CHANNEL_JOB_OUTPUT);
        assert_eq!(payload["state"], serde_json::json!("PartiallyCompleted"));
        assert_eq!(payload["missing"], serde_json::json!(["tile:1"]));
        assert_eq!(payload["sibling"], serde_json::json!("saved.partial.png"));
        assert!(!payload.to_string().contains("/tmp"));
        assert!(!payload_has_forbidden_keys(&payload));
        // Post-terminal answers stay stale.
        assert_eq!(
            table
                .answer_choice(
                    &id,
                    &Choice::Partial {
                        decision: dezoomify_protocol::dto::RecoveryChoice::Keep
                    }
                )
                .unwrap_err(),
            "stale"
        );
    }

    #[test]
    fn partial_discard_fails_honestly_with_no_output() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.apply_runner_snapshot(
            &id,
            &runner_snapshot(
                Lifecycle::AcquiringTiles,
                0,
                1,
                None,
                Some(Terminal::Failed(dezoomify_native::error::NativeError::new(
                    "tile.download-failed",
                    "1 tile(s) still failing",
                ))),
            ),
        );
        assert_eq!(table.state_of(&id), Some(JobState::Failed));
        assert!(table.output_missing_for(&id).is_empty());
        assert!(table.output_sibling_for(&id).is_none());
        let snapshot = table.error_snapshot_for(&id).expect("error snapshot");
        assert_eq!(snapshot.code, "tile.download-failed");
    }

    #[test]
    fn runner_snapshots_fold_through_poll_drivers() {
        let mut table = JobTable::new();
        let mut settings = DesktopSettings::with_defaults();
        settings.output_dir = Some(std::env::temp_dir().join("dezoomify-fold-test"));
        settings.output_format = "png".to_string();
        // 127.0.0.1:9 refuses connections immediately, so the runner reaches
        // a typed Failed terminal without touching any network.
        let id = table
            .start_job_with_settings("http://127.0.0.1:9/item", &settings)
            .unwrap();
        assert!(table.has_runner(&id));
        // Poll until the runner's terminal is folded (bounded wait).
        let mut folded = false;
        for _ in 0..200 {
            table.poll_drivers();
            if table.state_of(&id).is_some_and(|s| s.is_terminal()) {
                folded = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(folded, "runner terminal must fold into the transcript");
        let snapshot = table.error_snapshot_for(&id).expect("error snapshot");
        assert!(
            snapshot.code.starts_with("transport.") || snapshot.code.starts_with("discovery."),
            "typed failure code, got {}",
            snapshot.code
        );
        let events = table.events_for(&id);
        assert!(events.iter().any(|e| e.kind == "failed"));
        assert!(events.iter().any(|e| e.kind == "destination"));
        // The runner handle is released once the terminal folded.
        assert!(!table.has_runner(&id));
    }

    /// Test helper: canonical options for one input URL.
    fn engine_options(inputs: &[&str]) -> dezoomify_engine::JobOptions {
        dezoomify_engine::JobOptions::new(
            inputs
                .iter()
                .map(|url| dezoomify_engine::DiscoveryInput::new((*url).to_string()))
                .collect(),
        )
    }

    /// Test helper: build one runner snapshot.
    fn runner_snapshot(
        lifecycle: Lifecycle,
        acquired: u64,
        total: u64,
        recovery: Option<RecoveryLedger>,
        terminal: Option<Terminal>,
    ) -> RunnerSnapshot {
        RunnerSnapshot {
            job: "job:test".to_string(),
            seq: 0,
            lifecycle,
            acquired,
            total,
            recovery,
            terminal,
        }
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
