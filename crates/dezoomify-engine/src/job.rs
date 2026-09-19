//! Deterministic portable job state machine.
//!
//! The job decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. Hosts feed
//! explicit [`JobCommand`] inputs and drain one ordered typed message queue.
//! All counters use checked arithmetic.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use dezoomify_core::core::adaptive::{DiscoverableStep, ObservationResult, ProbeContinuation};
use dezoomify_core::core::discovery::{
    DiscoveryError, DiscoveryOperation, FetchCause, ResourceFailure, ResourceResponse,
};
use dezoomify_core::core::model::{CatalogEntry, ImageCatalog, ProcessingRecipe, TileRole};
use dezoomify_core::core::registry::{default_registry, registry_for};
use dezoomify_core::core::tile_plan::TileSource;
use dezoomify_core::Vec2d;
use dezoomify_protocol::dto::CatalogEntryDto;

use crate::config::Config;
use crate::retry::{retry_delay_ms, TileFailure};
use crate::state::State;
use crate::transition::{
    JobCommand, JobEffect, JobError, JobEvent, JobMessage, JobMessageBody, Outcome, RecoveryChoice,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobInput {
    pub url: String,
    pub contents: Option<Vec<u8>>,
}

impl JobInput {
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            contents: None,
        }
    }

    #[must_use]
    pub fn with_contents(url: impl Into<String>, contents: impl Into<Vec<u8>>) -> Self {
        Self {
            url: url.into(),
            contents: Some(contents.into()),
        }
    }
}

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

/// One end-to-end user request driven synchronously by explicit host inputs.
pub struct Job {
    inputs: Vec<JobInput>,
    input_index: usize,
    config: Config,
    /// Format selector: `None` auto-detects via `default_registry`;
    /// `Some(name)` selects the single named program via `registry_for`
    /// (`auto` also means auto-detect). Unknown names fail `start()` with
    /// typed `job.unknown-dezoomer`.
    format: Option<String>,
    state: State,
    seq: u32,
    messages: VecDeque<JobMessage>,
    /// Outstanding discovery resource fetches: request sequence -> core id.
    pending_discovery: HashMap<u32, usize>,
    /// Core discovery operation while discovery is in flight.
    discovery: Option<DiscoveryOperation>,
    /// Finished core catalog.
    catalog: Option<ImageCatalog>,
    /// Projected wire catalog (same order as `catalog` entries).
    catalog_images: Vec<CatalogEntryDto>,
    selected_image: Option<u32>,
    selected_image_index: Option<usize>,
    selected_level: Option<u32>,
    selected_level_index: Option<usize>,
    finalizing_partial: Option<bool>,
    cleanup_emitted: bool,
    planned_tiles: Vec<u32>,
    /// Plan-order tile set mirroring `planned_tiles` for O(1) membership.
    planned_set: HashSet<u32>,
    /// FIFO acquisition queue; pops are O(1) from the front.
    pending_tiles: VecDeque<u32>,
    /// Plan-order set mirroring `pending_tiles` for O(1) membership: every
    /// push and pop goes through `enqueue_front`, `enqueue_back`,
    /// `dequeue_next`, or `remove_from_pending`, so the queue is never
    /// scanned on the hot path.
    pending_set: HashSet<u32>,
    /// Plan-order index by wire tile id, built once per plan. The partial
    /// retry round requeues in plan order through this map instead of
    /// scanning `planned_tiles` per tile.
    plan_order: HashMap<u32, usize>,
    in_flight: HashSet<u32>,
    acquired_tiles: HashSet<u32>,
    tile_attempts: HashMap<u32, u32>,
    /// Tile request URIs by wire tile id (planned and probe tiles).
    tile_uris: HashMap<u32, String>,
    /// Core request headers by wire tile id (sent verbatim by native hosts;
    /// browser hosts ignore them).
    tile_headers: HashMap<u32, BTreeMap<String, String>>,
    /// Closed byte-processing recipe by wire tile id.
    tile_processing: HashMap<u32, ProcessingRecipe>,
    /// Output destinations by wire tile id.
    tile_destinations: HashMap<u32, Vec2d>,
    /// Expected decoded extents by wire tile id (`None` while unknown).
    tile_extents: HashMap<u32, Option<Vec2d>>,
    /// Declared canvas size for the planned level (`None` while unknown,
    /// e.g. mid-probe or custom layouts that derive it from tiles).
    canvas_size: Option<Vec2d>,
    /// Wire tile ids emitted as probes (answered via `ProbeOutcome`).
    probe_tiles: HashSet<u32>,
    /// Pending probe continuation; exactly one probe is in flight.
    probe: Option<ProbeContinuation>,
    probe_tile: Option<u32>,
    probe_output: bool,
    retained_probe: Option<(u32, Vec2d)>,
    probes_emitted: u32,
    recovery_reason: Option<String>,
    pending_decision: Option<u32>,
    failed_tiles: Vec<u32>,
    /// Settled-as-failed set mirroring `failed_tiles` for O(1) membership.
    failed_set: HashSet<u32>,
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
            .field("seq", &self.seq)
            .field("terminal", &self.terminal)
            .finish()
    }
}

