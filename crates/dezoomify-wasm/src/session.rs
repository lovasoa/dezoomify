//! One-session job owner: typed configuration and dispatch, one pure
//! processing operation, and disposal.
//!
//! ## Canonical engine delegation
//!
//! [`Session`] owns a [`dezoomify_engine::EngineJob`] and drives the whole
//! lifecycle through the canonical API (`start`, `command`, `complete`,
//! `provide_metadata`). Each answer returns the newly issued effects plus
//! the current snapshot; the adapter projects the new effects onto the
//! generated ABI contract values and derives the ABI event stream from
//! snapshot diffs (state, catalog, progress, decision, notices, terminal).
//!
//! Host interaction map (every path is explicit and correlated):
//!
//! * `Start` creates the engine job and emits its first effects/events.
//! * Discovery bytes: `ProvideResource` carries the resource body directly
//!   (`bytes`) for one outstanding metadata effect. Bytes cross in the
//!   command; nothing is retained adapter-side.
//! * Tile success is body-free: `ProvideDisplayOutcome` answers one
//!   outstanding tile effect and forwards a typed `TileDisplayed`
//!   (the host holds an ordinary image element with no readable bytes; the
//!   tainted output completes as display-only downstream).
//! * Probe observations: each tile effect with `purpose: probe` is
//!   answered with `ProvideProbeOutcome` (request id plus a discriminated
//!   available/missing observation) and forwarded as the engine
//!   `ProbeAvailable`/`ProbeMissing`. Probe bytes are measured by the host
//!   and never retained.
//! * `ProvideFetchFailure` maps to a metadata failure (discovery request),
//!   a typed `TileFailed` carrying the observed HTTP status and
//!   `retry-after` hint for tile refusals (permanent failures such as HTTP
//!   403 settle after exactly one attempt; transient failures retry on the
//!   exact budget with explicit timer effects), or a missing probe
//!   observation (probe request).
//! * `RetryTimerElapsed` answers one outstanding retry-timer effect with
//!   the same tile and attempt after the host waited `delay_ms` on its own
//!   clock. While paused the host parks the completion and answers on
//!   resume; stale completions are ignored.
//! * Decisions: `SelectImage`, `SelectLevel`, and `RecoveryChoice` map 1:1
//!   onto engine commands. `RecoveryChoice` must reference the outstanding
//!   numeric decision generation.
//! * `FinalizationSucceeded` and `FinalizationFailed` complete the one
//!   awaited finalize effect.
//! * `CancelWork` instructs the host to close its own retained resources.
//!
//! Engine resources beyond this model are engine limitations, not adapter
//! limits: byte lengths pass through, never fabricated. Probe-driven levels
//! plan through the same core probe step machine as native hosts; the host
//! reports each probe observation and the engine resolves the plan.
//! Empty discovery resources fail the job via the engine
//! (`job.empty-resource`); nothing here can fake completion.

use crate::error::{AdapterError, AdapterErrorCode};
use dezoomify_core::core::discovery::TransportKind;
use dezoomify_engine::{
    Effect as EngineEffect, EffectId as EngineEffectId, EffectResult as EngineEffectResult,
    EngineError as EngineJobError, EngineJob, Failure as EngineFailure,
    JobOptions as EngineOptions, Lifecycle as EngineLifecycle,
    PartialDecision as EnginePartialDecision, ResponseMetadata as EngineResponseMetadata,
    SelectionPolicy as EngineSelectionPolicy, Update as EngineUpdate,
    UserCommand as EngineUserCommand,
};
use dezoomify_protocol::dto::{
    ErrorDto, ErrorPhase, ErrorTransport, FetchFailureDto, HeaderDto, HostEffect, HostMessage,
    JobCommand, JobEvent, JobState as ProtocolJobState, PointDto, ProbeOutcome, ProcessingRecipe,
    RecoveryAction, RecoveryChoice, RecoveryKind, RequestDto, RequestPurpose, ResourceKind,
    SessionConfig, SizeDto, TilePlacementDto,
};
use std::collections::{HashMap, HashSet};

