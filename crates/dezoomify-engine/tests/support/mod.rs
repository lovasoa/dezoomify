//! Scripted deterministic host for job workflow tests.
//!
//! The host drives [`EngineJob`] through the canonical API and records the
//! issued effects plus the derived events in deterministic order. It
//! performs no I/O, clock reads, or randomness during execution.
//!
//! Scripted inputs mirror the historical engine command shapes
//! ([`JobCommand`]) so workflow tests read as engine scenarios; effect
//! correlation (metadata/tile/probe/timer/finalize ids) is resolved
//! internally against the canonical per-attempt effect ids.

#![allow(dead_code)]

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectId, EffectResult, EngineError, EngineJob, Failure, JobOptions,
    OutputDisposition, PartialDecision, ResponseMetadata, SelectionPolicy, Terminal, Update,
    UserCommand,
};
use dezoomify_protocol::dto::ProbeOutcome;
use std::collections::{HashMap, HashSet};

/// Recognizable Deep Zoom input URL: the registry's deepzoom candidate
/// accepts it and asks for the `.dzi` document.
pub const DZI_INPUT_URL: &str = "https://example.test/image.dzi";

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The core parses it into a deepzoom catalog with ten grid levels ordered
/// ascending by size; the largest (last in the list) carries
/// four tiles with deterministic `image_files` URIs.
pub const DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

/// Scripted host input: one engine command, completion, or metadata body.
/// Shapes mirror the historical engine command vocabulary; correlation ids
/// are resolved against the live canonical effects (metadata request ids
/// are effect ids; tile/probe/timer answers resolve by tile/attempt).
#[derive(Clone, Debug)]
pub enum JobCommand {
    /// Supply one metadata body for an outstanding metadata effect.
    ResourceBytes {
        request: u32,
        bytes: Vec<u8>,
        final_uri: Option<String>,
    },
    /// Fail one outstanding metadata effect with a typed cause.
    FetchFailure {
        request: u32,
        cause: dezoomify_core::core::discovery::FetchCause,
    },
    /// Choose a catalog image by position.
    SelectImage { image: u32 },
    /// Follow one still-deferred catalog entry within the same job.
    FollowDeferred { image: u32 },
    /// Choose a level of the chosen image by position.
    SelectLevel { level: u32 },
    /// One tile acquired and decoded (body-free acknowledgement).
    TileAcquired { tile: u32 },
    /// One tile shown as an ordinary image (no readable bytes).
    TileDisplayed { tile: u32 },
    /// One tile failed with structured facts.
    TileFailed {
        tile: u32,
        failure: dezoomify_engine::retry::TileFailure,
    },
    /// Elapsed retry wait for one outstanding timer.
    RetryTimerElapsed { tile: u32, attempt: u32 },
    /// Probe observation for one outstanding probe effect.
    ProbeOutcome { tile: u32, outcome: ProbeOutcome },
    /// Answer the outstanding partial decision.
    RecoveryChoice {
        generation: u32,
        choice: RecoveryChoice,
    },
    /// The awaited output operation succeeded.
    FinalizationSucceeded,
    /// The awaited output operation failed.
    FinalizationFailed { code: String, message: String },
    /// Stop new work and release kept resources.
    Cancel,
    /// Stop scheduling new acquisitions; in-flight work settles.
    Pause,
    /// Re-drive pending work.
    Resume,
}

/// Answer to an outstanding partial decision.
pub use dezoomify_engine::PartialDecision as RecoveryChoice;

