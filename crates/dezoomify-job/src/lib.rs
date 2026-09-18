//! Deterministic portable job state machine.
//!
//! The engine decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. See
//! `docs/job-engine.md` for the behavior table.
//!
//! Discovery and planning are format-aware: metadata bytes are parsed by
//! `dezoomify-core` (pure and deterministic), the projected catalog is
//! emitted on the `catalog` event, selection is explicit over real catalog
//! ids, and tile plans are the real per-level plans (fixed-geometry grids
//! directly; probe-driven sources through the core probe step machine).

#![forbid(unsafe_code)]
// Shipped engine code maps failures to typed `JobError`s instead of
// panicking. Unit tests are exempt via `allow-unwrap-in-tests` in the
// workspace `clippy.toml`; integration `tests/` targets never inherit this
// crate-root attribute.
#![deny(clippy::unwrap_used)]

pub mod config;
pub mod engine_api;
pub mod job;
pub mod projection;
pub mod retry;
pub mod state;
pub mod transition;

pub use config::{Config, ConfigError};
pub use engine_api::project_engine_snapshot;
pub use engine_api::EngineJob;
pub use job::{Job, JobInput};
pub use projection::project_catalog;
pub use retry::{classify_tile_failure, retry_delay_ms, FailureCategory, TileFailure};
pub use state::State;
pub use transition::{
    JobCommand, JobEffect, JobError, JobEvent, JobMessage, JobMessageBody, Outcome, RecoveryChoice,
};
