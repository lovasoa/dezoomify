//! Deterministic portable job state machine.
//!
//! The job decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. Hosts feed
//! explicit [`JobCommand`] inputs and drain the ordered effect queue.
//! All counters use checked arithmetic.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::Vec2d;
use crate::core::adaptive::{DiscoverableStep, ObservationResult, ProbeContinuation};
use crate::core::discovery::{
    DiscoveryError, DiscoveryOperation, FetchCause, ResourceFailure, ResourceResponse,
};
use crate::core::model::{DiscoveredEntry, DiscoveryCatalog, TileRole, TileSpec};
use crate::core::registry::{default_registry, registry_for};
use crate::core::tile_plan::TileSource;
use crate::core::tile_plan::TileSourceError;

use crate::engine::config::Config;
use crate::engine::engine_api::DiscoveryInput;
use crate::engine::retry::{TileFailure, retry_delay_ms};
use crate::engine::state::State;
use crate::engine::transition::{JobCommand, JobEffect, JobError, Outcome};
use crate::model::RecoveryChoice;

/// One scheduled tile retry: the engine-minted attempt number plus the
/// explicit host wait. The host owns the clock and reports the elapsed
/// timer back with the same tile and attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PendingRetry {
    tile: u32,
    attempt: u32,
    delay_ms: u64,
    timer_issued: bool,
}

/// Selection phase data. Exactly one variant is live, so an image answer
/// cannot exist while awaiting an image, a level answer cannot exist
/// before its image, and decided data cannot leak across phase exits:
/// leaving a phase moves the discriminant, dropping the old payload.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Selection {
    /// No image chosen yet (`AwaitingImageSelection`).
    #[default]
    AwaitingImage,
    /// Image chosen, level still open (`AwaitingLevelSelection`).
    AwaitingLevel { image: u32 },
    /// Image and level chosen (planning and everything after).
    Selected { image: u32, level: u32 },
}

impl Selection {
    fn image_position(&self) -> Option<u32> {
        match *self {
            Selection::AwaitingImage => None,
            Selection::AwaitingLevel { image } | Selection::Selected { image, .. } => Some(image),
        }
    }

    fn level_position(&self) -> Option<u32> {
        match *self {
            Selection::Selected { level, .. } => Some(level),
            Selection::AwaitingImage | Selection::AwaitingLevel { .. } => None,
        }
    }
}

/// Partial-decision phase data. `Pending` exists only while
/// `AwaitingPartialDecision` is live; answering (or leaving) the phase
/// returns the discriminant to `None`, so decided data cannot survive
/// the phase exit and answering with none pending is a single-check
/// rejection on this discriminant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Decision {
    #[default]
    None,
    Pending {
        generation: u32,
    },
}

/// Finalization phase data. `Pending` exists only while `Finalizing` is
/// live; settling the phase returns the discriminant to `Idle`, so the
/// partial flag cannot leak into (or out of) finalization.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Finalization {
    #[default]
    Idle,
    Pending {
        partial: bool,
    },
}

/// Outstanding probe flight. The continuation, its wire tile, and the
/// output-reuse flag are set and cleared as one unit: exactly one probe
/// is ever in flight, so none of the three can exist without the others.
struct ActiveProbe {
    continuation: ProbeContinuation,
    tile: u32,
    output: bool,
}

type TileCursor = Box<dyn Iterator<Item = Result<TileSpec, TileSourceError>> + Send>;

/// One byte of durable scheduling state per plan position. Full requests
/// live only while a tile is active or retained for retry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
enum TileStatus {
    #[default]
    Pending,
    InFlight,
    RetryWaiting,
    RetryReady,
    Acquired,
    Failed,
}

/// One end-to-end user request driven synchronously by explicit host inputs.
pub struct Job {
    inputs: Vec<DiscoveryInput>,
    input_index: usize,
    config: Config,
    /// Format selector: `None` auto-detects via `default_registry`;
    /// `Some(name)` selects the single named program via `registry_for`
    /// (`auto` also means auto-detect). Unknown names fail `start()` with
    /// typed `job.unknown-format`.
    format: Option<String>,
    state: State,
    effects: VecDeque<JobEffect>,
    /// Outstanding discovery resource fetches: request sequence -> core id.
    pending_discovery: HashMap<u32, usize>,
    /// Core discovery operation while discovery is in flight.
    discovery: Option<DiscoveryOperation>,
    /// Finished core catalog.
    catalog: Option<DiscoveryCatalog>,
    selection: Selection,
    finalization: Finalization,
    cleanup_emitted: bool,
    /// Lazy row-major plan cursor. It materializes requests only as slots
    /// become available; the byte ledger tracks not-yet-generated tiles.
    tile_cursor: Option<TileCursor>,
    tile_status: Vec<TileStatus>,
    tile_total: u32,
    acquired_count: u32,
    /// Ready retries are the only queued tile IDs; ordinary work comes from
    /// `tile_cursor` and needs no O(tilecount) queue or set.
    retry_queue: VecDeque<u32>,
    in_flight: HashSet<u32>,
    tile_attempts: Vec<u32>,
    /// Complete tile descriptor by wire id (planned, retry, and probe tiles).
    tile_specs: HashMap<u32, TileSpec>,
    /// Declared canvas size for the planned level (`None` while unknown,
    /// e.g. mid-probe or custom layouts that derive it from tiles).
    canvas_size: Option<Vec2d>,
    /// Pending probe flight (continuation plus its wire tile and
    /// output-reuse flag as one unit); exactly one probe is in flight.
    probe: Option<ActiveProbe>,
    retained_probe: Option<(u32, Vec2d)>,
    probes_emitted: u32,
    decision: Decision,
    failed_tiles: Vec<u32>,
    /// Planned tiles neither acquired nor settled-as-failed. Drives the
    /// settle check in O(1); incremented only when a retry round requeues.
    unsettled: usize,
    /// Structured failure facts per settled-as-failed tile, in arrival
    /// order. Backs the full missing detail for partial handling; cleared
    /// for requeued tiles when a retry round restarts.
    tile_failure_log: HashMap<u32, Vec<TileFailure>>,
    /// Retry timers awaiting their host-reported completion, in issue
    /// order. `timer_issued` marks entries the host already holds a
    /// `WaitForRetry` effect for; entries created while paused are issued
    /// on resume instead. Outstanding timers never exceed the concurrency
    /// gate, so the completion lookup scans a bounded deque.
    pending_retry_timers: VecDeque<PendingRetry>,
    /// Elapsed retries deferred while paused; re-driven on resume.
    ready_retries: Vec<(u32, u32)>,
    /// Whether the in-flight discovery is a same-job deferred follow
    /// (failures end the job instead of advancing the input list).
    following_deferred: bool,
    /// Same-job deferred follows consumed so far (bounded by config).
    deferred_follows: u32,
    /// Discovery URIs already consumed by this job (cycle guard covering
    /// initial inputs plus every followed URI).
    visited_uris: HashSet<String>,
    terminal: Option<String>,
    /// Stable code and message behind a `Failed` terminal, retained for
    /// snapshot projection (events are drained, facts must persist).
    terminal_error: Option<(String, String)>,
    /// Pause overlay (suspend-acquisition): when true the engine stops
    /// scheduling new `acquire-tile` effects, finishes in-flight work,
    /// retains decoded output, and re-drives on resume. The 19 `State`
    /// variants are unchanged; pause is orthogonal to state.
    paused: bool,
    next_request: u32,
    next_decision: u32,
    next_probe: u32,
}

