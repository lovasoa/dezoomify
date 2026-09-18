//! One-session job owner: typed configuration and dispatch, buffer lifecycle,
//! one pure processing operation, and disposal.
//!
//! ## Real job-engine delegation
//!
//! [`Session`] owns a [`dezoomify_job::Job`] and delegates the whole
//! lifecycle to it. The adapter projects the engine's single typed FIFO
//! queue directly onto generated ABI contract values.
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
//! * Probe observations: each `acquire-tile` with `purpose: probe` is
//!   answered with `ProvideProbeOutcome` (request id plus a discriminated
//!   available/missing observation) and forwarded as the engine `ProbeOutcome`.
//!   Probe bytes are measured by the host and never retained.
//! * Display-only tiles: `ProvideDisplayOutcome` answers a tile that the
//!   host holds as an ordinary image (no readable bytes) with a successful
//!   tile outcome; the tainted output completes as display-only downstream.
//! * Late host answers: a host fetch may settle after the engine left its
//!   phase (a sibling's retry exhaustion can move it to
//!   AwaitingPartialDecision, cancellation can end it, Keep can start
//!   finalizing). The adapter only correlates: it consumes the arena slot
//!   exactly once, drops the correlation, and forwards. The engine owns
//!   acceptance: it processes outcomes for work it still awaits (its
//!   in-flight bookkeeping spans phase transitions and it never re-emits
//!   in-flight tiles) and ignores the rest, exactly as it ignores late
//!   sibling discovery replies.
//! * `ProvideFetchFailure` maps to `FetchFailure` (discovery request), a
//!   failed `TileOutcome` (tile request), or a missing `ProbeOutcome`
//!   (probe request).
//! * Decisions: `SelectImage`, `SelectLevel`, and `RecoveryChoice` map 1:1
//!   onto engine responses. `RecoveryChoice` must reference the outstanding
//!   numeric decision generation.
//! * `FinalizationSucceeded` and `FinalizationFailed` complete the one
//!   awaited `finalize-output` effect.
//! * `CancelWork` instructs the host to close its own retained resources.
//!
//! Engine resources beyond this model are engine limitations, not adapter
//! limits: byte lengths pass through, never fabricated. Probe-driven levels
//! plan through the same core probe step machine as native hosts; the host
//! reports each probe observation and the engine resolves the plan.
//! Empty discovery resources fail the job via the engine
//! (`job.empty-resource`); nothing here can fake completion.

use crate::buffer::{ArenaHandle, ByteArena, MAX_BUFFERS, MAX_BUFFER_BYTES, MAX_TOTAL_BYTES};
use crate::error::{AdapterError, AdapterErrorCode};
use dezoomify_core::core::discovery::{FetchCause, FetchCode, PolicyReason, TransportKind};
use dezoomify_job::{
    Job as EngineJob, JobCommand as EngineCommand, JobEffect as EngineEffect,
    JobError as EngineJobError, JobEvent as EngineEvent, JobMessageBody, Outcome,
    RecoveryChoice as EngineRecoveryChoice,
};
use dezoomify_protocol::dto::{
    ErrorDto, ErrorPhase, ErrorTransport, FetchFailureDto, HeaderDto, HostEffect, HostMessage,
    JobCommand, JobEvent, JobState as ProtocolJobState, PointDto, ProbeOutcome, ProcessingRecipe,
    RecoveryAction, RecoveryChoice, RecoveryKind, RequestDto, RequestPurpose, ResourceKind,
    SessionConfig, SizeDto, TilePlacementDto,
};
use std::collections::{HashMap, HashSet};

/// Hard per-buffer ceiling (32 MiB); requested caps above this are rejected.
pub const HARD_MAX_BUFFER_BYTES: u64 = 32 << 20;
/// Hard session-total ceiling (256 MiB).
pub const HARD_MAX_TOTAL_BYTES: u64 = 256 << 20;
/// Hard live-buffer ceiling.
pub const HARD_MAX_BUFFERS: usize = 4096;

/// Default per-buffer cap (browser baseline `max_tile_bytes`, 8 MiB).
pub const DEFAULT_MAX_BUFFER_BYTES: u64 = MAX_BUFFER_BYTES;
/// Default session-total cap (64 MiB).
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = MAX_TOTAL_BYTES;
/// Default live-buffer cap.
pub const DEFAULT_MAX_BUFFERS: usize = MAX_BUFFERS;

