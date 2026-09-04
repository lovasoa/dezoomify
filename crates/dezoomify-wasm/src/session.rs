//! One-session job owner: version/config validation, canonical dispatch,
//! FIFO message draining, buffer lifecycle, one pure processing op, disposal.
//!
//! ## Temporary minimal job machine
//!
//! `crates/dezoomify-job` currently contains only its `README.md` (no
//! `src/` or `Cargo.toml`), so there is no job API to wrap yet. Until that
//! crate lands, [`Session`] embeds a minimal synchronous state machine with
//! the same transcript shape — canonical [`ControlEnvelope`] messages
//! encoded by [`dezoomify_protocol::codec`] — over the states
//! `Created -> Discovering -> {Completed, Failed, Cancelled}`:
//!
//! * `Start` (in `Created`) emits `job-state/discovering` plus one
//!   `acquire-resource` host effect and moves to `Discovering`.
//! * `ProvideResource` with a committed arena buffer (consumed exactly once)
//!   emits `completed` and moves to `Completed` (the basic-success path).
//! * `ProvideFetchFailure` emits `failed` and moves to `Failed`.
//! * `Cancel` emits `cancelled` and moves to `Cancelled`.
//! * Outcome/selection commands are accepted as no-ops while `Discovering`
//!   (matching job only) so replays of richer scripts do not diverge on
//!   unknown-command errors; every other state mismatch is `wrong-state`.
//!
//! When `dezoomify-job` becomes available this machine must be replaced by a
//! thin wrapper that delegates transitions to the job crate, keeping the
//! canonical transcript byte-identical. The `P07-WORKFLOWS` transcript test
//! (`tests/adapter.rs`) pins the current shape.
//!
//! ## Deterministic fixed IDs
//!
//! The minimal machine uses fixed per-session IDs (`req:wasm-meta-1`,
//! `fx:wasm-acq-1`, `out:wasm-1`). Sessions are isolated (separate arenas,
//! queues, and job bindings), so fixed IDs cannot collide across sessions.

use crate::buffer::{ArenaHandle, ByteArena};
use crate::codec::{decode_envelope, encode_envelope};
use crate::error::{redact, AdapterError, AdapterErrorCode};
use crate::processing::{composite_crop, fnv1a64_hex, CropGeometry};
use dezoomify_protocol::dto::{
    negotiate_version, ControlBody, ControlEnvelope, EffectId, ErrorDto, HostEffect, JobCommand,
    JobEvent, JobId, OutputId, RequestDto, RequestId, RequestPurpose,
};
use serde::Deserialize;
use std::collections::VecDeque;

/// Hard per-buffer ceiling (32 MiB); requested caps above this are rejected.
pub const HARD_MAX_BUFFER_BYTES: u64 = 32 << 20;
/// Hard session-total ceiling (256 MiB).
pub const HARD_MAX_TOTAL_BYTES: u64 = 256 << 20;
/// Hard live-buffer ceiling.
pub const HARD_MAX_BUFFERS: usize = 4096;
/// Hard queued-message ceiling.
pub const HARD_MAX_MESSAGES: usize = 65536;

/// Default per-buffer cap (browser baseline `max_tile_bytes`, 8 MiB).
pub const DEFAULT_MAX_BUFFER_BYTES: u64 = 8 << 20;
/// Default session-total cap (64 MiB).
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = 64 << 20;
/// Default live-buffer cap.
pub const DEFAULT_MAX_BUFFERS: usize = 256;
/// Default queued-message cap.
pub const DEFAULT_MAX_MESSAGES: usize = 1024;

/// Fixed metadata request id emitted by the minimal machine.
pub const FIXED_REQUEST_ID: &str = "req:wasm-meta-1";
/// Fixed acquire effect id emitted by the minimal machine.
pub const FIXED_EFFECT_ID: &str = "fx:wasm-acq-1";
/// Fixed output id emitted on the basic-success path.
pub const FIXED_OUTPUT_ID: &str = "out:wasm-1";
/// Name of the single supported processing operation.
pub const PROCESSING_OPERATION: &str = "composite-crop";

/// Minimal job lifecycle mirrored until `dezoomify-job` lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SessionState {
    /// Constructed, no command accepted yet except `Start`.
    Created,
    /// `Start` accepted, awaiting host responses.
    Discovering,
    /// `ProvideResource` accepted; terminal.
    Completed,
    /// `ProvideFetchFailure` accepted; terminal.
    Failed,
    /// `Cancel` or `dispose` while active; terminal.
    Cancelled,
}