/// One adapter session: exactly one engine job plus its request correlation.
pub struct Session {
    job: Option<EngineJob>,
    session_config: SessionConfig,
    state: EngineLifecycle,
    disposed: bool,
    /// Last emitted lifecycle (snapshot-diff event derivation).
    emitted_state: Option<EngineLifecycle>,
    /// Whether the catalog event was emitted for the current catalog.
    emitted_catalog: bool,
    /// Last emitted progress counts.
    emitted_progress: Option<(u64, Option<u64>)>,
    /// Last emitted decision generation.
    emitted_decision: Option<u32>,
    /// Whether the terminal event was emitted.
    emitted_terminal: bool,
    /// Last emitted pause flag.
    emitted_paused: bool,
    /// Engine notices already emitted (identity keys).
    emitted_notice_keys: Vec<String>,
    /// Outstanding metadata effect ids (adapter request id == effect id).
    live_discovery_requests: HashSet<u32>,
    /// Adapter tile/probe request id -> engine tile id.
    outstanding_tile_requests: HashMap<u32, u32>,
    /// Complete adapter-emitted request context, keyed by its correlation id.
    request_context: HashMap<u32, RequestDto>,
    /// Adapter-minted probe request ids (subset of tile requests emitted
    /// while planning probe-driven levels).
    probe_requests: HashSet<u32>,
    /// Outstanding retry-timer effects by (tile, attempt).
    live_timers: HashMap<(u32, u32), EngineEffectId>,
    /// Outstanding finalize effect, if the host awaits output.
    live_finalize: Option<EngineEffectId>,
    /// Recovery id from the latest request-decision effect.
    pending_recovery: Option<u32>,
    /// The complete browser failure that caused discovery to terminate.
    /// The job engine groups failures by typed cause; the adapter retains
    /// the host context so the terminal event does not discard it.
    terminal_discovery_error: Option<ErrorDto>,
}

impl Session {
    /// Validate the typed job-budget config, then construct an empty session.
    ///
    /// # Errors
    ///
    /// Returns the engine validation failure for invalid job budgets.
    pub fn new(config: SessionConfig) -> Result<Self, AdapterError> {
        Ok(Self {
            job: None,
            session_config: config,
            state: EngineLifecycle::Created,
            disposed: false,
            emitted_state: None,
            emitted_catalog: false,
            emitted_progress: None,
            emitted_decision: None,
            emitted_terminal: false,
            emitted_paused: false,
            emitted_notice_keys: Vec::new(),
            live_discovery_requests: HashSet::new(),
            outstanding_tile_requests: HashMap::new(),
            request_context: HashMap::new(),
            probe_requests: HashSet::new(),
            live_timers: HashMap::new(),
            live_finalize: None,
            pending_recovery: None,
            terminal_discovery_error: None,
        })
    }

    /// Current lifecycle phase (engine projection).
    #[must_use]
    pub const fn state(&self) -> EngineLifecycle {
        self.state
    }

