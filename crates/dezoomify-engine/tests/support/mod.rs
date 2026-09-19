//! Scripted deterministic host for job workflow tests.
//!
//! The host drives [`EngineJob`] through the canonical API and records the
//! issued effects in arrival order for correlation. It performs no I/O,
//! clock reads, or randomness during execution, and it never refolds an
//! event stream: every query reads the live engine snapshot or the recorded
//! canonical effects directly.
//!
//! Scripted inputs are host answers ([`JobCommand`]); effect correlation
//! (metadata/tile/probe/timer/finalize ids) is resolved internally against
//! the canonical per-attempt effect ids.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectId, EffectResult, EngineError, EngineJob, Failure, JobOptions,
    OutputDisposition, RecoveryChoice, ResponseMetadata, SelectionPolicy, Update, UserCommand,
};
use dezoomify_protocol::dto::CatalogEntryDto;
use dezoomify_protocol::dto::SnapshotTerminalDto;
use std::collections::{HashMap, HashSet};

/// Recognizable Deep Zoom input URL: the registry's deepzoom candidate
/// accepts it and asks for the `.dzi` document.
// Shared helper, used by adversarial.
#[allow(dead_code)]
pub const DZI_INPUT_URL: &str = "https://example.test/image.dzi";

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The core parses it into a deepzoom catalog with ten grid levels ordered
/// ascending by size; the largest (last in the list) carries
/// four tiles with deterministic `image_files` URIs.
// Shared helper, used by adversarial and host_effects.
#[allow(dead_code)]
pub const DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

/// Scripted host input: one host answer to an outstanding engine effect,
/// or one user command. Correlation ids are resolved against the live
/// canonical effects (metadata request ids are effect ids; tile/probe/timer
/// answers resolve by tile/attempt).
#[derive(Clone, Debug)]
pub enum JobCommand {
    /// Supply one metadata body for an outstanding metadata effect.
    ResourceBytes {
        request: u32,
        bytes: Vec<u8>,
        final_uri: Option<String>,
    },
    /// Choose a catalog image by position.
    SelectImage { image: u32 },
    // Shared helper, used by engine_regressions.
    #[allow(dead_code)]
    /// Follow one still-deferred catalog entry within the same job.
    FollowDeferred { image: u32 },
    /// Choose a level of the chosen image by position.
    SelectLevel { level: u32 },
    // Shared helper, used by engine_regressions and workflows.
    #[allow(dead_code)]
    /// One tile acquired and decoded (body-free acknowledgement).
    TileAcquired { tile: u32 },
    // Shared helper, used by engine_regressions and workflows.
    #[allow(dead_code)]
    /// One tile failed with structured facts.
    TileFailed {
        tile: u32,
        failure: dezoomify_engine::retry::TileFailure,
    },
    // Shared helper, used by engine_regressions.
    #[allow(dead_code)]
    /// Elapsed retry wait for one outstanding timer.
    RetryTimerElapsed { tile: u32, attempt: u32 },
    // Shared helper, used by workflows.
    #[allow(dead_code)]
    /// Answer the outstanding partial decision.
    RecoveryChoice {
        generation: u32,
        choice: RecoveryChoice,
    },
    // Shared helper, used by engine_regressions and workflows.
    #[allow(dead_code)]
    /// The awaited output operation succeeded.
    FinalizationSucceeded,
    // Shared helper, used by adversarial and workflows.
    #[allow(dead_code)]
    /// Stop new work and release kept resources.
    Cancel,
    // Shared helper, used by workflows.
    #[allow(dead_code)]
    /// Stop scheduling new acquisitions; in-flight work settles.
    Pause,
    // Shared helper, used by workflows.
    #[allow(dead_code)]
    /// Re-drive pending work.
    Resume,
}

/// Deterministic host wrapping one [`EngineJob`] plus its issued effects.
#[derive(Debug)]
pub struct ScriptedHost {
    job: Option<EngineJob>,
    pending_options: Option<JobOptions>,
    /// Canonical effect objects in arrival order (for id extraction in tests).
    pub effects: Vec<Effect>,
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
    outstanding: HashSet<EffectId>,
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

