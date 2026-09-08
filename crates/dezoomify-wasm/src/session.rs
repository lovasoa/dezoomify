//! One-session job owner: version/config validation, canonical dispatch,
//! FIFO message draining, buffer lifecycle, one pure processing op, disposal.
//!
//! ## Real job-engine delegation
//!
//! [`Session`] owns a [`dezoomify_job::Job`] and delegates the whole
//! lifecycle to it. The adapter is a thin translation layer between the
//! canonical [`ControlEnvelope`] channel and the engine's effect/event
//! queues: engine effects and events are drained and projected, in engine
//! `seq` order, onto typed protocol messages encoded by
//! [`dezoomify_protocol::codec`].
//!
//! Host interaction map (every path is explicit and correlated):
//!
//! * `Start` creates the engine job and emits its first effects/events.
//! * Discovery bytes: `ProvideResource` whose `request` matches one of the
//!   outstanding `acquire-resource` effects (the engine may ask for several
//!   metadata resources). The buffer is consumed exactly once (taken out of
//!   the arena) and forwarded as `ResourceBytes` with its bytes.
//! * Tile bytes: each `acquire-tile` effect carries an adapter-minted
//!   `req:tile-<n>` request id plus the tile's complete output placement
//!   (position, planned extent, declared canvas, processing recipe) and the
//!   engine-declared request headers. Hosts decode during acquisition (the
//!   native model): `ProvideResource` with that id forwards a successful
//!   `TileOutcome`, and the adapter takes the buffer out of the arena
//!   immediately: tile bytes are never retained server-side. Empty tile
//!   buffers forward a failed `TileOutcome` (the engine retries).
//! * `ProvideFetchFailure` maps to `FetchFailure` (discovery request) or a
//!   failed `TileOutcome` (tile request).
//! * Decisions: `SelectImage`, `SelectLevel`, `DestinationResponse`,
//!   `RetryReady`, and `PartialChoice` map 1:1 onto engine responses.
//!   `PartialChoice` must reference the outstanding `rec:*` recovery id.
//! * Codec outcome commands (`ProvideDecodeOutcome`, …) are accepted as
//!   acknowledged no-ops: this engine does not await them.
//! * `decode-pixels`/`open-encoder`/`finalize-encoder`/`publish-output`
//!   carry the placement and output geometry the host needs to assemble
//!   (the tile placement arrived with the acquisition effect; the encoder
//!   effect carries the format and declared canvas). `release-bytes`
//!   instructs the host to close its own retained per-tile resources
//!   (decoded bitmaps, surfaces).
//!
//! Engine resources beyond this model are engine limitations, not adapter
//! limits: byte lengths pass through, never fabricated. Probe-driven
//! planning is disabled for the session (the host never observes tile
//! geometry here; the interactive discovery adapter owns that flow), so
//! probe-driven levels fail with a typed `job.probe-unsupported` error.
//! Empty discovery resources fail the job via the engine
//! (`job.empty-resource`); nothing here can fake completion.

use crate::buffer::{ArenaHandle, ByteArena, MAX_BUFFERS, MAX_BUFFER_BYTES, MAX_TOTAL_BYTES};
use crate::codec::{decode_envelope, encode_envelope};
use crate::error::{redact, AdapterError, AdapterErrorCode};
use dezoomify_job::{Job as EngineJob, JobError as EngineJobError, JobResponse, Outcome};
use dezoomify_protocol::dto::{
    negotiate_version, CatalogDto, ControlBody, ControlEnvelope, EffectId, ErrorDto, ErrorPhase,
    HeaderDto, HostEffect, JobCommand, JobEvent, JobId, OutputId, PointDto, RecoveryAction,
    RecoveryId, RecoveryKind, RequestDto, RequestId, RequestPurpose, SizeDto, TileId,
    TilePlacementDto,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};