    /// Whether [`Session::dispose`] has run.
    #[must_use]
    pub const fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// Project the canonical engine snapshot for the active job: absolute
    /// lifecycle, pause flag, progress, selection/decision payload,
    /// terminal result, and output summary. No new work is issued.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `wrong-state` before `Start` creates the job.
    pub fn snapshot(&self) -> Result<dezoomify_protocol::dto::EngineSnapshotDto, AdapterError> {
        self.require_live()?;
        let job = self.job.as_ref().ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
        })?;
        Ok(job.project_dto())
    }

    /// Last projected snapshot (or the idle projection before start). The
    /// retained host failure context patches the terminal error, mirroring
    /// the Failed event enrichment below, so the absolute snapshot never
    /// discards what the event stream keeps.
    fn last_snapshot(&self) -> dezoomify_protocol::dto::EngineSnapshotDto {
        use dezoomify_protocol::dto::{
            EngineSnapshotDto, JobState as ProtocolJobState, SnapshotProgressDto,
            SnapshotSelectionDto,
        };
        let mut dto = match &self.job {
            Some(job) => job.project_dto(),
            None => EngineSnapshotDto {
                revision: 0,
                lifecycle: ProtocolJobState::Created,
                paused: false,
                progress: SnapshotProgressDto {
                    completed: 0,
                    total: Some(0),
                },
                selection: SnapshotSelectionDto {
                    image: None,
                    level: None,
                    level_count: 0,
                    deferred: Vec::new(),
                },
                decision: None,
                terminal: None,
                output: None,
            },
        };
        self.patch_terminal_error(&mut dto);
        dto
    }

    fn patch_terminal_error(&self, dto: &mut dezoomify_protocol::dto::EngineSnapshotDto) {
        use dezoomify_protocol::dto::SnapshotTerminalDto;
        let (Some(enriched), Some(SnapshotTerminalDto::Failed { error })) =
            (&self.terminal_discovery_error, &mut dto.terminal)
        else {
            return;
        };
        let mut patched = enriched.clone();
        if patched.detail.is_none() && patched.message != error.message {
            patched.detail = Some(error.message.clone());
        }
        *error = patched;
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
    /// message in engine order plus the canonical snapshot after the
    /// answer. The snapshot is absolute: hosts render it directly instead
    /// of refolding the message stream.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `wrong-state`/`limit-exceeded` per transition.
    pub fn dispatch(
        &mut self,
        command: JobCommand,
    ) -> Result<(Vec<HostMessage>, dezoomify_protocol::dto::EngineSnapshotDto), AdapterError> {
        self.require_live()?;
        let messages = self.dispatch_command(command)?;
        let snapshot = self.last_snapshot();
        Ok((messages, snapshot))
    }

    /// Cancel the active job through the engine and release adapter
    /// resources. Repeat-safe: later calls succeed without enqueueing
    /// duplicates, returning the last snapshot. Afterwards every operation
    /// except repeated disposal fails with `disposed`.
    pub fn dispose(
        &mut self,
    ) -> Result<(Vec<HostMessage>, dezoomify_protocol::dto::EngineSnapshotDto), AdapterError> {
        if self.disposed {
            return Ok((Vec::new(), self.last_snapshot()));
        }
        self.disposed = true;
        let mut messages = if let Some(job) = self.job.as_mut() {
            if job.snapshot().terminal.is_none() {
                match job.command(EngineUserCommand::Cancel) {
                    Ok(update) => self.drain_update(update),
                    Err(_) => vec![self.force_cancelled_event()],
                }
            } else {
                Vec::new()
            }
        } else {
            vec![self.force_cancelled_event()]
        };
        if !messages.iter().any(|message| {
            matches!(
                message,
                HostMessage::Event(JobEvent::Cancelled | JobEvent::Failed { .. })
            )
        }) {
            messages.push(self.force_cancelled_event());
        }
        let snapshot = self.last_snapshot();
        self.job = None;
        Ok((messages, snapshot))
    }

    fn force_cancelled_event(&mut self) -> HostMessage {
        self.state = EngineLifecycle::Cancelled;
        HostMessage::Event(JobEvent::Cancelled)
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
    // Command dispatch (canonical engine delegation)
    // -----------------------------------------------------------------------

    fn dispatch_command(&mut self, command: JobCommand) -> Result<Vec<HostMessage>, AdapterError> {
        match command {
            JobCommand::Start { inputs } => self.on_start(inputs),
            JobCommand::Cancel => self.run_user_command(EngineUserCommand::Cancel),
            JobCommand::Pause => self.run_user_command(EngineUserCommand::Pause),
            JobCommand::Resume => self.run_user_command(EngineUserCommand::Resume),
            JobCommand::ProvideResource {
                request,
                bytes,
                final_uri,
            } => self.on_provide_resource(request, bytes, final_uri),
            JobCommand::ProvideFetchFailure { request, error } => {
                self.on_fetch_failure(request, error)
            }
            JobCommand::ProvideProbeOutcome { request, outcome } => {
                self.on_probe_outcome(request, outcome)
            }
            JobCommand::ProvideDisplayOutcome { request } => self.on_display_outcome(request),
            JobCommand::TileAcquired { request } => self.on_tile_acquired(request),
            JobCommand::RetryTimerElapsed { tile, attempt } => self.on_timer_elapsed(tile, attempt),
            JobCommand::SelectImage { image } => {
                self.run_user_command(EngineUserCommand::SelectImage { image })
            }
            JobCommand::SelectLevel { level } => {
                self.run_user_command(EngineUserCommand::SelectLevel { level })
            }
            JobCommand::RecoveryChoice { generation, choice } => {
                if self.pending_recovery != Some(generation) {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "recovery choice does not match the outstanding recovery",
                    ));
                }
                self.run_user_command(EngineUserCommand::AnswerPartial {
                    decision: match choice {
                        RecoveryChoice::Keep => EnginePartialDecision::Keep,
                        RecoveryChoice::Retry => EnginePartialDecision::Retry,
                        RecoveryChoice::Discard => EnginePartialDecision::Discard,
                    },
                })
            }
            JobCommand::FinalizationSucceeded => self.on_finalize_succeeded(),
            JobCommand::FinalizationFailed { error } => self.on_finalize_failed(error),
        }
    }

    fn require_engine_state(&self, expected: EngineLifecycle) -> Result<(), AdapterError> {
        if self.state != expected {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                format!("command not accepted in state {:?}", self.state),
            ));
        }
        Ok(())
    }

    fn engine_job(&mut self) -> Result<&mut EngineJob, AdapterError> {
        self.job.as_mut().ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::WrongState, "session has no active job")
        })
    }

    /// Run one user command and project the answer.
    fn run_user_command(
        &mut self,
        command: EngineUserCommand,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        let update = self
            .engine_job()?
            .command(command)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    fn on_start(
        &mut self,
        inputs: Vec<dezoomify_protocol::dto::JobInputDto>,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        self.require_engine_state(EngineLifecycle::Created)?;
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
        let mut options = EngineOptions::new(
            inputs
                .into_iter()
                .map(|input| match input.contents {
                    Some(contents) => dezoomify_engine::DiscoveryInput::with_contents(
                        input.url,
                        contents.into_bytes(),
                    ),
                    None => dezoomify_engine::DiscoveryInput::new(input.url),
                })
                .collect(),
        );
        // Optional job-budget overrides; the engine validates them at
        // start, so zero/oversized values fail typed there.
        let config = &self.session_config;
        if let Some(value) = config.max_concurrent_fetches {
            options.max_concurrent = value.get();
        }
        if let Some(value) = config.max_tiles {
            options.max_tiles = value.get();
        }
        if let Some(value) = config.max_retries {
            options.max_retries = value;
        }
        if options.selection != EngineSelectionPolicy::Manual {
            options.selection = EngineSelectionPolicy::Manual;
        }
        // Start emits the Discovering state plus one metadata effect per
        // outstanding discovery request; nothing here echoes the URL
        // anywhere.
        let (job, update) = EngineJob::start(options).map_err(Self::engine_error)?;
        self.job = Some(job);
        Ok(self.drain_update(update))
    }

    fn on_provide_resource(
        &mut self,
        request: u32,
        bytes: Vec<u8>,
        final_uri: Option<String>,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        // Correlate before touching any state: unknown request ids are
        // atomic rejections.
        if self.outstanding_tile_requests.contains_key(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "tile requests are answered with provide-display-outcome or provide-fetch-failure, not provide-resource",
            ));
        }
        if !self.live_discovery_requests.contains(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "resource does not match an outstanding request",
            ));
        }
        self.live_discovery_requests.remove(&request);
        self.request_context.remove(&request);
        // Discovery is intentionally concurrent. A sibling metadata
        // fetch may finish after another candidate has already
        // produced the catalog and advanced the job into selection,
        // planning, or tile acquisition. The job engine treats that
        // response as ignored; the adapter preserves that same
        // stale-response behavior instead of turning normal fetch
        // reordering into a session failure.
        if self.state != EngineLifecycle::Discovering {
            return Ok(Vec::new());
        }
        let update = self
            .engine_job()?
            .provide_metadata(
                EngineEffectId(request),
                EngineResponseMetadata {
                    final_uri: final_uri.filter(|uri| !uri.is_empty()),
                },
                &bytes,
            )
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    fn on_probe_outcome(
        &mut self,
        request: u32,
        outcome: ProbeOutcome,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        let _tile_id = match self.outstanding_tile_requests.get(&request) {
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
        self.require_engine_state(EngineLifecycle::Planning)?;
        self.outstanding_tile_requests.remove(&request);
        self.probe_requests.remove(&request);
        self.request_context.remove(&request);
        let result = match outcome {
            ProbeOutcome::Available { width, height } => EngineEffectResult::ProbeAvailable {
                width: u32::try_from(width.get()).unwrap_or(u32::MAX),
                height: u32::try_from(height.get()).unwrap_or(u32::MAX),
            },
            ProbeOutcome::Missing => EngineEffectResult::ProbeMissing,
        };
        let update = self
            .engine_job()?
            .complete(EngineEffectId(request), result)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    /// Display-only answer for one outstanding tile request: the host holds
    /// an ordinary image element (no readable bytes) and the engine records
    /// a typed display success; the tainted canvas completes as
    /// display-only downstream.
    fn on_display_outcome(&mut self, request: u32) -> Result<Vec<HostMessage>, AdapterError> {
        if !self.outstanding_tile_requests.contains_key(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "display outcome does not match an outstanding request",
            ));
        }
        if self.probe_requests.contains(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "probe requests are answered with provide-probe-outcome, not provide-display-outcome",
            ));
        }
        self.require_engine_state(EngineLifecycle::AcquiringTiles)?;
        self.outstanding_tile_requests.remove(&request);
        self.request_context.remove(&request);
        let update = self
            .engine_job()?
            .complete(EngineEffectId(request), EngineEffectResult::TileDisplayed)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    /// Successful acquisition of one outstanding tile request: the host has
    /// already fetched, decoded, and placed the tile, so the outcome carries
    /// no body. Mirrors `on_display_outcome` correlation exactly.
    fn on_tile_acquired(&mut self, request: u32) -> Result<Vec<HostMessage>, AdapterError> {
        if !self.outstanding_tile_requests.contains_key(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "tile acquisition does not match an outstanding request",
            ));
        }
        if self.probe_requests.contains(&request) {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "probe requests are answered with provide-probe-outcome, not tile-acquired",
            ));
        }
        self.require_engine_state(EngineLifecycle::AcquiringTiles)?;
        self.outstanding_tile_requests.remove(&request);
        self.request_context.remove(&request);
        let update = self
            .engine_job()?
            .complete(EngineEffectId(request), EngineEffectResult::TileAcquired)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    /// Elapsed retry wait: the host waited on its own clock and answers
    /// with the same tile and attempt. Stale completions are ignored.
    fn on_timer_elapsed(
        &mut self,
        tile: u32,
        attempt: u32,
    ) -> Result<Vec<HostMessage>, AdapterError> {
        let Some(effect) = self.live_timers.remove(&(tile, attempt)) else {
            return Ok(Vec::new());
        };
        let update = self
            .engine_job()?
            .complete(effect, EngineEffectResult::TimerElapsed)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    fn on_finalize_succeeded(&mut self) -> Result<Vec<HostMessage>, AdapterError> {
        let Some(effect) = self.live_finalize.take() else {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "no output operation is awaited",
            ));
        };
        let update = self
            .engine_job()?
            .complete(
                effect,
                EngineEffectResult::OutputCommitted {
                    disposition: dezoomify_engine::OutputDisposition::BrowserSaveInitiated,
                },
            )
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    fn on_finalize_failed(&mut self, error: ErrorDto) -> Result<Vec<HostMessage>, AdapterError> {
        let Some(effect) = self.live_finalize.take() else {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "no output operation is awaited",
            ));
        };
        let update = self
            .engine_job()?
            .complete(
                effect,
                EngineEffectResult::OutputFailed {
                    code: error.code,
                    message: error.message,
                },
            )
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
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
            Some(_tile_id) => {
                if self.probe_requests.contains(&request) {
                    self.require_engine_state(EngineLifecycle::Planning)?;
                    self.outstanding_tile_requests.remove(&request);
                    self.probe_requests.remove(&request);
                    self.request_context.remove(&request);
                    let update = self
                        .engine_job()?
                        .complete(EngineEffectId(request), EngineEffectResult::ProbeMissing)
                        .map_err(Self::engine_error)?;
                    return Ok(self.drain_update(update));
                }
                self.require_engine_state(EngineLifecycle::AcquiringTiles)?;
                self.outstanding_tile_requests.remove(&request);
                self.request_context.remove(&request);
                // The bridge forwards the observed facts into a typed engine
                // failure: the HTTP status decides retryability (permanent
                // refusals such as HTTP 403 settle after exactly one
                // attempt), and an observed `retry-after` hint sets the
                // explicit wait before a transient retry. The engine emits
                // one retry-timer effect per remaining attempt.
                let update = self
                    .engine_job()?
                    .complete(
                        EngineEffectId(request),
                        EngineEffectResult::TileFailed(EngineFailure {
                            code: failure.code,
                            http: failure.http,
                            retry_after_ms: failure.retry_after_ms,
                            transport: None,
                            detail: failure.detail,
                        }),
                    )
                    .map_err(Self::engine_error)?;
                Ok(self.drain_update(update))
            }
            None => {
                self.live_discovery_requests.remove(&request);
                self.request_context.remove(&request);
                // A late sibling failure is also a normal consequence of
                // concurrent discovery after another candidate has won.
                if self.state != EngineLifecycle::Discovering {
                    return Ok(Vec::new());
                }
                // Forward the typed cause so the engine groups discovery
                // diagnostics on `(kind, cause)`, never on rendered text.
                // Host message text stays out of the engine entirely:
                // nothing free-form crosses, so there is nothing to
                // redact or bound here. The full request URL is named by
                // the host itself, outside the engine block.
                let transport = match failure.transport {
                    ErrorTransport::Direct => TransportKind::Direct,
                    ErrorTransport::MetadataProxy => TransportKind::MetadataProxy,
                    ErrorTransport::BrowserSession => TransportKind::BrowserSession,
                    ErrorTransport::Native => TransportKind::Native,
                    ErrorTransport::DisplayOnly => TransportKind::DisplayOnly,
                };
                self.terminal_discovery_error = Some(ErrorDto {
                    code: failure.code.clone(),
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
                let update = self
                    .engine_job()?
                    .complete(
                        EngineEffectId(request),
                        EngineEffectResult::MetadataFailed(EngineFailure {
                            code: failure.code,
                            http: failure.http,
                            retry_after_ms: failure.retry_after_ms,
                            transport: Some(transport),
                            detail: None,
                        }),
                    )
                    .map_err(Self::engine_error)?;
                Ok(self.drain_update(update))
            }
        }
    }

    fn engine_error(error: EngineJobError) -> AdapterError {
        let code = match error.code.as_str() {
            "job.post-terminal" | "job.invalid-state" => AdapterErrorCode::WrongState,
            "job.invalid-config" => AdapterErrorCode::Malformed,
            "job.resource-limit" | "job.overflow" => AdapterErrorCode::LimitExceeded,
            "job.stale-effect" | "job.wrong-result-kind" => AdapterErrorCode::WrongState,
            _ => AdapterErrorCode::WrongState,
        };
        AdapterError::new(code, error.message)
    }

    // -----------------------------------------------------------------------
    // Canonical engine answer -> ABI projection
    // -----------------------------------------------------------------------

    /// Project one canonical answer: the newly issued effects become ABI
    /// host effects, and the snapshot diffs become the ABI events.
    fn drain_update(&mut self, update: EngineUpdate) -> Vec<HostMessage> {
        let mut projected = Vec::new();
        let snapshot = &update.snapshot;
        let state = snapshot.lifecycle;
        // Lifecycle moves first so the initial state event precedes the
        // first effects, exactly like the engine queue order.
        if self.emitted_state != Some(state) {
            self.emitted_state = Some(state);
            self.state = state;
            projected.push(HostMessage::Event(JobEvent::JobState {
                state: protocol_state_of(state),
            }));
        }
        // The kept catalog replaces the selection payload on deferred
        // follows: re-emit it so hosts never render a stale gallery.
        if let Some(catalog) = snapshot.selection.catalog.clone() {
            if !self.emitted_catalog {
                self.emitted_catalog = true;
                self.terminal_discovery_error = None;
                projected.push(HostMessage::Event(JobEvent::Catalog { catalog }));
            }
        }
        // Progress advances monotonically; re-emit only on change.
        let progress = (snapshot.progress.completed, snapshot.progress.total);
        if self.emitted_progress != Some(progress) {
            self.emitted_progress = Some(progress);
            projected.push(HostMessage::Event(JobEvent::Progress {
                acquired: progress.0,
                total: progress.1.unwrap_or(0),
            }));
        }
        // Pause overlay transitions.
        if self.emitted_paused != snapshot.paused {
            self.emitted_paused = snapshot.paused;
            projected.push(HostMessage::Event(if snapshot.paused {
                JobEvent::Paused
            } else {
                JobEvent::Resumed
            }));
        }
        // Outstanding partial decision: one cue per generation.
        if let Some(decision) = &snapshot.decision {
            if self.emitted_decision != Some(decision.generation) {
                self.emitted_decision = Some(decision.generation);
                projected.push(HostMessage::Event(JobEvent::RecoveryRequest {
                    generation: decision.generation,
                    actions: vec![RecoveryAction {
                        id: "retry".to_string(),
                        kind: RecoveryKind::Retry,
                        scope: "partial".to_string(),
                        rationale: "Retry the partial step".to_string(),
                    }],
                }));
            }
        }
        // Bounded recent engine notices (retries, settled work),
        // deduplicated by identity: the recent log truncates, so a
        // positional skip would miss entries.
        for notice in &snapshot.notices {
            let key = format!(
                "{}:{}:{:?}:{:?}",
                notice.revision, notice.tile, notice.attempt, notice.missing
            );
            if self.emitted_notice_keys.contains(&key) {
                continue;
            }
            self.emitted_notice_keys.push(key);
            if notice.missing.is_empty() {
                let mut error = ErrorDto::new(
                    "job.tile-retry",
                    ErrorPhase::Acquisition,
                    format!(
                        "tile {} failed; retry attempt {}",
                        notice.tile,
                        notice.attempt.unwrap_or(0)
                    ),
                );
                error.retryable = true;
                projected.push(HostMessage::Event(JobEvent::Warning { error }));
            } else {
                let mut error = ErrorDto::new(
                    "job.missing-tiles",
                    ErrorPhase::Acquisition,
                    format!("tiles failed: {:?}", notice.missing),
                );
                error.retryable = true;
                projected.push(HostMessage::Event(JobEvent::Warning { error }));
            }
        }
        // Newly issued effects, in canonical order.
        for effect in &update.effects {
            if let Some(message) = self.project_effect(effect) {
                projected.push(HostMessage::Effect(message));
            }
        }
        // Terminal outcome last: exactly one terminal render.
        if !self.emitted_terminal {
            if let Some(terminal) = &snapshot.terminal {
                self.emitted_terminal = true;
                projected.push(HostMessage::Event(self.project_terminal(terminal)));
            }
        }
        self.state = snapshot.lifecycle;
        projected
    }

    fn project_effect(&mut self, effect: &EngineEffect) -> Option<HostEffect> {
        match effect {
            EngineEffect::AcquireMetadata { id, uri } => {
                let request = id.get();
                self.live_discovery_requests.insert(request);
                let request_dto = RequestDto {
                    id: request,
                    uri: uri.clone(),
                    headers: Vec::new(),
                    purpose: RequestPurpose::Metadata,
                };
                self.request_context.insert(request, request_dto.clone());
                Some(HostEffect::AcquireResource {
                    request: request_dto,
                })
            }
            EngineEffect::AcquireTile {
                id,
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
                let request = id.get();
                self.outstanding_tile_requests.insert(request, *tile);
                if *probe {
                    self.probe_requests.insert(request);
                }
                let request_dto = RequestDto {
                    id: request,
                    uri: uri.clone(),
                    headers: headers
                        .iter()
                        .map(|header| HeaderDto {
                            name: header.name.clone(),
                            value: header.value.clone(),
                        })
                        .collect(),
                    purpose: if *probe {
                        RequestPurpose::Probe
                    } else {
                        RequestPurpose::Tile
                    },
                };
                self.request_context.insert(request, request_dto.clone());
                Some(HostEffect::AcquireTile {
                    request: request_dto,
                    tile: *tile,
                    placement: TilePlacementDto {
                        position: PointDto {
                            x: u64::from(destination.x),
                            y: u64::from(destination.y),
                        },
                        expected_size: expected_size.map(|size| SizeDto {
                            width: u64::from(size.width),
                            height: u64::from(size.height),
                        }),
                        canvas: canvas.map(|size| SizeDto {
                            width: u64::from(size.width),
                            height: u64::from(size.height),
                        }),
                        processing: match processing {
                            dezoomify_core::core::model::ProcessingRecipe::None => {
                                ProcessingRecipe::None
                            }
                            dezoomify_core::core::model::ProcessingRecipe::GoogleArtsDecrypt => {
                                ProcessingRecipe::GoogleArtsDecrypt
                            }
                        },
                        probe_output: *probe_output,
                    },
                })
            }
            EngineEffect::WaitRetryTimer {
                id,
                tile,
                attempt,
                delay_ms,
            } => {
                self.live_timers.insert((*tile, *attempt), *id);
                Some(HostEffect::WaitRetryTimer {
                    tile: *tile,
                    attempt: *attempt,
                    delay_ms: *delay_ms,
                })
            }
            EngineEffect::FinalizeOutput {
                id,
                partial,
                canvas,
            } => {
                self.live_finalize = Some(*id);
                Some(HostEffect::FinalizeOutput {
                    partial: *partial,
                    format: dezoomify_protocol::dto::OutputFormat::Png,
                    canvas: canvas.map(|size| SizeDto {
                        width: u64::from(size.width),
                        height: u64::from(size.height),
                    }),
                })
            }
            EngineEffect::RequestPartialDecision {
                id: _, generation, ..
            } => {
                self.pending_recovery = Some(*generation);
                Some(HostEffect::RequestDecision {
                    generation: *generation,
                })
            }
            EngineEffect::CancelRelease { .. } => Some(HostEffect::CancelWork),
        }
    }

    fn project_terminal(&mut self, terminal: &dezoomify_engine::Terminal) -> JobEvent {
        match terminal {
            dezoomify_engine::Terminal::Completed => JobEvent::Completed,
            dezoomify_engine::Terminal::PartiallyCompleted { .. } => JobEvent::PartialCompleted,
            dezoomify_engine::Terminal::Failed { code, message } => {
                let error = if let Some(enriched) = &self.terminal_discovery_error {
                    let mut error = enriched.clone();
                    if error.detail.is_none() && error.message != *message {
                        error.detail = Some(message.clone());
                    }
                    error
                } else {
                    ErrorDto::new(code.clone(), ErrorPhase::Discovery, message.clone())
                };
                JobEvent::Failed { error }
            }
            dezoomify_engine::Terminal::Cancelled => JobEvent::Cancelled,
        }
    }
}

fn protocol_state_of(state: EngineLifecycle) -> ProtocolJobState {
    match state {
        EngineLifecycle::Created => ProtocolJobState::Created,
        EngineLifecycle::Discovering => ProtocolJobState::Discovering,
        EngineLifecycle::AwaitingImageSelection => ProtocolJobState::AwaitingImageSelection,
        EngineLifecycle::AwaitingLevelSelection => ProtocolJobState::AwaitingLevelSelection,
        EngineLifecycle::Planning => ProtocolJobState::Planning,
        EngineLifecycle::AcquiringTiles => ProtocolJobState::AcquiringTiles,
        EngineLifecycle::AwaitingPartialDecision => ProtocolJobState::AwaitingPartialDecision,
        EngineLifecycle::Finalizing => ProtocolJobState::Finalizing,
        EngineLifecycle::Cancelling => ProtocolJobState::Cancelling,
        EngineLifecycle::Completed => ProtocolJobState::Completed,
        EngineLifecycle::PartiallyCompleted => ProtocolJobState::PartiallyCompleted,
        EngineLifecycle::Failed => ProtocolJobState::Failed,
        EngineLifecycle::Cancelled => ProtocolJobState::Cancelled,
    }
}