impl std::fmt::Debug for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The core discovery operation is not `Debug`; the machine summary
        // stays informative without it.
        f.debug_struct("Job")
            .field("state", &self.state)
            .field("terminal", &self.terminal)
            .finish()
    }
}

impl Job {
    pub fn new(inputs: Vec<DiscoveryInput>, config: Config) -> Self {
        let visited_uris: HashSet<String> = inputs.iter().map(|input| input.url.clone()).collect();
        Self {
            inputs,
            input_index: 0,
            config,
            format: None,
            state: State::Created,
            effects: VecDeque::new(),
            pending_discovery: HashMap::new(),
            discovery: None,
            catalog: None,
            selection: Selection::AwaitingImage,
            finalization: Finalization::Idle,
            cleanup_emitted: false,
            tile_cursor: None,
            tile_status: Vec::new(),
            tile_total: 0,
            acquired_count: 0,
            retry_queue: VecDeque::new(),
            in_flight: HashSet::new(),
            tile_attempts: Vec::new(),
            tile_specs: HashMap::new(),
            canvas_size: None,
            probe: None,
            retained_probe: None,
            probes_emitted: 0,
            decision: Decision::None,
            failed_tiles: Vec::new(),
            unsettled: 0,
            tile_failure_log: HashMap::new(),
            pending_retry_timers: VecDeque::new(),
            ready_retries: Vec::new(),
            following_deferred: false,
            deferred_follows: 0,
            visited_uris,
            terminal: None,
            terminal_error: None,
            paused: false,
            next_request: 0,
            next_decision: 0,
            next_probe: 0,
        }
    }

    /// Current state.
    #[must_use]
    pub fn state(&self) -> State {
        self.state
    }

    /// Terminal event kind once terminal, else `None`.
    #[must_use]
    pub fn terminal_kind(&self) -> Option<&str> {
        self.terminal.as_deref()
    }

    /// Whether the pause overlay is active (suspend-acquisition).
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Structured failure facts for tiles settled as failed, in arrival
    /// order per tile. This is the full missing detail behind a partial
    /// decision; empty while acquisition is still settling.
    #[must_use]
    pub fn missing_detail(&self) -> Vec<(u32, Vec<TileFailure>)> {
        let mut detail: Vec<(u32, Vec<TileFailure>)> = self
            .tile_failure_log
            .iter()
            .map(|(tile, failures)| (*tile, failures.clone()))
            .collect();
        detail.sort_by_key(|(tile, _)| *tile);
        detail
    }

    /// Acquisition progress as `(acquired, total)` over the planned tiles.
    #[must_use]
    pub fn acquisition_progress(&self) -> (u64, u64) {
        (u64::from(self.acquired_count), u64::from(self.tile_total))
    }

    /// Selected image position, once chosen.
    #[must_use]
    pub fn selected_image(&self) -> Option<u32> {
        self.selection.image_position()
    }

    /// Selected level position, once chosen.
    #[must_use]
    pub fn selected_level(&self) -> Option<u32> {
        self.selection.level_position()
    }

    /// Outstanding partial-decision generation, if one is awaited.
    #[must_use]
    pub fn pending_decision(&self) -> Option<u32> {
        match self.decision {
            Decision::Pending { generation } => Some(generation),
            Decision::None => None,
        }
    }

    /// Declared canvas size for the planned level, when known.
    #[must_use]
    pub fn canvas_size(&self) -> Option<Vec2d> {
        self.canvas_size
    }

    /// Take issued effects exactly once in deterministic order.
    #[must_use]
    pub fn drain_effects(&mut self) -> Vec<JobEffect> {
        self.effects.drain(..).collect()
    }

    #[must_use]
    pub fn catalog(&self) -> Option<&DiscoveryCatalog> {
        self.catalog.as_ref()
    }

    #[must_use]
    pub fn level_count(&self, image: u32) -> u32 {
        usize::try_from(image)
            .ok()
            .and_then(|index| self.catalog.as_ref()?.entries().get(index))
            .map(|entry| match entry {
                DiscoveredEntry::Ready(image) => {
                    u32::try_from(image.levels.len()).unwrap_or(u32::MAX)
                }
                DiscoveredEntry::Deferred(_) => 0,
            })
            .unwrap_or(0)
    }

    #[must_use]
    pub fn terminal_error(&self) -> Option<&(String, String)> {
        self.terminal_error.as_ref()
    }

    /// Set the format selector before [`Job::start`]: `None` auto-detects,
    /// `Some("auto")` also auto-detects, otherwise the single named program
    /// is selected (case-insensitive, matching the core `registry_for`).
    /// Unknown names fail `start()` with typed `job.unknown-format`.
    pub fn set_format(&mut self, format: Option<String>) {
        self.format = format;
    }

    /// Validate start and enter `Discovering` with one metadata fetch effect.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] when called outside `Created`, on overflow, or
    /// for an unknown named format (`job.unknown-format`).
    pub fn start(&mut self) -> Result<Outcome, JobError> {
        if self.terminal.is_some() {
            return Err(JobError::post_terminal());
        }
        if self.state != State::Created {
            return Err(JobError::invalid_state("start is valid only in Created"));
        }
        if let Some(name) = self.format.as_deref()
            && name != "auto"
            && registry_for(name).is_none()
        {
            return Err(JobError::new(
                "job.unknown-format",
                format!("unknown format '{name}'"),
            ));
        }
        self.set_state(State::Discovering)?;
        self.start_current_input()?;
        Ok(Outcome::Applied)
    }

    fn start_current_input(&mut self) -> Result<(), JobError> {
        let input = self.inputs[self.input_index].clone();
        let registry = match self.format.as_deref() {
            None | Some("auto") => default_registry(&input.url),
            Some(name) => registry_for(name).expect("validated by start"),
        };
        self.discovery = Some(registry.start(input.url.clone()));
        if let Some(contents) = input.contents {
            let len = u64::try_from(contents.len()).unwrap_or(u64::MAX);
            if contents.is_empty() || len > self.config.max_bytes {
                return self.try_next_input(DiscoveryError::MetadataSizeLimitExceeded);
            }
            let need = match self
                .discovery
                .as_mut()
                .expect("set above")
                .next_priority_need()
            {
                Ok(Some(need)) => need,
                Ok(None) => return self.drive_discovery(),
                Err(error) => return self.try_next_input(error),
            };
            let response = ResourceResponse::new(need.id, contents).with_final_uri(input.url);
            if let Err(error) = self
                .discovery
                .as_mut()
                .expect("set above")
                .provide(response)
            {
                return self.try_next_input(error);
            }
        }
        self.drive_discovery()
    }

    fn try_next_input(&mut self, error: DiscoveryError) -> Result<(), JobError> {
        // A failed same-job deferred follow ends the job: there is no input
        // list position to advance to, and the visited set already guards
        // against retrying the same URI.
        if self.following_deferred {
            self.following_deferred = false;
            self.pending_discovery.clear();
            self.discovery = None;
            return self.fail_via_cleanup("job.discovery-failed", error.engine_detail());
        }
        self.pending_discovery.clear();
        self.discovery = None;
        self.input_index += 1;
        if self.input_index < self.inputs.len() {
            self.start_current_input()
        } else {
            let no_candidate = matches!(error, DiscoveryError::NoCandidateAccepted { .. });
            let code = if no_candidate && self.format.is_none() {
                "job.no-images"
            } else {
                "job.discovery-failed"
            };
            self.fail_via_cleanup(code, error.engine_detail())
        }
    }