/// Deterministic host wrapping one [`EngineJob`] plus an ordered transcript.
#[derive(Debug)]
pub struct ScriptedHost {
    job: Option<EngineJob>,
    pending_options: Option<JobOptions>,
    /// Effect objects in arrival order (for id extraction in tests).
    pub effects: Vec<serde_json::Value>,
    /// Event objects in arrival order (for id extraction in tests).
    pub events: Vec<serde_json::Value>,
    /// Record seq (arrival order; deterministic and sorted).
    next_seq: u64,
    /// Last recorded lifecycle name.
    emitted_lifecycle: Option<String>,
    /// Live tile effect per tile ordinal (latest attempt wins).
    tile_effects_live: HashMap<u32, EffectId>,
    /// Live probe effect per tile ordinal.
    probe_effects_live: HashMap<u32, EffectId>,
    /// Live timer effects by (tile, attempt).
    timer_effects_live: HashMap<(u32, u32), EffectId>,
    /// Live metadata effect ids.
    metadata_effects_live: HashMap<u32, EffectId>,
    /// Every tile ordinal ever issued (for never-seen rejection).
    seen_tiles: HashSet<u32>,
    /// Live finalize effect id.
    finalize_effect_live: Option<EffectId>,
    /// Live decision generations.
    decision_live: Option<u32>,
    /// Outstanding canonical effect ids (issued minus completed).
    outstanding: HashMap<EffectId, String>,
    /// Last emitted catalog JSON (re-emitted when a deferred follow
    /// replaces the catalog).
    emitted_catalog: Option<serde_json::Value>,
    /// Last emitted progress pair.
    emitted_progress: Option<(u64, Option<u64>)>,
    /// Last emitted decision generation.
    emitted_decision: Option<u32>,
    /// Last emitted pause flag.
    emitted_paused: bool,
    /// Engine notices already emitted (identity keys).
    emitted_notice_keys: Vec<String>,
    /// Whether the terminal event was recorded.
    emitted_terminal: bool,
}

impl ScriptedHost {
    /// Create a host with validated options, recording the initial state.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when the URL or budgets are invalid.
    pub fn new(
        _job_id: &str,
        input_url: &str,
        config: dezoomify_engine::Config,
    ) -> Result<Self, EngineError> {
        Self::from_options(job_options_for(
            vec![DiscoveryInput::new(input_url)],
            &config,
        ))
    }

    pub fn new_with_inputs(
        inputs: Vec<DiscoveryInput>,
        config: dezoomify_engine::Config,
    ) -> Result<Self, EngineError> {
        Self::from_options(job_options_for(inputs, &config))
    }

    fn from_options(options: JobOptions) -> Result<Self, EngineError> {
        EngineJob::validate_options(&options)?;
        let mut host = Self {
            job: None,
            pending_options: None,
            effects: Vec::new(),
            events: Vec::new(),
            next_seq: 0,
            emitted_lifecycle: None,
            tile_effects_live: HashMap::new(),
            probe_effects_live: HashMap::new(),
            timer_effects_live: HashMap::new(),
            metadata_effects_live: HashMap::new(),
            seen_tiles: HashSet::new(),
            finalize_effect_live: None,
            decision_live: None,
            outstanding: HashMap::new(),
            emitted_catalog: None,
            emitted_progress: None,
            emitted_decision: None,
            emitted_paused: false,
            emitted_notice_keys: Vec::new(),
            emitted_terminal: false,
        };
        host.pending_options = Some(options);
        Ok(host)
    }

    /// Start the job and record resulting effects/events.
    ///
    /// # Errors
    ///
    /// Propagates [`EngineError`] from [`EngineJob::start`].
    pub fn start(&mut self) -> Result<(), EngineError> {
        let options = self.pending_options.take().expect("start once");
        let (job, update) = EngineJob::start(options)?;
        self.job = Some(job);
        self.record(update);
        Ok(())
    }

    /// Apply one scripted response and record resulting effects/events/state.
    ///
    /// # Errors
    ///
    /// Propagates [`EngineError`] rejections; rejected inputs leave the
    /// transcript unchanged.
    pub fn apply(&mut self, response: JobCommand) -> Result<(), EngineError> {
        let revision_before = self.snapshot_revision();
        let effects_before = self.effects.len();
        let events_before = self.events.len();
        let result = self.apply_inner(response);
        if result.is_err() {
            // Rejections must not add work: no new effects or events, and
            // the snapshot revision is unchanged.
            debug_assert_eq!(self.effects.len(), effects_before);
            debug_assert_eq!(self.events.len(), events_before);
            debug_assert_eq!(self.snapshot_revision(), revision_before);
        }
        result
    }

    fn apply_inner(&mut self, response: JobCommand) -> Result<(), EngineError> {
        if self
            .job
            .as_ref()
            .is_some_and(|job| job.snapshot().terminal.is_some())
        {
            return Err(EngineError::new(
                "job.post-terminal",
                "job already reached a terminal outcome",
            ));
        }
        match self.apply_strict(response) {
            Err(error) if error.code == "job.stale-effect" => Ok(()),
            result => result,
        }
    }