impl SessionState {
    /// Stable state string used in `job-state` events.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Discovering => "discovering",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// Terminal states emit no further transitions.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        match self {
            Self::Created | Self::Discovering => false,
            Self::Completed | Self::Failed | Self::Cancelled => true,
        }
    }
}

/// Optional session quotas parsed from the constructor config JSON.
/// Absent fields take `DEFAULT_*`; values of zero are malformed; values
/// above the `HARD_*` ceilings are `limit-exceeded`.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
struct SessionConfigJson {
    max_buffer_bytes: Option<u64>,
    max_total_bytes: Option<u64>,
    max_buffers: Option<usize>,
    max_messages: Option<usize>,
}

/// One adapter session: exactly one job, one arena, one FIFO message queue.
#[derive(Debug)]
pub struct Session {
    arena: ByteArena,
    queue: VecDeque<Vec<u8>>,
    state: SessionState,
    job: Option<JobId>,
    disposed: bool,
    max_messages: usize,
}

impl Session {
    /// Validate `protocol_version` (via protocol negotiation) and the quota
    /// config, then construct an empty session. No large allocation happens
    /// here; quotas are enforced before any later large allocation.
    ///
    /// # Errors
    ///
    /// `version-unsupported` for a rejected version; `malformed` for bad
    /// config JSON or zero quotas; `limit-exceeded` for quotas above the
    /// hard ceilings.
    pub fn new(protocol_version: &str, config_json: &str) -> Result<Self, AdapterError> {
        negotiate_version(protocol_version).map_err(|dto: ErrorDto| {
            AdapterError::new(AdapterErrorCode::VersionUnsupported, dto.message)
        })?;
        let trimmed = config_json.trim();
        let config: SessionConfigJson = if trimmed.is_empty() {
            SessionConfigJson::default()
        } else {
            serde_json::from_str(trimmed).map_err(|detail| {
                AdapterError::new(
                    AdapterErrorCode::Malformed,
                    format!("invalid session config: {}", redact(&detail.to_string())),
                )
            })?
        };
        let max_buffer_bytes = Self::quota(
            config.max_buffer_bytes,
            DEFAULT_MAX_BUFFER_BYTES,
            HARD_MAX_BUFFER_BYTES,
            "max_buffer_bytes",
        )?;
        let max_total_bytes = Self::quota(
            config.max_total_bytes,
            DEFAULT_MAX_TOTAL_BYTES,
            HARD_MAX_TOTAL_BYTES,
            "max_total_bytes",
        )?;
        let max_buffers = Self::quota_usize(
            config.max_buffers,
            DEFAULT_MAX_BUFFERS,
            HARD_MAX_BUFFERS,
            "max_buffers",
        )?;
        let max_messages = Self::quota_usize(
            config.max_messages,
            DEFAULT_MAX_MESSAGES,
            HARD_MAX_MESSAGES,
            "max_messages",
        )?;
        Ok(Self {
            arena: ByteArena::with_limits(max_buffer_bytes, max_total_bytes, max_buffers),
            queue: VecDeque::new(),
            state: SessionState::Created,
            job: None,
            disposed: false,
            max_messages,
        })
    }

