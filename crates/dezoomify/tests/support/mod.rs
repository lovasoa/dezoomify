//! Scripted deterministic host for job workflow tests.
//!
//! The host drives [`EngineJob`] through the canonical API and records the
//! issued effects in arrival order for correlation. It performs no I/O,
//! clock reads, or randomness during execution, and it never refolds an
//! event stream: every query reads the live engine snapshot or the recorded
//! canonical effects directly.
//!
//! Tests submit canonical [`UserCommand`] and [`EffectResult`] values.
//! Small selectors resolve metadata/tile/timer/finalize correlations against
//! the canonical per-attempt effect ids.

use dezoomify::engine::{
    DiscoveryInput, EffectId, EffectResult, EngineError, EngineJob, JobOptions, ResponseMetadata,
    SelectionPolicy, Update, UserCommand,
};
use dezoomify::model::CatalogEntry;
use dezoomify::model::HostEffect as Effect;
use dezoomify::model::Terminal;
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
}

#[allow(dead_code)] // Each integration-test binary uses a different helper subset.
impl ScriptedHost {
    /// Create a host with validated options, recording the initial state.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when the URL or budgets are invalid.
    pub fn new(
        _job_id: &str,
        input_url: &str,
        config: dezoomify::engine::Config,
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
        config: dezoomify::engine::Config,
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

    /// Apply one canonical user command and record its update.
    pub fn command(&mut self, command: UserCommand) -> Result<(), EngineError> {
        self.transition(|job| job.command(command))
    }

    /// Supply bytes for one outstanding metadata request.
    pub fn provide_metadata(
        &mut self,
        request: u32,
        bytes: &[u8],
        final_uri: Option<String>,
    ) -> Result<(), EngineError> {
        let Some(effect) = self.metadata_effects_live.remove(&request) else {
            return Ok(());
        };
        self.transition(|job| {
            job.provide_metadata(
                effect,
                ResponseMetadata {
                    final_uri: final_uri.filter(|uri| !uri.is_empty()),
                },
                bytes,
            )
        })
    }

    /// Complete the live ordinary-tile effect for `tile`.
    pub fn complete_tile(&mut self, tile: u32, result: EffectResult) -> Result<(), EngineError> {
        let Some(effect) = self.take_tile(tile)? else {
            return Ok(());
        };
        self.complete(effect, result)
    }

    /// Complete the live retry timer selected by tile and attempt.
    pub fn complete_timer(
        &mut self,
        tile: u32,
        attempt: u32,
        result: EffectResult,
    ) -> Result<(), EngineError> {
        let Some(effect) = self.timer_effects_live.remove(&(tile, attempt)) else {
            return Ok(());
        };
        self.complete(effect, result)
    }

    /// Complete the most recently issued output operation.
    pub fn complete_output(&mut self, result: EffectResult) -> Result<(), EngineError> {
        let effect = self.effects.iter().rev().find_map(|effect| match effect {
            Effect::FinalizeOutput { effect, .. } => Some(EffectId(*effect)),
            _ => None,
        });
        let Some(effect) = effect else {
            return Err(EngineError::new(
                "job.invalid-state",
                "no output operation is awaited",
            ));
        };
        self.complete(effect, result)
    }

    fn complete(&mut self, effect: EffectId, result: EffectResult) -> Result<(), EngineError> {
        self.transition(|job| job.complete(effect, result))
    }

    fn transition(
        &mut self,
        apply: impl FnOnce(&mut EngineJob) -> Result<Update, EngineError>,
    ) -> Result<(), EngineError> {
        let revision_before = self.snapshot_revision();
        let effects_before = self.effects.len();
        let result = if self
            .job
            .as_ref()
            .is_some_and(|job| job.snapshot().terminal.is_some())
        {
            Err(EngineError::new(
                "job.post-terminal",
                "job already reached a terminal outcome",
            ))
        } else {
            match apply(self.job_mut()?) {
                Ok(update) => {
                    self.record(update);
                    Ok(())
                }
                Err(error) => Err(error),
            }
        };
        if result.is_err() {
            // Rejections must add no work: no new effects and the snapshot
            // revision is unchanged.
            debug_assert_eq!(self.effects.len(), effects_before);
            debug_assert_eq!(self.snapshot_revision(), revision_before);
        }
        result
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
                Some(Terminal::Completed) => Some("completed".to_string()),
                Some(Terminal::PartialCompleted { .. }) => Some("partial-completed".to_string()),
                Some(Terminal::Failed { .. }) => Some("failed".to_string()),
                Some(Terminal::Cancelled) => Some("cancelled".to_string()),
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
                    CatalogEntry::Image(image) => Some((position, image.levels.len())),
                    CatalogEntry::ImageRequest(_) => None,
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
                Effect::AcquireTile { request, tile, .. } => Some((
                    *tile,
                    request.uri.clone(),
                    request.purpose == dezoomify::model::RequestPurpose::Probe,
                )),
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
            Some(effect) => Ok(Some(effect)),
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
            match effect {
                Effect::AcquireResource { request } => {
                    let id = EffectId(request.id);
                    self.metadata_effects_live.insert(id.get(), id);
                }
                Effect::AcquireTile { request, tile, .. } => {
                    let id = EffectId(request.id);
                    self.seen_tiles.insert(*tile);
                    if request.purpose == dezoomify::model::RequestPurpose::Probe {
                        self.probe_effects_live.insert(*tile, id);
                    } else {
                        self.tile_effects_live.insert(*tile, id);
                    }
                }
                Effect::WaitRetryTimer {
                    effect,
                    tile,
                    attempt,
                    ..
                } => {
                    let id = EffectId(*effect);
                    self.timer_effects_live.insert((*tile, *attempt), id);
                }
                Effect::FinalizeOutput { .. }
                | Effect::RequestDecision { .. }
                | Effect::CancelWork => {}
            }
            self.effects.push(effect.clone());
        }
    }
}

/// Canonical options for scripted inputs: manual selection, prompted
/// partials, PNG output, and the validated budgets from an engine config.
fn job_options_for(inputs: Vec<DiscoveryInput>, config: &dezoomify::engine::Config) -> JobOptions {
    JobOptions {
        inputs,
        format: None,
        selection: SelectionPolicy::Manual,
        partial: dezoomify::engine::PartialPolicy::Prompt,
        output: dezoomify::model::OutputFormat::Png,
        max_concurrent: config.max_concurrent_fetches,
        max_tiles: config.max_tiles,
        max_retries: config.max_retries,
        max_bytes: config.max_bytes,
        max_deferred_follows: config.max_deferred_follows,
        retry_base_delay_ms: config.retry_base_delay_ms,
    }
}