    /// Drive one deterministic transition from an explicit host response.
    ///
    /// Post-terminal inputs are stably rejected with no new work. Duplicates
    /// are ignored. Valid inputs advance state and queue
    /// effects for facade-managed revisions.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] for post-terminal, invalid-state, and
    /// counter-overflow rejections.
    pub fn on_command(&mut self, response: JobCommand) -> Result<Outcome, JobError> {
        if self.terminal.is_some() {
            return Err(JobError::post_terminal());
        }
        match response {
            JobCommand::Cancel => self.enter_cancelled(),
            JobCommand::Pause => self.apply_pause(),
            JobCommand::Resume => self.apply_resume(),
            JobCommand::ResourceBytes {
                request,
                bytes,
                final_uri,
            } => self.apply_resource_bytes(request, bytes, final_uri),
            JobCommand::FetchFailure { request, cause } => self.apply_fetch_failure(request, cause),
            JobCommand::SelectImage { image } => self.apply_selected_image(image),
            JobCommand::FollowDeferred { image } => self.apply_follow_deferred(image),
            JobCommand::SelectLevel { level } => self.apply_selected_level(level),
            JobCommand::TileAcquired { tile } | JobCommand::TileDisplayed { tile } => {
                self.apply_tile_success(tile)
            }
            JobCommand::TileFailed { tile, failure } => self.apply_tile_failed(tile, failure),
            JobCommand::RetryTimerElapsed { tile, attempt } => {
                self.apply_retry_timer_elapsed(tile, attempt)
            }
            JobCommand::ProbeOutcome { tile, outcome } => self.apply_probe_outcome(tile, outcome),
            JobCommand::RecoveryChoice { generation, choice } => {
                self.apply_recovery_choice(generation, choice)
            }
            JobCommand::FinalizationSucceeded => self.apply_finalization_succeeded(),
            JobCommand::FinalizationFailed { code, message } => {
                self.apply_finalization_failed(code, message)
            }
        }
    }

    /// Emit one acquire-resource effect per outstanding core discovery
    /// request, or finish the discovery and emit the real catalog when the
    /// core needs nothing more. Core discovery is a poll: the same request
    /// is reported until its outcome is provided, so this must never loop
    /// on `next_priority_need` waiting for an unanswered fetch. The batch
    /// form returns every outstanding request at once; an empty batch means
    /// the catalog is complete.
    fn drive_discovery(&mut self) -> Result<(), JobError> {
        let needs = {
            let Some(operation) = self.discovery.as_mut() else {
                return Ok(());
            };
            match operation.missing_resources() {
                Ok(needs) => needs,
                Err(e) => return self.discovery_failed(e),
            }
        };
        if needs.is_empty() {
            return self.finish_discovery();
        }
        for need in needs {
            // One wire request per core request: re-driving after one
            // response must not duplicate effects for fetches that are
            // still outstanding.
            if self
                .pending_discovery
                .values()
                .any(|&core_id| core_id == need.id.0)
            {
                continue;
            }
            let wire = self.alloc_request_id()?;
            self.pending_discovery.insert(wire, need.id.0);
            let mut header_names: Vec<String> = need
                .request
                .headers
                .iter()
                .map(|header| header.name.clone())
                .collect();
            header_names.sort();
            self.push_effect(JobEffect::AcquireResource {
                request: wire,
                uri: need.request.uri,
                header_names,
            })?;
        }
        Ok(())
    }

    /// Finish the core discovery and project the real catalog.
    fn finish_discovery(&mut self) -> Result<(), JobError> {
        let Some(operation) = self.discovery.take() else {
            return Ok(());
        };
        let catalog = match operation.finish() {
            Ok(catalog) => catalog,
            Err(e) => return self.discovery_failed(e),
        };
        let catalog = catalog.normalize();
        if catalog.is_empty() {
            return self
                .fail_via_cleanup("job.no-images", "discovery produced no images".to_string());
        }
        self.catalog = Some(catalog);
        // A followed catalog replaces the superseded one in the same job;
        // the follow flag clears so later failures route normally again.
        self.following_deferred = false;
        // Sibling discovery fetches still in flight are moot once the
        // catalog wins; drop them so late answers are plain duplicates.
        self.pending_discovery.clear();
        self.set_state(State::AwaitingImageSelection)?;
        Ok(())
    }

    fn discovery_failed(&mut self, error: DiscoveryError) -> Result<(), JobError> {
        self.try_next_input(error)
    }

    fn apply_resource_bytes(
        &mut self,
        request: u32,
        bytes: Vec<u8>,
        final_uri: Option<String>,
    ) -> Result<Outcome, JobError> {
        let Some(&core_id) = self.pending_discovery.get(&request) else {
            return Ok(Outcome::Ignored);
        };
        // Batch discovery emits one effect per outstanding core need; the
        // first answer may complete discovery while sibling fetches are
        // still in flight. Late answers for still-pending requests are
        // moot and safely ignored so the winning catalog survives.
        if self.state != State::Discovering {
            self.pending_discovery.remove(&request);
            return Ok(Outcome::Ignored);
        }
        let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if len > self.config.max_bytes {
            self.pending_discovery.remove(&request);
            self.discovery = None;
            self.fail_via_cleanup(
                "job.resource-limit",
                format!("resource bytes {len} exceed max_bytes"),
            )?;
            return Ok(Outcome::Applied);
        }
        if bytes.is_empty() {
            self.pending_discovery.remove(&request);
            self.discovery = None;
            self.fail_via_cleanup(
                "job.empty-resource",
                "empty resource cannot yield a catalog".to_string(),
            )?;
            return Ok(Outcome::Applied);
        }
        let outcome = {
            let Some(operation) = self.discovery.as_mut() else {
                return Err(JobError::invalid_state("discovery already finished"));
            };
            let response = ResourceResponse::new(crate::core::discovery::RequestId(core_id), bytes);
            // Relative tile URLs resolve against the post-redirect URL the
            // host actually read; without it the core falls back to the
            // request URI it asked for. Empty values collapse to missing so
            // a proxied fetch without a redirect URL never produces
            // page-relative tile URLs.
            let response = match final_uri.filter(|uri| !uri.is_empty()) {
                Some(uri) => response.with_final_uri(uri),
                None => response,
            };
            operation.provide(response)
        };
        if let Err(e) = outcome {
            self.pending_discovery.remove(&request);
            self.try_next_input(e)?;
            return Ok(Outcome::Applied);
        }
        self.pending_discovery.remove(&request);
        self.drive_discovery()?;
        Ok(Outcome::Applied)
    }

    fn apply_fetch_failure(
        &mut self,
        request: u32,
        cause: FetchCause,
    ) -> Result<Outcome, JobError> {
        let Some(&core_id) = self.pending_discovery.get(&request) else {
            return Ok(Outcome::Ignored);
        };
        // Sibling discovery fetches may still fail after a winner already
        // completed discovery; those late failures are moot and ignored.
        if self.state != State::Discovering {
            self.pending_discovery.remove(&request);
            return Ok(Outcome::Ignored);
        }
        let core_id = crate::core::discovery::RequestId(core_id);
        // The core owns candidate fallback on failure: it may surface another
        // need (a different candidate) or end discovery with a typed error.
        let outcome = {
            let Some(operation) = self.discovery.as_mut() else {
                return Err(JobError::invalid_state("discovery already finished"));
            };
            operation.provide_failure(ResourceFailure { id: core_id, cause })
        };
        self.pending_discovery.remove(&request);
        if let Err(e) = outcome {
            self.try_next_input(e)?;
            return Ok(Outcome::Applied);
        }
        self.drive_discovery()?;
        Ok(Outcome::Applied)
    }