/// Session lifecycle state, projected 1:1 from the engine state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SessionState {
    Created,
    Discovering,
    AwaitingImageSelection,
    AwaitingLevelSelection,
    Planning,
    AcquiringTiles,
    AwaitingPartialDecision,
    Finalizing,
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
            Self::Planning => "Planning",
            Self::AcquiringTiles => "AcquiringTiles",
            Self::AwaitingPartialDecision => "AwaitingPartialDecision",
            Self::Finalizing => "Finalizing",
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
            S::Planning => Self::Planning,
            S::AcquiringTiles => Self::AcquiringTiles,
            S::AwaitingPartialDecision => Self::AwaitingPartialDecision,
            S::Finalizing => Self::Finalizing,
            S::Cancelling => Self::Cancelling,
            S::Completed => Self::Completed,
            S::PartiallyCompleted => Self::PartiallyCompleted,
            S::Failed => Self::Failed,
            S::Cancelled => Self::Cancelled,
        }
    }
}

/// One adapter session: exactly one engine job and one byte arena.
#[derive(Debug)]
pub struct Session {
    arena: ByteArena,
    job: Option<EngineJob>,
    job_config: dezoomify_job::Config,
    state: SessionState,
    disposed: bool,
    /// Outstanding discovery request ids from acquire-resource effects.
    live_discovery_requests: HashSet<u32>,
    /// Adapter-minted tile request id -> engine tile id.
    outstanding_tile_requests: HashMap<u32, u32>,
    /// Complete adapter-emitted request context, keyed by its correlation id.
    request_context: HashMap<u32, RequestDto>,
    /// Adapter-minted probe request ids (subset of tile requests emitted
    /// while planning probe-driven levels).
    probe_requests: HashSet<u32>,
    /// Recovery id from the latest request-decision effect.
    pending_recovery: Option<u32>,
    /// The complete browser failure that caused discovery to terminate.
    /// The job engine groups failures by typed cause; the adapter retains
    /// the host context so the terminal event does not discard it.
    terminal_discovery_error: Option<ErrorDto>,
}

impl Session {
    /// Validate the typed quota config, then construct an empty session. No large allocation happens
    /// here; quotas are enforced before any later large allocation.
    ///
    /// # Errors
    ///
    /// `limit-exceeded` for quotas above the hard ceilings. Zero-valued
    /// positive quotas cannot deserialize into [`SessionConfig`].
    pub fn new(config: SessionConfig) -> Result<Self, AdapterError> {
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
        // Optional job-budget overrides; the engine validates them when the
        // job is created, so zero/oversized values fail typed there.
        let mut job_config = dezoomify_job::Config::default();
        if let Some(value) = config.max_concurrent_fetches {
            job_config.max_concurrent_fetches = value.get();
        }
        if let Some(value) = config.max_concurrent_decodes {
            job_config.max_concurrent_decodes = value.get();
        }
        if let Some(value) = config.max_tiles {
            job_config.max_tiles = value.get();
        }
        if let Some(value) = config.max_retries {
            job_config.max_retries = value;
        }
        Ok(Self {
            arena: ByteArena::with_limits(max_buffer_bytes, max_total_bytes, max_buffers),
            job: None,
            job_config,
            state: SessionState::Created,
            disposed: false,
            live_discovery_requests: HashSet::new(),
            outstanding_tile_requests: HashMap::new(),
            request_context: HashMap::new(),
            probe_requests: HashSet::new(),
            pending_recovery: None,
            terminal_discovery_error: None,
        })
    }

