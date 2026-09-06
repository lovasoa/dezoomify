//! Deterministic portable job state machine.
//!
//! The job decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. Hosts feed
//! explicit [`JobResponse`] inputs and drain [`Job::drain_effects`] and
//! [`Job::drain_effects`]/events. All counters use checked arithmetic.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::json;

use dezoomify_core::core::adaptive::{DiscoverableStep, ObservationResult, ProbeContinuation};
use dezoomify_core::core::discovery::{
    DiscoveryError, DiscoveryOperation, ResourceFailure, ResourceResponse,
};
use dezoomify_core::core::model::{CatalogEntry, ImageCatalog, ProcessingRecipe};
use dezoomify_core::core::registry::default_registry;
use dezoomify_core::core::tile_plan::TileSource;
use dezoomify_core::Vec2d;
use dezoomify_protocol::dto::{ImageDto, Readiness};

use crate::config::Config;
use crate::state::State;
use crate::transition::{make_effect, make_event, JobError, JobResponse, Outcome};

/// One end-to-end user request driven synchronously by explicit host inputs.
pub struct Job {
    id: String,
    input_url: String,
    config: Config,
    state: State,
    seq: u64,
    effects: Vec<serde_json::Value>,
    events: Vec<serde_json::Value>,
    /// Outstanding discovery resource fetches: wire request id -> core id.
    pending_discovery: HashMap<String, usize>,
    /// Core discovery operation while discovery is in flight.
    discovery: Option<DiscoveryOperation>,
    /// Finished core catalog.
    catalog: Option<ImageCatalog>,
    /// Projected wire catalog (same order as `catalog` entries).
    catalog_images: Vec<ImageDto>,
    selected_image: Option<String>,
    selected_image_index: Option<usize>,
    selected_level: Option<String>,
    selected_level_index: Option<usize>,
    destination: Option<String>,
    planned_tiles: Vec<String>,
    pending_tiles: Vec<String>,
    in_flight: HashSet<String>,
    acquired_tiles: HashSet<String>,
    tile_attempts: HashMap<String, u32>,
    /// Tile request URIs by wire tile id (planned and probe tiles).
    tile_uris: HashMap<String, String>,
    /// Core request headers by wire tile id (sent verbatim by native hosts;
    /// browser hosts ignore them).
    tile_headers: HashMap<String, BTreeMap<String, String>>,
    /// Stable byte-processing recipe names by wire tile id (`none`,
    /// `google-arts-decrypt`).
    tile_processing: HashMap<String, String>,
    /// Output destinations by wire tile id.
    tile_destinations: HashMap<String, Vec2d>,
    /// Expected decoded extents by wire tile id (`None` while unknown).
    tile_extents: HashMap<String, Option<Vec2d>>,
    /// Declared canvas size for the planned level (`None` while unknown,
    /// e.g. mid-probe or custom layouts that derive it from tiles).
    canvas_size: Option<Vec2d>,
    /// Wire tile ids emitted as probes (answered via `ProbeOutcome`).
    probe_tiles: HashSet<String>,
    /// Pending probe continuation; exactly one probe is in flight.
    probe: Option<ProbeContinuation>,
    probe_tile: Option<String>,
    probes_emitted: u32,
    recovery_reason: Option<String>,
    failed_tiles: Vec<String>,
    terminal: Option<String>,
    next_request: u32,
    next_effect: u32,
    next_recovery: u32,
    next_probe: u32,
}