    fn apply_selected_image(&mut self, image: u32) -> Result<Outcome, JobError> {
        // A repeat of the decided image is a duplicate, whatever the phase.
        if self.selection.image_position() == Some(image) {
            return Ok(Outcome::Ignored);
        }
        if self.state != State::AwaitingImageSelection
            || !matches!(self.selection, Selection::AwaitingImage)
        {
            return Err(JobError::invalid_state(
                "image selection valid only in AwaitingImageSelection",
            ));
        }
        let index = usize::try_from(image).map_err(|_| JobError::overflow("image position"))?;
        let selected = self
            .catalog
            .as_ref()
            .and_then(|catalog| catalog.entries().get(index))
            .ok_or_else(|| JobError::invalid_state("image position is out of range"))?;
        let DiscoveredEntry::Ready(_) = selected else {
            return Err(JobError::invalid_state(
                "image metadata was not fetched; the image cannot be selected",
            ));
        };
        self.selection = Selection::AwaitingLevel { image };
        self.set_state(State::AwaitingLevelSelection)?;
        Ok(Outcome::Applied)
    }

    /// Follow one still-deferred catalog entry within the same job.
    ///
    /// The follow is bounded by `max_deferred_follows` and guarded against
    /// cycles by the visited-URI set: the same URI is never fetched twice
    /// by one job. The catalog is replaced on success; the job ID and
    /// revision lineage never change, so hosts never fork replacement jobs.
    fn apply_follow_deferred(&mut self, image: u32) -> Result<Outcome, JobError> {
        if self.state != State::AwaitingImageSelection
            || !matches!(self.selection, Selection::AwaitingImage)
        {
            return Err(JobError::invalid_state(
                "deferred follow valid only before image selection",
            ));
        }
        if self.config.max_deferred_follows == 0 {
            return Err(JobError::invalid_state("deferred follows are disabled"));
        }
        if self.deferred_follows >= self.config.max_deferred_follows {
            return Err(JobError::invalid_state("deferred follow budget exhausted"));
        }
        let index = usize::try_from(image).map_err(|_| JobError::overflow("image position"))?;
        let uri = match self
            .catalog
            .as_ref()
            .and_then(|catalog| catalog.entries().get(index))
        {
            Some(DiscoveredEntry::Deferred(deferred)) => deferred.uri.clone(),
            Some(DiscoveredEntry::Ready(_)) => {
                return Err(JobError::invalid_state(
                    "image is ready; only deferred entries are followed",
                ));
            }
            None => {
                return Err(JobError::invalid_state("image position is out of range"));
            }
        };
        if !self.visited_uris.insert(uri.clone()) {
            return Err(JobError::invalid_state(
                "deferred cycle: this URI was already consumed by the job",
            ));
        }
        self.deferred_follows = self
            .deferred_follows
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("deferred follows"))?;
        // Sibling discovery fetches from the superseded catalog are moot.
        self.pending_discovery.clear();
        self.following_deferred = true;
        let registry = match self.format.as_deref() {
            None | Some("auto") => default_registry(&uri),
            Some(name) => registry_for(name).expect("validated by start"),
        };
        self.discovery = Some(registry.start(uri));
        self.set_state(State::Discovering)?;
        self.drive_discovery()?;
        Ok(Outcome::Applied)
    }

    fn apply_selected_level(&mut self, level: u32) -> Result<Outcome, JobError> {
        // A repeat of the decided level is a duplicate, whatever the phase.
        if self.selection.level_position() == Some(level) {
            return Ok(Outcome::Ignored);
        }
        if self.state != State::AwaitingLevelSelection {
            return Err(JobError::invalid_state(
                "level selection valid only in AwaitingLevelSelection",
            ));
        }
        let Selection::AwaitingLevel { image } = self.selection else {
            return Err(JobError::invalid_state("no image selected"));
        };
        let image_index =
            usize::try_from(image).map_err(|_| JobError::overflow("image position"))?;
        let level_index =
            usize::try_from(level).map_err(|_| JobError::overflow("level position"))?;
        let in_range = match self
            .catalog
            .as_ref()
            .and_then(|catalog| catalog.entries().get(image_index))
        {
            Some(DiscoveredEntry::Ready(image)) => image.levels.get(level_index).is_some(),
            Some(DiscoveredEntry::Deferred(_)) | None => false,
        };
        if !in_range {
            return Err(JobError::invalid_state("level position is out of range"));
        }
        self.selection = Selection::Selected { image, level };
        self.set_state(State::Planning)?;
        self.plan_selected_level()?;
        Ok(Outcome::Applied)
    }

    /// Plan the selected level from its real core tile source.
    fn plan_selected_level(&mut self) -> Result<(), JobError> {
        let source = {
            let catalog = self
                .catalog
                .as_ref()
                .ok_or_else(|| JobError::invalid_state("no catalog"))?;
            let Selection::Selected { image, level } = self.selection else {
                return Err(JobError::invalid_state("no level selected"));
            };
            let image_index = usize::try_from(image)
                .map_err(|_| JobError::overflow("selected image position"))?;
            let level_index = usize::try_from(level)
                .map_err(|_| JobError::overflow("selected level position"))?;
            let Some(entry) = catalog.entries().get(image_index) else {
                return self.fail_via_cleanup(
                    "job.plan-invalid",
                    "selected image position is out of range".to_string(),
                );
            };
            let DiscoveredEntry::Ready(image) = entry else {
                return self.fail_via_cleanup(
                    "job.plan-invalid",
                    "selected image metadata was not fetched".to_string(),
                );
            };
            let Some(selected_level) = image.levels.get(level_index) else {
                return self.fail_via_cleanup(
                    "job.plan-invalid",
                    "selected level position is out of range".to_string(),
                );
            };
            selected_level.source.clone()
        };
        match source {
            TileSource::Grid(grid) => {
                let canvas = Some(grid.image_size());
                let total = grid.count();
                self.plan_from_tiles(Box::new(grid.tiles_row_major()), total, canvas)
            }
            TileSource::Positioned(positioned) => {
                let canvas = positioned.image_size();
                let total = positioned.count();
                self.plan_from_tiles(Box::new(positioned.tiles()), total, canvas)
            }
            TileSource::DiscoverableGrid(discoverable) => self.drive_probe(discoverable.start()),
            TileSource::Adaptive(adaptive) => self.drive_probe(adaptive.start()),
        }
    }

    /// Plan from a fully known tile iterator (grid or positioned source).
    /// Probe-role tiles never reach the output plan; the host learns
    /// geometry, headers, and processing per tile from its `acquire-tile`
    /// effect so native assembly matches core layout exactly.
    fn plan_from_tiles(
        &mut self,
        tiles: TileCursor,
        total: u64,
        canvas: Option<Vec2d>,
    ) -> Result<(), JobError> {
        if total == 0 {
            return self.fail_via_cleanup(
                "job.plan-empty",
                "the selected level has no tiles".to_string(),
            );
        }
        if total > u64::from(self.config.max_tiles) {
            return self.fail_via_cleanup(
                "job.resource-limit",
                format!("tile plan exceeds max_tiles {}", self.config.max_tiles),
            );
        }
        let total = u32::try_from(total).map_err(|_| JobError::overflow("tile count"))?;
        self.canvas_size = canvas;
        self.begin_acquisition(tiles, total)
    }

    /// Advance the core probe step machine by one step.
    fn drive_probe(&mut self, step: DiscoverableStep) -> Result<(), JobError> {
        match step {
            DiscoverableStep::Resolved {
                grid,
                previously_output,
            } => {
                let canvas = Some(grid.image_size());
                let total = grid.count();
                self.plan_from_tiles_reusing(
                    Box::new(grid.tiles_row_major()),
                    total,
                    canvas,
                    &previously_output,
                )
            }
            DiscoverableStep::Empty => self.fail_via_cleanup(
                "job.plan-empty",
                "probe discovery found no tiles".to_string(),
            ),
            DiscoverableStep::Error(e) => self.fail_via_cleanup("job.plan-invalid", e.to_string()),
            DiscoverableStep::Probe { tile, continuation } => {
                self.probes_emitted = self
                    .probes_emitted
                    .checked_add(1)
                    .ok_or_else(|| JobError::overflow("probe count"))?;
                if self.probes_emitted > self.config.max_tiles {
                    return self.fail_via_cleanup(
                        "job.resource-limit",
                        format!("probe count exceeds max_tiles {}", self.config.max_tiles),
                    );
                }
                let probe_output = tile.role == TileRole::ProbeAndOutput;
                let wire = if probe_output {
                    tile.ordinal
                } else {
                    let wire = self.next_probe;
                    self.next_probe = self
                        .next_probe
                        .checked_add(1)
                        .ok_or_else(|| JobError::overflow("probe id"))?;
                    wire
                };
                // The flight is one unit: continuation, wire tile, and the
                // reuse flag are set together and cleared together.
                self.probe = Some(ActiveProbe {
                    continuation,
                    tile: wire,
                    output: probe_output,
                });
                self.tile_specs.insert(wire, tile.clone());
                self.in_flight.insert(wire);
                self.push_acquire_tile(wire, true, probe_output)?;
                Ok(())
            }
        }
    }

    fn plan_from_tiles_reusing(
        &mut self,
        tiles: TileCursor,
        total: u64,
        canvas: Option<Vec2d>,
        previously_output: &[Vec2d],
    ) -> Result<(), JobError> {
        self.retained_probe = self
            .retained_probe
            .filter(|(_, destination)| previously_output.contains(destination));
        self.plan_from_tiles(tiles, total, canvas)
    }

    /// Shared transition from a complete plan into bounded acquisition.
    fn begin_acquisition(&mut self, tiles: TileCursor, total: u32) -> Result<(), JobError> {
        // Any probe flight ended with the resolved plan: the plan owns the
        // tiles now (a reused `probe_output` tile arrives via `retained_probe`
        // below, never via the probe flight).
        let retained_id = self.retained_probe.map(|(tile, _)| tile);
        self.probe = None;
        self.tile_cursor = Some(tiles);
        self.tile_status.clear();
        self.tile_status.resize(total as usize, TileStatus::Pending);
        self.tile_attempts.clear();
        self.tile_attempts.resize(total as usize, 0);
        self.tile_total = total;
        self.acquired_count = 0;
        self.retry_queue.clear();
        self.in_flight.clear();
        self.failed_tiles.clear();
        self.tile_specs.retain(|wire, _| Some(*wire) == retained_id);
        if let Some((tile, destination)) = self.retained_probe.take() {
            if tile < total
                && self.tile_specs.get(&tile).map(|spec| spec.destination) == Some(destination)
            {
                self.tile_status[tile as usize] = TileStatus::Acquired;
                self.acquired_count += 1;
            }
            self.tile_specs.remove(&tile);
        }
        self.unsettled = total.saturating_sub(self.acquired_count) as usize;
        self.set_state(State::AcquiringTiles)?;
        if self.unsettled == 0 {
            self.complete_remaining(false)?;
        } else {
            self.emit_pending_tiles()?;
        }
        Ok(())
    }

    /// Record one successful tile acquisition (`TileAcquired` for decoded
    /// bytes, `TileDisplayed` for an ordinary image element). Both settle
    /// the tile identically: progress advances, and a round with stashed
    /// failures settles into the partial decision once complete.
    fn apply_tile_success(&mut self, tile: u32) -> Result<Outcome, JobError> {
        if self
            .probe
            .as_ref()
            .is_some_and(|flight| flight.tile == tile)
        {
            return Err(JobError::invalid_state(
                "probe tiles are answered with a probe outcome, not a tile success",
            ));
        }
        if self.state != State::AcquiringTiles {
            return Err(JobError::invalid_state(
                "tile success valid only in AcquiringTiles",
            ));
        }
        let Some(status) = self.tile_status.get(tile as usize).copied() else {
            return Err(JobError::invalid_state("tile ordinal is out of range"));
        };
        if matches!(status, TileStatus::Acquired | TileStatus::Failed) {
            // A duplicate completion for settled work cannot alter ledger.
            return Ok(Outcome::Ignored);
        }
        if status != TileStatus::InFlight {
            return Err(JobError::invalid_state(
                "tile success requires an issued acquisition",
            ));
        }
        // The status ledger is authoritative for both cursor and retry
        // work; removing the descriptor releases its request context.
        self.in_flight.remove(&tile);
        self.tile_status[tile as usize] = TileStatus::Acquired;
        self.tile_specs.remove(&tile);
        self.acquired_count += 1;
        self.unsettled = self.unsettled.saturating_sub(1);
        // A success can settle the round when failures are stashed:
        // with every planned tile acquired or settled-as-failed the
        // partial decision carries the complete missing list.
        if !self.failed_tiles.is_empty() {
            self.maybe_enter_partial_decision()?;
            if self.state == State::AwaitingPartialDecision {
                return Ok(Outcome::Applied);
            }
        }
        // Pause: finish in-flight, retain decoded, defer completion
        // and new scheduling until resume. Resume re-drives completion
        // when every tile has arrived while paused.
        if self.paused {
            return Ok(Outcome::Applied);
        }
        if self.unsettled == 0 {
            self.complete_remaining(false)?;
        } else {
            self.emit_pending_tiles()?;
        }
        Ok(Outcome::Applied)
    }

    /// Typed tile failure carrying structured facts instead of one boolean.
    ///
    /// Permanent failures settle the tile after exactly one attempt;
    /// transient failures schedule one explicit retry timer per remaining
    /// attempt. A settled-as-failed tile joins the partial decision only
    /// after acquisition settles (nothing in flight, queued, or awaiting a
    /// timer), so late successes still count and the missing list stays
    /// complete.
    fn apply_tile_failed(&mut self, tile: u32, failure: TileFailure) -> Result<Outcome, JobError> {
        if self
            .probe
            .as_ref()
            .is_some_and(|flight| flight.tile == tile)
        {
            return Err(JobError::invalid_state(
                "probe tiles are answered with a probe outcome, not a tile failure",
            ));
        }
        if self.state != State::AcquiringTiles {
            return Err(JobError::invalid_state(
                "tile failure valid only in AcquiringTiles",
            ));
        }
        let Some(status) = self.tile_status.get(tile as usize).copied() else {
            return Err(JobError::invalid_state("tile ordinal is out of range"));
        };
        if matches!(status, TileStatus::Acquired | TileStatus::Failed) {
            return Ok(Outcome::Ignored);
        }
        if status != TileStatus::InFlight {
            return Err(JobError::invalid_state(
                "tile failure requires an issued acquisition",
            ));
        }
        let attempt = self.tile_attempts[tile as usize]
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("tile attempts"))?;
        self.tile_attempts[tile as usize] = attempt;
        self.in_flight.remove(&tile);
        self.tile_failure_log
            .entry(tile)
            .or_default()
            .push(failure.clone());
        if failure.is_retryable() && attempt <= self.config.max_retries {
            self.tile_status[tile as usize] = TileStatus::RetryWaiting;
            // Attempts count the initial try: the first failure schedules
            // retry-timer 1, whose completion re-issues the second try.
            let delay_ms = retry_delay_ms(
                attempt,
                failure.retry_after_ms,
                self.config.retry_base_delay_ms,
            );
            let timer_issued = !self.paused;
            self.pending_retry_timers.push_back(PendingRetry {
                tile,
                attempt,
                delay_ms,
                timer_issued,
            });
            // While paused the timer stays pending and is issued on resume;
            // no new `acquire-tile` while paused.
            if timer_issued {
                self.push_effect(JobEffect::WaitForRetry {
                    tile,
                    attempt,
                    delay_ms,
                })?;
            }
            // A retry timer occupies no acquisition slot. Keep the rest of
            // the lazy plan moving while this tile waits for its retry.
            self.emit_pending_tiles()?;
            return Ok(Outcome::Applied);
        }
        self.stash_failed_tile(tile);
        self.maybe_enter_partial_decision()?;
        if self.state == State::AcquiringTiles {
            self.emit_pending_tiles()?;
        }
        Ok(Outcome::Applied)
    }

    /// Host-reported elapsed retry timer. Stale or duplicate completions
    /// (no matching pending timer) are ignored. While paused the retry is
    /// parked and re-driven on resume; otherwise the tile rejoins the
    /// acquisition queue immediately.
    fn apply_retry_timer_elapsed(&mut self, tile: u32, attempt: u32) -> Result<Outcome, JobError> {
        if self.state != State::AcquiringTiles {
            return Err(JobError::invalid_state(
                "retry timer completion valid only in AcquiringTiles",
            ));
        }
        let position = self
            .pending_retry_timers
            .iter()
            .position(|pending| pending.tile == tile && pending.attempt == attempt);
        let Some(position) = position else {
            return Ok(Outcome::Ignored);
        };
        self.pending_retry_timers.remove(position);
        if matches!(
            self.tile_status.get(tile as usize),
            Some(TileStatus::Acquired | TileStatus::Failed)
        ) {
            return Ok(Outcome::Applied);
        }
        if self.paused {
            self.tile_status[tile as usize] = TileStatus::RetryReady;
            if !self.ready_retries.contains(&(tile, attempt)) {
                self.ready_retries.push((tile, attempt));
            }
            return Ok(Outcome::Applied);
        }
        self.tile_status[tile as usize] = TileStatus::RetryReady;
        if self.tile_specs.contains_key(&tile) {
            self.retry_queue.push_front(tile);
        }
        self.emit_pending_tiles()?;
        Ok(Outcome::Applied)
    }

    /// Record one tile as settled-as-failed (idempotent).
    fn stash_failed_tile(&mut self, tile: u32) {
        if self.tile_status[tile as usize] != TileStatus::Failed {
            self.tile_status[tile as usize] = TileStatus::Failed;
            self.failed_tiles.push(tile);
            self.unsettled = self.unsettled.saturating_sub(1);
        }
    }

    /// Move to the partial decision once acquisition fully settles: every
    /// planned tile is acquired or settled-as-failed (`unsettled == 0`),
    /// nothing is in flight, and no retry timer is outstanding or parked.
    /// Until then failures stay stashed so late successes still count and
    /// the missing list stays complete. All checks are O(1).
    fn maybe_enter_partial_decision(&mut self) -> Result<(), JobError> {
        if self.failed_tiles.is_empty()
            || self.unsettled != 0
            || !self.in_flight.is_empty()
            || !self.retry_queue.is_empty()
            || !self.pending_retry_timers.is_empty()
            || !self.ready_retries.is_empty()
        {
            return Ok(());
        }
        let generation = self.alloc_decision_generation()?;
        self.set_state(State::AwaitingPartialDecision)?;
        self.push_effect(JobEffect::RequestDecision { generation })?;
        Ok(())
    }

    fn apply_probe_outcome(
        &mut self,
        tile: u32,
        outcome: crate::model::ProbeOutcome,
    ) -> Result<Outcome, JobError> {
        // The outstanding flight is the whole gate: no flight means no
        // probe is answerable, and a tile mismatch names a different (or
        // already-settled) probe. The state sync below is a debug-only
        // cross-check; the flight discriminant owns the rejection.
        let flight_output = match self.probe.as_ref() {
            Some(flight) if flight.tile == tile => flight.output,
            _ => {
                return Err(JobError::invalid_state(
                    "probe outcome valid only for the outstanding probe while Planning",
                ));
            }
        };
        debug_assert_eq!(self.state, State::Planning);
        let available = matches!(outcome, crate::model::ProbeOutcome::Available { .. });
        let observation = match outcome {
            crate::model::ProbeOutcome::Available { width, height } => {
                let x =
                    u32::try_from(width.get()).map_err(|_| JobError::overflow("probe width"))?;
                let y =
                    u32::try_from(height.get()).map_err(|_| JobError::overflow("probe height"))?;
                ObservationResult::Available {
                    size: crate::Vec2d { x, y },
                }
            }
            crate::model::ProbeOutcome::Missing => ObservationResult::Missing,
        };
        if available && flight_output {
            let destination = self
                .tile_specs
                .get(&tile)
                .map_or_else(Vec2d::default, |spec| spec.destination);
            if let Some((previous, _)) = self.retained_probe.replace((tile, destination))
                && previous != tile
            {
                self.tile_specs.remove(&previous);
            }
        } else {
            self.tile_specs.remove(&tile);
        }
        let Some(flight) = self.probe.take() else {
            return Err(JobError::invalid_state("no probe continuation pending"));
        };
        self.in_flight.remove(&tile);
        let step = flight
            .continuation
            .submit(observation)
            .map_err(|e| JobError::new("job.plan-invalid", e.to_string()))?;
        self.drive_probe(step)?;
        Ok(Outcome::Applied)
    }

    fn apply_recovery_choice(
        &mut self,
        generation: u32,
        choice: RecoveryChoice,
    ) -> Result<Outcome, JobError> {
        // The decision discriminant owns the rejection: `None` (no decision
        // pending, or an already-answered one) is one check, and a
        // generation mismatch is the stale-answer rejection. The state sync
        // below is a debug-only cross-check; `Pending` exists only while
        // `AwaitingPartialDecision` is live.
        let Decision::Pending {
            generation: expected,
        } = self.decision
        else {
            return Err(JobError::invalid_state(
                "recovery choice valid only while a partial decision is pending",
            ));
        };
        if expected != generation {
            return Err(JobError::invalid_state(
                "recovery choice generation is stale",
            ));
        }
        debug_assert_eq!(self.state, State::AwaitingPartialDecision);
        // Leaving the phase drops the decided payload: decided data cannot
        // survive the phase exit on any arm below.
        self.decision = Decision::None;
        match choice {
            RecoveryChoice::Retry => {
                // Requeue every settled-as-failed tile with a fresh attempt
                // budget for the new round, in plan order; acquired tiles
                // are preserved so success is never re-fetched. Restored
                // tiles rejoin the unsettled count exactly once each.
                let mut requeued: Vec<u32> = std::mem::take(&mut self.failed_tiles);
                requeued.sort_unstable();
                let mut restored = 0usize;
                for tile in requeued {
                    self.tile_attempts[tile as usize] = 0;
                    self.tile_failure_log.remove(&tile);
                    if self.tile_status[tile as usize] != TileStatus::Acquired {
                        self.tile_status[tile as usize] = TileStatus::RetryReady;
                        if self.tile_specs.contains_key(&tile) {
                            self.retry_queue.push_back(tile);
                        }
                        restored = restored.saturating_add(1);
                    }
                }
                self.unsettled = self.unsettled.saturating_add(restored);
                self.set_state(State::AcquiringTiles)?;
                if !self.paused {
                    self.emit_pending_tiles()?;
                }
                Ok(Outcome::Applied)
            }
            RecoveryChoice::Keep => {
                self.complete_remaining(true)?;
                Ok(Outcome::Applied)
            }
            RecoveryChoice::Discard => {
                self.fail_via_cleanup(
                    "job.partial-discarded",
                    "partial result discarded by choice".to_string(),
                )?;
                Ok(Outcome::Applied)
            }
        }
    }

    fn enter_cancelled(&mut self) -> Result<Outcome, JobError> {
        self.paused = false;
        self.set_state(State::Cancelling)?;
        // Exactly one idempotent `cancel-work`: the cleanup gate below
        // owns the emission, so cancellation and failure paths converge.
        self.emit_cleanup_once()?;
        self.tile_cursor = None;
        self.retry_queue.clear();
        self.tile_specs.clear();
        self.set_state(State::Cancelled)?;
        self.terminal = Some("cancelled".to_string());
        Ok(Outcome::Applied)
    }

    /// Pause (suspend-acquisition): stop scheduling new `acquire-tile`
    /// effects, finish in-flight work, retain decoded output. Valid in any
    /// non-terminal state; terminal inputs are already rejected as
    /// post-terminal. FIFO queues are preserved; retry wakeups are preserved
    /// (deferred until resume); hosts still own clocks.
    fn apply_pause(&mut self) -> Result<Outcome, JobError> {
        if self.paused {
            return Ok(Outcome::Ignored);
        }
        self.paused = true;
        Ok(Outcome::Applied)
    }

    /// Resume a paused job (re-drive): clear the overlay and schedule
    /// pending tiles again. If all tiles finished while paused, complete
    /// now; otherwise emit up to the concurrency gate. Cursor order and the
    /// parked retry order are preserved while paused.
    fn apply_resume(&mut self) -> Result<Outcome, JobError> {
        if !self.paused {
            return Err(JobError::invalid_state("resume valid only while paused"));
        }
        self.paused = false;
        // Retry timers created while paused start now: issue one
        // `WaitForRetry` per pending retry the host does not hold yet.
        let unissued: Vec<(u32, u32, u64)> = self
            .pending_retry_timers
            .iter()
            .filter(|pending| !pending.timer_issued)
            .map(|pending| (pending.tile, pending.attempt, pending.delay_ms))
            .collect();
        for (tile, attempt, delay_ms) in unissued {
            if let Some(pending) = self
                .pending_retry_timers
                .iter_mut()
                .find(|pending| pending.tile == tile && pending.attempt == attempt)
            {
                pending.timer_issued = true;
            }
            self.push_effect(JobEffect::WaitForRetry {
                tile,
                attempt,
                delay_ms,
            })?;
        }
        // Elapsed-while-paused retries rejoin the queue now, ahead of
        // never-started tiles so the resumed round finishes in order.
        for (tile, _) in std::mem::take(&mut self.ready_retries) {
            if matches!(
                self.tile_status.get(tile as usize),
                Some(TileStatus::RetryReady)
            ) && self.tile_specs.contains_key(&tile)
            {
                self.retry_queue.push_front(tile);
            }
        }
        if self.state == State::AcquiringTiles
            && self.acquired_count == self.tile_total
            && self.tile_total != 0
        {
            self.complete_remaining(false)?;
        } else if self.state == State::AcquiringTiles {
            self.emit_pending_tiles()?;
        }
        Ok(Outcome::Applied)
    }

    fn complete_remaining(&mut self, partial: bool) -> Result<(), JobError> {
        self.paused = false;
        self.tile_cursor = None;
        self.retry_queue.clear();
        self.tile_specs.clear();
        self.finalization = Finalization::Pending { partial };
        self.set_state(State::Finalizing)?;
        self.push_effect(JobEffect::FinalizeOutput {
            partial,
            format: crate::model::OutputFormat::Png,
            canvas: self.canvas_size,
        })?;
        Ok(())
    }

    fn apply_finalization_succeeded(&mut self) -> Result<Outcome, JobError> {
        // The finalization discriminant owns the rejection: only `Pending`
        // answers. The state sync is a debug-only cross-check; `Pending`
        // exists only while `Finalizing` is live.
        let Finalization::Pending { partial } = self.finalization else {
            return Err(JobError::invalid_state(
                "finalization response valid only while finalization is pending",
            ));
        };
        debug_assert_eq!(self.state, State::Finalizing);
        // Settling the phase drops the flag: it cannot leak past finalization.
        self.finalization = Finalization::Idle;
        if partial {
            self.set_state(State::PartiallyCompleted)?;
            self.terminal = Some("partial-completed".to_string());
        } else {
            self.set_state(State::Completed)?;
            self.terminal = Some("completed".to_string());
        }
        Ok(Outcome::Applied)
    }

    fn apply_finalization_failed(
        &mut self,
        code: String,
        message: String,
    ) -> Result<Outcome, JobError> {
        if !matches!(self.finalization, Finalization::Pending { .. }) {
            return Err(JobError::invalid_state(
                "finalization response valid only while finalization is pending",
            ));
        }
        debug_assert_eq!(self.state, State::Finalizing);
        self.finalization = Finalization::Idle;
        self.fail_via_cleanup(&code, message)?;
        Ok(Outcome::Applied)
    }

    pub(crate) fn fail_via_cleanup(&mut self, code: &str, message: String) -> Result<(), JobError> {
        self.paused = false;
        self.tile_cursor = None;
        self.retry_queue.clear();
        self.tile_specs.clear();
        self.terminal_error = Some((code.to_string(), message.clone()));
        self.emit_cleanup_once()?;
        self.set_state(State::Failed)?;
        self.terminal = Some("failed".to_string());
        Ok(())
    }

    fn emit_cleanup_once(&mut self) -> Result<(), JobError> {
        if !self.cleanup_emitted {
            self.cleanup_emitted = true;
            self.push_effect(JobEffect::CancelWork)?;
        }
        Ok(())
    }

    fn emit_pending_tiles(&mut self) -> Result<(), JobError> {
        // Pause: suspend-acquisition stops new scheduling; in-flight
        // finishes, decoded output is retained, FIFO order is preserved.
        if self.paused {
            return Ok(());
        }
        let limit = usize::try_from(self.config.max_concurrent_fetches)
            .map_err(|_| JobError::overflow("concurrency"))?;
        while self.in_flight.len() < limit {
            let Some((next, spec)) = self.next_tile_to_issue()? else {
                break;
            };
            self.tile_specs.insert(next, spec);
            self.tile_status[next as usize] = TileStatus::InFlight;
            self.in_flight.insert(next);
            self.push_acquire_tile(next, false, false)?;
        }
        Ok(())
    }

    /// Retry descriptors take priority. Ordinary descriptors are produced
    /// just in time from the row-major cursor and dropped once settled.
    fn next_tile_to_issue(&mut self) -> Result<Option<(u32, TileSpec)>, JobError> {
        loop {
            if let Some(tile) = self.retry_queue.pop_front() {
                if self.tile_status.get(tile as usize) != Some(&TileStatus::RetryReady) {
                    continue;
                }
                if let Some(spec) = self.tile_specs.get(&tile).cloned() {
                    return Ok(Some((tile, spec)));
                }
                self.fail_via_cleanup(
                    "job.plan-invalid",
                    format!("retry tile {tile} has no retained descriptor"),
                )?;
                return Ok(None);
            }

            let Some(cursor) = self.tile_cursor.as_mut() else {
                return Ok(None);
            };
            let Some(item) = cursor.next() else {
                self.tile_cursor = None;
                return Ok(None);
            };
            let spec = match item {
                Ok(spec) => spec,
                Err(error) => {
                    self.fail_via_cleanup("job.plan-invalid", error.to_string())?;
                    return Ok(None);
                }
            };
            if spec.role != TileRole::Output {
                self.fail_via_cleanup(
                    "job.plan-invalid",
                    format!("non-output tile {} entered acquisition plan", spec.ordinal),
                )?;
                return Ok(None);
            }
            let tile = spec.ordinal;
            let Some(status) = self.tile_status.get(tile as usize).copied() else {
                self.fail_via_cleanup(
                    "job.plan-invalid",
                    format!("tile ordinal {tile} exceeds declared plan"),
                )?;
                return Ok(None);
            };
            // A probe can already have painted an output tile before the
            // resolved grid is available. Its ordinal remains in the
            // row-major cursor, but acquisition must reuse the painted tile.
            if status == TileStatus::Acquired {
                continue;
            }
            if status != TileStatus::Pending {
                self.fail_via_cleanup(
                    "job.plan-invalid",
                    format!("tile ordinal {tile} was generated after it left Pending"),
                )?;
                return Ok(None);
            }
            return Ok(Some((tile, spec)));
        }
    }

    /// Stable byte-processing recipe name for the wire. Hosts that decode
    /// pixels (native) apply it before decoding; hosts that never decode
    /// (browser) ignore it.
    fn push_acquire_tile(
        &mut self,
        wire: u32,
        probe: bool,
        probe_output: bool,
    ) -> Result<(), JobError> {
        let Some(spec) = self.tile_specs.get(&wire) else {
            return Err(JobError::invalid_state(
                "tile descriptor is not materialized",
            ));
        };
        self.push_effect(JobEffect::AcquireTile {
            tile: wire,
            uri: spec.request.uri.clone(),
            headers: spec.request.headers.clone(),
            processing: spec.processing,
            destination: spec.destination,
            expected_size: spec.expected_size,
            canvas: self.canvas_size,
            probe,
            probe_output,
        })?;
        Ok(())
    }

    fn set_state(&mut self, state: State) -> Result<(), JobError> {
        self.state = state;
        Ok(())
    }

    fn push_effect(&mut self, effect: JobEffect) -> Result<(), JobError> {
        self.effects.push_back(effect);
        Ok(())
    }

    fn alloc_request_id(&mut self) -> Result<u32, JobError> {
        let n = self.next_request;
        let next = n
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("request id"))?;
        self.next_request = next;
        Ok(n)
    }

    fn alloc_decision_generation(&mut self) -> Result<u32, JobError> {
        let n = self.next_decision;
        let next = n
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("decision generation"))?;
        self.next_decision = next;
        self.decision = Decision::Pending { generation: n };
        Ok(n)
    }
}

