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
//! snapshot diffs (state, catalog, progress, decision, terminal).
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
//!   the same effect id after the host waited `delay_ms` on its own
//!   clock. The engine parks elapsed retries while paused and re-drives them
//!   on resume; stale completions are rejected.
//! * Decisions: `SelectImage`, `FollowDeferred`, `SelectLevel`, and
//!   `RecoveryChoice` map 1:1 onto engine commands. `RecoveryChoice` must
//!   reference the outstanding numeric decision generation.
//! * `FinalizationSucceeded` and `FinalizationFailed` echo and complete the
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
    JobOptions as EngineOptions, OutputDisposition as EngineDisposition,
    ResponseMetadata as EngineResponseMetadata, SelectionPolicy as EngineSelectionPolicy,
    Update as EngineUpdate, UserCommand as EngineUserCommand,
};
use dezoomify_protocol::dto::{
    ErrorDto, ErrorPhase, ErrorTransport, FetchFailureDto, HeaderDto, HostCompletion, HostEffect,
    JobCommand, JobState as ProtocolJobState, OutputDispositionDto, PointDto, ProbeOutcome,
    ProcessingRecipe, RequestDto, RequestPurpose, ResourceKind, SessionConfig, SizeDto,
    TilePlacementDto,
};
use std::collections::{HashMap, HashSet};

