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
use dezoomify_core::core::model::{CatalogEntry, ImageCatalog, ProcessingRecipe};
use dezoomify_core::core::registry::{default_registry, registry_for};
use dezoomify_core::core::tile_plan::TileSource;
use dezoomify_core::Vec2d;
use dezoomify_protocol::dto::{ImageDto, Readiness};

use crate::config::Config;
use crate::state::State;
use crate::transition::{
    DecisionReason, JobCommand, JobEffect, JobError, JobEvent, JobMessage, JobMessageBody, Outcome,
};

/// One end-to-end user request driven synchronously by explicit host inputs.
pub struct Job {
    input_url: String,
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
    catalog_images: Vec<ImageDto>,
    selected_image: Option<u32>,
    selected_image_index: Option<usize>,
    selected_level: Option<u32>,
    selected_level_index: Option<usize>,
    planned_tiles: Vec<u32>,
    pending_tiles: Vec<u32>,
    in_flight: HashSet<u32>,
    acquired_tiles: HashSet<u32>,
    tile_attempts: HashMap<u32, u32>,
    /// Tile request URIs by wire tile id (planned and probe tiles).
    tile_uris: HashMap<u32, String>,
    /// Core request headers by wire tile id (sent verbatim by native hosts;
    /// browser hosts ignore them).
    tile_headers: HashMap<u32, BTreeMap<String, String>>,
    /// Stable byte-processing recipe names by wire tile id (`none`,
    /// `google-arts-decrypt`).
    tile_processing: HashMap<u32, String>,
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
    probes_emitted: u32,
    recovery_reason: Option<String>,
    pending_decision: Option<u32>,
    failed_tiles: Vec<u32>,
    terminal: Option<String>,
    /// Pause v1 overlay (suspend-acquisition): when true the engine stops
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
    /// Create a validated job in `Created`. No effects are emitted yet.
    ///
    /// # Errors
    ///
    /// Returns a typed [`JobError`] when the input URL or config is
    /// invalid.
    pub fn new(input_url: &str, config: Config) -> Result<Self, JobError> {
        if !is_valid_input_url(input_url) {
            return Err(JobError::new(
                "job.invalid-input",
                "input_url must be an http(s) URL, file:// URI, or local path up to 2048 bytes"
                    .to_string(),
            ));
        }
        if let Err(e) = config.validate() {
            return Err(JobError::new(&e.code, e.message));
        }
        Ok(Self {
            input_url: input_url.to_string(),
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
            planned_tiles: Vec::new(),
            pending_tiles: Vec::new(),
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
            probes_emitted: 0,
            recovery_reason: None,
            pending_decision: None,
            failed_tiles: Vec::new(),
            terminal: None,
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

    /// Whether the job is in a terminal state.
    #[must_use]
    pub fn is_terminal(&self) -> bool {
        self.state.is_terminal()
    }

    /// Whether Pause v1 is active (suspend-acquisition overlay).
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Deferred follow-up URI for a catalog position, if that entry is
    /// still-deferred metadata pointing at another resource. Native hosts
    /// follow the first catalog entry's URI with a fresh job (bounded);
    /// the projected catalog event carries readiness but never URIs.
    #[must_use]
    pub fn deferred_uri(&self, image: u32) -> Option<String> {
        let index = usize::try_from(image).ok()?;
        match self.catalog.as_ref()?.entries().get(index)? {
            CatalogEntry::Ready(_) => None,
            CatalogEntry::Deferred(deferred) => Some(deferred.uri.clone()),
        }
    }

    /// Number of queued messages.
    #[must_use]
    pub fn pending_message_count(&self) -> usize {
        self.messages.len()
    }

    /// Take queued messages exactly once in sequence order.
    #[must_use]
    pub fn drain_messages(&mut self) -> Vec<JobMessage> {
        self.messages.drain(..).collect()
    }

    /// Peek queued messages without acknowledging work.
    #[must_use]
    pub fn peek_messages(&self) -> &VecDeque<JobMessage> {
        &self.messages
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
        // Genuine core use: `None`/`auto` orders candidates by URL
        // preference via `default_registry`; a named format selects the
        // single program via `registry_for`. Unknown names fail typed.
        let registry = match self.format.as_deref() {
            None | Some("auto") => default_registry(&self.input_url),
            Some(name) => registry_for(name).ok_or_else(|| {
                JobError::new("job.unknown-dezoomer", format!("unknown dezoomer '{name}'"))
            })?,
        };
        self.discovery = Some(registry.start(self.input_url.clone()));
        self.set_state(State::Discovering)?;
        self.push_event(JobEvent::State {
            state: State::Discovering,
        })?;
        self.drive_discovery()?;
        Ok(Outcome::Applied)
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
            JobCommand::SelectLevel { level } => self.apply_selected_level(level),
            JobCommand::DestinationGranted => self.apply_destination_granted(),
            JobCommand::DestinationDenied => self.apply_destination_denied(),
            JobCommand::TileOutcome { tile, ok } => self.apply_tile_outcome(tile, ok),
            JobCommand::ProbeOutcome {
                tile,
                available,
                width,
                height,
            } => self.apply_probe_outcome(tile, available, width, height),
            JobCommand::RetryReady => self.apply_retry_ready(),
            JobCommand::PartialChoice { generation, keep } => {
                self.apply_partial_keep(generation, keep)
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
        let images = crate::projection::project_catalog(&catalog).images;
        self.catalog = Some(catalog);
        self.catalog_images = images;
        // Sibling discovery fetches still in flight are moot once the
        // catalog wins; drop them so late answers are plain duplicates.
        self.pending_discovery.clear();
        self.set_state(State::AwaitingImageSelection)?;
        self.push_event(JobEvent::Catalog {
            catalog: dezoomify_protocol::dto::CatalogDto {
                images: self.catalog_images.clone(),
            },
        })?;
        self.push_event(JobEvent::State {
            state: State::AwaitingImageSelection,
        })?;
        Ok(())
    }

    fn discovery_failed(&mut self, error: DiscoveryError) -> Result<(), JobError> {
        // `engine_detail` keeps the headline out: the prominent message
        // is the host's own copy, never the engine's aggregate.
        self.fail_via_cleanup("job.discovery-failed", error.engine_detail())
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
            self.discovery = None;
            self.discovery_failed(e)?;
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
            self.discovery = None;
            self.discovery_failed(e)?;
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
        let selected = self
            .catalog_images
            .get(index)
            .ok_or_else(|| JobError::invalid_state("image position is out of range"))?;
        if selected.readiness != Readiness::Ready {
            return Err(JobError::invalid_state(
                "image metadata was not fetched; the image cannot be selected",
            ));
        }
        self.selected_image = Some(image);
        self.selected_image_index = Some(index);
        self.set_state(State::AwaitingLevelSelection)?;
        let levels: Vec<u32> = (0..self.catalog_images[index].levels.len())
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
        if self.catalog_images[image_index]
            .levels
            .get(level_index)
            .is_none()
        {
            return Err(JobError::invalid_state("level position is out of range"));
        }
        self.selected_level = Some(level);
        self.selected_level_index = Some(level_index);
        self.set_state(State::AwaitingDestination)?;
        self.push_effect(JobEffect::RequestDestination {
            format: "png".to_string(),
        })?;
        self.push_event(JobEvent::State {
            state: State::AwaitingDestination,
        })?;
        Ok(Outcome::Applied)
    }

    fn apply_destination_granted(&mut self) -> Result<Outcome, JobError> {
        if self.state != State::AwaitingDestination {
            return Err(JobError::invalid_state(
                "destination grant valid only in AwaitingDestination",
            ));
        }
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
            TileSource::DiscoverableGrid(discoverable) => {
                if !self.config.plan_probes {
                    return self.fail_via_cleanup(
                        "job.probe-unsupported",
                        "probe-driven planning is disabled for this host; use the interactive discovery adapter".to_string(),
                    );
                }
                self.drive_probe(discoverable.start())
            }
            TileSource::Adaptive(adaptive) => {
                if !self.config.plan_probes {
                    return self.fail_via_cleanup(
                        "job.probe-unsupported",
                        "probe-driven planning is disabled for this host; use the interactive discovery adapter".to_string(),
                    );
                }
                self.drive_probe(adaptive.start())
            }
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
            self.tile_processing
                .insert(ordinal, processing_name(&spec.processing).to_string());
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
            DiscoverableStep::Resolved { grid, .. } => {
                let canvas = Some(grid.image_size());
                self.plan_from_tiles(grid.tiles_row_major(), canvas)
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
                let wire = self.next_probe;
                self.next_probe = self
                    .next_probe
                    .checked_add(1)
                    .ok_or_else(|| JobError::overflow("probe id"))?;
                self.probe = Some(continuation);
                self.probe_tile = Some(wire);
                self.probe_tiles.insert(wire);
                self.tile_uris.insert(wire, tile.request.uri.clone());
                self.tile_headers.insert(wire, tile.request.headers.clone());
                self.tile_processing
                    .insert(wire, processing_name(&tile.processing).to_string());
                self.tile_destinations.insert(wire, tile.destination);
                self.tile_extents.insert(wire, tile.expected_size);
                self.in_flight.insert(wire);
                self.push_acquire_tile(wire, true)?;
                Ok(())
            }
        }
    }

    /// Shared transition from a complete plan into bounded acquisition.
    fn begin_acquisition(&mut self, planned: Vec<u32>) -> Result<(), JobError> {
        let total = planned.len() as u64;
        for wire in planned {
            self.planned_tiles.push(wire);
        }
        self.probe_tiles.clear();
        self.pending_tiles = self.planned_tiles.clone();
        self.in_flight.clear();
        self.acquired_tiles.clear();
        self.set_state(State::AcquiringTiles)?;
        self.push_event(JobEvent::Progress { acquired: 0, total })?;
        self.push_event(JobEvent::State {
            state: State::AcquiringTiles,
        })?;
        self.emit_pending_tiles()?;
        Ok(())
    }

    fn apply_destination_denied(&mut self) -> Result<Outcome, JobError> {
        if self.state != State::AwaitingDestination {
            return Err(JobError::invalid_state(
                "destination denial valid only in AwaitingDestination",
            ));
        }
        self.recovery_reason = Some("destination".to_string());
        let generation = self.alloc_decision_generation()?;
        self.set_state(State::AwaitingRecovery)?;
        self.push_effect(JobEffect::RequestDecision {
            generation,
            reason: DecisionReason::Destination,
        })?;
        self.push_event(JobEvent::RecoveryRequested {
            generation,
            reason: DecisionReason::Destination,
        })?;
        self.push_event(JobEvent::State {
            state: State::AwaitingRecovery,
        })?;
        Ok(Outcome::Applied)
    }

    fn apply_tile_outcome(&mut self, tile: u32, ok: bool) -> Result<Outcome, JobError> {
        if self.probe_tiles.contains(&tile) {
            return Err(JobError::invalid_state(
                "probe tiles are answered with a probe outcome, not a tile outcome",
            ));
        }
        if self.state != State::AcquiringTiles {
            return Err(JobError::invalid_state(
                "tile outcome valid only in AcquiringTiles",
            ));
        }
        if !self.planned_tiles.contains(&tile) {
            return Err(JobError::invalid_state("tile ordinal is out of range"));
        }
        if self.acquired_tiles.contains(&tile) {
            return Ok(Outcome::Ignored);
        }
        if ok {
            self.in_flight.remove(&tile);
            self.pending_tiles.retain(|value| *value != tile);
            self.acquired_tiles.insert(tile);
            let acquired = u64::try_from(self.acquired_tiles.len())
                .map_err(|_| JobError::overflow("acquired count"))?;
            let total = self.planned_tiles.len() as u64;
            self.push_event(JobEvent::Progress { acquired, total })?;
            // Pause v1: finish in-flight, retain decoded, defer completion
            // and new scheduling until resume. Resume re-drives completion
            // when every tile has arrived while paused.
            if self.paused {
                return Ok(Outcome::Applied);
            }
            if self.acquired_tiles.len() == self.planned_tiles.len() {
                self.complete_remaining(false)?;
            } else {
                self.emit_pending_tiles()?;
            }
            return Ok(Outcome::Applied);
        }
        let current = self.tile_attempts.get(&tile).copied().unwrap_or(0);
        let next = current
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("tile attempts"))?;
        self.tile_attempts.insert(tile, next);
        if next <= self.config.max_retries {
            self.in_flight.remove(&tile);
            if !self.pending_tiles.contains(&tile) {
                self.pending_tiles.insert(0, tile);
            }
            self.push_event(JobEvent::Warning {
                tile,
                attempt: next,
            })?;
            // Pause v1: retry wakeups are preserved in `pending_tiles` and
            // re-driven on resume; no new `acquire-tile` while paused.
            if !self.paused {
                self.emit_pending_tiles()?;
            }
            return Ok(Outcome::Applied);
        }
        self.in_flight.remove(&tile);
        self.pending_tiles.retain(|value| *value != tile);
        if !self.failed_tiles.contains(&tile) {
            self.failed_tiles.push(tile);
        }
        self.recovery_reason = Some("tile".to_string());
        let generation = self.alloc_decision_generation()?;
        self.set_state(State::AwaitingPartialDecision)?;
        self.push_effect(JobEffect::RequestDecision {
            generation,
            reason: DecisionReason::Partial,
        })?;
        self.push_event(JobEvent::MissingWork {
            failed: self.failed_tiles.clone(),
        })?;
        self.push_event(JobEvent::RecoveryRequested {
            generation,
            reason: DecisionReason::Partial,
        })?;
        self.push_event(JobEvent::State {
            state: State::AwaitingPartialDecision,
        })?;
        Ok(Outcome::Applied)
    }

    fn apply_probe_outcome(
        &mut self,
        tile: u32,
        available: bool,
        width: u64,
        height: u64,
    ) -> Result<Outcome, JobError> {
        if self.state != State::Planning || self.probe_tile != Some(tile) {
            return Err(JobError::invalid_state(
                "probe outcome valid only for the outstanding probe while Planning",
            ));
        }
        if !self.probe_tiles.contains(&tile) {
            return Err(JobError::invalid_state("unknown probe tile id"));
        }
        let observation = if available {
            if width == 0 || height == 0 {
                return Err(JobError::invalid_state(
                    "available probe observations need positive width and height",
                ));
            }
            let x = u32::try_from(width).map_err(|_| JobError::overflow("probe width"))?;
            let y = u32::try_from(height).map_err(|_| JobError::overflow("probe height"))?;
            ObservationResult::Available {
                size: dezoomify_core::Vec2d { x, y },
            }
        } else {
            ObservationResult::Missing
        };
        self.probe_tile = None;
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

    fn apply_retry_ready(&mut self) -> Result<Outcome, JobError> {
        match self.state {
            State::AwaitingRecovery => {
                let reason = self
                    .recovery_reason
                    .clone()
                    .ok_or_else(|| JobError::invalid_state("no recovery pending for retry"))?;
                match reason.as_str() {
                    "destination" => {
                        self.recovery_reason = None;
                        self.pending_decision = None;
                        self.set_state(State::AwaitingDestination)?;
                        self.push_effect(JobEffect::RequestDestination {
                            format: "png".to_string(),
                        })?;
                        self.push_event(JobEvent::State {
                            state: State::AwaitingDestination,
                        })?;
                        Ok(Outcome::Applied)
                    }
                    _ => {
                        self.recovery_reason = None;
                        self.pending_decision = None;
                        self.set_state(State::AcquiringTiles)?;
                        self.push_event(JobEvent::State {
                            state: State::AcquiringTiles,
                        })?;
                        // Pause v1: retry wakeups are preserved; new tiles
                        // wait for resume.
                        if !self.paused {
                            self.emit_pending_tiles()?;
                        }
                        Ok(Outcome::Applied)
                    }
                }
            }
            State::AwaitingPartialDecision => {
                self.recovery_reason = None;
                self.pending_decision = None;
                self.failed_tiles.clear();
                self.set_state(State::AcquiringTiles)?;
                self.push_event(JobEvent::State {
                    state: State::AcquiringTiles,
                })?;
                if !self.paused {
                    self.emit_pending_tiles()?;
                }
                Ok(Outcome::Applied)
            }
            _ => Err(JobError::invalid_state(
                "retry-ready valid only in AwaitingRecovery or AwaitingPartialDecision",
            )),
        }
    }

    fn apply_partial_keep(&mut self, generation: u32, keep: bool) -> Result<Outcome, JobError> {
        if self.state != State::AwaitingPartialDecision {
            return Err(JobError::invalid_state(
                "partial choice valid only in AwaitingPartialDecision",
            ));
        }
        if self.pending_decision != Some(generation) {
            return Err(JobError::invalid_state(
                "partial choice generation is stale",
            ));
        }
        self.recovery_reason = None;
        self.pending_decision = None;
        if keep {
            self.complete_remaining(true)?;
        } else {
            self.fail_via_cleanup(
                "job.partial-discarded",
                "partial result discarded by choice".to_string(),
            )?;
        }
        Ok(Outcome::Applied)
    }

    fn enter_cancelled(&mut self) -> Result<Outcome, JobError> {
        self.paused = false;
        self.set_state(State::Cancelling)?;
        self.push_effect(JobEffect::CancelWork)?;
        self.push_event(JobEvent::State {
            state: State::Cancelling,
        })?;
        self.set_state(State::CleaningUp)?;
        self.push_effect(JobEffect::ReleaseBytes)?;
        self.push_event(JobEvent::State {
            state: State::CleaningUp,
        })?;
        self.set_state(State::Cancelled)?;
        self.push_event(JobEvent::State {
            state: State::Cancelled,
        })?;
        self.push_event(JobEvent::Cancelled)?;
        self.terminal = Some("cancelled".to_string());
        Ok(Outcome::Applied)
    }

    /// Pause v1 (suspend-acquisition): stop scheduling new `acquire-tile`
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
        self.set_state(State::ProcessingTiles)?;
        // A partial result deliberately has holes: only successfully acquired
        // tiles can be decoded. Emitting decode work for failed or still
        // in-flight tiles makes every host treat an accepted partial result as
        // an output-state failure before it can encode the retained pieces.
        let tiles_to_decode: Vec<_> = self
            .planned_tiles
            .clone()
            .into_iter()
            .filter(|tile| !partial || self.acquired_tiles.contains(tile))
            .collect();
        for tile in tiles_to_decode {
            self.push_effect(JobEffect::DecodePixels { tile })?;
        }
        self.push_event(JobEvent::State {
            state: State::ProcessingTiles,
        })?;
        self.set_state(State::Encoding)?;
        self.push_effect(JobEffect::OpenEncoder {
            format: "png".to_string(),
            canvas: self.canvas_size,
        })?;
        self.push_event(JobEvent::State {
            state: State::Encoding,
        })?;
        self.set_state(State::Finalizing)?;
        self.push_effect(JobEffect::FinalizeEncoder)?;
        self.push_event(JobEvent::State {
            state: State::Finalizing,
        })?;
        self.set_state(State::Publishing)?;
        self.push_effect(JobEffect::PublishOutput)?;
        self.push_event(JobEvent::State {
            state: State::Publishing,
        })?;
        self.set_state(State::CleaningUp)?;
        self.push_effect(JobEffect::ReleaseBytes)?;
        self.push_event(JobEvent::State {
            state: State::CleaningUp,
        })?;
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
        Ok(())
    }

    fn fail_via_cleanup(&mut self, code: &str, message: String) -> Result<(), JobError> {
        self.paused = false;
        self.set_state(State::CleaningUp)?;
        self.push_effect(JobEffect::ReleaseBytes)?;
        self.push_event(JobEvent::State {
            state: State::CleaningUp,
        })?;
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

    fn emit_pending_tiles(&mut self) -> Result<(), JobError> {
        // Pause v1: suspend-acquisition stops new scheduling; in-flight
        // finishes, decoded output is retained, FIFO order is preserved.
        if self.paused {
            return Ok(());
        }
        let limit = usize::try_from(self.config.max_concurrent_fetches)
            .map_err(|_| JobError::overflow("concurrency"))?;
        while self.in_flight.len() < limit {
            let Some(next) = self.pending_tiles.first().cloned() else {
                break;
            };
            if self.acquired_tiles.contains(&next) {
                self.pending_tiles.remove(0);
                continue;
            }
            if self.in_flight.contains(&next) {
                self.pending_tiles.remove(0);
                continue;
            }
            self.pending_tiles.remove(0);
            self.in_flight.insert(next);
            self.push_acquire_tile(next, false)?;
        }
        Ok(())
    }

    /// Stable byte-processing recipe name for the wire. Hosts that decode
    /// pixels (native) apply it before decoding; hosts that never decode
    /// (browser) ignore it.
    fn push_acquire_tile(&mut self, wire: u32, probe: bool) -> Result<(), JobError> {
        let uri = self.tile_uris.get(&wire).cloned().unwrap_or_default();
        let headers = self.tile_headers.get(&wire).cloned().unwrap_or_default();
        let processing = self
            .tile_processing
            .get(&wire)
            .cloned()
            .unwrap_or_else(|| "none".to_string());
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

/// Stable wire name for a core byte-processing recipe. The mapping is total
/// over the closed recipe enum; unknown recipes cannot exist without a
/// compile error here, so hosts never mis-decode.
fn processing_name(recipe: &ProcessingRecipe) -> &'static str {
    match recipe {
        ProcessingRecipe::None => "none",
        ProcessingRecipe::GoogleArtsDecrypt => "google-arts-decrypt",
    }
}

/// Whether `input_url` names a fetchable input: `http(s)` URLs, local
/// `file://` URIs (only `file:///abs/path` and `file://localhost/abs/path`,
/// mirroring the native `fetch_local` mapping; any other `file://` host is
/// rejected), or plain filesystem paths read via `fs::read`. Empty and
/// over-long inputs are rejected. Messages never echo the input text, which
/// may name private directories.
fn is_valid_input_url(input_url: &str) -> bool {
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