impl std::fmt::Debug for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The core discovery operation is not `Debug`; the machine summary
        // stays informative without it.
        f.debug_struct("Job")
            .field("id", &self.id)
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
    /// Returns a typed [`JobError`] when the job id, input URL, or config is
    /// invalid.
    pub fn new(job_id: &str, input_url: &str, config: Config) -> Result<Self, JobError> {
        if dezoomify_protocol::dto::JobId::new(job_id).is_none() {
            return Err(JobError::invalid_id("job id must look like job:<suffix>"));
        }
        if input_url.is_empty()
            || input_url.len() > 2048
            || !(input_url.starts_with("http://") || input_url.starts_with("https://"))
        {
            return Err(JobError::new(
                "job.invalid-input",
                "input_url must be an http(s) URL up to 2048 bytes".to_string(),
            ));
        }
        if let Err(e) = config.validate() {
            return Err(JobError::new(&e.code, e.message));
        }
        Ok(Self {
            id: job_id.to_string(),
            input_url: input_url.to_string(),
            config,
            state: State::Created,
            seq: 0,
            effects: Vec::new(),
            events: Vec::new(),
            pending_discovery: HashMap::new(),
            discovery: None,
            catalog: None,
            catalog_images: Vec::new(),
            selected_image: None,
            selected_image_index: None,
            selected_level: None,
            selected_level_index: None,
            destination: None,
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
            failed_tiles: Vec::new(),
            terminal: None,
            next_request: 0,
            next_effect: 0,
            next_recovery: 0,
            next_probe: 0,
        })
    }

    /// Current state.
    #[must_use]
    pub fn state(&self) -> State {
        self.state
    }

    /// Owning job id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Monotonic sequence last assigned (checked arithmetic).
    #[must_use]
    pub fn seq(&self) -> u64 {
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

    /// Deferred follow-up URI for a wire image id, if that catalog entry is
    /// still-deferred metadata pointing at another resource. Native hosts
    /// follow the first catalog entry's URI with a fresh job (bounded);
    /// the projected catalog event carries readiness but never URIs.
    #[must_use]
    pub fn deferred_uri(&self, image: &str) -> Option<String> {
        let index = self
            .catalog_images
            .iter()
            .position(|entry| entry.id.as_str() == image)?;
        match self.catalog.as_ref()?.entries().get(index)? {
            CatalogEntry::Ready(_) => None,
            CatalogEntry::Deferred(deferred) => Some(deferred.uri.clone()),
        }
    }

    /// Number of queued effects (drain does not acknowledge until called).
    #[must_use]
    pub fn pending_effect_count(&self) -> usize {
        self.effects.len()
    }

    /// Number of queued events.
    #[must_use]
    pub fn pending_event_count(&self) -> usize {
        self.events.len()
    }

    /// Take queued effects exactly once (FIFO).
    #[must_use]
    pub fn drain_effects(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.effects)
    }

    /// Take queued events exactly once (FIFO).
    #[must_use]
    pub fn drain_events(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.events)
    }

    /// Peek queued effects without acknowledging work.
    #[must_use]
    pub fn peek_effects(&self) -> &[serde_json::Value] {
        &self.effects
    }

    /// Peek queued events without acknowledging work.
    #[must_use]
    pub fn peek_events(&self) -> &[serde_json::Value] {
        &self.events
    }

    /// Validate start and enter `Discovering` with one metadata fetch effect.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] when called outside `Created` or on overflow.
    pub fn start(&mut self) -> Result<Outcome, JobError> {
        if self.terminal.is_some() {
            return Err(JobError::post_terminal());
        }
        if self.state != State::Created {
            return Err(JobError::invalid_state("start is valid only in Created"));
        }
        // Genuine core use: the default registry orders candidates by URL
        // preference; the operation stays pure and deterministic.
        let registry = default_registry(&self.input_url);
        self.discovery = Some(registry.start(self.input_url.clone()));
        self.set_state(State::Discovering)?;
        self.push_event("job-state", json!({"state": State::Discovering.name()}))?;
        self.drive_discovery()?;
        Ok(Outcome::Applied)
    }

    /// Drive one deterministic transition from an explicit host response.
    ///
    /// Wrong-job and post-terminal inputs are stably rejected with no new
    /// work. Duplicates are ignored. Valid inputs advance state and queue
    /// effects/events with monotonic `seq`.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] for wrong-job, post-terminal, invalid-state,
    /// invalid-id, and counter-overflow rejections.
    pub fn on_response(&mut self, response: JobResponse) -> Result<Outcome, JobError> {
        if response.job_id() != self.id {
            return Err(JobError::wrong_job(&self.id));
        }
        if self.terminal.is_some() {
            return Err(JobError::post_terminal());
        }
        // Cancellation is valid in every non-terminal state.
        if matches!(response, JobResponse::Cancel { .. }) {
            return self.enter_cancelled();
        }
        match response {
            JobResponse::Cancel { .. } => self.enter_cancelled(),
            JobResponse::ResourceBytes {
                request,
                bytes,
                final_uri,
                ..
            } => self.apply_resource_bytes(&request, bytes, final_uri),
            JobResponse::FetchFailure { request, .. } => self.apply_fetch_failure(&request),
            JobResponse::SelectedImage { image, .. } => self.apply_selected_image(&image),
            JobResponse::SelectedLevel { level, .. } => self.apply_selected_level(&level),
            JobResponse::DestinationGranted { destination, .. } => {
                self.apply_destination_granted(&destination)
            }
            JobResponse::DestinationDenied { .. } => self.apply_destination_denied(),
            JobResponse::TileOutcome { tile, ok, .. } => self.apply_tile_outcome(&tile, ok),
            JobResponse::ProbeOutcome {
                tile,
                available,
                width,
                height,
                ..
            } => self.apply_probe_outcome(&tile, available, width, height),
            JobResponse::RetryReady { attempt, .. } => self.apply_retry_ready(&attempt),
            JobResponse::PartialKeep { keep, .. } => self.apply_partial_keep(keep),
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
            self.pending_discovery.insert(wire.clone(), need.id.0);
            let effect = self.alloc_effect_id()?;
            let mut header_names: Vec<String> = need.request.headers.keys().cloned().collect();
            header_names.sort();
            self.push_effect(
                "acquire-resource",
                json!({
                    "effect": effect,
                    "request": wire,
                    "uri": need.request.uri,
                    "purpose": "metadata",
                    "header_names": header_names,
                }),
            )?;
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
        let catalog = match catalog.normalize() {
            Ok(catalog) => catalog,
            Err(e) => {
                return self.fail_via_cleanup("job.catalog-invalid", e.to_string());
            }
        };
        if catalog.is_empty() {
            return self
                .fail_via_cleanup("job.no-images", "discovery produced no images".to_string());
        }
        let images = crate::projection::project_catalog(&catalog)
            .map_err(|e| JobError::new("job.catalog-invalid", e.to_string()))?
            .images;
        self.catalog = Some(catalog);
        self.catalog_images = images;
        // Sibling discovery fetches still in flight are moot once the
        // catalog wins; drop them so late answers are plain duplicates.
        self.pending_discovery.clear();
        self.set_state(State::AwaitingImageSelection)?;
        let payload = serde_json::json!({ "images": self.catalog_images });
        self.push_event("catalog", payload)?;
        self.push_event(
            "job-state",
            json!({"state": State::AwaitingImageSelection.name()}),
        )?;
        Ok(())
    }

    fn discovery_failed(&mut self, error: DiscoveryError) -> Result<(), JobError> {
        self.fail_via_cleanup("job.discovery-failed", error.to_string())
    }

    fn apply_resource_bytes(
        &mut self,
        request: &str,
        bytes: Vec<u8>,
        final_uri: Option<String>,
    ) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::RequestId::new(request).is_none() {
            return Err(JobError::invalid_id("request must look like req:<suffix>"));
        }
        let Some(&core_id) = self.pending_discovery.get(request) else {
            return Ok(Outcome::Ignored);
        };
        // Batch discovery emits one effect per outstanding core need; the
        // first answer may complete discovery while sibling fetches are
        // still in flight. Late answers for still-pending requests are
        // moot and safely ignored so the winning catalog survives.
        if self.state != State::Discovering {
            self.pending_discovery.remove(request);
            return Ok(Outcome::Ignored);
        }
        let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if len > self.config.max_bytes {
            self.pending_discovery.remove(request);
            self.discovery = None;
            self.fail_via_cleanup(
                "job.resource-limit",
                format!("resource bytes {len} exceed max_bytes"),
            )?;
            return Ok(Outcome::Applied);
        }
        if bytes.is_empty() {
            self.pending_discovery.remove(request);
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
            // request URI it asked for.
            let response = match final_uri {
                Some(uri) => response.with_final_uri(uri),
                None => response,
            };
            operation.provide(response)
        };
        if let Err(e) = outcome {
            self.pending_discovery.remove(request);
            self.discovery = None;
            self.discovery_failed(e)?;
            return Ok(Outcome::Applied);
        }
        self.pending_discovery.remove(request);
        self.drive_discovery()?;
        Ok(Outcome::Applied)
    }

    fn apply_fetch_failure(&mut self, request: &str) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::RequestId::new(request).is_none() {
            return Err(JobError::invalid_id("request must look like req:<suffix>"));
        }
        let Some(&core_id) = self.pending_discovery.get(request) else {
            return Ok(Outcome::Ignored);
        };
        // Sibling discovery fetches may still fail after a winner already
        // completed discovery; those late failures are moot and ignored.
        if self.state != State::Discovering {
            self.pending_discovery.remove(request);
            return Ok(Outcome::Ignored);
        }
        // The core owns candidate fallback on failure: it may surface another
        // need (a different candidate) or end discovery with a typed error.
        let outcome = {
            let Some(operation) = self.discovery.as_mut() else {
                return Err(JobError::invalid_state("discovery already finished"));
            };
            operation.provide_failure(ResourceFailure {
                id: dezoomify_core::core::discovery::RequestId(core_id),
                message: "host fetch failed".to_string(),
            })
        };
        self.pending_discovery.remove(request);
        if let Err(e) = outcome {
            self.discovery = None;
            self.discovery_failed(e)?;
            return Ok(Outcome::Applied);
        }
        self.drive_discovery()?;
        Ok(Outcome::Applied)
    }

    fn apply_selected_image(&mut self, image: &str) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::ImageId::new(image).is_none() {
            return Err(JobError::invalid_id("image must look like img:<suffix>"));
        }
        if self.selected_image.as_deref() == Some(image) {
            return Ok(Outcome::Ignored);
        }
        if self.state != State::AwaitingImageSelection {
            return Err(JobError::invalid_state(
                "image selection valid only in AwaitingImageSelection",
            ));
        }
        let index = self
            .catalog_images
            .iter()
            .position(|entry| entry.id.as_str() == image)
            .ok_or_else(|| JobError::invalid_state("unknown image id"))?;
        if self.catalog_images[index].readiness != Readiness::Ready {
            return Err(JobError::invalid_state(
                "image metadata was not fetched; the image cannot be selected",
            ));
        }
        self.selected_image = Some(image.to_string());
        self.selected_image_index = Some(index);
        self.set_state(State::AwaitingLevelSelection)?;
        let levels: Vec<String> = self.catalog_images[index]
            .levels
            .iter()
            .map(|level| level.id.as_str().to_string())
            .collect();
        self.push_event("levels", json!({"image": image, "levels": levels}))?;
        self.push_event(
            "job-state",
            json!({"state": State::AwaitingLevelSelection.name()}),
        )?;
        Ok(Outcome::Applied)
    }

    fn apply_selected_level(&mut self, level: &str) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::LevelId::new(level).is_none() {
            return Err(JobError::invalid_id("level must look like lvl:<suffix>"));
        }
        if self.selected_level.as_deref() == Some(level) {
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
        let level_index = self.catalog_images[image_index]
            .levels
            .iter()
            .position(|entry| entry.id.as_str() == level)
            .ok_or_else(|| JobError::invalid_state("unknown level id for the selected image"))?;
        self.selected_level = Some(level.to_string());
        self.selected_level_index = Some(level_index);
        let effect = self.alloc_effect_id()?;
        self.set_state(State::AwaitingDestination)?;
        self.push_effect(
            "request-destination",
            json!({"effect": effect, "format": "png"}),
        )?;
        self.push_event(
            "job-state",
            json!({"state": State::AwaitingDestination.name()}),
        )?;
        Ok(Outcome::Applied)
    }

    fn apply_destination_granted(&mut self, destination: &str) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::DestinationId::new(destination).is_none() {
            return Err(JobError::invalid_id(
                "destination must look like dst:<suffix>",
            ));
        }
        if self.state != State::AwaitingDestination {
            return Err(JobError::invalid_state(
                "destination grant valid only in AwaitingDestination",
            ));
        }
        self.destination = Some(destination.to_string());
        self.set_state(State::Planning)?;
        self.push_event("job-state", json!({"state": State::Planning.name()}))?;
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
        let mut planned: Vec<String> = Vec::new();
        for tile in tiles {
            let spec = match tile {
                Ok(spec) => spec,
                Err(e) => return self.fail_via_cleanup("job.plan-invalid", e.to_string()),
            };
            if spec.role == dezoomify_core::core::model::TileRole::Probe {
                continue;
            }
            let ordinal =
                u32::try_from(spec.id.ordinal).map_err(|_| JobError::overflow("tile ordinal"))?;
            if planned.len() + 1 > self.config.max_tiles as usize {
                return self.fail_via_cleanup(
                    "job.resource-limit",
                    format!("tile plan exceeds max_tiles {}", self.config.max_tiles),
                );
            }
            let wire = format!("tile:{ordinal}");
            self.tile_uris.insert(wire.clone(), spec.request.uri);
            self.tile_headers.insert(wire.clone(), spec.request.headers);
            self.tile_processing
                .insert(wire.clone(), processing_name(&spec.processing).to_string());
            self.tile_destinations
                .insert(wire.clone(), spec.destination);
            self.tile_extents.insert(wire.clone(), spec.expected_size);
            planned.push(wire);
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
                let wire = format!("tile:probe-{}", self.next_probe);
                self.next_probe = self
                    .next_probe
                    .checked_add(1)
                    .ok_or_else(|| JobError::overflow("probe id"))?;
                self.probe = Some(continuation);
                self.probe_tile = Some(wire.clone());
                self.probe_tiles.insert(wire.clone());
                self.tile_uris
                    .insert(wire.clone(), tile.request.uri.clone());
                self.tile_headers
                    .insert(wire.clone(), tile.request.headers.clone());
                self.tile_processing
                    .insert(wire.clone(), processing_name(&tile.processing).to_string());
                self.tile_destinations
                    .insert(wire.clone(), tile.destination);
                self.tile_extents.insert(wire.clone(), tile.expected_size);
                self.in_flight.insert(wire.clone());
                self.push_acquire_tile(&wire, true)?;
                Ok(())
            }
        }
    }

    /// Shared transition from a complete plan into bounded acquisition.
    fn begin_acquisition(&mut self, planned: Vec<String>) -> Result<(), JobError> {
        let total = planned.len() as u64;
        for wire in planned {
            self.planned_tiles.push(wire);
        }
        self.pending_tiles = self
            .planned_tiles
            .iter()
            .filter(|wire| !self.probe_tiles.contains(*wire))
            .cloned()
            .collect();
        self.in_flight.clear();
        self.acquired_tiles.clear();
        self.set_state(State::AcquiringTiles)?;
        self.push_event("progress", json!({"acquired": 0, "total": total}))?;
        self.push_event("job-state", json!({"state": State::AcquiringTiles.name()}))?;
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
        let effect = self.alloc_effect_id()?;
        let recovery = self.alloc_recovery_id()?;
        self.set_state(State::AwaitingRecovery)?;
        self.push_effect(
            "request-decision",
            json!({"effect": effect, "recovery": recovery, "reason": "destination"}),
        )?;
        self.push_event("recovery-requested", json!({"reason": "destination"}))?;
        self.push_event(
            "job-state",
            json!({"state": State::AwaitingRecovery.name()}),
        )?;
        Ok(Outcome::Applied)
    }

    fn apply_tile_outcome(&mut self, tile: &str, ok: bool) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::TileId::new(tile).is_none() {
            return Err(JobError::invalid_id("tile must look like tile:<suffix>"));
        }
        if self.probe_tiles.contains(tile) {
            return Err(JobError::invalid_state(
                "probe tiles are answered with a probe outcome, not a tile outcome",
            ));
        }
        if self.state != State::AcquiringTiles {
            return Err(JobError::invalid_state(
                "tile outcome valid only in AcquiringTiles",
            ));
        }
        if !self.planned_tiles.contains(&tile.to_string()) {
            return Err(JobError::invalid_state("unknown tile id"));
        }
        if self.acquired_tiles.contains(tile) {
            return Ok(Outcome::Ignored);
        }
        if ok {
            self.in_flight.remove(tile);
            self.pending_tiles.retain(|t| t != tile);
            self.acquired_tiles.insert(tile.to_string());
            let acquired = u64::try_from(self.acquired_tiles.len())
                .map_err(|_| JobError::overflow("acquired count"))?;
            let total = self.planned_tiles.len() as u64;
            self.push_event("progress", json!({"acquired": acquired, "total": total}))?;
            if self.acquired_tiles.len() == self.planned_tiles.len() {
                self.complete_remaining(false)?;
            } else {
                self.emit_pending_tiles()?;
            }
            return Ok(Outcome::Applied);
        }
        let current = self.tile_attempts.get(tile).copied().unwrap_or(0);
        let next = current
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("tile attempts"))?;
        self.tile_attempts.insert(tile.to_string(), next);
        if next <= self.config.max_retries {
            self.in_flight.remove(tile);
            if !self.pending_tiles.contains(&tile.to_string()) {
                self.pending_tiles.insert(0, tile.to_string());
            }
            self.push_event("warning", json!({"tile": tile, "attempt": next}))?;
            self.emit_pending_tiles()?;
            return Ok(Outcome::Applied);
        }
        self.in_flight.remove(tile);
        self.pending_tiles.retain(|t| t != tile);
        if !self.failed_tiles.contains(&tile.to_string()) {
            self.failed_tiles.push(tile.to_string());
        }
        self.recovery_reason = Some("tile".to_string());
        let effect = self.alloc_effect_id()?;
        let recovery = self.alloc_recovery_id()?;
        self.set_state(State::AwaitingPartialDecision)?;
        self.push_effect(
            "request-decision",
            json!({"effect": effect, "recovery": recovery, "reason": "partial"}),
        )?;
        self.push_event("missing-work", json!({"failed": self.failed_tiles.clone()}))?;
        self.push_event(
            "job-state",
            json!({"state": State::AwaitingPartialDecision.name()}),
        )?;
        Ok(Outcome::Applied)
    }

    fn apply_probe_outcome(
        &mut self,
        tile: &str,
        available: bool,
        width: u64,
        height: u64,
    ) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::TileId::new(tile).is_none() {
            return Err(JobError::invalid_id("tile must look like tile:<suffix>"));
        }
        if self.state != State::Planning || self.probe_tile.as_deref() != Some(tile) {
            return Err(JobError::invalid_state(
                "probe outcome valid only for the outstanding probe while Planning",
            ));
        }
        if !self.probe_tiles.contains(tile) {
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
        self.in_flight.remove(tile);
        let Some(continuation) = self.probe.take() else {
            return Err(JobError::invalid_state("no probe continuation pending"));
        };
        let step = continuation
            .submit(observation)
            .map_err(|e| JobError::new("job.plan-invalid", e.to_string()))?;
        self.drive_probe(step)?;
        Ok(Outcome::Applied)
    }

    fn apply_retry_ready(&mut self, attempt: &str) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::AttemptId::new(attempt).is_none() {
            return Err(JobError::invalid_id("attempt must look like att:<suffix>"));
        }
        match self.state {
            State::AwaitingRecovery => {
                let reason = self
                    .recovery_reason
                    .clone()
                    .ok_or_else(|| JobError::invalid_state("no recovery pending for retry"))?;
                match reason.as_str() {
                    "destination" => {
                        let effect = self.alloc_effect_id()?;
                        self.recovery_reason = None;
                        self.set_state(State::AwaitingDestination)?;
                        self.push_effect(
                            "request-destination",
                            json!({"effect": effect, "format": "png"}),
                        )?;
                        self.push_event(
                            "job-state",
                            json!({"state": State::AwaitingDestination.name()}),
                        )?;
                        Ok(Outcome::Applied)
                    }
                    _ => {
                        self.recovery_reason = None;
                        self.set_state(State::AcquiringTiles)?;
                        self.push_event(
                            "job-state",
                            json!({"state": State::AcquiringTiles.name()}),
                        )?;
                        self.emit_pending_tiles()?;
                        Ok(Outcome::Applied)
                    }
                }
            }
            State::AwaitingPartialDecision => {
                self.recovery_reason = None;
                self.failed_tiles.clear();
                self.set_state(State::AcquiringTiles)?;
                self.push_event("job-state", json!({"state": State::AcquiringTiles.name()}))?;
                self.emit_pending_tiles()?;
                Ok(Outcome::Applied)
            }
            _ => Err(JobError::invalid_state(
                "retry-ready valid only in AwaitingRecovery or AwaitingPartialDecision",
            )),
        }
    }

    fn apply_partial_keep(&mut self, keep: bool) -> Result<Outcome, JobError> {
        if self.state != State::AwaitingPartialDecision {
            return Err(JobError::invalid_state(
                "partial choice valid only in AwaitingPartialDecision",
            ));
        }
        self.recovery_reason = None;
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
        let cancel_effect = self.alloc_effect_id()?;
        let release_effect = self.alloc_effect_id()?;
        self.set_state(State::Cancelling)?;
        self.push_effect("cancel-work", json!({"effect": cancel_effect}))?;
        self.push_event("job-state", json!({"state": State::Cancelling.name()}))?;
        self.set_state(State::CleaningUp)?;
        self.push_effect("release-bytes", json!({"effect": release_effect}))?;
        self.push_event("job-state", json!({"state": State::CleaningUp.name()}))?;
        self.set_state(State::Cancelled)?;
        self.push_event("job-state", json!({"state": State::Cancelled.name()}))?;
        self.push_event("cancelled", json!({}))?;
        self.terminal = Some("cancelled".to_string());
        Ok(Outcome::Applied)
    }

    fn complete_remaining(&mut self, partial: bool) -> Result<(), JobError> {
        self.set_state(State::ProcessingTiles)?;
        for tile in self.planned_tiles.clone() {
            let effect = self.alloc_effect_id()?;
            self.push_effect("decode-pixels", json!({"effect": effect, "tile": tile}))?;
        }
        self.push_event("job-state", json!({"state": State::ProcessingTiles.name()}))?;
        self.set_state(State::Encoding)?;
        let open_effect = self.alloc_effect_id()?;
        self.push_effect("open-encoder", json!({"effect": open_effect}))?;
        self.push_event("job-state", json!({"state": State::Encoding.name()}))?;
        self.set_state(State::Finalizing)?;
        let finalize_effect = self.alloc_effect_id()?;
        self.push_effect("finalize-encoder", json!({"effect": finalize_effect}))?;
        self.push_event("job-state", json!({"state": State::Finalizing.name()}))?;
        self.set_state(State::Publishing)?;
        let publish_effect = self.alloc_effect_id()?;
        self.push_effect(
            "publish-output",
            json!({"effect": publish_effect, "output": "out:0"}),
        )?;
        self.push_event("job-state", json!({"state": State::Publishing.name()}))?;
        self.set_state(State::CleaningUp)?;
        let release_effect = self.alloc_effect_id()?;
        self.push_effect("release-bytes", json!({"effect": release_effect}))?;
        self.push_event("job-state", json!({"state": State::CleaningUp.name()}))?;
        if partial {
            self.set_state(State::PartiallyCompleted)?;
            self.push_event(
                "job-state",
                json!({"state": State::PartiallyCompleted.name()}),
            )?;
            self.push_event("partial-completed", json!({"output": "out:0"}))?;
            self.terminal = Some("partial-completed".to_string());
        } else {
            self.set_state(State::Completed)?;
            self.push_event("job-state", json!({"state": State::Completed.name()}))?;
            self.push_event("completed", json!({"output": "out:0"}))?;
            self.terminal = Some("completed".to_string());
        }
        Ok(())
    }

    fn fail_via_cleanup(&mut self, code: &str, message: String) -> Result<(), JobError> {
        let release_effect = self.alloc_effect_id()?;
        self.set_state(State::CleaningUp)?;
        self.push_effect("release-bytes", json!({"effect": release_effect}))?;
        self.push_event("job-state", json!({"state": State::CleaningUp.name()}))?;
        self.set_state(State::Failed)?;
        self.push_event("job-state", json!({"state": State::Failed.name()}))?;
        self.push_event("failed", json!({"code": code, "message": message}))?;
        self.terminal = Some("failed".to_string());
        Ok(())
    }

    fn emit_pending_tiles(&mut self) -> Result<(), JobError> {
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
            self.in_flight.insert(next.clone());
            self.push_acquire_tile(&next, false)?;
        }
        Ok(())
    }

    /// Stable byte-processing recipe name for the wire. Hosts that decode
    /// pixels (native) apply it before decoding; hosts that never decode
    /// (browser) ignore it.
    fn push_acquire_tile(&mut self, wire: &str, probe: bool) -> Result<(), JobError> {
        let effect = self.alloc_effect_id()?;
        let uri = self.tile_uris.get(wire).cloned().unwrap_or_default();
        let headers = self.tile_headers.get(wire).cloned().unwrap_or_default();
        let processing = self
            .tile_processing
            .get(wire)
            .cloned()
            .unwrap_or_else(|| "none".to_string());
        let destination = self
            .tile_destinations
            .get(wire)
            .copied()
            .unwrap_or_default();
        let extent = self.tile_extents.get(wire).copied().flatten();
        let mut detail = json!({
            "effect": effect,
            "tile": wire,
            "uri": uri,
            "headers": headers,
            "processing": processing,
            "destination": {"x": destination.x, "y": destination.y},
            "expected_size": extent.map(|size| json!({"x": size.x, "y": size.y})).unwrap_or(serde_json::Value::Null),
            "canvas": self.canvas_size.map(|size| json!({"x": size.x, "y": size.y})).unwrap_or(serde_json::Value::Null),
        });
        if probe {
            detail["probe"] = serde_json::Value::Bool(true);
        }
        self.push_effect("acquire-tile", detail)?;
        Ok(())
    }

    fn set_state(&mut self, state: State) -> Result<(), JobError> {
        self.state = state;
        Ok(())
    }

    fn bump_seq(&mut self) -> Result<u64, JobError> {
        let next = self
            .seq
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("seq"))?;
        self.seq = next;
        Ok(next)
    }

    fn push_effect(&mut self, kind: &str, detail: serde_json::Value) -> Result<(), JobError> {
        let seq = self.bump_seq()?;
        let id = self.id.clone();
        self.effects.push(make_effect(kind, seq, &id, detail));
        Ok(())
    }

    fn push_event(&mut self, kind: &str, detail: serde_json::Value) -> Result<(), JobError> {
        let seq = self.bump_seq()?;
        let id = self.id.clone();
        self.events.push(make_event(kind, seq, &id, detail));
        Ok(())
    }

    fn alloc_request_id(&mut self) -> Result<String, JobError> {
        let n = self.next_request;
        let next = n
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("request id"))?;
        self.next_request = next;
        Ok(format!("req:{n}"))
    }

    fn alloc_effect_id(&mut self) -> Result<String, JobError> {
        let n = self.next_effect;
        let next = n
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("effect id"))?;
        self.next_effect = next;
        Ok(format!("fx:{n}"))
    }

    fn alloc_recovery_id(&mut self) -> Result<String, JobError> {
        let n = self.next_recovery;
        let next = n
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("recovery id"))?;
        self.next_recovery = next;
        Ok(format!("rec:{n}"))
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