    // Shared helper, used by workflows.
    #[allow(dead_code)]
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
            tile_effects_live: HashMap::new(),
            probe_effects_live: HashMap::new(),
            timer_effects_live: HashMap::new(),
            metadata_effects_live: HashMap::new(),
            seen_tiles: HashSet::new(),
            finalize_effect_live: None,
            decision_live: None,
            outstanding: HashSet::new(),
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
        let result = self.apply_inner(response);
        if result.is_err() {
            // Rejections must add no work: no new effects and the snapshot
            // revision is unchanged.
            debug_assert_eq!(self.effects.len(), effects_before);
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
            JobCommand::RecoveryChoice { generation, choice } => {
                if self.decision_live != Some(generation) {
                    return Err(EngineError::new(
                        "job.invalid-state",
                        "recovery choice does not match the outstanding recovery",
                    ));
                }
                let update = self.job_mut()?.command(UserCommand::AnswerPartial {
                    generation,
                    decision: choice,
                })?;
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

    /// Current job lifecycle name.
    #[must_use]
    // Shared helper, used by adversarial, engine_regressions and workflows.
    #[allow(dead_code)]
    pub fn state(&self) -> String {
        self.job
            .as_ref()
            .map(|job| format!("{:?}", job.snapshot().lifecycle))
            .unwrap_or_else(|| "Created".to_string())
    }

    /// Whether the job is paused.
    #[must_use]
    // Shared helper, used by workflows.
    #[allow(dead_code)]
    pub fn is_paused(&self) -> bool {
        self.job.as_ref().is_some_and(|job| job.snapshot().paused)
    }

    /// Terminal kind (`completed`, `partial-completed`, `failed`,
    /// `cancelled`), once finished.
    #[must_use]
    // Shared helper, used by workflows.
    #[allow(dead_code)]
    pub fn terminal_kind(&self) -> Option<String> {
        self.job
            .as_ref()
            .and_then(|job| match job.snapshot().terminal {
                Some(SnapshotTerminalDto::Completed) => Some("completed".to_string()),
                Some(SnapshotTerminalDto::PartialCompleted { .. }) => {
                    Some("partial-completed".to_string())
                }
                Some(SnapshotTerminalDto::Failed { .. }) => Some("failed".to_string()),
                Some(SnapshotTerminalDto::Cancelled) => Some("cancelled".to_string()),
                None => None,
            })
    }

    /// Borrow the inner job for snapshot assertions.
    #[must_use]
    // Shared helper, used by adversarial.
    #[allow(dead_code)]
    pub fn job(&self) -> &EngineJob {
        self.job.as_ref().expect("job started")
    }

    /// Positions of the first catalog image and its levels, read off the
    /// live engine snapshot (never a replayed event).
    // Shared helper, used by engine_regressions, host_effects and workflows.
    #[allow(dead_code)]
    pub fn catalog(&self) -> Option<(u32, Vec<u32>)> {
        let catalog = self.job.as_ref()?.snapshot().selection.catalog?;
        let (image, level_count) =
            catalog
                .entries
                .iter()
                .enumerate()
                .find_map(|(position, entry)| match entry {
                    CatalogEntryDto::Image(image) => Some((position, image.levels.len())),
                    CatalogEntryDto::ImageRequest(_) => None,
                })?;
        let image = u32::try_from(image).ok()?;
        let levels = (0..level_count)
            .filter_map(|level| u32::try_from(level).ok())
            .collect();
        Some((image, levels))
    }

    /// Every `acquire-tile` effect as `(tile id, uri, probe flag)` in
    /// arrival order, read off the recorded canonical effects.
    // Shared helper, used by engine_regressions, host_effects and workflows.
    #[allow(dead_code)]
    pub fn tile_effects(&self) -> Vec<(u32, String, bool)> {
        self.effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::AcquireTile {
                    tile, uri, probe, ..
                } => Some((*tile, uri.clone(), *probe)),
                _ => None,
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

    fn record(&mut self, update: Update) {
        // Newly issued effects first, in canonical order. Correlation only:
        // live ids are tracked so answers resolve, nothing is refolded into
        // an event stream.
        for effect in &update.effects {
            let id = effect.id();
            self.outstanding.insert(id);
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
            self.effects.push(effect.clone());
        }
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
        retry_base_delay_ms: config.retry_base_delay_ms,
    }
}