/// Whether `input_url` names a fetchable input: `http(s)` URLs, local
/// `file://` URIs (only `file:///abs/path` and `file://localhost/abs/path`,
/// mirroring the native `fetch_local` mapping; any other `file://` host is
/// rejected), or plain filesystem paths read via `fs::read`. Empty and
/// over-long inputs are rejected. Messages never echo the input text, which
/// may name private directories.
pub(crate) fn is_valid_input_url(input_url: &str) -> bool {
    if input_url.is_empty() || input_url.len() > 2048 {
        return false;
    }
    if input_url.starts_with("http://") || input_url.starts_with("https://") {
        return true;
    }
    if let Some(rest) = input_url.strip_prefix("file://") {
        if let Some(path) = rest.strip_prefix("localhost") {
            return path.is_empty() || path.starts_with('/');
        }
        return rest.starts_with('/');
    }
    true
}

#[cfg(test)]
mod lazy_plan_tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use crate::Vec2d;
    use crate::core::adaptive::DiscoverableGrid;
    use crate::core::model::Request;
    use crate::core::tile_plan::{Grid, GridTile};

    use super::{Job, State};
    use crate::engine::config::Config;
    use crate::engine::engine_api::DiscoveryInput;
    use crate::engine::transition::JobEffect;

    #[test]
    fn grid_requests_are_materialized_only_for_open_slots() {
        let generated = Arc::new(AtomicUsize::new(0));
        let generated_by_request = Arc::clone(&generated);
        let grid = Grid::with_requests(
            Vec2d {
                x: 256 * 1000,
                y: 256,
            },
            Vec2d::square(256),
            Vec2d::default(),
            move |tile: GridTile| {
                generated_by_request.fetch_add(1, Ordering::Relaxed);
                Request::new(format!("https://tiles.test/{}", tile.row_major_ordinal))
            },
        )
        .unwrap();
        let total = grid.count();
        let config = Config {
            max_concurrent_fetches: 4,
            ..Config::default()
        };
        let mut job = Job::new(
            vec![DiscoveryInput::new("https://source.test/large")],
            config,
        );

        job.plan_from_tiles(
            Box::new(grid.tiles_row_major()),
            total,
            Some(grid.image_size()),
        )
        .unwrap();

        // Each issued tile builds its request and the legacy first-tile
        // Referer, so the format generator runs twice per materialized spec.
        assert_eq!(generated.load(Ordering::Relaxed), 8);
        assert_eq!(job.tile_specs.len(), 4);
        assert_eq!(job.tile_status.len(), 1000);
        let issued: Vec<_> = job
            .effects
            .iter()
            .filter_map(|effect| match effect {
                JobEffect::AcquireTile { tile, uri, .. } => Some((*tile, uri.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            issued,
            [
                (0, "https://tiles.test/0"),
                (1, "https://tiles.test/1"),
                (2, "https://tiles.test/2"),
                (3, "https://tiles.test/3")
            ]
        );

        job.apply_tile_success(0).unwrap();
        assert_eq!(generated.load(Ordering::Relaxed), 10);
        assert_eq!(job.tile_specs.len(), 4);
        assert!(job.tile_specs.contains_key(&4));
        assert!(!job.tile_specs.contains_key(&0));
    }

    #[test]
    fn completed_probe_descriptors_are_released_before_the_next_probe() {
        let mut job = Job::new(
            vec![DiscoveryInput::new("https://source.test/generic")],
            Config::default(),
        );
        job.state = State::Planning;
        job.drive_probe(
            DiscoverableGrid::new("https://tiles.test/tile?x={{X}}&y={{Y}}".into()).start(),
        )
        .unwrap();

        let mut probes = 0;
        while let Some(flight) = job.probe.as_ref() {
            let tile = flight.tile;
            assert_eq!(job.tile_specs.len(), 1, "only the active probe is retained");
            job.apply_probe_outcome(tile, crate::model::ProbeOutcome::Missing)
                .unwrap();
            probes += 1;
            assert!(job.tile_specs.len() <= 1);
        }
        assert!(probes > 1, "the generic grid should issue multiple probes");
        assert!(job.tile_specs.is_empty());
    }
}