    fn apply_strict(&mut self, response: JobCommand) -> Result<(), EngineError> {
        match response {
            JobCommand::ResourceBytes {
                request,
                bytes,
                final_uri,
            } => {
                let Some(effect) = self.take_metadata(request) else {
                    return Ok(());
                };
                let update = self.job_mut()?.provide_metadata(
                    effect,
                    ResponseMetadata {
                        final_uri: final_uri.filter(|uri| !uri.is_empty()),
                    },
                    &bytes,
                )?;
                self.record(update);
                Ok(())
            }
            JobCommand::FetchFailure { request, cause } => {
                let Some(effect) = self.take_metadata(request) else {
                    return Ok(());
                };
                let update = self.job_mut()?.complete(
                    effect,
                    EffectResult::MetadataFailed(Failure {
                        code: cause.code.to_string(),
                        http: cause.http,
                        retry_after_ms: None,
                        transport: Some(cause.transport),
                        detail: None,
                    }),
                )?;
                self.record(update);
                Ok(())
            }
            JobCommand::SelectImage { image } => {
                let update = self
                    .job_mut()?
                    .command(UserCommand::SelectImage { image })?;
                self.record(update);
                Ok(())
            }
            JobCommand::FollowDeferred { image } => {
                let update = self
                    .job_mut()?
                    .command(UserCommand::FollowDeferred { image })?;
                self.record(update);
                Ok(())
            }
            JobCommand::SelectLevel { level } => {
                let update = self
                    .job_mut()?
                    .command(UserCommand::SelectLevel { level })?;
                self.record(update);
                Ok(())
            }
            JobCommand::TileAcquired { tile } => {
                let Some(effect) = self.take_tile(tile)? else {
                    return Ok(());
                };
                let update = self
                    .job_mut()?
                    .complete(effect, EffectResult::TileAcquired)?;
                self.record(update);
                Ok(())
            }
            JobCommand::TileDisplayed { tile } => {
                let Some(effect) = self.take_tile(tile)? else {
                    return Ok(());
                };
                let update = self
                    .job_mut()?
                    .complete(effect, EffectResult::TileDisplayed)?;
                self.record(update);
                Ok(())
            }
            JobCommand::TileFailed { tile, failure } => {
                let Some(effect) = self.take_tile(tile)? else {
                    return Ok(());
                };
                let update = self.job_mut()?.complete(
                    effect,
                    EffectResult::TileFailed(Failure {
                        code: failure.code.clone(),
                        http: failure.http,
                        retry_after_ms: failure.retry_after_ms,
                        transport: None,
                        detail: failure.detail.clone(),
                    }),
                )?;
                self.record(update);
                Ok(())
            }
            JobCommand::RetryTimerElapsed { tile, attempt } => {
                let Some(effect) = self.timer_effects_live.remove(&(tile, attempt)) else {
                    // Stale timer completions settle nothing.
                    return Ok(());
                };
                self.outstanding.remove(&effect);
                let update = self
                    .job_mut()?
                    .complete(effect, EffectResult::TimerElapsed)?;
                self.record(update);
                Ok(())
            }
            JobCommand::ProbeOutcome { tile, outcome } => {
                let Some(effect) = self.take_probe(tile)? else {
                    return Ok(());
                };
                let result = match outcome {
                    ProbeOutcome::Available { width, height } => EffectResult::ProbeAvailable {
                        width: u32::try_from(width.get()).unwrap_or(u32::MAX),
                        height: u32::try_from(height.get()).unwrap_or(u32::MAX),
                    },
                    ProbeOutcome::Missing => EffectResult::ProbeMissing,
                };
                let update = self.job_mut()?.complete(effect, result)?;
                self.record(update);
                Ok(())
            }
            JobCommand::RecoveryChoice { generation, choice } => {
                if self.decision_live != Some(generation) {
                    return Err(EngineError::new(
                        "job.invalid-state",
                        "recovery choice does not match the outstanding recovery",
                    ));
                }
                let decision = match choice {
                    RecoveryChoice::Retry => PartialDecision::Retry,
                    RecoveryChoice::Keep => PartialDecision::Keep,
                    RecoveryChoice::Discard => PartialDecision::Discard,
                };
                let update = self
                    .job_mut()?
                    .command(UserCommand::AnswerPartial { decision })?;
                self.record(update);
                Ok(())
            }
            JobCommand::FinalizationSucceeded => {
                let Some(effect) = self.finalize_effect_live.take() else {
                    return Err(EngineError::new(
                        "job.invalid-state",
                        "no output operation is awaited",
                    ));
                };
                self.outstanding.remove(&effect);
                let update = self.job_mut()?.complete(
                    effect,
                    EffectResult::OutputCommitted {
                        disposition: OutputDisposition::NativePublication,
                    },
                )?;
                self.record(update);
                Ok(())
            }
            JobCommand::FinalizationFailed { code, message } => {
                let Some(effect) = self.finalize_effect_live.take() else {
                    return Err(EngineError::new(
                        "job.invalid-state",
                        "no output operation is awaited",
                    ));
                };
                self.outstanding.remove(&effect);
                let update = self
                    .job_mut()?
                    .complete(effect, EffectResult::OutputFailed { code, message })?;
                self.record(update);
                Ok(())
            }
            JobCommand::Cancel => {
                let update = self.job_mut()?.command(UserCommand::Cancel)?;
                self.record(update);
                Ok(())
            }
            JobCommand::Pause => {
                let update = self.job_mut()?.command(UserCommand::Pause)?;
                self.record(update);
                Ok(())
            }
            JobCommand::Resume => {
                let update = self.job_mut()?.command(UserCommand::Resume)?;
                self.record(update);
                Ok(())
            }
        }
    }