impl Job {
    pub fn new_with_inputs(inputs: Vec<JobInput>, config: Config) -> Result<Self, JobError> {
        if inputs.is_empty() || inputs.iter().any(|input| !is_valid_input_url(&input.url)) {
            return Err(JobError::new(
                "job.invalid-input",
                "inputs must contain valid http(s) URLs, file:// URIs, or local paths up to 2048 bytes"
                    .to_string(),
            ));
        }
        if let Err(e) = config.validate() {
            return Err(JobError::new(&e.code, e.message));
        }
        let visited_uris: HashSet<String> = inputs.iter().map(|input| input.url.clone()).collect();
        Ok(Self {
            inputs,
            input_index: 0,
            config,
            format: None,
            state: State::Created,
            seq: 0,
            messages: VecDeque::new(),
            pending_discovery: HashMap::new(),
            discovery: None,
            catalog: None,
            catalog_images: Vec::new(),
            selected_image: None,
            selected_image_index: None,
            selected_level: None,
            selected_level_index: None,
            finalizing_partial: None,
            cleanup_emitted: false,
            planned_tiles: Vec::new(),
            planned_set: HashSet::new(),
            pending_tiles: VecDeque::new(),
            pending_set: HashSet::new(),
            plan_order: HashMap::new(),
            in_flight: HashSet::new(),
            acquired_tiles: HashSet::new(),
            tile_attempts: HashMap::new(),
            tile_uris: HashMap::new(),
            tile_headers: HashMap::new(),
            tile_processing: HashMap::new(),
            tile_destinations: HashMap::new(),
            tile_extents: HashMap::new(),
            canvas_size: None,
            probe_tiles: HashSet::new(),
            probe: None,
            probe_tile: None,
            probe_output: false,
            retained_probe: None,
            probes_emitted: 0,
            recovery_reason: None,
            pending_decision: None,
            failed_tiles: Vec::new(),
            failed_set: HashSet::new(),
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
        })
    }

    /// Current state.
    #[must_use]
    pub fn state(&self) -> State {
        self.state
    }

