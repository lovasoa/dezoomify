//! Deterministic portable job state machine (Phase 06 lean scope).
//!
//! The engine decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. See
//! `docs/job-engine.md` for the behavior table.
//!
//! Discovery and planning are format-aware: metadata bytes are parsed by
//! `dezoomify-core` (pure and deterministic), the projected catalog is
//! emitted on the `catalog` event, selection is explicit over real catalog
//! ids, and tile plans are the real per-level plans (fixed-geometry grids
//! directly; probe-driven sources through the core probe step machine when
//! `config.plan_probes` allows it).

#![forbid(unsafe_code)]

pub mod config;
pub mod job;
pub mod projection;
pub mod state;
pub mod transition;

pub use config::{Config, ConfigError};
pub use job::Job;
pub use projection::{project_catalog, ProjectionError};
pub use state::State;
pub use transition::{JobError, JobResponse, Outcome};