/// Hard per-buffer ceiling (32 MiB); requested caps above this are rejected.
pub const HARD_MAX_BUFFER_BYTES: u64 = 32 << 20;
/// Hard session-total ceiling (256 MiB).
pub const HARD_MAX_TOTAL_BYTES: u64 = 256 << 20;
/// Hard live-buffer ceiling.
pub const HARD_MAX_BUFFERS: usize = 4096;
/// Hard queued-message ceiling.
pub const HARD_MAX_MESSAGES: usize = 65536;

/// Default per-buffer cap (browser baseline `max_tile_bytes`, 8 MiB).
pub const DEFAULT_MAX_BUFFER_BYTES: u64 = MAX_BUFFER_BYTES;
/// Default session-total cap (64 MiB).
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = MAX_TOTAL_BYTES;
/// Default live-buffer cap.
pub const DEFAULT_MAX_BUFFERS: usize = MAX_BUFFERS;
/// Default queued-message cap.
pub const DEFAULT_MAX_MESSAGES: usize = 1024;

/// Session lifecycle state, projected 1:1 from the engine state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SessionState {
    Created,
    Discovering,
    AwaitingImageSelection,
    AwaitingLevelSelection,
    AwaitingDestination,
    Planning,
    AcquiringTiles,
    ProcessingTiles,
    AwaitingPartialDecision,
    AwaitingRecovery,
    Encoding,
    Finalizing,
    Publishing,
    CleaningUp,
    Cancelling,
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

