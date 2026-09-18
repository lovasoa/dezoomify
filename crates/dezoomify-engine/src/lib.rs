//! Authoritative deterministic job engine for dezoomify.
//!
//! This crate is the single home of the job interface every product drives:
//! formats, discovery, planning, acquisition policy, and output
//! finalization. It is pure and deterministic: no I/O, clocks, or tasks.
//! Hosts perform effects, own clocks, and report explicit completions; the
//! engine decides what happens next.
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
//! The canonical state machine lives in `dezoomify_job` and is re-exported
//! here unchanged, so every host compiles against the `dezoomify_engine`
//! paths above. `crates/dezoomify-job` keeps the same items at its
//! long-standing paths while native and bridge hosts migrate.

pub use dezoomify_job::engine_api::{
    DecisionPayload, DeferredEntry, DiscoveryInput, Effect, EffectId, EffectResult, EngineError,
    EngineJob, Failure, JobOptions, JobSnapshot, Lifecycle, OutputDisposition, OutputFormat,
    OutputSummary, PartialDecision, PartialPolicy, Progress, ResponseMetadata, Selection,
    SelectionPolicy, Terminal, Update, UserCommand,
};
pub use dezoomify_job::retry::{
    classify_tile_failure, retry_delay_ms, FailureCategory, TileFailure, MAX_FAILURE_DETAIL_CHARS,
    MAX_RETRY_AFTER_MS, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS,
};

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
