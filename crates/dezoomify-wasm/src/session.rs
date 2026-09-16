//! One-session job owner: version/config validation, canonical dispatch,
//! FIFO message draining, buffer lifecycle, one pure processing op, disposal.
//!
//! ## Real job-engine delegation
//!
//! [`Session`] owns a [`dezoomify_job::Job`] and delegates the whole
//! lifecycle to it. The adapter projects the engine's single typed FIFO
//! queue onto typed protocol messages encoded by
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
//!   numeric request sequence plus the tile's complete output placement
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
//!   `PartialChoice` must reference the outstanding numeric decision generation.
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
use dezoomify_core::core::discovery::{FetchCause, FetchCode, TransportKind};
use dezoomify_job::{
    DecisionReason, Job as EngineJob, JobCommand as EngineCommand, JobEffect as EngineEffect,
    JobError as EngineJobError, JobEvent as EngineEvent, JobMessageBody, Outcome,
};
use dezoomify_protocol::dto::{
    negotiate_version, ControlBody, ControlEnvelope, ErrorDto, ErrorPhase, HeaderDto, HostEffect,
    JobCommand, JobEvent, PointDto, RecoveryAction, RecoveryKind, RequestDto, RequestPurpose,
    SizeDto, TilePlacementDto,
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
    state: SessionState,
    disposed: bool,
    max_messages: usize,
    /// Outstanding discovery request ids from acquire-resource effects.
    live_discovery_requests: HashSet<u32>,
    /// Adapter-minted tile request id -> engine tile id.
    outstanding_tile_requests: HashMap<u32, u32>,
    /// Recovery id from the latest request-decision effect.
    pending_recovery: Option<u32>,
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
            state: SessionState::Created,
            disposed: false,
            max_messages,
            live_discovery_requests: HashSet::new(),
            outstanding_tile_requests: HashMap::new(),
            pending_recovery: None,
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
                let _ = job.on_command(EngineCommand::Cancel);
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
        self.state = SessionState::Cancelled;
        let event = JobEvent::Cancelled;
        if let Ok(envelope) = ControlEnvelope::new(ControlBody::Event(event)) {
            if let Ok(bytes) = encode_envelope(&envelope) {
                self.queue.push_back(bytes);
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
            JobCommand::Start { input_url } => self.on_start(input_url),
            JobCommand::Cancel => self.forward(EngineCommand::Cancel),
            JobCommand::Pause => self.forward(EngineCommand::Pause),
            JobCommand::Resume => self.forward(EngineCommand::Resume),
            JobCommand::ProvideResource { request, buffer } => {
                self.on_provide_resource(request, &buffer)
            }
            JobCommand::ProvideFetchFailure { request, error } => {
                self.on_fetch_failure(request, error)
            }
            JobCommand::SelectImage { image } => self.forward(EngineCommand::SelectImage { image }),
            JobCommand::SelectLevel { level } => self.forward(EngineCommand::SelectLevel { level }),
            JobCommand::DestinationResponse { granted } => {
                let response = if granted {
                    EngineCommand::DestinationGranted
                } else {
                    EngineCommand::DestinationDenied
                };
                self.forward(response)
            }
            JobCommand::RetryReady => self.forward(EngineCommand::RetryReady),
            JobCommand::PartialChoice {
                generation,
                keep_partial,
            } => {
                if self.pending_recovery != Some(generation) {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "partial choice does not match the outstanding recovery",
                    ));
                }
                self.forward(EngineCommand::PartialChoice {
                    generation,
                    keep: keep_partial,
                })
            }
            // Codec outcomes: the lean engine does not await them; accept and
            // acknowledge so richer replays do not diverge.
            JobCommand::ProvideDecodeOutcome { .. }
            | JobCommand::ProvideProcessOutcome { .. }
            | JobCommand::ProvideWriteOutcome { .. }
            | JobCommand::ProvideEncodeOutcome { .. }
            | JobCommand::ProvideFinalizeOutcome { .. }
            | JobCommand::ProvidePublicationOutcome { .. } => {
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

    fn require_engine_state(&self, expected: SessionState) -> Result<(), AdapterError> {
        if self.state != expected {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                format!("command not accepted in state {}", self.state.as_str()),
            ));
        }
        Ok(())
    }

    fn forward(&mut self, response: EngineCommand) -> Result<(), AdapterError> {
        let outcome = self
            .job
            .as_mut()
            .ok_or_else(|| {
                AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
            })?
            .on_command(response)
            .map_err(Self::engine_error)?;
        let _ = outcome;
        self.absorb()
    }

    fn on_start(&mut self, input_url: String) -> Result<(), AdapterError> {
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
            &input_url,
            dezoomify_job::Config {
                plan_probes: false,
                ..dezoomify_job::Config::default()
            },
        )
        .map_err(Self::engine_error)?;
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
        request: u32,
        buffer: &dezoomify_protocol::dto::BufferHandle,
    ) -> Result<(), AdapterError> {
        // Correlate before touching any state: unknown request ids are
        // atomic rejections.
        let tile = if self.outstanding_tile_requests.contains_key(&request) {
            Some(self.outstanding_tile_requests[&request])
        } else if self.live_discovery_requests.contains(&request) {
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
                self.outstanding_tile_requests.remove(&request);
                self.forward(EngineCommand::TileOutcome { tile: tile_id, ok })
            }
            None => {
                // Exactly-once consumption: a replayed reference is stale
                // afterwards. The engine takes the real bytes; a zero-length
                // resource fails the job (job.empty-resource) and empty
                // metadata can never yield a fake success.
                let bytes = self.arena.take_buffer(handle)?;
                self.live_discovery_requests.remove(&request);
                // Discovery is intentionally concurrent. A sibling metadata
                // fetch may finish after another candidate has already
                // produced the catalog and advanced the job into selection,
                // planning, or tile acquisition. The job engine treats that
                // response as ignored; the adapter must consume the buffer
                // and preserve that same stale-response behavior instead of
                // turning normal fetch reordering into a session failure.
                if self.state != SessionState::Discovering {
                    return Ok(());
                }
                self.forward(EngineCommand::ResourceBytes {
                    request,
                    bytes,
                    // The browser never reports the post-redirect URL, so the
                    // engine keeps resolving against the request URI here.
                    // Native hosts supply it; web behavior is unchanged.
                    final_uri: None,
                })
            }
        }
    }

    fn on_fetch_failure(&mut self, request: u32, error: ErrorDto) -> Result<(), AdapterError> {
        let tile = if let Some(tile_id) = self.outstanding_tile_requests.get(&request) {
            Some(*tile_id)
        } else if self.live_discovery_requests.contains(&request) {
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
                self.outstanding_tile_requests.remove(&request);
                self.forward(EngineCommand::TileOutcome {
                    tile: tile_id,
                    ok: false,
                })
            }
            None => {
                self.live_discovery_requests.remove(&request);
                // A late sibling failure is also a normal consequence of
                // concurrent discovery after another candidate has won.
                if self.state != SessionState::Discovering {
                    return Ok(());
                }
                // Forward the typed cause so the engine groups discovery
                // diagnostics on `(kind, cause)`, never on rendered text.
                // Host message text stays out of the engine entirely:
                // nothing free-form crosses, so there is nothing to
                // redact or bound here. The full request URL is named by
                // the host itself, outside the engine block.
                let cause = FetchCause {
                    code: FetchCode::from_string(error.code.clone()),
                    http: None,
                    transport: TransportKind::from_wire(error.transport.as_deref()),
                    reason: None,
                };
                self.forward(EngineCommand::FetchFailure { request, cause })
            }
        }
    }

    fn engine_error(error: EngineJobError) -> AdapterError {
        let code = match error.code.as_str() {
            "job.post-terminal" | "job.invalid-state" => AdapterErrorCode::WrongState,
            "job.invalid-config" => AdapterErrorCode::Malformed,
            "job.resource-limit" | "job.overflow" => AdapterErrorCode::LimitExceeded,
            _ => AdapterErrorCode::WrongState,
        };
        AdapterError::new(code, error.message)
    }

    // -----------------------------------------------------------------------
    // Engine -> adapter projection
    // -----------------------------------------------------------------------

    /// Drain the engine's already ordered typed queue and project each item
    /// onto the protocol without JSON inspection or string-kind switching.
    fn absorb(&mut self) -> Result<(), AdapterError> {
        let messages = self
            .job
            .as_mut()
            .ok_or_else(|| {
                AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
            })?
            .drain_messages();
        for message in messages {
            let body = match message.body {
                JobMessageBody::Effect(effect) => {
                    ControlBody::Effect(self.project_effect(message.sequence, effect)?)
                }
                JobMessageBody::Event(event) => match self.project_event(event) {
                    Some(event) => ControlBody::Event(event),
                    None => continue,
                },
            };
            self.enqueue(body)?;
        }
        if let Some(job) = self.job.as_ref() {
            self.state = SessionState::from_engine(job.state());
        }
        Ok(())
    }

    fn project_effect(
        &mut self,
        sequence: u32,
        effect: EngineEffect,
    ) -> Result<HostEffect, AdapterError> {
        Ok(match effect {
            EngineEffect::AcquireResource { request, uri, .. } => {
                self.live_discovery_requests.insert(request);
                HostEffect::AcquireResource {
                    request: RequestDto {
                        id: request,
                        uri,
                        headers: Vec::new(),
                        purpose: RequestPurpose::Metadata,
                    },
                }
            }
            EngineEffect::AcquireTile {
                tile,
                uri,
                headers,
                processing,
                destination,
                expected_size,
                canvas,
                probe,
            } => {
                let request = sequence;
                self.outstanding_tile_requests.insert(request, tile);
                HostEffect::AcquireTile {
                    request: RequestDto {
                        id: request,
                        uri,
                        headers: headers
                            .into_iter()
                            .map(|(name, value)| HeaderDto { name, value })
                            .collect(),
                        purpose: if probe {
                            RequestPurpose::Probe
                        } else {
                            RequestPurpose::Tile
                        },
                    },
                    tile,
                    placement: TilePlacementDto {
                        position: PointDto {
                            x: u64::from(destination.x),
                            y: u64::from(destination.y),
                        },
                        expected_size: expected_size.map(|size| SizeDto {
                            width: u64::from(size.x),
                            height: u64::from(size.y),
                        }),
                        canvas: canvas.map(|size| SizeDto {
                            width: u64::from(size.x),
                            height: u64::from(size.y),
                        }),
                        processing,
                    },
                }
            }
            EngineEffect::RequestDestination { format } => {
                HostEffect::RequestDestination { format }
            }
            EngineEffect::DecodePixels { tile } => HostEffect::DecodePixels { tile },
            EngineEffect::OpenEncoder { format, canvas } => HostEffect::OpenEncoder {
                format,
                canvas: canvas.map(|size| SizeDto {
                    width: u64::from(size.x),
                    height: u64::from(size.y),
                }),
            },
            EngineEffect::FinalizeEncoder => HostEffect::FinalizeEncoder,
            EngineEffect::PublishOutput => HostEffect::PublishOutput,
            EngineEffect::ReleaseBytes => HostEffect::ReleaseBytes,
            EngineEffect::CancelWork => HostEffect::CancelWork,
            EngineEffect::RequestDecision { generation, .. } => {
                self.pending_recovery = Some(generation);
                HostEffect::RequestDecision { generation }
            }
        })
    }

    fn project_event(&self, event: EngineEvent) -> Option<JobEvent> {
        Some(match event {
            EngineEvent::State { state } => JobEvent::JobState {
                state: state.name().to_string(),
            },
            EngineEvent::Catalog { catalog } => JobEvent::Catalog { catalog },
            EngineEvent::Levels { .. } => return None,
            EngineEvent::Progress { acquired, total } => JobEvent::Progress { acquired, total },
            EngineEvent::Warning { tile, attempt } => {
                let mut error = ErrorDto::new(
                    "job.tile-retry",
                    ErrorPhase::Acquisition,
                    format!("tile {tile} failed; retry attempt {attempt}"),
                );
                error.retryable = true;
                JobEvent::Warning { error }
            }
            EngineEvent::MissingWork { failed } => {
                let mut error = ErrorDto::new(
                    "job.missing-tiles",
                    ErrorPhase::Acquisition,
                    format!("tiles failed: {failed:?}"),
                );
                error.retryable = true;
                JobEvent::Warning { error }
            }
            EngineEvent::RecoveryRequested { generation, reason } => {
                let scope = match reason {
                    DecisionReason::Destination => "destination",
                    DecisionReason::Partial => "partial",
                };
                JobEvent::RecoveryRequest {
                    generation,
                    actions: vec![RecoveryAction {
                        id: "retry".to_string(),
                        kind: RecoveryKind::Retry,
                        scope: scope.to_string(),
                        rationale: format!("Retry the {scope} step"),
                    }],
                }
            }
            EngineEvent::Completed => JobEvent::Completed,
            EngineEvent::PartialCompleted => JobEvent::PartialCompleted,
            EngineEvent::Failed { code, message } => JobEvent::Failed {
                error: ErrorDto::new(code, ErrorPhase::Discovery, message),
            },
            EngineEvent::Cancelled => JobEvent::Cancelled,
            EngineEvent::Paused => JobEvent::Paused,
            EngineEvent::Resumed => JobEvent::Resumed,
        })
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

    fn start_bytes(_job: &str) -> Vec<u8> {
        let command = JobCommand::Start {
            input_url: "https://example.com/image.dzi".to_string(),
        };
        let envelope = ControlEnvelope::new(ControlBody::Command(command)).unwrap();
        encode_envelope(&envelope).unwrap()
    }

    #[test]
    fn version_negotiation_precedes_work() {
        assert!(Session::new("2.0", "{}").is_ok());
        assert!(Session::new("1", "{}").is_err());
        let error = Session::new("1.0", "{}").unwrap_err();
        assert_eq!(error.code(), AdapterErrorCode::VersionUnsupported);
    }

    #[test]
    fn malformed_dispatch_leaves_session_untouched() {
        let mut session = Session::new("2.0", "{}").unwrap();
        let error = session.dispatch(b"{not json}").unwrap_err();
        assert_eq!(error.code(), AdapterErrorCode::Malformed);
        assert_eq!(session.state(), SessionState::Created);
        assert!(session.drain_messages().is_empty());
    }

    #[test]
    fn start_delegates_to_engine_and_emits_fifo() {
        let mut session = Session::new("2.0", "{}").unwrap();
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