    fn quota(
        requested: Option<u64>,
        default: u64,
        hard: u64,
        name: &str,
    ) -> Result<u64, AdapterError> {
        match requested {
            None => Ok(default),
            Some(0) => Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                format!("session quota {name} must be non-zero"),
            )),
            Some(value) if value > hard => Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!("session quota {name} of {value} exceeds hard ceiling {hard}"),
            )),
            Some(value) => Ok(value),
        }
    }

    fn quota_usize(
        requested: Option<usize>,
        default: usize,
        hard: usize,
        name: &str,
    ) -> Result<usize, AdapterError> {
        match requested {
            None => Ok(default),
            Some(0) => Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                format!("session quota {name} must be non-zero"),
            )),
            Some(value) if value > hard => Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!("session quota {name} of {value} exceeds hard ceiling {hard}"),
            )),
            Some(value) => Ok(value),
        }
    }

    /// Current lifecycle state.
    #[must_use]
    pub const fn state(&self) -> SessionState {
        self.state
    }

    /// Whether [`Session::dispose`] has run.
    #[must_use]
    pub const fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// Number of queued (undrained) messages.
    #[must_use]
    pub fn pending_messages(&self) -> usize {
        self.queue.len()
    }

    /// Bound job id, if `Start` was accepted.
    #[must_use]
    pub fn job_id(&self) -> Option<&JobId> {
        self.job.as_ref()
    }

    fn require_live(&self) -> Result<(), AdapterError> {
        if self.disposed {
            return Err(AdapterError::new(
                AdapterErrorCode::Disposed,
                "session is disposed",
            ));
        }
        Ok(())
    }

    /// Decode one canonical control envelope and run its transition
    /// synchronously. Returns status only; emitted messages wait in the
    /// FIFO queue for [`Session::drain_messages`]. Atomic: rejected input
    /// changes no state, queue, or buffer.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `malformed` for undecodable input or
    /// non-command bodies; `version-unsupported` for a wrong envelope
    /// version; `wrong-state`/`stale-buffer`/`limit-exceeded` per transition.
    pub fn dispatch(&mut self, control: &[u8]) -> Result<(), AdapterError> {
        self.require_live()?;
        let envelope = decode_envelope(control)?;
        match envelope.body {
            ControlBody::Command(command) => self.dispatch_command(command),
            _ => Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                "adapter dispatch accepts command envelopes only",
            )),
        }
    }

    /// Remove and return queued canonical messages in FIFO order. Each
    /// message is delivered exactly once; later drains return only newer
    /// messages. Allowed after disposal so terminal cleanup can be collected.
    /// (Draining is the side effect, so the return value may be discarded.)
    pub fn drain_messages(&mut self) -> Vec<Vec<u8>> {
        self.queue.drain(..).collect()
    }

    /// Cancel the job and release adapter resources. Repeat-safe: later
    /// calls succeed without enqueueing duplicates. Afterwards every method
    /// except [`Session::drain_messages`] fails with `disposed`.
    pub fn dispose(&mut self) -> Result<(), AdapterError> {
        if self.disposed {
            return Ok(());
        }
        self.disposed = true;
        if matches!(
            self.state,
            SessionState::Created | SessionState::Discovering
        ) {
            self.state = SessionState::Cancelled;
            if let Some(job) = self.job.clone() {
                let event = JobEvent::Cancelled { job };
                // Disposal must not fail on a full queue; force the terminal
                // marker so hosts always observe cancellation.
                if let Ok(envelope) = ControlEnvelope::new(ControlBody::Event(event)) {
                    if let Ok(bytes) = encode_envelope(&envelope) {
                        self.queue.push_back(bytes);
                    }
                }
            }
        }
        self.arena.clear();
        Ok(())
    }

    /// Reserve `length` zeroed bytes for host-supplied data.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal, else arena quotas (see [`ByteArena`]).
    pub fn allocate_buffer(&mut self, length: u64) -> Result<ArenaHandle, AdapterError> {
        self.require_live()?;
        self.arena.allocate(length)
    }

    /// Copy host bytes into an uncommitted allocation.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal, else arena errors (see [`ByteArena`]).
    pub fn write_buffer(
        &mut self,
        handle: ArenaHandle,
        offset: u64,
        data: &[u8],
    ) -> Result<(), AdapterError> {
        self.require_live()?;
        self.arena.write_bytes(handle, offset, data)
    }

    /// Seal an allocation at `actual` bytes.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal, else arena errors (see [`ByteArena`]).
    pub fn commit_buffer(&mut self, handle: ArenaHandle, actual: u64) -> Result<(), AdapterError> {
        self.require_live()?;
        self.arena.commit(handle, actual)
    }

    /// Move committed bytes out exactly once.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal, else arena errors (see [`ByteArena`]).
    pub fn take_buffer(&mut self, handle: ArenaHandle) -> Result<Vec<u8>, AdapterError> {
        self.require_live()?;
        self.arena.take_buffer(handle)
    }

    /// Release a buffer handle (idempotent).
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `stale-buffer` for forged/stale handles.
    pub fn free_buffer(&mut self, handle: ArenaHandle) -> Result<(), AdapterError> {
        self.require_live()?;
        self.arena.free(handle)
    }

    /// Project a live handle onto its canonical protocol reference.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal, else arena errors (see [`ByteArena`]).
    pub fn protocol_handle(
        &self,
        handle: ArenaHandle,
    ) -> Result<dezoomify_protocol::dto::BufferHandle, AdapterError> {
        self.require_live()?;
        self.arena.to_protocol_handle(handle)
    }

    /// Run the single bounded pure operation `composite-crop`: copy
    /// `geometry` from committed RGBA8 `input` (`src_width` x `src_height`)
    /// into uncommitted `output` (capacity must equal the crop exactly).
    /// Returns the FNV-1a digest of the cropped bytes. Failure is atomic:
    /// `output` is untouched on error.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `malformed` for unknown operation names;
    /// arena seal/aliasing errors; processing bound errors.
    pub fn process_crop(
        &mut self,
        operation: &str,
        input: ArenaHandle,
        output: ArenaHandle,
        src_width: u32,
        src_height: u32,
        geometry: &CropGeometry,
    ) -> Result<String, AdapterError> {
        self.require_live()?;
        if operation != PROCESSING_OPERATION {
            return Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                format!("unsupported processing operation {operation}"),
            ));
        }
        let (input_bytes, output_bytes) = self.arena.processing_pair(input, output)?;
        composite_crop(input_bytes, src_width, src_height, output_bytes, geometry)?;
        Ok(fnv1a64_hex(output_bytes))
    }

    fn dispatch_command(&mut self, command: JobCommand) -> Result<(), AdapterError> {
        match command {
            JobCommand::Start { job, input_url } => self.on_start(job, input_url),
            JobCommand::Cancel { job } => self.on_cancel(job),
            JobCommand::ProvideResource {
                job,
                request: _,
                buffer,
            } => self.on_provide_resource(job, &buffer),
            JobCommand::ProvideFetchFailure {
                job,
                request: _,
                error,
            } => self.on_fetch_failure(job, error),
            // Accepted as no-ops while Discovering so richer replays do not
            // diverge; rejected in any other phase.
            JobCommand::SelectImage { job, .. }
            | JobCommand::SelectLevel { job, .. }
            | JobCommand::ProvideDecodeOutcome { job, .. }
            | JobCommand::ProvideProcessOutcome { job, .. }
            | JobCommand::ProvideWriteOutcome { job, .. }
            | JobCommand::ProvideEncodeOutcome { job, .. }
            | JobCommand::ProvideFinalizeOutcome { job, .. }
            | JobCommand::ProvidePublicationOutcome { job, .. }
            | JobCommand::RetryReady { job, .. }
            | JobCommand::PartialChoice { job, .. }
            | JobCommand::DestinationResponse { job, .. } => {
                self.require_job(&job)?;
                if self.state == SessionState::Discovering {
                    Ok(())
                } else {
                    Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        format!("command not accepted in state {}", self.state.as_str()),
                    ))
                }
            }
        }
    }

    fn require_job(&self, job: &JobId) -> Result<(), AdapterError> {
        match self.job.as_ref() {
            Some(bound) if bound == job => Ok(()),
            _ => Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "command job does not match this session",
            )),
        }
    }

    fn enqueue(&mut self, body: ControlBody) -> Result<(), AdapterError> {
        if self.queue.len() >= self.max_messages {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "session message queue is full",
            ));
        }
        let envelope = ControlEnvelope::new(body)
            .map_err(|dto: ErrorDto| AdapterError::new(AdapterErrorCode::Malformed, dto.message))?;
        let bytes = encode_envelope(&envelope)?;
        self.queue.push_back(bytes);
        Ok(())
    }

    fn on_start(&mut self, job: JobId, input_url: String) -> Result<(), AdapterError> {
        if self.state != SessionState::Created {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                format!("start not accepted in state {}", self.state.as_str()),
            ));
        }
        if input_url.is_empty()
            || input_url.len() > 2048
            || !(input_url.starts_with("https://") || input_url.starts_with("http://"))
        {
            return Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                "start requires an http(s) input_url up to 2048 bytes",
            ));
        }
        if self.queue.len() + 2 > self.max_messages {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "session message queue is full",
            ));
        }
        let request_id: RequestId = FIXED_REQUEST_ID.parse().map_err(|_| {
            AdapterError::new(AdapterErrorCode::Malformed, "fixed request id is invalid")
        })?;
        let effect_id: EffectId = FIXED_EFFECT_ID.parse().map_err(|_| {
            AdapterError::new(AdapterErrorCode::Malformed, "fixed effect id is invalid")
        })?;
        // Redacted copies only: the canonical request preserves the exact URI
        // text for the host, but nothing here echoes it into errors or logs.
        let request = RequestDto {
            id: request_id,
            uri: input_url,
            headers: Vec::new(),
            purpose: RequestPurpose::Metadata,
        };
        self.job = Some(job.clone());
        self.state = SessionState::Discovering;
        self.enqueue(ControlBody::Event(JobEvent::JobState {
            job: job.clone(),
            state: SessionState::Discovering.as_str().to_string(),
        }))?;
        self.enqueue(ControlBody::Effect(HostEffect::AcquireResource {
            effect: effect_id,
            job,
            request,
        }))?;
        Ok(())
    }

    fn on_cancel(&mut self, job: JobId) -> Result<(), AdapterError> {
        self.require_job(&job)?;
        if self.state.is_terminal() {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                format!("cancel not accepted in state {}", self.state.as_str()),
            ));
        }
        self.state = SessionState::Cancelled;
        self.enqueue(ControlBody::Event(JobEvent::Cancelled { job }))?;
        Ok(())
    }

    fn on_provide_resource(
        &mut self,
        job: JobId,
        buffer: &dezoomify_protocol::dto::BufferHandle,
    ) -> Result<(), AdapterError> {
        self.require_job(&job)?;
        if self.state != SessionState::Discovering {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                format!("resource not accepted in state {}", self.state.as_str()),
            ));
        }
        // Resolve before mutating anything: stale or unsealed references are
        // atomic rejections.
        let handle = self.arena.resolve_protocol(buffer)?;
        if self.queue.len() + 1 > self.max_messages {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "session message queue is full",
            ));
        }
        // Exactly-once consumption: a replayed reference is stale afterwards.
        let _consumed = self.arena.take_buffer(handle)?;
        let output: OutputId = FIXED_OUTPUT_ID.parse().map_err(|_| {
            AdapterError::new(AdapterErrorCode::Malformed, "fixed output id is invalid")
        })?;
        self.state = SessionState::Completed;
        self.enqueue(ControlBody::Event(JobEvent::Completed { job, output }))?;
        Ok(())
    }

    fn on_fetch_failure(&mut self, job: JobId, error: ErrorDto) -> Result<(), AdapterError> {
        self.require_job(&job)?;
        if self.state != SessionState::Discovering {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                format!("failure not accepted in state {}", self.state.as_str()),
            ));
        }
        if self.queue.len() + 1 > self.max_messages {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "session message queue is full",
            ));
        }
        // Host-supplied error text is untrusted: redact before re-emitting.
        let safe = ErrorDto {
            message: redact(&error.message),
            ..error
        };
        self.state = SessionState::Failed;
        self.enqueue(ControlBody::Event(JobEvent::Failed { job, error: safe }))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::messages_to_json_array;

    fn start_bytes(job: &str) -> Vec<u8> {
        let command = JobCommand::Start {
            job: job.parse().unwrap(),
            input_url: "https://example.com/item/1".to_string(),
        };
        let envelope = ControlEnvelope::new(ControlBody::Command(command)).unwrap();
        encode_envelope(&envelope).unwrap()
    }

    #[test]
    fn version_negotiation_precedes_work() {
        assert!(Session::new("1.0", "{}").is_ok());
        assert!(Session::new("1", "{}").is_ok());
        let error = Session::new("2.0", "{}").unwrap_err();
        assert_eq!(error.code(), AdapterErrorCode::VersionUnsupported);
    }

    #[test]
    fn malformed_dispatch_leaves_session_untouched() {
        let mut session = Session::new("1.0", "{}").unwrap();
        let error = session.dispatch(b"{not json}").unwrap_err();
        assert_eq!(error.code(), AdapterErrorCode::Malformed);
        assert_eq!(session.state(), SessionState::Created);
        assert!(session.drain_messages().is_empty());
    }

    #[test]
    fn start_emits_state_and_effect_fifo() {
        let mut session = Session::new("1.0", "{}").unwrap();
        session.dispatch(&start_bytes("job:basic-1")).unwrap();
        assert_eq!(session.state(), SessionState::Discovering);
        let messages = session.drain_messages();
        assert_eq!(messages.len(), 2);
        let transcript = messages_to_json_array(&messages).unwrap();
        assert!(transcript.contains("job-state"));
        assert!(transcript.contains("acquire-resource"));
        assert!(session.drain_messages().is_empty());
    }
}
