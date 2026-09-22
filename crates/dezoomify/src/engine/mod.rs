//! Authoritative deterministic job engine for dezoomify.
//!
//! This crate owns the job interface every product drives: formats,
//! discovery, planning, acquisition policy, and output finalization. It is
//! pure and deterministic: no I/O, clocks, or tasks. Hosts perform effects,
//! own clocks, and report explicit completions; the engine decides what
//! happens next.
//!
//! ```text
//! dezoomify::engine::EngineJob
//! dezoomify::engine::JobOptions
//! dezoomify::engine::UserCommand
//! dezoomify::model::HostEffect
//! dezoomify::engine::EffectId
//! dezoomify::engine::EffectResult
//! dezoomify::engine::Failure
//! dezoomify::model::Snapshot
//! dezoomify::engine::Update
//! dezoomify::engine::TileFailure
//! dezoomify::engine::FailureCategory
//! dezoomify::engine::classify_tile_failure
//! dezoomify::engine::retry_delay_ms
//! dezoomify::engine::format_inventory
//! ```
//!
//! The canonical state machine lives here (`job`, `transition`, `state`,
//! `config`, `retry`) behind the canonical facade
//! (`engine_api`). All hosts compile against these paths.
//!
//! The inner state machine is private; consumers use the canonical facade:
//!
//! ```compile_fail
//! use dezoomify::engine::job::Job;
//! ```

#![forbid(unsafe_code)]
// Shipped engine code maps failures to typed `JobError`s instead of
// panicking. Unit tests are exempt via `allow-unwrap-in-tests` in the
// workspace `clippy.toml`; integration `tests/` targets never inherit this
// crate-root attribute.
#![deny(clippy::unwrap_used)]

pub mod config;
pub mod engine_api;
pub(crate) mod job;
pub mod retry;
mod state;
mod transition;

pub use config::{Config, ConfigError};
pub use engine_api::{
    DiscoveryInput, EffectId, EffectResult, EngineError, EngineJob, Failure, JobOptions,
    OutstandingKind, PartialPolicy, ResponseMetadata, SelectionPolicy, Update, UserCommand,
};
pub(crate) use job::Job;
pub use retry::{
    FailureCategory, MAX_FAILURE_DETAIL_CHARS, MAX_RETRY_AFTER_MS, RETRY_BASE_DELAY_MS,
    RETRY_MAX_DELAY_MS, TileFailure, classify_tile_failure, retry_delay_ms,
};
pub(crate) use state::State;
pub(crate) use transition::{JobCommand, JobEffect, Outcome};

/// Command rejection for option validation.
pub type ValidationError = EngineError;
/// Command rejection for user commands.
pub type CommandError = EngineError;
/// Completion rejection for effect completions.
pub type CompletionError = EngineError;

/// Ordered `(id, display name)` inventory of every built-in format, derived
/// from the core registry in candidate precedence order.
///
/// The unknown-URI registry keeps built-in priority order, so this snapshot
/// is generated directly from the registry rather than a handwritten copy.
#[must_use]
pub fn format_inventory() -> Vec<(&'static str, &'static str)> {
    crate::core::registry::default_registry("https://example.invalid/unknown").snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

    fn started() -> (EngineJob, Update) {
        EngineJob::start(JobOptions::new(vec![DiscoveryInput::with_contents(
            "https://example.test/image.dzi",
            DZI,
        )]))
        .expect("valid test job")
    }

    fn auto_select_options(input: DiscoveryInput) -> JobOptions {
        let mut options = JobOptions::new(vec![input]);
        options.selection = SelectionPolicy::NativeAutomatic {
            image_index: 0,
            largest: true,
            max_width: None,
            max_height: None,
            zoom_level: None,
        };
        options
    }

    #[test]
    fn inline_discovery_and_automatic_selection_share_start_revision() {
        let (job, update) = EngineJob::start(auto_select_options(DiscoveryInput::with_contents(
            "https://example.test/image.dzi",
            DZI,
        )))
        .expect("valid auto-select job");
        assert_eq!(update.snapshot.revision, 1);
        assert_eq!(
            update.snapshot.lifecycle,
            crate::model::JobState::AcquiringTiles
        );
        assert!(update.effects.len() > 1);
        assert_eq!(job.snapshot().revision, 1);
    }

    #[test]
    fn metadata_completion_and_automatic_selection_share_one_revision() {
        let (mut job, started) = EngineJob::start(auto_select_options(DiscoveryInput::new(
            "https://example.test/image.dzi",
        )))
        .expect("valid auto-select job");
        assert_eq!(started.snapshot.revision, 1);
        let metadata = started.metadata_effects()[0]
            .correlation()
            .expect("correlated effect");
        let discovered = job
            .provide_metadata(metadata, ResponseMetadata::new(), DZI)
            .expect("metadata");
        assert_eq!(discovered.snapshot.revision, 2);
        assert_eq!(
            discovered.snapshot.lifecycle,
            crate::model::JobState::AcquiringTiles
        );
        assert!(discovered.effects.len() > 1);
    }

    #[test]
    fn pause_and_resume_each_advance_revision_once() {
        let (mut job, started) = started();
        assert_eq!(started.snapshot.revision, 1);
        let paused = job.command(UserCommand::Pause).expect("pause");
        assert_eq!(paused.snapshot.revision, 2);
        assert!(paused.snapshot.paused);
        let resumed = job.command(UserCommand::Resume).expect("resume");
        assert_eq!(resumed.snapshot.revision, 3);
        assert!(!resumed.snapshot.paused);
    }

    #[test]
    fn one_transition_issuing_multiple_effects_advances_once() {
        let (mut job, _) = started();
        let selected = job
            .command(UserCommand::SelectImage { image: 0 })
            .expect("image");
        let revision = selected.snapshot.revision;
        let planned = job
            .command(UserCommand::SelectLevel {
                level: selected.snapshot.selection.level_count - 1,
            })
            .expect("level");
        assert!(planned.effects.len() > 1);
        assert_eq!(planned.snapshot.revision, revision + 1);
    }

    #[test]
    fn ignored_late_completion_leaves_revision_unchanged() {
        let (mut job, _) = started();
        let selected = job
            .command(UserCommand::SelectImage { image: 0 })
            .expect("image");
        let planned = job
            .command(UserCommand::SelectLevel {
                level: selected.snapshot.selection.level_count - 1,
            })
            .expect("level");
        let tile = planned.tile_effects()[0]
            .correlation()
            .expect("correlated effect");
        let settled = job
            .complete(tile, EffectResult::TileAcquired)
            .expect("tile result");
        let revision = settled.snapshot.revision;
        assert_eq!(
            job.complete(tile, EffectResult::TileAcquired)
                .expect_err("duplicate completion is stale")
                .code,
            "job.stale-effect"
        );
        assert_eq!(job.snapshot().revision, revision);
    }

    #[test]
    fn every_inventoried_format_resolves() {
        for (id, _) in format_inventory() {
            assert!(
                crate::core::registry::registry_for(id).is_some(),
                "inventoried format `{id}` must resolve to a single program"
            );
        }
    }
}