    /// Recorded activity count (effects plus events): the change detector
    /// for tolerated no-ops.
    #[must_use]
    pub fn activity_len(&self) -> usize {
        self.effects.len() + self.events.len()
    }

    /// Current job lifecycle name.
    #[must_use]
    pub fn state(&self) -> String {
        self.job
            .as_ref()
            .map(|job| format!("{:?}", job.snapshot().lifecycle))
            .unwrap_or_else(|| "Created".to_string())
    }

    /// Current snapshot revision.
    #[must_use]
    pub fn revision(&self) -> u32 {
        self.snapshot_revision()
    }

    /// Whether the job is paused.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.job.as_ref().is_some_and(|job| job.snapshot().paused)
    }

    /// Terminal kind (`completed`, `partial-completed`, `failed`,
    /// `cancelled`), once finished.
    #[must_use]
    pub fn terminal_kind(&self) -> Option<String> {
        self.job
            .as_ref()
            .and_then(|job| match job.snapshot().terminal {
                Some(Terminal::Completed) => Some("completed".to_string()),
                Some(Terminal::PartiallyCompleted { .. }) => Some("partial-completed".to_string()),
                Some(Terminal::Failed { .. }) => Some("failed".to_string()),
                Some(Terminal::Cancelled) => Some("cancelled".to_string()),
                None => None,
            })
    }

    /// Acquisition progress `(completed, total)`.
    #[must_use]
    pub fn acquisition_progress(&self) -> (u64, u64) {
        self.job
            .as_ref()
            .map(|job| {
                let progress = &job.snapshot().progress;
                (progress.completed, progress.total.unwrap_or(0))
            })
            .unwrap_or((0, 0))
    }

    /// Structured missing-tile detail behind the outstanding decision or
    /// partial terminal: tile ids with their failure facts.
    #[must_use]
    pub fn decision_detail(&self) -> Vec<(u32, Vec<dezoomify_engine::retry::TileFailure>)> {
        let Some(job) = self.job.as_ref() else {
            return Vec::new();
        };
        let snapshot = job.snapshot();
        if let Some(decision) = &snapshot.decision {
            return decision.missing.clone();
        }
        Vec::new()
    }

    /// Missing tiles behind the outstanding decision or partial terminal.
    #[must_use]
    pub fn missing_tiles(&self) -> Vec<u32> {
        let Some(job) = self.job.as_ref() else {
            return Vec::new();
        };
        let snapshot = job.snapshot();
        if let Some(decision) = &snapshot.decision {
            return decision.missing.iter().map(|(tile, _)| *tile).collect();
        }
        if let Some(Terminal::PartiallyCompleted { missing }) = &snapshot.terminal {
            return missing.clone();
        }
        Vec::new()
    }

    /// Borrow the inner job for snapshot assertions.
    #[must_use]
    pub fn job(&self) -> &EngineJob {
        self.job.as_ref().expect("job started")
    }

    /// Deferred follow-up URI for a wire image id, if still deferred.
    #[must_use]
    pub fn deferred_uri_for_test(&self, image: u32) -> Option<String> {
        self.job.as_ref().and_then(|job| {
            job.snapshot()
                .selection
                .deferred
                .iter()
                .find(|entry| entry.position == image)
                .map(|entry| entry.uri.clone())
        })
    }

    /// Outstanding canonical effect ids (issued minus completed).
    #[must_use]
    pub fn outstanding_count(&self) -> usize {
        self.outstanding.len()
    }

    /// Whether a `job-state` event for one lifecycle phase was recorded.
    #[must_use]
    pub fn has_state_event(&self, phase: &str) -> bool {
        self.events.iter().any(|event| {
            event.get("kind").and_then(serde_json::Value::as_str) == Some("job-state")
                && event.get("state").and_then(serde_json::Value::as_str) == Some(phase)
        })
    }

    /// Whether an event of one kind was recorded.
    #[must_use]
    pub fn has_event(&self, kind: &str) -> bool {
        self.events
            .iter()
            .any(|event| event.get("kind").and_then(serde_json::Value::as_str) == Some(kind))
    }

    /// Failed events in arrival order.
    #[must_use]
    pub fn failed_events(&self) -> Vec<&serde_json::Value> {
        self.events
            .iter()
            .filter(|event| event.get("kind").and_then(serde_json::Value::as_str) == Some("failed"))
            .collect()
    }

    /// Count terminal events (must be 0 or 1).
    #[must_use]
    pub fn terminal_count(&self) -> usize {
        self.events
            .iter()
            .filter(|event| {
                matches!(
                    event.get("kind").and_then(serde_json::Value::as_str),
                    Some("completed" | "partial-completed" | "failed" | "cancelled")
                )
            })
            .count()
    }

    /// Positions of the first catalog image and its levels.
    pub fn catalog(&self) -> Option<(u32, Vec<u32>)> {
        let event = self
            .events
            .iter()
            .rev()
            .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("catalog"))?;
        let image = event.get("entries")?.get(0)?;
        let levels: Vec<u32> = image
            .get("levels")?
            .as_array()?
            .iter()
            .enumerate()
            .filter_map(|(position, _)| u32::try_from(position).ok())
            .collect();
        Some((0, levels))
    }

    /// Every `acquire-tile` effect as `(tile id, uri, probe flag)` in seq order.
    pub fn tile_effects(&self) -> Vec<(u32, String, bool)> {
        self.effects
            .iter()
            .filter(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-tile"))
            .map(|v| {
                (
                    v.get("tile")
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .unwrap_or(0),
                    v.get("uri")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    v.get("probe")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                )
            })
            .collect()
    }

    fn job_mut(&mut self) -> Result<&mut EngineJob, EngineError> {
        self.job
            .as_mut()
            .ok_or_else(|| EngineError::new("job.invalid-state", "job has not started"))
    }

    fn snapshot_revision(&self) -> u32 {
        self.job
            .as_ref()
            .map(|job| job.snapshot().revision)
            .unwrap_or(0)
    }

    /// Take a live metadata effect. Unknown or already-answered requests
    /// are tolerated no-ops (discovery is a poll): the caller skips the
    /// engine answer entirely.
    fn take_metadata(&mut self, request: u32) -> Option<EffectId> {
        let effect = self.metadata_effects_live.remove(&request)?;
        self.outstanding.remove(&effect);
        Some(effect)
    }

    /// Take a live tile effect. Tiles never issued are rejections;
    /// already-answered tiles are tolerated no-ops.
    fn take_tile(&mut self, tile: u32) -> Result<Option<EffectId>, EngineError> {
        if self.probe_effects_live.remove(&tile).is_some() {
            return Err(EngineError::new(
                "job.invalid-state",
                "probe effects are answered with probe outcomes, not tile outcomes",
            ));
        }
        match self.tile_effects_live.remove(&tile) {
            Some(effect) => {
                self.outstanding.remove(&effect);
                Ok(Some(effect))
            }
            None if self.seen_tiles.contains(&tile) => Ok(None),
            None => Err(EngineError::new(
                "job.invalid-state",
                "tile was never issued",
            )),
        }
    }

    fn take_probe(&mut self, tile: u32) -> Result<Option<EffectId>, EngineError> {
        match self.probe_effects_live.remove(&tile) {
            Some(effect) => {
                self.outstanding.remove(&effect);
                Ok(Some(effect))
            }
            None if self.seen_tiles.contains(&tile) => Ok(None),
            None => Err(EngineError::new(
                "job.invalid-state",
                "probe was never issued",
            )),
        }
    }

    fn record(&mut self, update: Update) {
        // Newly issued effects first, in canonical order.
        for effect in &update.effects {
            let id = effect.id();
            let value = effect_json(self.claim_seq(), effect);
            let kind = value
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            self.outstanding.insert(id, kind);
            match effect {
                Effect::AcquireMetadata { .. } => {
                    self.metadata_effects_live.insert(id.get(), id);
                }
                Effect::AcquireTile { tile, probe, .. } => {
                    self.seen_tiles.insert(*tile);
                    if *probe {
                        self.probe_effects_live.insert(*tile, id);
                    } else {
                        self.tile_effects_live.insert(*tile, id);
                    }
                }
                Effect::WaitRetryTimer { tile, attempt, .. } => {
                    self.timer_effects_live.insert((*tile, *attempt), id);
                }
                Effect::FinalizeOutput { .. } => {
                    self.finalize_effect_live = Some(id);
                }
                Effect::RequestPartialDecision { generation, .. } => {
                    self.decision_live = Some(*generation);
                }
                Effect::CancelRelease { .. } => {}
            }
            self.effects.push(value);
        }
        let snapshot = &update.snapshot;
        // Lifecycle moves.
        let state = format!("{:?}", snapshot.lifecycle);
        if Some(state.clone()) != self.emitted_lifecycle {
            self.emitted_lifecycle = Some(state.clone());
            let value =
                serde_json::json!({"kind":"job-state","seq":self.claim_seq(),"state":state});
            self.events.push(value);
        }
        // The kept catalog (re-emitted when a deferred follow replaces it).
        if let Some(catalog) = &snapshot.selection.catalog {
            let entries = serde_json::to_value(&catalog.entries).unwrap_or_default();
            if self.emitted_catalog.as_ref() != Some(&entries) {
                self.emitted_catalog = Some(entries.clone());
                let value =
                    serde_json::json!({"kind":"catalog","seq":self.claim_seq(),"entries":entries});
                self.events.push(value);
            }
        }
        // Progress advances.
        let progress = (snapshot.progress.completed, snapshot.progress.total);
        if self.emitted_progress != Some(progress) {
            self.emitted_progress = Some(progress);
            let value = serde_json::json!({
                "kind":"progress","seq":self.claim_seq(),
                "acquired":progress.0,"total":progress.1.unwrap_or(0),
            });
            self.events.push(value);
        }
        // Pause overlay transitions.
        if self.emitted_paused != snapshot.paused {
            self.emitted_paused = snapshot.paused;
            let kind = if snapshot.paused { "paused" } else { "resumed" };
            let value = serde_json::json!({"kind":kind,"seq":self.claim_seq()});
            self.events.push(value);
        }
        // Outstanding partial decision: one cue per generation.
        if let Some(decision) = &snapshot.decision {
            if self.emitted_decision != Some(decision.generation) {
                self.emitted_decision = Some(decision.generation);
                let value = serde_json::json!({
                    "kind":"recovery-requested","seq":self.claim_seq(),
                    "generation":decision.generation,
                });
                self.events.push(value);
            }
        }
        // Bounded recent engine notices (deduplicated by identity: the
        // recent log truncates, so a positional skip would miss entries).
        for notice in &snapshot.notices {
            let key = format!(
                "{}:{}:{:?}:{:?}",
                notice.revision, notice.tile, notice.attempt, notice.missing
            );
            if self.emitted_notice_keys.contains(&key) {
                continue;
            }
            self.emitted_notice_keys.push(key);
            let value = if notice.missing.is_empty() {
                serde_json::json!({
                    "kind":"warning","seq":self.claim_seq(),
                    "tile":notice.tile,"attempt":notice.attempt.unwrap_or(0),
                })
            } else {
                serde_json::json!({
                    "kind":"missing-work","seq":self.claim_seq(),"failed":notice.missing,
                })
            };
            self.events.push(value);
        }
        // Terminal outcome last: exactly one terminal render.
        if !self.emitted_terminal {
            if let Some(terminal) = &snapshot.terminal {
                self.emitted_terminal = true;
                let value = match terminal {
                    Terminal::Completed => {
                        serde_json::json!({"kind":"completed","seq":self.claim_seq()})
                    }
                    Terminal::PartiallyCompleted { .. } => {
                        serde_json::json!({"kind":"partial-completed","seq":self.claim_seq()})
                    }
                    Terminal::Failed { code, message } => serde_json::json!({
                        "kind":"failed","seq":self.claim_seq(),"code":code,"message":message,
                    }),
                    Terminal::Cancelled => {
                        serde_json::json!({"kind":"cancelled","seq":self.claim_seq()})
                    }
                };
                self.events.push(value);
            }
        }
    }

    fn claim_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }
}