    /// Monotonic sequence last assigned (checked arithmetic).
    #[must_use]
    pub fn seq(&self) -> u32 {
        self.seq
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

    /// Selectable level count for one catalog image position.
    #[must_use]
    pub fn catalog_level_count(&self, image: u32) -> u32 {
        let index = usize::try_from(image).ok();
        let count = index
            .and_then(|index| self.catalog.as_ref()?.entries().get(index))
            .and_then(|entry| match entry {
                CatalogEntry::Ready(image) => Some(image.levels.len()),
                CatalogEntry::Deferred(_) => None,
            })
            .unwrap_or(0);
        u32::try_from(count).unwrap_or(u32::MAX)
    }

    /// Still-deferred catalog entries as `(position, follow-up URI)`.
    #[must_use]
    pub fn deferred_entries(&self) -> Vec<(u32, String)> {
        let Some(catalog) = self.catalog.as_ref() else {
            return Vec::new();
        };
        catalog
            .entries()
            .iter()
            .enumerate()
            .filter_map(|(position, entry)| match entry {
                CatalogEntry::Ready(_) => None,
                CatalogEntry::Deferred(deferred) => u32::try_from(position)
                    .ok()
                    .map(|position| (position, deferred.uri.clone())),
            })
            .collect()
    }

    /// Stable code and message behind a `Failed` terminal, if the job
    /// failed. Retained past event draining for snapshot projection.
    #[must_use]
    pub fn terminal_error(&self) -> Option<(String, String)> {
        self.terminal_error.clone()
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
        (
            self.acquired_tiles.len() as u64,
            self.planned_tiles.len() as u64,
        )
    }

    /// Selected image position, once chosen.
    #[must_use]
    pub fn selected_image(&self) -> Option<u32> {
        self.selected_image
    }

    /// Selected level position, once chosen.
    #[must_use]
    pub fn selected_level(&self) -> Option<u32> {
        self.selected_level
    }

    /// Outstanding partial-decision generation, if one is awaited.
    #[must_use]
    pub fn pending_decision(&self) -> Option<u32> {
        self.pending_decision
    }

    /// Declared canvas size for the planned level, when known.
    #[must_use]
    pub fn canvas_size(&self) -> Option<Vec2d> {
        self.canvas_size
    }

    /// Take queued messages exactly once in sequence order.
    #[must_use]
    pub fn drain_messages(&mut self) -> Vec<JobMessage> {
        self.messages.drain(..).collect()
    }

    /// Set the format selector before [`Job::start`]: `None` auto-detects,
    /// `Some("auto")` also auto-detects, otherwise the single named program
    /// is selected (case-insensitive, matching the core `registry_for`).
    /// Unknown names fail `start()` with typed `job.unknown-dezoomer`.
    pub fn set_format(&mut self, format: Option<String>) {
        self.format = format;
    }

    /// Validate start and enter `Discovering` with one metadata fetch effect.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] when called outside `Created`, on overflow, or
    /// for an unknown named format (`job.unknown-dezoomer`).
    pub fn start(&mut self) -> Result<Outcome, JobError> {
        if self.terminal.is_some() {
            return Err(JobError::post_terminal());
        }
        if self.state != State::Created {
            return Err(JobError::invalid_state("start is valid only in Created"));
        }
        if let Some(name) = self.format.as_deref() {
            if name != "auto" && registry_for(name).is_none() {
                return Err(JobError::new(
                    "job.unknown-dezoomer",
                    format!("unknown dezoomer '{name}'"),
                ));
            }
        }
        self.set_state(State::Discovering)?;
        self.push_event(JobEvent::State {
            state: State::Discovering,
        })?;
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
    /// effects/events with monotonic `seq`.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] for post-terminal, invalid-state, and
    /// counter-overflow rejections.
    pub fn on_command(&mut self, response: JobCommand) -> Result<Outcome, JobError> {
        if self.terminal.is_some() {
            return Err(JobError::post_terminal());
        }
        // Cancellation is valid in every non-terminal state.
        if matches!(response, JobCommand::Cancel) {
            return self.enter_cancelled();
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
            let mut header_names: Vec<String> = need.request.headers.keys().cloned().collect();
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
        let images = crate::projection::project_catalog(&catalog).entries;
        self.catalog = Some(catalog);
        self.catalog_images = images;
        // A followed catalog replaces the superseded one in the same job;
        // the follow flag clears so later failures route normally again.
        self.following_deferred = false;
        // Sibling discovery fetches still in flight are moot once the
        // catalog wins; drop them so late answers are plain duplicates.
        self.pending_discovery.clear();
        self.set_state(State::AwaitingImageSelection)?;
        self.push_event(JobEvent::Catalog {
            catalog: dezoomify_protocol::dto::CatalogDto {
                entries: self.catalog_images.clone(),
            },
        })?;
        self.push_event(JobEvent::State {
            state: State::AwaitingImageSelection,
        })?;
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
            let response =
                ResourceResponse::new(dezoomify_core::core::discovery::RequestId(core_id), bytes);
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
        let core_id = dezoomify_core::core::discovery::RequestId(core_id);
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
        if self.selected_image == Some(image) {
            return Ok(Outcome::Ignored);
        }
        if self.state != State::AwaitingImageSelection {
            return Err(JobError::invalid_state(
                "image selection valid only in AwaitingImageSelection",
            ));
        }
        let index = usize::try_from(image).map_err(|_| JobError::overflow("image position"))?;
        let level_count = {
            let selected = self
                .catalog_images
                .get(index)
                .ok_or_else(|| JobError::invalid_state("image position is out of range"))?;
            let CatalogEntryDto::Image(selected) = selected else {
                return Err(JobError::invalid_state(
                    "image metadata was not fetched; the image cannot be selected",
                ));
            };
            selected.levels.len()
        };
        self.selected_image = Some(image);
        self.selected_image_index = Some(index);
        self.set_state(State::AwaitingLevelSelection)?;
        let levels: Vec<u32> = (0..level_count)
            .map(|position| {
                u32::try_from(position).map_err(|_| JobError::overflow("level position"))
            })
            .collect::<Result<_, _>>()?;
        self.push_event(JobEvent::Levels { image, levels })?;
        self.push_event(JobEvent::State {
            state: State::AwaitingLevelSelection,
        })?;
        Ok(Outcome::Applied)
    }

    /// Follow one still-deferred catalog entry within the same job.
    ///
    /// The follow is bounded by `max_deferred_follows` and guarded against
    /// cycles by the visited-URI set: the same URI is never fetched twice
    /// by one job. The catalog is replaced on success; the job ID and
    /// revision lineage never change, so hosts never fork replacement jobs.
    fn apply_follow_deferred(&mut self, image: u32) -> Result<Outcome, JobError> {
        if self.state != State::AwaitingImageSelection || self.selected_image.is_some() {
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
            Some(CatalogEntry::Deferred(deferred)) => deferred.uri.clone(),
            Some(CatalogEntry::Ready(_)) => {
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
        self.push_event(JobEvent::State {
            state: State::Discovering,
        })?;
        self.drive_discovery()?;
        Ok(Outcome::Applied)
    }

    fn apply_selected_level(&mut self, level: u32) -> Result<Outcome, JobError> {
        if self.selected_level == Some(level) {
            return Ok(Outcome::Ignored);
        }
        if self.state != State::AwaitingLevelSelection {
            return Err(JobError::invalid_state(
                "level selection valid only in AwaitingLevelSelection",
            ));
        }
        let image_index = self
            .selected_image_index
            .ok_or_else(|| JobError::invalid_state("no image selected"))?;
        let level_index =
            usize::try_from(level).map_err(|_| JobError::overflow("level position"))?;
        let in_range = match &self.catalog_images[image_index] {
            CatalogEntryDto::Image(image) => image.levels.get(level_index).is_some(),
            CatalogEntryDto::ImageRequest(_) => false,
        };
        if !in_range {
            return Err(JobError::invalid_state("level position is out of range"));
        }
        self.selected_level = Some(level);
        self.selected_level_index = Some(level_index);
        self.set_state(State::Planning)?;
        self.push_event(JobEvent::State {
            state: State::Planning,
        })?;
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
            let image_index = self
                .selected_image_index
                .ok_or_else(|| JobError::invalid_state("no image selected"))?;
            let level_index = self
                .selected_level_index
                .ok_or_else(|| JobError::invalid_state("no level selected"))?;
            let CatalogEntry::Ready(image) = &catalog.entries()[image_index] else {
                return self.fail_via_cleanup(
                    "job.plan-invalid",
                    "selected image metadata was not fetched".to_string(),
                );
            };
            image.levels[level_index].source.clone()
        };
        match source {
            TileSource::Grid(grid) => {
                let canvas = Some(grid.image_size());
                self.plan_from_tiles(grid.tiles_row_major(), canvas)
            }
            TileSource::Positioned(positioned) => {
                let canvas = positioned.image_size();
                self.plan_from_tiles(positioned.tiles(), canvas)
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
        tiles: impl Iterator<
            Item = Result<
                dezoomify_core::core::model::TileSpec,
                dezoomify_core::core::tile_plan::TileSourceError,
            >,
        >,
        canvas: Option<Vec2d>,
    ) -> Result<(), JobError> {
        let mut planned: Vec<u32> = Vec::new();
        for tile in tiles {
            let spec = match tile {
                Ok(spec) => spec,
                Err(e) => return self.fail_via_cleanup("job.plan-invalid", e.to_string()),
            };
            if spec.role == dezoomify_core::core::model::TileRole::Probe {
                continue;
            }
            let ordinal = spec.ordinal;
            if planned.len() + 1 > self.config.max_tiles as usize {
                return self.fail_via_cleanup(
                    "job.resource-limit",
                    format!("tile plan exceeds max_tiles {}", self.config.max_tiles),
                );
            }
            self.tile_uris.insert(ordinal, spec.request.uri);
            self.tile_headers.insert(ordinal, spec.request.headers);
            self.tile_processing.insert(ordinal, spec.processing);
            self.tile_destinations.insert(ordinal, spec.destination);
            self.tile_extents.insert(ordinal, spec.expected_size);
            planned.push(ordinal);
        }
        if planned.is_empty() {
            return self.fail_via_cleanup(
                "job.plan-empty",
                "the selected level has no tiles".to_string(),
            );
        }
        self.canvas_size = canvas;
        self.begin_acquisition(planned)
    }

    /// Advance the core probe step machine by one step.
    fn drive_probe(&mut self, step: DiscoverableStep) -> Result<(), JobError> {
        match step {
            DiscoverableStep::Resolved {
                grid,
                previously_output,
            } => {
                let canvas = Some(grid.image_size());
                self.plan_from_tiles_reusing(grid.tiles_row_major(), canvas, &previously_output)
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
                self.probe = Some(continuation);
                self.probe_tile = Some(wire);
                self.probe_output = probe_output;
                self.probe_tiles.insert(wire);
                self.tile_uris.insert(wire, tile.request.uri.clone());
                self.tile_headers.insert(wire, tile.request.headers.clone());
                self.tile_processing.insert(wire, tile.processing);
                self.tile_destinations.insert(wire, tile.destination);
                self.tile_extents.insert(wire, tile.expected_size);
                self.in_flight.insert(wire);
                self.push_acquire_tile(wire, true, probe_output)?;
                Ok(())
            }
        }
    }

    fn plan_from_tiles_reusing(
        &mut self,
        tiles: impl Iterator<
            Item = Result<
                dezoomify_core::core::model::TileSpec,
                dezoomify_core::core::tile_plan::TileSourceError,
            >,
        >,
        canvas: Option<Vec2d>,
        previously_output: &[Vec2d],
    ) -> Result<(), JobError> {
        self.retained_probe = self
            .retained_probe
            .filter(|(_, destination)| previously_output.contains(destination));
        self.plan_from_tiles(tiles, canvas)
    }

    /// Shared transition from a complete plan into bounded acquisition.
    fn begin_acquisition(&mut self, planned: Vec<u32>) -> Result<(), JobError> {
        let total = planned.len() as u64;
        for wire in planned {
            self.planned_tiles.push(wire);
        }
        self.planned_set = self.planned_tiles.iter().copied().collect();
        self.plan_order = self
            .planned_tiles
            .iter()
            .enumerate()
            .map(|(index, tile)| (*tile, index))
            .collect();
        self.probe_tiles.clear();
        self.pending_tiles = self.planned_tiles.iter().copied().collect();
        self.pending_set = self.planned_tiles.iter().copied().collect();
        self.in_flight.clear();
        self.acquired_tiles.clear();
        self.failed_tiles.clear();
        self.failed_set.clear();
        if let Some((tile, destination)) = self.retained_probe.take() {
            if self.planned_set.contains(&tile)
                && self.tile_destinations.get(&tile) == Some(&destination)
            {
                self.remove_from_pending(tile);
                self.acquired_tiles.insert(tile);
            }
        }
        self.unsettled = self
            .planned_tiles
            .len()
            .saturating_sub(self.acquired_tiles.len());
        let acquired = self.acquired_tiles.len() as u64;
        self.set_state(State::AcquiringTiles)?;
        self.push_event(JobEvent::Progress { acquired, total })?;
        self.push_event(JobEvent::State {
            state: State::AcquiringTiles,
        })?;
        if self.acquired_tiles.len() == self.planned_tiles.len() {
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
        if self.probe_tiles.contains(&tile) {
            return Err(JobError::invalid_state(
                "probe tiles are answered with a probe outcome, not a tile success",
            ));
        }
        if self.state != State::AcquiringTiles {
            return Err(JobError::invalid_state(
                "tile success valid only in AcquiringTiles",
            ));
        }
        if !self.planned_set.contains(&tile) {
            return Err(JobError::invalid_state("tile ordinal is out of range"));
        }
        if self.acquired_tiles.contains(&tile) {
            return Ok(Outcome::Ignored);
        }
        // A success for a settled-as-failed tile is a late duplicate of an
        // already-recorded attempt outcome: it must not resurrect the tile
        // or double-decrement the settle accounting.
        if self.failed_set.contains(&tile) {
            return Ok(Outcome::Ignored);
        }
        // Flight and queue are disjoint: a tile enters the queue only
        // when not in flight, so a tile just removed from flight cannot
        // be queued and the queue is never scanned on the hot path.
        if !self.in_flight.remove(&tile) {
            self.remove_from_pending(tile);
        }
        self.acquired_tiles.insert(tile);
        self.unsettled = self.unsettled.saturating_sub(1);
        let acquired = u64::try_from(self.acquired_tiles.len())
            .map_err(|_| JobError::overflow("acquired count"))?;
        let total = self.planned_tiles.len() as u64;
        self.push_event(JobEvent::Progress { acquired, total })?;
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
        if self.probe_tiles.contains(&tile) {
            return Err(JobError::invalid_state(
                "probe tiles are answered with a probe outcome, not a tile failure",
            ));
        }
        if self.state != State::AcquiringTiles {
            return Err(JobError::invalid_state(
                "tile failure valid only in AcquiringTiles",
            ));
        }
        if !self.planned_set.contains(&tile) {
            return Err(JobError::invalid_state("tile ordinal is out of range"));
        }
        if self.acquired_tiles.contains(&tile) || self.failed_set.contains(&tile) {
            return Ok(Outcome::Ignored);
        }
        // No re-acquisition was issued since the recorded failure, so a
        // second report for this tile is a duplicate: the pending timer (or
        // parked retry) already owns the next attempt.
        if self
            .pending_retry_timers
            .iter()
            .any(|pending| pending.tile == tile)
            || self.ready_retries.iter().any(|(ready, _)| *ready == tile)
        {
            return Ok(Outcome::Ignored);
        }
        let attempt = self
            .tile_attempts
            .get(&tile)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("tile attempts"))?;
        self.tile_attempts.insert(tile, attempt);
        let was_in_flight = self.in_flight.remove(&tile);
        self.tile_failure_log
            .entry(tile)
            .or_default()
            .push(failure.clone());
        if failure.is_retryable() && attempt <= self.config.max_retries {
            self.push_event(JobEvent::Warning { tile, attempt })?;
            // Attempts count the initial try: the first failure schedules
            // retry-timer 1, whose completion re-issues the second try.
            let delay_ms = retry_delay_ms(attempt, failure.retry_after_ms);
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
            return Ok(Outcome::Applied);
        }
        self.stash_failed_tile(tile, was_in_flight);
        self.maybe_enter_partial_decision()?;
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
        if self.acquired_tiles.contains(&tile) || self.failed_set.contains(&tile) {
            return Ok(Outcome::Applied);
        }
        if self.paused {
            if !self.ready_retries.contains(&(tile, attempt)) {
                self.ready_retries.push((tile, attempt));
            }
            return Ok(Outcome::Applied);
        }
        self.enqueue_front(tile);
        self.emit_pending_tiles()?;
        Ok(Outcome::Applied)
    }

    /// Record one tile as settled-as-failed (idempotent). `was_in_flight`
    /// tells whether the tile just left the flight set: flight and queue
    /// are disjoint, so only a tile that was not in flight can still be
    /// queued, and only then is it removed through the membership set.
    fn stash_failed_tile(&mut self, tile: u32, was_in_flight: bool) {
        if !was_in_flight {
            self.remove_from_pending(tile);
        }
        if self.failed_set.insert(tile) {
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
            || !self.pending_retry_timers.is_empty()
            || !self.ready_retries.is_empty()
        {
            return Ok(());
        }
        self.recovery_reason = Some("tile".to_string());
        let generation = self.alloc_decision_generation()?;
        self.set_state(State::AwaitingPartialDecision)?;
        self.push_effect(JobEffect::RequestDecision { generation })?;
        self.push_event(JobEvent::MissingWork {
            failed: self.failed_tiles.clone(),
        })?;
        self.push_event(JobEvent::RecoveryRequested { generation })?;
        self.push_event(JobEvent::State {
            state: State::AwaitingPartialDecision,
        })?;
        Ok(())
    }

    fn apply_probe_outcome(
        &mut self,
        tile: u32,
        outcome: dezoomify_protocol::dto::ProbeOutcome,
    ) -> Result<Outcome, JobError> {
        if self.state != State::Planning || self.probe_tile != Some(tile) {
            return Err(JobError::invalid_state(
                "probe outcome valid only for the outstanding probe while Planning",
            ));
        }
        if !self.probe_tiles.contains(&tile) {
            return Err(JobError::invalid_state("unknown probe tile id"));
        }
        let available = matches!(
            outcome,
            dezoomify_protocol::dto::ProbeOutcome::Available { .. }
        );
        let observation = match outcome {
            dezoomify_protocol::dto::ProbeOutcome::Available { width, height } => {
                let x =
                    u32::try_from(width.get()).map_err(|_| JobError::overflow("probe width"))?;
                let y =
                    u32::try_from(height.get()).map_err(|_| JobError::overflow("probe height"))?;
                ObservationResult::Available {
                    size: dezoomify_core::Vec2d { x, y },
                }
            }
            dezoomify_protocol::dto::ProbeOutcome::Missing => ObservationResult::Missing,
        };
        if available && self.probe_output {
            let destination = self
                .tile_destinations
                .get(&tile)
                .copied()
                .unwrap_or_default();
            self.retained_probe = Some((tile, destination));
        }
        self.probe_tile = None;
        self.probe_output = false;
        self.probe_tiles.remove(&tile);
        self.in_flight.remove(&tile);
        let Some(continuation) = self.probe.take() else {
            return Err(JobError::invalid_state("no probe continuation pending"));
        };
        let step = continuation
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
        if self.state != State::AwaitingPartialDecision {
            return Err(JobError::invalid_state(
                "recovery choice valid only in AwaitingPartialDecision",
            ));
        }
        if self.pending_decision != Some(generation) {
            return Err(JobError::invalid_state(
                "recovery choice generation is stale",
            ));
        }
        self.recovery_reason = None;
        self.pending_decision = None;
        match choice {
            RecoveryChoice::Retry => {
                // Requeue every settled-as-failed tile with a fresh attempt
                // budget for the new round, in plan order; acquired tiles
                // are preserved so success is never re-fetched. Restored
                // tiles rejoin the unsettled count exactly once each.
                let mut requeued: Vec<u32> = std::mem::take(&mut self.failed_tiles);
                self.failed_set.clear();
                requeued
                    .sort_by_key(|tile| self.plan_order.get(tile).copied().unwrap_or(usize::MAX));
                let mut restored = 0usize;
                for tile in requeued {
                    self.tile_attempts.insert(tile, 0);
                    self.tile_failure_log.remove(&tile);
                    if !self.acquired_tiles.contains(&tile) && self.enqueue_back(tile) {
                        restored = restored.saturating_add(1);
                    }
                }
                self.unsettled = self.unsettled.saturating_add(restored);
                self.set_state(State::AcquiringTiles)?;
                self.push_event(JobEvent::State {
                    state: State::AcquiringTiles,
                })?;
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
        self.push_event(JobEvent::State {
            state: State::Cancelling,
        })?;
        self.emit_cleanup_once()?;
        self.set_state(State::Cancelled)?;
        self.push_event(JobEvent::State {
            state: State::Cancelled,
        })?;
        self.push_event(JobEvent::Cancelled)?;
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
        self.push_event(JobEvent::Paused)?;
        Ok(Outcome::Applied)
    }

    /// Resume a paused job (re-drive): clear the overlay and schedule
    /// pending tiles again. If all tiles finished while paused, complete
    /// now; otherwise emit up to the concurrency gate. FIFO order is
    /// preserved because `pending_tiles` was never reordered while paused.
    fn apply_resume(&mut self) -> Result<Outcome, JobError> {
        if !self.paused {
            return Err(JobError::invalid_state("resume valid only while paused"));
        }
        self.paused = false;
        self.push_event(JobEvent::Resumed)?;
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
            if !self.acquired_tiles.contains(&tile) && !self.failed_set.contains(&tile) {
                self.enqueue_front(tile);
            }
        }
        if self.state == State::AcquiringTiles
            && self.acquired_tiles.len() == self.planned_tiles.len()
            && !self.planned_tiles.is_empty()
        {
            self.complete_remaining(false)?;
        } else if self.state == State::AcquiringTiles {
            self.emit_pending_tiles()?;
        }
        Ok(Outcome::Applied)
    }

    fn complete_remaining(&mut self, partial: bool) -> Result<(), JobError> {
        self.paused = false;
        self.finalizing_partial = Some(partial);
        self.set_state(State::Finalizing)?;
        self.push_effect(JobEffect::FinalizeOutput {
            partial,
            format: dezoomify_protocol::dto::OutputFormat::Png,
            canvas: self.canvas_size,
        })?;
        self.push_event(JobEvent::State {
            state: State::Finalizing,
        })?;
        Ok(())
    }

    fn apply_finalization_succeeded(&mut self) -> Result<Outcome, JobError> {
        if self.state != State::Finalizing {
            return Err(JobError::invalid_state(
                "finalization response valid only in Finalizing",
            ));
        }
        let partial = self
            .finalizing_partial
            .take()
            .ok_or_else(|| JobError::invalid_state("no finalization pending"))?;
        if partial {
            self.set_state(State::PartiallyCompleted)?;
            self.push_event(JobEvent::State {
                state: State::PartiallyCompleted,
            })?;
            self.push_event(JobEvent::PartialCompleted)?;
            self.terminal = Some("partial-completed".to_string());
        } else {
            self.set_state(State::Completed)?;
            self.push_event(JobEvent::State {
                state: State::Completed,
            })?;
            self.push_event(JobEvent::Completed)?;
            self.terminal = Some("completed".to_string());
        }
        Ok(Outcome::Applied)
    }

    fn apply_finalization_failed(
        &mut self,
        code: String,
        message: String,
    ) -> Result<Outcome, JobError> {
        if self.state != State::Finalizing {
            return Err(JobError::invalid_state(
                "finalization response valid only in Finalizing",
            ));
        }
        self.finalizing_partial = None;
        self.fail_via_cleanup(&code, message)?;
        Ok(Outcome::Applied)
    }

    fn fail_via_cleanup(&mut self, code: &str, message: String) -> Result<(), JobError> {
        self.paused = false;
        self.terminal_error = Some((code.to_string(), message.clone()));
        self.emit_cleanup_once()?;
        self.set_state(State::Failed)?;
        self.push_event(JobEvent::State {
            state: State::Failed,
        })?;
        self.push_event(JobEvent::Failed {
            code: code.to_string(),
            message,
        })?;
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
            let Some(next) = self.dequeue_next() else {
                break;
            };
            if self.acquired_tiles.contains(&next)
                || self.failed_set.contains(&next)
                || self.in_flight.contains(&next)
            {
                continue;
            }
            self.in_flight.insert(next);
            self.push_acquire_tile(next, false, false)?;
        }
        Ok(())
    }

    /// Queue one tile at the front unless already queued. The membership
    /// set keeps this O(1); the queue itself is never scanned.
    fn enqueue_front(&mut self, tile: u32) {
        if self.pending_set.insert(tile) {
            self.pending_tiles.push_front(tile);
        }
    }

    /// Queue one tile at the back unless already queued, reporting whether
    /// it was queued. The membership set keeps this O(1); the queue itself
    /// is never scanned.
    fn enqueue_back(&mut self, tile: u32) -> bool {
        if self.pending_set.insert(tile) {
            self.pending_tiles.push_back(tile);
            true
        } else {
            false
        }
    }

    /// Pop the oldest queued tile, keeping the membership set mirrored.
    fn dequeue_next(&mut self) -> Option<u32> {
        let next = self.pending_tiles.pop_front()?;
        self.pending_set.remove(&next);
        Some(next)
    }

    /// Drop one tile from the queue wherever it sits. The set gates the
    /// scan: absent tiles (the common case, since answered work leaves
    /// flight first) skip it entirely. Only a still-queued tile pays the
    /// removal scan, which hosts can only trigger by answering work that
    /// was never issued.
    fn remove_from_pending(&mut self, tile: u32) {
        if self.pending_set.remove(&tile) {
            self.pending_tiles.retain(|value| *value != tile);
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
        let uri = self.tile_uris.get(&wire).cloned().unwrap_or_default();
        let headers = self.tile_headers.get(&wire).cloned().unwrap_or_default();
        let processing = self
            .tile_processing
            .get(&wire)
            .cloned()
            .unwrap_or(ProcessingRecipe::None);
        let destination = self
            .tile_destinations
            .get(&wire)
            .copied()
            .unwrap_or_default();
        let extent = self.tile_extents.get(&wire).copied().flatten();
        self.push_effect(JobEffect::AcquireTile {
            tile: wire,
            uri,
            headers,
            processing,
            destination,
            expected_size: extent,
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

    fn bump_seq(&mut self) -> Result<u32, JobError> {
        let next = self
            .seq
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("seq"))?;
        self.seq = next;
        Ok(next)
    }

    fn push_effect(&mut self, effect: JobEffect) -> Result<(), JobError> {
        let sequence = self.bump_seq()?;
        self.messages.push_back(JobMessage {
            sequence,
            body: JobMessageBody::Effect(effect),
        });
        Ok(())
    }

    fn push_event(&mut self, event: JobEvent) -> Result<(), JobError> {
        let sequence = self.bump_seq()?;
        self.messages.push_back(JobMessage {
            sequence,
            body: JobMessageBody::Event(event),
        });
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
        self.pending_decision = Some(n);
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