    fn quota(
        requested: Option<std::num::NonZeroU64>,
        default: u64,
        hard: u64,
        name: &str,
    ) -> Result<u64, AdapterError> {
        match requested {
            None => Ok(default),
            Some(value) if value.get() > hard => Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!("session quota {name} of {value} exceeds hard ceiling {hard}"),
            )),
            Some(value) => Ok(value.get()),
        }
    }

    fn quota_usize(
        requested: Option<std::num::NonZeroUsize>,
        default: usize,
        hard: usize,
        name: &str,
    ) -> Result<usize, AdapterError> {
        match requested {
            None => Ok(default),
            Some(value) if value.get() > hard => Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!("session quota {name} of {value} exceeds hard ceiling {hard}"),
            )),
            Some(value) => Ok(value.get()),
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

    fn require_live(&self) -> Result<(), AdapterError> {
        if self.disposed {
            return Err(AdapterError::new(
                AdapterErrorCode::Disposed,
                "session is disposed",
            ));
        }
        Ok(())
    }

    /// Run one typed command synchronously and return every resulting host
    /// message in engine order. Rejected input changes no state or buffer.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `wrong-state`/`stale-buffer`/
    /// `limit-exceeded` per transition.
    pub fn dispatch(&mut self, command: JobCommand) -> Result<Vec<HostMessage>, AdapterError> {
        self.require_live()?;
        self.dispatch_command(command)
    }

    /// Cancel the active job through the engine and release adapter
    /// resources. Repeat-safe: later calls succeed without enqueueing
    /// duplicates. Afterwards every operation except repeated disposal fails
    /// with `disposed`.
    pub fn dispose(&mut self) -> Result<Vec<HostMessage>, AdapterError> {
        if self.disposed {
            return Ok(Vec::new());
        }
        self.disposed = true;
        let messages = if let Some(job) = self.job.as_mut() {
            if !job.is_terminal() {
                let _ = job.on_command(EngineCommand::Cancel);
                self.absorb()
                    .unwrap_or_else(|_| self.force_cancelled_event())
            } else {
                Vec::new()
            }
        } else {
            self.force_cancelled_event()
        };
        self.job = None;
        self.arena.clear();
        Ok(messages)
    }

    fn force_cancelled_event(&mut self) -> Vec<HostMessage> {
        self.state = SessionState::Cancelled;
        vec![HostMessage::Event(JobEvent::Cancelled)]
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

    /// Project a live arena handle onto the generated buffer reference.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal, else arena errors (see [`ByteArena`]).
    pub fn buffer_handle(
        &self,
        handle: ArenaHandle,
    ) -> Result<dezoomify_protocol::dto::BufferHandle, AdapterError> {
        self.require_live()?;
        self.arena.to_buffer_handle(handle)
    }

    /// Apply one core processing recipe to fetched tile bytes. Pure: it
    /// touches no job state, so hosts may call it for any acquired tile
    /// (the same recipes the discovery adapter exposes).
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `malformed` for unknown recipes or
    /// processing failures.
    pub fn apply_processing(
        &self,
        recipe: ProcessingRecipe,
        bytes: Vec<u8>,
    ) -> Result<Vec<u8>, AdapterError> {
        self.require_live()?;
        crate::discovery::apply_processing_recipe(recipe, bytes)
    }

    // -----------------------------------------------------------------------
    // Command dispatch (delegation to the engine)
    // -----------------------------------------------------------------------

    fn dispatch_command(&mut self, command: JobCommand) -> Result<Vec<HostMessage>, AdapterError> {
        match command {
            JobCommand::Start { inputs } => self.on_start(inputs),
            JobCommand::Cancel => self.forward(EngineCommand::Cancel),
            JobCommand::Pause => self.forward(EngineCommand::Pause),
            JobCommand::Resume => self.forward(EngineCommand::Resume),
            JobCommand::ProvideResource {
                request,
                buffer,
                final_uri,
            } => self.on_provide_resource(request, &buffer, final_uri),
            JobCommand::ProvideFetchFailure { request, error } => {
                self.on_fetch_failure(request, error)
            }
            JobCommand::ProvideProbeOutcome { request, outcome } => {
                self.on_probe_outcome(request, outcome)
            }
            JobCommand::ProvideDisplayOutcome { request } => self.on_display_outcome(request),
            JobCommand::SelectImage { image } => self.forward(EngineCommand::SelectImage { image }),
            JobCommand::SelectLevel { level } => self.forward(EngineCommand::SelectLevel { level }),
            JobCommand::RecoveryChoice { generation, choice } => {
                if self.pending_recovery != Some(generation) {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "recovery choice does not match the outstanding recovery",
                    ));
                }
                let messages = self.forward(EngineCommand::RecoveryChoice {
                    generation,
                    choice: match choice {
                        RecoveryChoice::Keep => EngineRecoveryChoice::Keep,
                        RecoveryChoice::Retry => EngineRecoveryChoice::Retry,
                        RecoveryChoice::Discard => EngineRecoveryChoice::Discard,
                    },
                })?;
                // The generation is consumed exactly once.
                self.pending_recovery = None;
                Ok(messages)
            }
            JobCommand::FinalizationSucceeded => self.forward(EngineCommand::FinalizationSucceeded),
            JobCommand::FinalizationFailed { error } => {
                self.forward(EngineCommand::FinalizationFailed {
                    code: error.code,
                    message: error.message,
                })
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

    fn forward(&mut self, response: EngineCommand) -> Result<Vec<HostMessage>, AdapterError> {
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

    fn on_start(
        &mut self,
        inputs: Vec<dezoomify_protocol::dto::JobInputDto>,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        self.require_engine_state(SessionState::Created)?;
        if inputs.is_empty()
            || inputs.iter().any(|input| {
                input.url.is_empty()
                    || input.url.len() > 2048
                    || !(input.url.starts_with("https://") || input.url.starts_with("http://"))
            })
        {
            return Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                "start requires a non-empty batch of http(s) inputs up to 2048 bytes each",
            ));
        }
        // Probe-driven levels plan through the engine probe step machine;
        // the host answers each probe effect with an observed size.
        let engine = EngineJob::new_with_inputs(
            inputs
                .into_iter()
                .map(|input| dezoomify_job::JobInput {
                    url: input.url,
                    contents: input.contents.map(String::into_bytes),
                })
                .collect(),
            self.job_config.clone(),
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
        final_uri: Option<String>,
    ) -> Result<Vec<HostMessage>, AdapterError> {
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
        let handle = self.arena.resolve_buffer_handle(buffer)?;
        match tile {
            Some(tile_id) => {
                if self.probe_requests.contains(&request) {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "probe requests are answered with provide-probe-outcome, not provide-resource",
                    ));
                }
                // Tile bytes are never retained: hosts decode during
                // acquisition and hold their own decoded tile, so the arena
                // copy is released as soon as the outcome settles. Empty
                // bytes forward a failed outcome so the engine can retry
                // honestly. The engine owns acceptance: a response that
                // outlived its phase is processed if the engine still
                // awaits the tile, ignored if not.
                let tile_bytes = self.arena.take_buffer(handle)?;
                let ok = !tile_bytes.is_empty();
                self.outstanding_tile_requests.remove(&request);
                self.request_context.remove(&request);
                self.forward(EngineCommand::TileOutcome { tile: tile_id, ok })
            }
            None => {
                // Exactly-once consumption: a replayed reference is stale
                // afterwards. The engine takes the real bytes; a zero-length
                // resource fails the job (job.empty-resource) and empty
                // metadata can never yield a fake success.
                let bytes = self.arena.take_buffer(handle)?;
                self.live_discovery_requests.remove(&request);
                self.request_context.remove(&request);
                // Discovery is intentionally concurrent. A sibling metadata
                // fetch may finish after another candidate has already
                // produced the catalog and advanced the job into selection,
                // planning, or tile acquisition. The job engine treats that
                // response as ignored; the adapter must consume the buffer
                // and preserve that same stale-response behavior instead of
                // turning normal fetch reordering into a session failure.
                if self.state != SessionState::Discovering {
                    return Ok(Vec::new());
                }
                self.forward(EngineCommand::ResourceBytes {
                    request,
                    bytes,
                    // Native hosts report the post-redirect URL; browser
                    // hosts supply it when their fetch exposes one, else the
                    // engine resolves relative tile URLs against the request
                    // URI.
                    final_uri: final_uri.filter(|uri| !uri.is_empty()),
                })
            }
        }
    }

    fn on_probe_outcome(
        &mut self,
        request: u32,
        outcome: ProbeOutcome,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        let tile_id = match self.outstanding_tile_requests.get(&request) {
            Some(tile_id) => *tile_id,
            None => {
                return Err(AdapterError::new(
                    AdapterErrorCode::WrongState,
                    "probe outcome does not match an outstanding request",
                ));
            }
        };
        if !self.probe_requests.contains(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "probe outcome matches a tile request, not a probe request",
            ));
        }
        // The engine owns acceptance: the outstanding probe is processed,
        // a duplicate or late answer for an already-answered probe is
        // ignored, and an answer for a non-probe tile is a fault.
        self.outstanding_tile_requests.remove(&request);
        self.probe_requests.remove(&request);
        self.request_context.remove(&request);
        self.forward(EngineCommand::ProbeOutcome {
            tile: tile_id,
            outcome,
        })
    }

    /// Display-only answer for one outstanding tile request: the host holds
    /// an ordinary image element (no readable bytes) and the engine records
    /// a successful acquisition; the tainted canvas completes as
    /// display-only downstream.
    fn on_display_outcome(&mut self, request: u32) -> Result<Vec<HostMessage>, AdapterError> {
        let tile_id = match self.outstanding_tile_requests.get(&request) {
            Some(tile_id) => *tile_id,
            None => {
                return Err(AdapterError::new(
                    AdapterErrorCode::WrongState,
                    "display outcome does not match an outstanding request",
                ));
            }
        };
        if self.probe_requests.contains(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "probe requests are answered with provide-probe-outcome, not provide-display-outcome",
            ));
        }
        // The engine owns acceptance, exactly as for tile bytes.
        self.outstanding_tile_requests.remove(&request);
        self.request_context.remove(&request);
        self.forward(EngineCommand::TileOutcome {
            tile: tile_id,
            ok: true,
        })
    }

    fn on_fetch_failure(
        &mut self,
        request: u32,
        failure: FetchFailureDto,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        let context = self.request_context.get(&request).cloned().ok_or_else(|| {
            AdapterError::new(
                AdapterErrorCode::WrongState,
                "failure does not match an outstanding request",
            )
        })?;
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
                if self.probe_requests.contains(&request) {
                    // The engine owns acceptance: a failed probe fetch is a
                    // missing observation for the outstanding probe, and
                    // moot (ignored) once the probe is answered.
                    self.outstanding_tile_requests.remove(&request);
                    self.probe_requests.remove(&request);
                    self.request_context.remove(&request);
                    return self.forward(EngineCommand::ProbeOutcome {
                        tile: tile_id,
                        outcome: ProbeOutcome::Missing,
                    });
                }
                // The engine owns acceptance, exactly as for tile bytes.
                self.outstanding_tile_requests.remove(&request);
                self.request_context.remove(&request);
                self.forward(EngineCommand::TileOutcome {
                    tile: tile_id,
                    ok: false,
                })
            }
            None => {
                self.live_discovery_requests.remove(&request);
                self.request_context.remove(&request);
                // A late sibling failure is also a normal consequence of
                // concurrent discovery after another candidate has won. The
                // engine would ignore it, and forwarding must not stamp the
                // adapter's terminal-error slot with a moot cause.
                if self.state != SessionState::Discovering {
                    return Ok(Vec::new());
                }
                // Forward the typed cause so the engine groups discovery
                // diagnostics on `(kind, cause)`, never on rendered text.
                // Host message text stays out of the engine entirely:
                // nothing free-form crosses, so there is nothing to
                // redact or bound here. The full request URL is named by
                // the host itself, outside the engine block.
                let cause = FetchCause {
                    code: FetchCode::from_string(failure.code.clone()),
                    http: failure.http,
                    transport: match failure.transport {
                        ErrorTransport::Direct => TransportKind::Direct,
                        ErrorTransport::MetadataProxy => TransportKind::MetadataProxy,
                        ErrorTransport::BrowserSession => TransportKind::BrowserSession,
                        ErrorTransport::Native => TransportKind::Native,
                        ErrorTransport::DisplayOnly => TransportKind::DisplayOnly,
                    },
                    reason: failure
                        .blocked_reason
                        .map(|reason| PolicyReason::from_string(reason.as_str())),
                };
                self.terminal_discovery_error = Some(ErrorDto {
                    code: failure.code,
                    phase: ErrorPhase::Discovery,
                    retryable: failure.retryable,
                    message: failure.message,
                    recovery: failure.recovery,
                    request: Some(context.uri),
                    transport: Some(failure.transport),
                    blocked_reason: failure.blocked_reason,
                    resource_kind: Some(ResourceKind::Metadata),
                    http: failure.http,
                    preview: failure.preview,
                    detail: failure.detail,
                });
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

    /// Project the engine's already ordered typed messages into ABI values.
    fn absorb(&mut self) -> Result<Vec<HostMessage>, AdapterError> {
        let messages = self
            .job
            .as_mut()
            .ok_or_else(|| {
                AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
            })?
            .drain_messages();
        let mut projected = Vec::with_capacity(messages.len());
        for message in messages {
            let body = match message.body {
                JobMessageBody::Effect(effect) => {
                    HostMessage::Effect(self.project_effect(message.sequence, effect)?)
                }
                JobMessageBody::Event(event) => match self.project_event(event) {
                    Some(event) => HostMessage::Event(event),
                    None => continue,
                },
            };
            projected.push(body);
        }
        if let Some(job) = self.job.as_ref() {
            self.state = SessionState::from_engine(job.state());
        }
        Ok(projected)
    }

    fn project_effect(
        &mut self,
        sequence: u32,
        effect: EngineEffect,
    ) -> Result<HostEffect, AdapterError> {
        Ok(match effect {
            EngineEffect::AcquireResource { request, uri, .. } => {
                self.live_discovery_requests.insert(request);
                let request = RequestDto {
                    id: request,
                    uri,
                    headers: Vec::new(),
                    purpose: RequestPurpose::Metadata,
                };
                self.request_context.insert(request.id, request.clone());
                HostEffect::AcquireResource { request }
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
                probe_output,
            } => {
                let request = sequence;
                self.outstanding_tile_requests.insert(request, tile);
                if probe {
                    self.probe_requests.insert(request);
                }
                let request = RequestDto {
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
                };
                self.request_context.insert(request.id, request.clone());
                HostEffect::AcquireTile {
                    request,
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
                        processing: match processing {
                            dezoomify_core::core::model::ProcessingRecipe::None => {
                                ProcessingRecipe::None
                            }
                            dezoomify_core::core::model::ProcessingRecipe::GoogleArtsDecrypt => {
                                ProcessingRecipe::GoogleArtsDecrypt
                            }
                        },
                        probe_output,
                    },
                }
            }
            EngineEffect::FinalizeOutput {
                partial,
                format,
                canvas,
            } => HostEffect::FinalizeOutput {
                partial,
                format,
                canvas: canvas.map(|size| SizeDto {
                    width: u64::from(size.x),
                    height: u64::from(size.y),
                }),
            },
            EngineEffect::CancelWork => HostEffect::CancelWork,
            EngineEffect::RequestDecision { generation } => {
                self.pending_recovery = Some(generation);
                HostEffect::RequestDecision { generation }
            }
        })
    }

    fn project_event(&mut self, event: EngineEvent) -> Option<JobEvent> {
        Some(match event {
            EngineEvent::State { state } => JobEvent::JobState {
                state: match state {
                    dezoomify_job::State::Created => ProtocolJobState::Created,
                    dezoomify_job::State::Discovering => ProtocolJobState::Discovering,
                    dezoomify_job::State::AwaitingImageSelection => {
                        ProtocolJobState::AwaitingImageSelection
                    }
                    dezoomify_job::State::AwaitingLevelSelection => {
                        ProtocolJobState::AwaitingLevelSelection
                    }
                    dezoomify_job::State::Planning => ProtocolJobState::Planning,
                    dezoomify_job::State::AcquiringTiles => ProtocolJobState::AcquiringTiles,
                    dezoomify_job::State::AwaitingPartialDecision => {
                        ProtocolJobState::AwaitingPartialDecision
                    }
                    dezoomify_job::State::Finalizing => ProtocolJobState::Finalizing,
                    dezoomify_job::State::Cancelling => ProtocolJobState::Cancelling,
                    dezoomify_job::State::Completed => ProtocolJobState::Completed,
                    dezoomify_job::State::PartiallyCompleted => {
                        ProtocolJobState::PartiallyCompleted
                    }
                    dezoomify_job::State::Failed => ProtocolJobState::Failed,
                    dezoomify_job::State::Cancelled => ProtocolJobState::Cancelled,
                },
            },
            EngineEvent::Catalog { catalog } => {
                self.terminal_discovery_error = None;
                JobEvent::Catalog { catalog }
            }
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
            EngineEvent::RecoveryRequested { generation } => {
                let scope = "partial";
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
            EngineEvent::Failed { code, message } => {
                let error = if let Some(mut error) = self.terminal_discovery_error.take() {
                    if error.detail.is_none() && error.message != message {
                        error.detail = Some(message);
                    }
                    error
                } else {
                    ErrorDto::new(code, ErrorPhase::Discovery, message)
                };
                JobEvent::Failed { error }
            }
            EngineEvent::Cancelled => JobEvent::Cancelled,
            EngineEvent::Paused => JobEvent::Paused,
            EngineEvent::Resumed => JobEvent::Resumed,
        })
    }
}