/// One adapter session: exactly one engine job plus its request correlation.
///
/// The engine owns lifecycle, progress, decisions, and terminals. This
/// session keeps only effect correlation (host request ids to engine effect
/// ids) plus the request context needed to validate answers. It never
/// mirrors lifecycle or re-derives events: answers carry the
/// engine effects verbatim and the absolute snapshot after the answer.
/// Host failure context for discovery travels through the engine's
/// `note_metadata_failure` (the engine patches the terminal and clears the
/// retention on a winning catalog); nothing is retained here.
pub struct Session {
    job: Option<EngineJob>,
    session_config: SessionConfig,
    disposed: bool,
    /// Outstanding metadata effect ids (adapter request id == effect id).
    live_discovery_requests: HashSet<u32>,
    /// Adapter tile/probe request id -> engine tile id.
    outstanding_tile_requests: HashMap<u32, u32>,
    /// Complete adapter-emitted request context, keyed by its correlation id.
    request_context: HashMap<u32, RequestDto>,
    /// Adapter-minted probe request ids (subset of tile requests emitted
    /// while planning probe-driven levels).
    probe_requests: HashSet<u32>,
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
            disposed: false,
            live_discovery_requests: HashSet::new(),
            outstanding_tile_requests: HashMap::new(),
            request_context: HashMap::new(),
            probe_requests: HashSet::new(),
        })
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

    /// Last projected snapshot (or the idle projection before start).
    /// The engine patches the terminal error from the retained host
    /// failure context, so the absolute snapshot never discards what the
    /// engine groups away.
    fn last_snapshot(&self) -> dezoomify_protocol::dto::EngineSnapshotDto {
        use dezoomify_protocol::dto::{
            EngineSnapshotDto, JobState as ProtocolJobState, SnapshotProgressDto,
            SnapshotSelectionDto,
        };
        match &self.job {
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
                    catalog: None,
                    deferred: Vec::new(),
                },
                decision: None,
                terminal: None,
                output: None,
            },
        }
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

    /// Run one typed user command synchronously and return every resulting
    /// host effect in engine order plus the canonical snapshot after the
    /// answer. The snapshot is absolute: hosts render it directly instead
    /// of refolding the message stream. User commands can never supply
    /// bytes, complete an effect, or claim publication; those cross only as
    /// [`HostCompletion`] through [`Session::complete`].
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `wrong-state`/`limit-exceeded` per transition.
    pub fn command(
        &mut self,
        command: JobCommand,
    ) -> Result<(Vec<HostEffect>, dezoomify_protocol::dto::EngineSnapshotDto), AdapterError> {
        self.require_live()?;
        let messages = self.dispatch_command(command)?;
        let snapshot = self.last_snapshot();
        Ok((messages, snapshot))
    }

    /// Answer one outstanding host effect synchronously and return every
    /// resulting host effect in engine order plus the canonical snapshot
    /// after the answer. Only completions carry bytes, failures,
    /// observations, and publication claims.
    ///
    /// # Errors
    ///
    /// `disposed` after disposal; `wrong-state` for unknown, stale, or
    /// already-settled effects.
    pub fn complete(
        &mut self,
        completion: HostCompletion,
    ) -> Result<(Vec<HostEffect>, dezoomify_protocol::dto::EngineSnapshotDto), AdapterError> {
        self.require_live()?;
        let messages = self.dispatch_completion(completion)?;
        let snapshot = self.last_snapshot();
        Ok((messages, snapshot))
    }

    /// Cancel the active job through the engine and release adapter
    /// resources. Repeat-safe: later calls succeed without new work,
    /// returning the last snapshot. Afterwards every operation except
    /// repeated disposal fails with `disposed`. The engine snapshot carries
    /// the Cancelled terminal; no event is synthesized.
    pub fn dispose(
        &mut self,
    ) -> Result<(Vec<HostEffect>, dezoomify_protocol::dto::EngineSnapshotDto), AdapterError> {
        if self.disposed {
            return Ok((Vec::new(), self.last_snapshot()));
        }
        self.disposed = true;
        let messages = if let Some(job) = self.job.as_mut() {
            if job.snapshot().terminal.is_none() {
                match job.command(EngineUserCommand::Cancel) {
                    Ok(update) => self.drain_update(update),
                    Err(_) => Vec::new(),
                }
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        let snapshot = self.last_snapshot();
        self.job = None;
        Ok((messages, snapshot))
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

    fn dispatch_command(&mut self, command: JobCommand) -> Result<Vec<HostEffect>, AdapterError> {
        match command {
            JobCommand::Start { inputs } => self.on_start(inputs),
            JobCommand::Cancel => self.run_user_command(EngineUserCommand::Cancel),
            JobCommand::Pause => self.run_user_command(EngineUserCommand::Pause),
            JobCommand::Resume => self.run_user_command(EngineUserCommand::Resume),
            JobCommand::SelectImage { image } => {
                self.run_user_command(EngineUserCommand::SelectImage { image })
            }
            JobCommand::FollowDeferred { image } => {
                self.run_user_command(EngineUserCommand::FollowDeferred { image })
            }
            JobCommand::SelectLevel { level } => {
                self.run_user_command(EngineUserCommand::SelectLevel { level })
            }
            JobCommand::AnswerPartial {
                generation,
                decision,
            } => {
                // The engine validates the generation against the
                // outstanding decision; a stale answer fails typed there.
                self.run_user_command(EngineUserCommand::AnswerPartial {
                    generation,
                    decision,
                })
            }
        }
    }

    fn dispatch_completion(
        &mut self,
        completion: HostCompletion,
    ) -> Result<Vec<HostEffect>, AdapterError> {
        match completion {
            HostCompletion::ProvideResource {
                request,
                bytes,
                final_uri,
            } => self.on_provide_resource(request, bytes, final_uri),
            HostCompletion::ProvideFetchFailure { request, error } => {
                self.on_fetch_failure(request, error)
            }
            HostCompletion::ProvideProbeOutcome { request, outcome } => {
                self.on_probe_outcome(request, outcome)
            }
            HostCompletion::ProvideDisplayOutcome { request } => self.on_display_outcome(request),
            HostCompletion::TileAcquired { request } => self.on_tile_acquired(request),
            HostCompletion::RetryTimerElapsed { effect } => self.on_timer_elapsed(effect),
            HostCompletion::FinalizationSucceeded {
                effect,
                disposition,
            } => self.on_finalize_succeeded(effect, disposition),
            HostCompletion::FinalizationFailed { effect, error } => {
                self.on_finalize_failed(effect, error)
            }
        }
    }

    /// Whether the engine still accepts discovery answers. Late sibling
    /// responses after another candidate won (or after the terminal) are
    /// normal fetch reordering, ignored exactly like the engine ignores
    /// them, instead of failing the session.
    fn is_discovering(&self) -> bool {
        self.job
            .as_ref()
            .is_some_and(|job| job.snapshot().lifecycle == ProtocolJobState::Discovering)
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
    ) -> Result<Vec<HostEffect>, AdapterError> {
        let update = self
            .engine_job()?
            .command(command)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    fn on_start(
        &mut self,
        inputs: Vec<dezoomify_protocol::dto::JobInputDto>,
    ) -> Result<Vec<HostEffect>, AdapterError> {
        if self.job.is_some() {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "session already started",
            ));
        }
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
    ) -> Result<Vec<HostEffect>, AdapterError> {
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
        // Discovery is intentionally concurrent. A sibling metadata
        // fetch may finish after another candidate has already
        // produced the catalog and advanced the job. The job engine
        // treats that response as ignored; the adapter preserves that
        // same stale-response behavior instead of turning normal fetch
        // reordering into a session failure.
        if !self.is_discovering() {
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
        // The engine keeps an outstanding metadata effect live when it
        // rejects an empty body, so only settle the bridge correlation after
        // the engine accepted this completion. Otherwise a host cannot retry
        // the same effect with the body it subsequently obtained.
        self.live_discovery_requests.remove(&request);
        self.request_context.remove(&request);
        Ok(self.drain_update(update))
    }

    fn on_probe_outcome(
        &mut self,
        request: u32,
        outcome: ProbeOutcome,
    ) -> Result<Vec<HostEffect>, AdapterError> {
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
    fn on_display_outcome(&mut self, request: u32) -> Result<Vec<HostEffect>, AdapterError> {
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
    fn on_tile_acquired(&mut self, request: u32) -> Result<Vec<HostEffect>, AdapterError> {
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
        self.outstanding_tile_requests.remove(&request);
        self.request_context.remove(&request);
        let update = self
            .engine_job()?
            .complete(EngineEffectId(request), EngineEffectResult::TileAcquired)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    /// Elapsed retry wait: the host echoes the engine-minted effect id, so
    /// the engine validates it without a second adapter-side timer table.
    fn on_timer_elapsed(&mut self, effect: u32) -> Result<Vec<HostEffect>, AdapterError> {
        let update = self
            .engine_job()?
            .complete(EngineEffectId(effect), EngineEffectResult::TimerElapsed)
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    fn on_finalize_succeeded(
        &mut self,
        effect: u32,
        disposition: OutputDispositionDto,
    ) -> Result<Vec<HostEffect>, AdapterError> {
        let disposition = match disposition {
            OutputDispositionDto::NativePublication => EngineDisposition::NativePublication,
            OutputDispositionDto::BrowserSaveInitiated => EngineDisposition::BrowserSaveInitiated,
            OutputDispositionDto::BrowserSaveReady => EngineDisposition::BrowserSaveReady,
            OutputDispositionDto::DisplayOnly => EngineDisposition::DisplayOnly,
        };
        let update = self
            .engine_job()?
            .complete(
                EngineEffectId(effect),
                EngineEffectResult::OutputCommitted { disposition },
            )
            .map_err(Self::engine_error)?;
        Ok(self.drain_update(update))
    }

    fn on_finalize_failed(
        &mut self,
        effect: u32,
        error: ErrorDto,
    ) -> Result<Vec<HostEffect>, AdapterError> {
        let update = self
            .engine_job()?
            .complete(
                EngineEffectId(effect),
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
    ) -> Result<Vec<HostEffect>, AdapterError> {
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
                    self.outstanding_tile_requests.remove(&request);
                    self.probe_requests.remove(&request);
                    self.request_context.remove(&request);
                    let update = self
                        .engine_job()?
                        .complete(EngineEffectId(request), EngineEffectResult::ProbeMissing)
                        .map_err(Self::engine_error)?;
                    return Ok(self.drain_update(update));
                }
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
                if !self.is_discovering() {
                    return Ok(Vec::new());
                }
                // Forward the host-observed failure context through the
                // engine's retention: the engine groups discovery
                // diagnostics on `(kind, cause)` and patches the terminal
                // from the retained context, clearing it on a winning
                // catalog. Nothing is retained adapter-side.
                let transport = match failure.transport {
                    ErrorTransport::Direct => TransportKind::Direct,
                    ErrorTransport::MetadataProxy => TransportKind::MetadataProxy,
                    ErrorTransport::BrowserSession => TransportKind::BrowserSession,
                    ErrorTransport::Native => TransportKind::Native,
                    ErrorTransport::DisplayOnly => TransportKind::DisplayOnly,
                };
                self.engine_job()?.note_metadata_failure(
                    EngineEffectId(request),
                    ErrorDto {
                        code: failure.code.clone(),
                        phase: ErrorPhase::Discovery,
                        retryable: failure.retryable,
                        message: failure.message.clone(),
                        recovery: failure.recovery.clone(),
                        request: Some(context.uri),
                        transport: Some(failure.transport),
                        blocked_reason: failure.blocked_reason,
                        resource_kind: Some(ResourceKind::Metadata),
                        http: failure.http,
                        preview: failure.preview.clone(),
                        detail: failure.detail.clone(),
                    },
                );
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
    /// host effects verbatim. Job state travels only in the absolute
    /// snapshot the dispatch returns alongside; hosts render it directly
    /// and never refold a message stream.
    fn drain_update(&mut self, update: EngineUpdate) -> Vec<HostEffect> {
        update
            .effects
            .iter()
            .filter_map(|effect| self.project_effect(effect))
            .collect()
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
            } => Some(HostEffect::WaitRetryTimer {
                effect: id.get(),
                tile: *tile,
                attempt: *attempt,
                delay_ms: *delay_ms,
            }),
            EngineEffect::FinalizeOutput {
                id,
                partial,
                canvas,
            } => Some(HostEffect::FinalizeOutput {
                effect: id.get(),
                partial: *partial,
                format: dezoomify_protocol::dto::OutputFormat::Png,
                canvas: canvas.map(|size| SizeDto {
                    width: u64::from(size.width),
                    height: u64::from(size.height),
                }),
            }),
            EngineEffect::RequestPartialDecision {
                id: _, generation, ..
            } => Some(HostEffect::RequestDecision {
                generation: *generation,
            }),
            EngineEffect::CancelRelease { .. } => Some(HostEffect::CancelWork),
        }
    }
}
