//! Authoritative deterministic job engine for dezoomify.
//!
//! This crate owns the job interface every product drives: formats,
//! discovery, planning, acquisition policy, and output finalization. It is
//! pure and deterministic: no I/O, clocks, or tasks. Hosts perform effects,
//! own clocks, and report explicit completions; the engine decides what
//! happens next.
//!
//! ```text
//! dezoomify_engine::EngineJob
//! dezoomify_engine::JobOptions
//! dezoomify_engine::UserCommand
//! dezoomify_engine::Effect
//! dezoomify_engine::EffectId
//! dezoomify_engine::EffectResult
//! dezoomify_engine::Failure
//! dezoomify_engine::JobSnapshot
//! dezoomify_engine::Update
//! dezoomify_engine::TileFailure
//! dezoomify_engine::FailureCategory
//! dezoomify_engine::classify_tile_failure
//! dezoomify_engine::retry_delay_ms
//! dezoomify_engine::format_inventory
//! ```
//!
//! The canonical state machine lives here (`job`, `transition`, `state`,
//! `config`, `projection`, `retry`) behind the canonical facade
//! (`engine_api`). All hosts compile against these paths.

#![forbid(unsafe_code)]
// Shipped engine code maps failures to typed `JobError`s instead of
// panicking. Unit tests are exempt via `allow-unwrap-in-tests` in the
// workspace `clippy.toml`; integration `tests/` targets never inherit this
// crate-root attribute.
#![deny(clippy::unwrap_used)]

pub mod config;
pub mod engine_api;
pub(crate) mod job;
pub mod projection;
pub mod retry;
mod state;
mod transition;

pub use config::{Config, ConfigError};
pub use engine_api::{
    DecisionPayload, DeferredEntry, DiscoveryInput, Effect, EffectId, EffectResult, EngineError,
    EngineJob, EngineNotice, Failure, HeaderPair, JobOptions, JobSnapshot, Lifecycle,
    OutputDisposition, OutputFormat, OutputSummary, PartialDecision, PartialPolicy, Progress,
    ResponseMetadata, Selection, SelectionPolicy, Terminal, TilePosition, TileSize, Update,
    UserCommand,
};
pub(crate) use job::{Job, JobInput};
pub use projection::project_catalog;
pub use retry::{
    classify_tile_failure, retry_delay_ms, FailureCategory, TileFailure, MAX_FAILURE_DETAIL_CHARS,
    MAX_RETRY_AFTER_MS, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS,
};
pub(crate) use state::State;
pub(crate) use transition::{
    JobCommand, JobEffect, JobEvent, JobMessageBody, Outcome, RecoveryChoice,
};

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
/// always equals the registry's own listing. The protocol `FORMAT_GRID`
/// carries the same pairs for the wire; `format_grid_matches_registry`
/// fails on any drift between the two.
#[must_use]
pub fn format_inventory() -> Vec<(&'static str, &'static str)> {
    dezoomify_core::core::registry::default_registry("https://example.invalid/unknown").snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_grid_matches_registry() {
        let inventory = format_inventory();
        let grid: Vec<(&str, &str)> = dezoomify_protocol::dto::FORMAT_GRID.to_vec();
        assert_eq!(
            inventory, grid,
            "protocol FORMAT_GRID drifted from the core registry"
        );
    }

    #[test]
    fn every_inventoried_format_resolves() {
        for (id, _) in format_inventory() {
            assert!(
                dezoomify_core::core::registry::registry_for(id).is_some(),
                "inventoried format `{id}` must resolve to a single program"
            );
        }
    }
}