/// Canonical options for scripted inputs: manual selection, prompted
/// partials, PNG output, and the validated budgets from an engine config.
fn job_options_for(inputs: Vec<DiscoveryInput>, config: &dezoomify_engine::Config) -> JobOptions {
    JobOptions {
        inputs,
        format: None,
        selection: SelectionPolicy::Manual,
        partial: dezoomify_engine::PartialPolicy::Prompt,
        output: dezoomify_engine::OutputFormat::Png,
        max_concurrent: config.max_concurrent_fetches,
        max_tiles: config.max_tiles,
        max_retries: config.max_retries,
        max_bytes: config.max_bytes,
        max_deferred_follows: config.max_deferred_follows,
    }
}

fn effect_json(seq: u64, effect: &Effect) -> serde_json::Value {
    match effect {
        Effect::AcquireMetadata { id, uri } => serde_json::json!({
            "kind": "acquire-resource", "seq": seq, "request": id.get(),
            "uri": uri, "header_names": [], "purpose": "metadata",
        }),
        Effect::AcquireTile {
            id: _,
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
            let processing = match processing {
                dezoomify_core::core::model::ProcessingRecipe::None => "none",
                dezoomify_core::core::model::ProcessingRecipe::GoogleArtsDecrypt => {
                    "google-arts-decrypt"
                }
            };
            let headers: std::collections::BTreeMap<String, String> = headers
                .iter()
                .map(|header| (header.name.clone(), header.value.clone()))
                .collect();
            let mut value = serde_json::json!({
                "kind": "acquire-tile", "seq": seq, "tile": tile, "uri": uri,
                "headers": headers, "processing": processing,
                "destination": {"x": destination.x, "y": destination.y},
                "expected_size": expected_size.map(|v| serde_json::json!({"x": v.width, "y": v.height})),
                "canvas": canvas.map(|v| serde_json::json!({"x": v.width, "y": v.height})),
            });
            if *probe {
                value["probe"] = serde_json::Value::Bool(true);
            }
            if *probe_output {
                value["probe_output"] = serde_json::Value::Bool(true);
            }
            value
        }
        Effect::WaitRetryTimer {
            tile,
            attempt,
            delay_ms,
            ..
        } => serde_json::json!({
            "kind":"wait-retry","seq":seq,"tile":tile,"attempt":attempt,"delay_ms":delay_ms,
        }),
        Effect::FinalizeOutput {
            id: _,
            partial,
            canvas,
        } => {
            serde_json::json!({"kind":"finalize-output","seq":seq,"partial":partial,"format":"png","canvas":canvas.map(|v| serde_json::json!({"x":v.width,"y":v.height}))})
        }
        Effect::CancelRelease { .. } => serde_json::json!({"kind":"cancel-work","seq":seq}),
        Effect::RequestPartialDecision { generation, .. } => serde_json::json!({
            "kind":"request-decision","seq":seq,"generation":generation,
        }),
    }
}
