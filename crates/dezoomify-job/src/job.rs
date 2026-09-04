//! Deterministic portable job state machine.
//!
//! The job decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. Hosts feed
//! explicit [`JobResponse`] inputs and drain [`Job::drain_effects`] and
//! [`Job::drain_effects`]/events. All counters use checked arithmetic.

use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::config::Config;
use crate::state::State;
use crate::transition::{make_effect, make_event, JobError, JobResponse, Outcome};

/// Number of tiles in the lean fixed grid (`tile:0`, `tile:1`).
const LEAN_TILE_COUNT: usize = 2;
/// Lean tile ids in deterministic plan order.
const LEAN_TILES: [&str; LEAN_TILE_COUNT] = ["tile:0", "tile:1"];

/// One end-to-end user request driven synchronously by explicit host inputs.
#[derive(Debug)]
pub struct Job {
    id: String,
    input_url: String,
    config: Config,
    state: State,
    seq: u64,
    effects: Vec<serde_json::Value>,
    events: Vec<serde_json::Value>,
    pending_request: Option<String>,
    consumed_requests: HashSet<String>,
    selected_image: Option<String>,
    selected_level: Option<String>,
    destination: Option<String>,
    planned_tiles: Vec<String>,
    pending_tiles: Vec<String>,
    in_flight: HashSet<String>,
    acquired_tiles: HashSet<String>,
    tile_attempts: HashMap<String, u32>,
    discovery_attempts: u32,
    recovery_reason: Option<String>,
    failed_tiles: Vec<String>,
    terminal: Option<String>,
    next_request: u32,
    next_effect: u32,
    next_recovery: u32,
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
            pending_request: None,
            consumed_requests: HashSet::new(),
            selected_image: None,
            selected_level: None,
            destination: None,
            planned_tiles: Vec::new(),
            pending_tiles: Vec::new(),
            in_flight: HashSet::new(),
            acquired_tiles: HashSet::new(),
            tile_attempts: HashMap::new(),
            discovery_attempts: 0,
            recovery_reason: None,
            failed_tiles: Vec::new(),
            terminal: None,
            next_request: 0,
            next_effect: 0,
            next_recovery: 0,
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
        // Genuine core use: default browser-like headers seed the fetch effect
        // provenance without performing I/O.
        let headers = dezoomify_core::default_headers();
        let mut names: Vec<String> = headers.keys().cloned().collect();
        names.sort();
        let request = self.alloc_request_id()?;
        let effect = self.alloc_effect_id()?;
        self.pending_request = Some(request.clone());
        self.set_state(State::Discovering)?;
        self.push_effect(
            "acquire-resource",
            json!({
                "effect": effect,
                "request": request,
                "uri": self.input_url.clone(),
                "purpose": "metadata",
                "header_names": names,
            }),
        )?;
        self.push_event("job-state", json!({"state": State::Discovering.name()}))?;
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
                request, bytes_len, ..
            } => self.apply_resource_bytes(&request, bytes_len),
            JobResponse::FetchFailure { request, .. } => self.apply_fetch_failure(&request),
            JobResponse::SelectedImage { image, .. } => self.apply_selected_image(&image),
            JobResponse::SelectedLevel { level, .. } => self.apply_selected_level(&level),
            JobResponse::DestinationGranted { destination, .. } => {
                self.apply_destination_granted(&destination)
            }
            JobResponse::DestinationDenied { .. } => self.apply_destination_denied(),
            JobResponse::TileOutcome { tile, ok, .. } => self.apply_tile_outcome(&tile, ok),
            JobResponse::RetryReady { attempt, .. } => self.apply_retry_ready(&attempt),
            JobResponse::PartialKeep { keep, .. } => self.apply_partial_keep(keep),
        }
    }

    fn apply_resource_bytes(&mut self, request: &str, bytes_len: u64) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::RequestId::new(request).is_none() {
            return Err(JobError::invalid_id("request must look like req:<suffix>"));
        }
        if self.consumed_requests.contains(request) {
            return Ok(Outcome::Ignored);
        }
        if self.state != State::Discovering || self.pending_request.as_deref() != Some(request) {
            return Err(JobError::invalid_state(
                "resource bytes valid only for the outstanding discovery request",
            ));
        }
        if bytes_len > self.config.max_bytes {
            self.consumed_requests.insert(request.to_string());
            self.pending_request = None;
            self.fail_via_cleanup(
                "job.resource-limit",
                format!("resource bytes {bytes_len} exceed max_bytes"),
            )?;
            return Ok(Outcome::Applied);
        }
        self.consumed_requests.insert(request.to_string());
        self.pending_request = None;
        self.set_state(State::AwaitingImageSelection)?;
        self.push_event(
            "catalog",
            json!({"images": [{"id": "img:0", "levels": ["lvl:0"]}]}),
        )?;
        self.push_event(
            "job-state",
            json!({"state": State::AwaitingImageSelection.name()}),
        )?;
        Ok(Outcome::Applied)
    }

    fn apply_fetch_failure(&mut self, request: &str) -> Result<Outcome, JobError> {
        if dezoomify_protocol::dto::RequestId::new(request).is_none() {
            return Err(JobError::invalid_id("request must look like req:<suffix>"));
        }
        if self.consumed_requests.contains(request) {
            return Ok(Outcome::Ignored);
        }
        if self.state != State::Discovering || self.pending_request.as_deref() != Some(request) {
            return Err(JobError::invalid_state(
                "fetch failure valid only for the outstanding discovery request",
            ));
        }
        let attempts = self
            .discovery_attempts
            .checked_add(1)
            .ok_or_else(|| JobError::overflow("discovery attempts"))?;
        self.discovery_attempts = attempts;
        self.consumed_requests.insert(request.to_string());
        self.pending_request = None;
        if attempts <= self.config.max_retries {
            self.recovery_reason = Some("discovery".to_string());
            let effect = self.alloc_effect_id()?;
            let recovery = self.alloc_recovery_id()?;
            self.set_state(State::AwaitingRecovery)?;
            self.push_effect(
                "request-decision",
                json!({"effect": effect, "recovery": recovery, "reason": "discovery"}),
            )?;
            self.push_event(
                "recovery-requested",
                json!({"reason": "discovery", "attempt": attempts}),
            )?;
            self.push_event(
                "job-state",
                json!({"state": State::AwaitingRecovery.name()}),
            )?;
            return Ok(Outcome::Applied);
        }
        self.fail_via_cleanup(
            "job.fetch-failed",
            "discovery retries exhausted".to_string(),
        )?;
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
        if image != "img:0" {
            return Err(JobError::invalid_state("unknown image id"));
        }
        self.selected_image = Some(image.to_string());
        self.set_state(State::AwaitingLevelSelection)?;
        self.push_event("levels", json!({"image": image, "levels": ["lvl:0"]}))?;
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
        if level != "lvl:0" {
            return Err(JobError::invalid_state("unknown level id"));
        }
        self.selected_level = Some(level.to_string());
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
        if (LEAN_TILE_COUNT as u32) > self.config.max_tiles {
            self.fail_via_cleanup(
                "job.resource-limit",
                format!(
                    "tile plan {} exceeds max_tiles {}",
                    LEAN_TILE_COUNT, self.config.max_tiles
                ),
            )?;
            return Ok(Outcome::Applied);
        }
        self.planned_tiles = LEAN_TILES.iter().map(ToString::to_string).collect();
        self.pending_tiles = self.planned_tiles.clone();
        self.in_flight.clear();
        self.acquired_tiles.clear();
        self.set_state(State::AcquiringTiles)?;
        self.push_event("progress", json!({"acquired": 0, "total": 2}))?;
        self.push_event("job-state", json!({"state": State::AcquiringTiles.name()}))?;
        self.emit_pending_tiles()?;
        Ok(Outcome::Applied)
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
            self.push_event("progress", json!({"acquired": acquired, "total": 2}))?;
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
                    "discovery" => {
                        let request = self.alloc_request_id()?;
                        let effect = self.alloc_effect_id()?;
                        self.pending_request = Some(request.clone());
                        self.recovery_reason = None;
                        self.set_state(State::Discovering)?;
                        self.push_effect(
                            "acquire-resource",
                            json!({
                                "effect": effect,
                                "request": request,
                                "uri": self.input_url.clone(),
                                "purpose": "metadata",
                            }),
                        )?;
                        self.push_event("job-state", json!({"state": State::Discovering.name()}))?;
                        Ok(Outcome::Applied)
                    }
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
            let effect = self.alloc_effect_id()?;
            self.push_effect(
                "acquire-tile",
                json!({
                    "effect": effect,
                    "tile": next,
                    "uri": format!("{}/tiles/{next}", self.input_url),
                }),
            )?;
        }
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
