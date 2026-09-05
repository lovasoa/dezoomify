//! Deterministic portable job state machine (Phase 06 lean scope).
//!
//! The engine decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. See
//! `docs/job-engine.md` for the behavior table.
//!
//! Lean scope (honest): discovery accepts a resource by byte length only
//! (hosts own byte validation), catalog/levels are the fixed `img:0`/`lvl:0`
//! pair, and tile plans are the fixed `tile:0`/`tile:1` pair. Real format
//! parsing lives in `dezoomify-core`; wiring `ResourceBytes` bytes through
//! core discovery is future work, not claimed here.

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