impl SessionState {
    /// Stable state name used in `job-state` events (engine spelling).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "Created",
            Self::Discovering => "Discovering",
            Self::AwaitingImageSelection => "AwaitingImageSelection",
            Self::AwaitingLevelSelection => "AwaitingLevelSelection",
            Self::AwaitingDestination => "AwaitingDestination",
            Self::Planning => "Planning",
            Self::AcquiringTiles => "AcquiringTiles",
            Self::ProcessingTiles => "ProcessingTiles",
            Self::AwaitingPartialDecision => "AwaitingPartialDecision",
            Self::AwaitingRecovery => "AwaitingRecovery",
            Self::Encoding => "Encoding",
            Self::Finalizing => "Finalizing",
            Self::Publishing => "Publishing",
            Self::CleaningUp => "CleaningUp",
            Self::Cancelling => "Cancelling",
            Self::Completed => "Completed",
            Self::PartiallyCompleted => "PartiallyCompleted",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }

    /// Terminal states emit no further transitions.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::PartiallyCompleted | Self::Failed | Self::Cancelled
        )
    }

    fn from_engine(state: dezoomify_job::State) -> Self {
        use dezoomify_job::State as S;
        match state {
            S::Created => Self::Created,
            S::Discovering => Self::Discovering,
            S::AwaitingImageSelection => Self::AwaitingImageSelection,
            S::AwaitingLevelSelection => Self::AwaitingLevelSelection,
            S::AwaitingDestination => Self::AwaitingDestination,
            S::Planning => Self::Planning,
            S::AcquiringTiles => Self::AcquiringTiles,
            S::ProcessingTiles => Self::ProcessingTiles,
            S::AwaitingPartialDecision => Self::AwaitingPartialDecision,
            S::AwaitingRecovery => Self::AwaitingRecovery,
            S::Encoding => Self::Encoding,
            S::Finalizing => Self::Finalizing,
            S::Publishing => Self::Publishing,
            S::CleaningUp => Self::CleaningUp,
            S::Cancelling => Self::Cancelling,
            S::Completed => Self::Completed,
            S::PartiallyCompleted => Self::PartiallyCompleted,
            S::Failed => Self::Failed,
            S::Cancelled => Self::Cancelled,
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

/// One adapter session: exactly one engine job, one arena, one FIFO queue.
#[derive(Debug)]
pub struct Session {
    arena: ByteArena,
    queue: VecDeque<Vec<u8>>,
    job: Option<EngineJob>,
    job_id: Option<JobId>,
    state: SessionState,
    disposed: bool,
    max_messages: usize,
    /// Outstanding discovery request ids from acquire-resource effects.
    live_discovery_requests: HashSet<String>,
    /// Adapter-minted tile request id -> engine tile id.
    outstanding_tile_requests: HashMap<String, String>,
    /// Recovery id from the latest request-decision effect.
    pending_recovery: Option<String>,
    /// Adapter-minted tile request counter.
    next_tile_request: u32,
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
            job: None,
            job_id: None,
            state: SessionState::Created,
            disposed: false,
            max_messages,
            live_discovery_requests: HashSet::new(),
            outstanding_tile_requests: HashMap::new(),
            pending_recovery: None,
            next_tile_request: 0,
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

    /// Current lifecycle state (engine projection).
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
        self.job_id.as_ref()
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

    /// Cancel the active job through the engine and release adapter
    /// resources. Repeat-safe: later calls succeed without enqueueing
    /// duplicates. Afterwards every method except [`Session::drain_messages`]
    /// fails with `disposed`.
    pub fn dispose(&mut self) -> Result<(), AdapterError> {
        if self.disposed {
            return Ok(());
        }
        self.disposed = true;
        if let Some(job) = self.job.as_mut() {
            if !job.is_terminal() {
                // The engine owns the cancellation lifecycle (cancel-work,
                // release-bytes, terminal events); collect it best-effort so
                // hosts always observe cancellation even on a full queue.
                let _ = job.on_response(JobResponse::Cancel {
                    job: job.id().to_string(),
                });
                let forced = self.absorb();
                if forced.is_err() {
                    self.force_cancelled_event();
                }
            }
        } else {
            self.force_cancelled_event();
        }
        self.job = None;
        self.arena.clear();
        Ok(())
    }

    fn force_cancelled_event(&mut self) {
        if let Some(job) = self.job_id.clone() {
            self.state = SessionState::Cancelled;
            let event = JobEvent::Cancelled { job };
            if let Ok(envelope) = ControlEnvelope::new(ControlBody::Event(event)) {
                if let Ok(bytes) = encode_envelope(&envelope) {
                    self.queue.push_back(bytes);
                }
            }
        }
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

    // -----------------------------------------------------------------------
    // Command dispatch (delegation to the engine)
    // -----------------------------------------------------------------------

    fn dispatch_command(&mut self, command: JobCommand) -> Result<(), AdapterError> {
        match command {
            JobCommand::Start { job, input_url } => self.on_start(job, input_url),
            JobCommand::Cancel { job } => {
                self.require_job(&job)?;
                let response = JobResponse::Cancel {
                    job: job.as_str().to_string(),
                };
                self.forward(response)
            }
            JobCommand::Pause { job } => {
                self.require_job(&job)?;
                self.forward(JobResponse::Pause {
                    job: job.as_str().to_string(),
                })
            }
            JobCommand::Resume { job } => {
                self.require_job(&job)?;
                self.forward(JobResponse::Resume {
                    job: job.as_str().to_string(),
                })
            }
            JobCommand::ProvideResource {
                job,
                request,
                buffer,
            } => self.on_provide_resource(job, request.as_str(), &buffer),
            JobCommand::ProvideFetchFailure {
                job,
                request,
                error,
            } => self.on_fetch_failure(job, request.as_str(), error),
            JobCommand::SelectImage { job, image } => {
                self.require_job(&job)?;
                self.forward(JobResponse::SelectedImage {
                    job: job.as_str().to_string(),
                    image: image.as_str().to_string(),
                })
            }
            JobCommand::SelectLevel { job, level } => {
                self.require_job(&job)?;
                self.forward(JobResponse::SelectedLevel {
                    job: job.as_str().to_string(),
                    level: level.as_str().to_string(),
                })
            }
            JobCommand::DestinationResponse {
                job,
                destination,
                granted,
            } => {
                self.require_job(&job)?;
                let response = if granted {
                    JobResponse::DestinationGranted {
                        job: job.as_str().to_string(),
                        destination: destination.as_str().to_string(),
                    }
                } else {
                    JobResponse::DestinationDenied {
                        job: job.as_str().to_string(),
                    }
                };
                self.forward(response)
            }
            JobCommand::RetryReady { job, attempt } => {
                self.require_job(&job)?;
                self.forward(JobResponse::RetryReady {
                    job: job.as_str().to_string(),
                    attempt: attempt.as_str().to_string(),
                })
            }
            JobCommand::PartialChoice {
                job,
                recovery,
                keep_partial,
            } => {
                self.require_job(&job)?;
                if self.pending_recovery.as_deref() != Some(recovery.as_str()) {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "partial choice does not match the outstanding recovery",
                    ));
                }
                self.forward(JobResponse::PartialKeep {
                    job: job.as_str().to_string(),
                    keep: keep_partial,
                })
            }
            // Codec outcomes: the lean engine does not await them; accept and
            // acknowledge so richer replays do not diverge.
            JobCommand::ProvideDecodeOutcome { job, .. }
            | JobCommand::ProvideProcessOutcome { job, .. }
            | JobCommand::ProvideWriteOutcome { job, .. }
            | JobCommand::ProvideEncodeOutcome { job, .. }
            | JobCommand::ProvideFinalizeOutcome { job, .. }
            | JobCommand::ProvidePublicationOutcome { job, .. } => {
                self.require_job(&job)?;
                if self.state.is_terminal() {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        format!("command not accepted in state {}", self.state.as_str()),
                    ));
                }
                Ok(())
            }
        }
    }

    fn require_job(&self, job: &JobId) -> Result<(), AdapterError> {
        match self.job_id.as_ref() {
            Some(bound) if bound == job => Ok(()),
            _ => Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "command job does not match this session",
            )),
        }
    }

    fn require_engine_state(&self, expected: SessionState) -> Result<(), AdapterError> {
        if self.state != expected {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                format!("command not accepted in state {}", self.state.as_str()),
            ));
        }
        Ok(())
    }

    fn forward(&mut self, response: JobResponse) -> Result<(), AdapterError> {
        let outcome = self
            .job
            .as_mut()
            .ok_or_else(|| {
                AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
            })?
            .on_response(response)
            .map_err(Self::engine_error)?;
        let _ = outcome;
        self.absorb()
    }

    fn on_start(&mut self, job: JobId, input_url: String) -> Result<(), AdapterError> {
        self.require_engine_state(SessionState::Created)?;
        if input_url.is_empty()
            || input_url.len() > 2048
            || !(input_url.starts_with("https://") || input_url.starts_with("http://"))
        {
            return Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                "start requires an http(s) input_url up to 2048 bytes",
            ));
        }
        // Probe-driven planning stays disabled: the session host never
        // observes tile geometry, so the engine must fail those levels with
        // a typed `job.probe-unsupported` error instead of probing.
        let engine = EngineJob::new(
            job.as_str(),
            &input_url,
            dezoomify_job::Config {
                plan_probes: false,
                ..dezoomify_job::Config::default()
            },
        )
        .map_err(Self::engine_error)?;
        self.job_id = Some(job);
        self.job = Some(engine);
        // Start emits the Discovering state event plus one acquire-resource
        // effect per outstanding discovery request; nothing here echoes the
        // URL anywhere.
        let started = self
            .job
            .as_mut()
            .ok_or_else(|| {
                AdapterError::new(
                    AdapterErrorCode::WrongState,
                    "internal: job missing after bind",
                )
            })?
            .start()
            .map_err(Self::engine_error)?;
        debug_assert!(matches!(started, Outcome::Applied));
        self.absorb()
    }

    fn on_provide_resource(
        &mut self,
        job: JobId,
        request: &str,
        buffer: &dezoomify_protocol::dto::BufferHandle,
    ) -> Result<(), AdapterError> {
        self.require_job(&job)?;
        // Correlate before touching any state: unknown request ids are
        // atomic rejections.
        let tile = if self.outstanding_tile_requests.contains_key(request) {
            Some(self.outstanding_tile_requests[request].clone())
        } else if self.live_discovery_requests.contains(request) {
            None
        } else {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "resource does not match an outstanding request",
            ));
        };
        // Resolve before mutating anything: stale or unsealed references are
        // atomic rejections.
        let handle = self.arena.resolve_protocol(buffer)?;
        match tile {
            Some(tile_id) => {
                self.require_engine_state(SessionState::AcquiringTiles)?;
                // Tile bytes are never retained: hosts decode during
                // acquisition and hold their own decoded tile, so the arena
                // copy is released as soon as the outcome settles. Empty
                // bytes forward a failed outcome so the engine can retry
                // honestly.
                let ok = buffer.length > 0;
                if ok {
                    self.arena.take_buffer(handle)?;
                }
                self.outstanding_tile_requests.remove(request);
                self.forward(JobResponse::TileOutcome {
                    job: job.as_str().to_string(),
                    tile: tile_id,
                    ok,
                })
            }
            None => {
                self.require_engine_state(SessionState::Discovering)?;
                // Exactly-once consumption: a replayed reference is stale
                // afterwards. The engine takes the real bytes; a zero-length
                // resource fails the job (job.empty-resource) and empty
                // metadata can never yield a fake success.
                let bytes = self.arena.take_buffer(handle)?;
                self.live_discovery_requests.remove(request);
                self.forward(JobResponse::ResourceBytes {
                    job: job.as_str().to_string(),
                    request: request.to_string(),
                    bytes,
                    // The browser never reports the post-redirect URL, so the
                    // engine keeps resolving against the request URI here.
                    // Native hosts supply it; web behavior is unchanged.
                    final_uri: None,
                })
            }
        }
    }

    fn on_fetch_failure(
        &mut self,
        job: JobId,
        request: &str,
        error: ErrorDto,
    ) -> Result<(), AdapterError> {
        self.require_job(&job)?;
        let tile = if let Some(tile_id) = self.outstanding_tile_requests.get(request) {
            Some(tile_id.clone())
        } else if self.live_discovery_requests.contains(request) {
            None
        } else {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "failure does not match an outstanding request",
            ));
        };
        match tile {
            Some(tile_id) => {
                self.require_engine_state(SessionState::AcquiringTiles)?;
                self.outstanding_tile_requests.remove(request);
                self.forward(JobResponse::TileOutcome {
                    job: job.as_str().to_string(),
                    tile: tile_id,
                    ok: false,
                })
            }
            None => {
                self.require_engine_state(SessionState::Discovering)?;
                self.live_discovery_requests.remove(request);
                let _ = error;
                self.forward(JobResponse::FetchFailure {
                    job: job.as_str().to_string(),
                    request: request.to_string(),
                })
            }
        }
    }

    fn engine_error(error: EngineJobError) -> AdapterError {
        let code = match error.code.as_str() {
            "job.wrong-job" | "job.post-terminal" | "job.invalid-state" => {
                AdapterErrorCode::WrongState
            }
            "job.invalid-id" | "job.invalid-config" => AdapterErrorCode::Malformed,
            "job.resource-limit" | "job.overflow" => AdapterErrorCode::LimitExceeded,
            _ => AdapterErrorCode::WrongState,
        };
        AdapterError::new(code, error.message)
    }

    // -----------------------------------------------------------------------
    // Engine -> adapter projection
    // -----------------------------------------------------------------------

    /// Drain the engine's effects and events and enqueue their typed
    /// protocol projections in engine `seq` order.
    fn absorb(&mut self) -> Result<(), AdapterError> {
        let job = self.job.as_mut().ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
        })?;
        let mut effects = job.drain_effects();
        let mut events = job.drain_events();
        let mut merged: Vec<serde_json::Value> = Vec::new();
        merged.append(&mut effects);
        merged.append(&mut events);
        merged.sort_by_key(|value| value.get("seq").and_then(serde_json::Value::as_u64));
        for value in &merged {
            let kind = value
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            match kind {
                "job-state" | "catalog" | "progress" | "warning" | "recovery-requested"
                | "missing-work" | "levels" | "completed" | "partial-completed" | "failed"
                | "cancelled" | "paused" | "resumed" => self.enqueue_event(kind, value)?,
                _ => self.enqueue_effect(kind, value)?,
            }
        }
        if let Some(job) = self.job.as_ref() {
            self.state = SessionState::from_engine(job.state());
        }
        Ok(())
    }

    fn mint_tile_request(&mut self, tile: &str) -> String {
        let id = format!("req:tile-{}", self.next_tile_request);
        self.next_tile_request += 1;
        self.outstanding_tile_requests
            .insert(id.clone(), tile.to_string());
        id
    }

    fn enqueue_effect(
        &mut self,
        kind: &str,
        value: &serde_json::Value,
    ) -> Result<(), AdapterError> {
        let job_id = self.job_id.clone().ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
        })?;
        let effect = value
            .get("effect")
            .and_then(serde_json::Value::as_str)
            .and_then(EffectId::new)
            .ok_or_else(|| {
                AdapterError::new(AdapterErrorCode::Malformed, "engine effect lacks an id")
            })?;
        let body = match kind {
            "acquire-resource" => {
                let request = self.project_discovery_request(value)?;
                self.live_discovery_requests
                    .insert(request.id.as_str().to_string());
                HostEffect::AcquireResource {
                    effect,
                    job: job_id,
                    request,
                }
            }
            "acquire-tile" => {
                let tile = value
                    .get("tile")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let uri = value
                    .get("uri")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let headers = value
                    .get("headers")
                    .and_then(|headers| {
                        headers.as_object().map(|map| {
                            map.iter()
                                .map(|(name, val)| HeaderDto {
                                    name: name.clone(),
                                    value: val.as_str().unwrap_or("").to_string(),
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .unwrap_or_default();
                let request = RequestDto {
                    id: RequestId::new(self.mint_tile_request(&tile)).ok_or_else(|| {
                        AdapterError::new(AdapterErrorCode::Malformed, "tile request id")
                    })?,
                    uri,
                    headers,
                    purpose: RequestPurpose::Tile,
                };
                HostEffect::AcquireTile {
                    effect,
                    job: job_id,
                    request,
                    tile: TileId::new(tile).ok_or_else(|| {
                        AdapterError::new(AdapterErrorCode::Malformed, "engine tile id")
                    })?,
                    placement: Self::project_placement(value)?,
                }
            }
            "request-destination" => HostEffect::RequestDestination {
                effect,
                job: job_id,
                format: value
                    .get("format")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("png")
                    .to_string(),
            },
            "decode-pixels" => {
                let tile = value
                    .get("tile")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                HostEffect::DecodePixels {
                    effect,
                    job: job_id,
                    tile: TileId::new(tile).ok_or_else(|| {
                        AdapterError::new(AdapterErrorCode::Malformed, "engine tile id")
                    })?,
                }
            }
            "open-encoder" => HostEffect::OpenEncoder {
                effect,
                job: job_id,
                format: value
                    .get("format")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("png")
                    .to_string(),
                canvas: Self::project_size(value.get("canvas")),
            },
            "finalize-encoder" => HostEffect::FinalizeEncoder {
                effect,
                job: job_id,
            },
            "publish-output" => HostEffect::PublishOutput {
                effect,
                job: job_id,
                output: OutputId::new(
                    value
                        .get("output")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("out:0"),
                )
                .ok_or_else(|| {
                    AdapterError::new(AdapterErrorCode::Malformed, "engine output id")
                })?,
            },
            "release-bytes" => HostEffect::ReleaseBytes {
                effect,
                job: job_id,
            },
            "cancel-work" => HostEffect::CancelWork {
                effect,
                job: job_id,
            },
            "request-decision" => {
                let recovery = value
                    .get("recovery")
                    .and_then(serde_json::Value::as_str)
                    .and_then(RecoveryId::new)
                    .ok_or_else(|| {
                        AdapterError::new(AdapterErrorCode::Malformed, "engine recovery id")
                    })?;
                self.pending_recovery = Some(recovery.as_str().to_string());
                HostEffect::RequestDecision {
                    effect,
                    job: job_id,
                    recovery,
                }
            }
            other => {
                return Err(AdapterError::new(
                    AdapterErrorCode::Malformed,
                    format!("unknown engine effect kind {other}"),
                ));
            }
        };
        self.enqueue(ControlBody::Effect(body))
    }

    /// Project the engine's tile placement JSON (`destination`,
    /// `expected_size`, `canvas`, `processing`) onto the protocol DTO.
    fn project_placement(value: &serde_json::Value) -> Result<TilePlacementDto, AdapterError> {
        let point = |field: &str| -> Result<PointDto, AdapterError> {
            let raw = value.get(field).ok_or_else(|| {
                AdapterError::new(
                    AdapterErrorCode::Malformed,
                    "tile placement lacks destination",
                )
            })?;
            let x = raw
                .get("x")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    AdapterError::new(AdapterErrorCode::Malformed, "tile placement x")
                })?;
            let y = raw
                .get("y")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    AdapterError::new(AdapterErrorCode::Malformed, "tile placement y")
                })?;
            Ok(PointDto { x, y })
        };
        Ok(TilePlacementDto {
            position: point("destination")?,
            expected_size: Self::project_size_x_y(value.get("expected_size")),
            canvas: Self::project_size_x_y(value.get("canvas")),
            processing: value
                .get("processing")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("none")
                .to_string(),
        })
    }

    /// Project an engine `{"x","y"}` size (or JSON null) onto `SizeDto`.
    fn project_size_x_y(value: Option<&serde_json::Value>) -> Option<SizeDto> {
        let raw = value?;
        if raw.is_null() {
            return None;
        }
        let width = raw.get("x").and_then(serde_json::Value::as_u64)?;
        let height = raw.get("y").and_then(serde_json::Value::as_u64)?;
        Some(SizeDto { width, height })
    }

    /// Project an engine open-encoder `canvas` field onto `SizeDto`.
    fn project_size(value: Option<&serde_json::Value>) -> Option<SizeDto> {
        Self::project_size_x_y(value)
    }

    fn project_discovery_request(
        &self,
        value: &serde_json::Value,
    ) -> Result<RequestDto, AdapterError> {
        let id = value
            .get("request")
            .and_then(serde_json::Value::as_str)
            .and_then(RequestId::new)
            .ok_or_else(|| AdapterError::new(AdapterErrorCode::Malformed, "engine request id"))?;
        let purpose = match value
            .get("purpose")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("metadata")
        {
            "tile" => RequestPurpose::Tile,
            "probe" => RequestPurpose::Probe,
            _ => RequestPurpose::Metadata,
        };
        Ok(RequestDto {
            id,
            uri: value
                .get("uri")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            headers: Vec::new(),
            purpose,
        })
    }

    fn enqueue_event(&mut self, kind: &str, value: &serde_json::Value) -> Result<(), AdapterError> {
        let job_id = self.job_id.clone().ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
        })?;
        let event = match kind {
            "job-state" => JobEvent::JobState {
                job: job_id,
                state: value
                    .get("state")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            },
            "catalog" => JobEvent::Catalog {
                job: job_id,
                catalog: self.project_catalog(value)?,
            },
            // "levels" is folded into the catalog projection; the lean
            // engine emits both and the DTO has no separate levels event.
            "levels" => return Ok(()),
            "progress" => JobEvent::Progress {
                job: job_id,
                acquired: value
                    .get("acquired")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                total: value
                    .get("total")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            },
            "warning" | "missing-work" => JobEvent::Warning {
                job: job_id,
                error: self.project_warning(kind, value),
            },
            "recovery-requested" => {
                let recovery = self
                    .pending_recovery
                    .clone()
                    .and_then(RecoveryId::new)
                    .ok_or_else(|| AdapterError::new(AdapterErrorCode::Malformed, "recovery id"))?;
                let reason = value
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                JobEvent::RecoveryRequest {
                    job: job_id,
                    recovery,
                    actions: vec![RecoveryAction {
                        id: "retry".to_string(),
                        kind: RecoveryKind::Retry,
                        scope: reason.clone(),
                        rationale: format!("Retry the {reason} step"),
                    }],
                }
            }
            "completed" => JobEvent::Completed {
                job: job_id,
                output: Self::project_output(value)?,
            },
            "partial-completed" => JobEvent::PartialCompleted {
                job: job_id,
                output: Self::project_output(value)?,
            },
            "failed" => JobEvent::Failed {
                job: job_id,
                error: ErrorDto::new(
                    value
                        .get("code")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("job.failed"),
                    ErrorPhase::Discovery,
                    value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(""),
                ),
            },
            "cancelled" => JobEvent::Cancelled { job: job_id },
            "paused" => JobEvent::Paused { job: job_id },
            "resumed" => JobEvent::Resumed { job: job_id },
            other => {
                return Err(AdapterError::new(
                    AdapterErrorCode::Malformed,
                    format!("unknown engine event kind {other}"),
                ));
            }
        };
        self.enqueue(ControlBody::Event(event))
    }

    fn project_catalog(&self, value: &serde_json::Value) -> Result<CatalogDto, AdapterError> {
        // The engine emits the real projected catalog: a `CatalogDto`-shaped
        // payload with stable wire ids, geometry, and readiness.
        serde_json::from_value(value.clone()).map_err(|detail| {
            AdapterError::new(
                AdapterErrorCode::Malformed,
                format!(
                    "engine catalog does not project: {}",
                    redact(&detail.to_string())
                ),
            )
        })
    }

    fn project_warning(&self, kind: &str, value: &serde_json::Value) -> ErrorDto {
        if kind == "missing-work" {
            let mut error = ErrorDto::new(
                "job.missing-tiles",
                ErrorPhase::Acquisition,
                format!(
                    "tiles failed: {}",
                    value
                        .get("failed")
                        .map(serde_json::Value::to_string)
                        .unwrap_or_default()
                ),
            );
            error.retryable = true;
            error
        } else {
            let tile = value
                .get("tile")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("tile:?");

            let attempt = value
                .get("attempt")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let mut error = ErrorDto::new(
                "job.tile-retry",
                ErrorPhase::Acquisition,
                format!("tile {tile} failed; retry attempt {attempt}"),
            );
            error.retryable = true;
            error
        }
    }

    fn project_output(value: &serde_json::Value) -> Result<OutputId, AdapterError> {
        OutputId::new(
            value
                .get("output")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("out:0"),
        )
        .ok_or_else(|| AdapterError::new(AdapterErrorCode::Malformed, "engine output id"))
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::messages_to_json_array;

    fn start_bytes(job: &str) -> Vec<u8> {
        let command = JobCommand::Start {
            job: job.parse().unwrap(),
            input_url: "https://example.com/image.dzi".to_string(),
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
    fn start_delegates_to_engine_and_emits_fifo() {
        let mut session = Session::new("1.0", "{}").unwrap();
        session.dispatch(&start_bytes("job:basic-1")).unwrap();
        assert_eq!(session.state(), SessionState::Discovering);
        let messages = session.drain_messages();
        assert_eq!(messages.len(), 2);
        let transcript = messages_to_json_array(&messages).unwrap();
        assert!(transcript.contains("job-state"));
        assert!(transcript.contains("acquire-resource"));
        assert!(transcript.contains("Discovering"));
        assert!(session.drain_messages().is_empty());
    }
}
