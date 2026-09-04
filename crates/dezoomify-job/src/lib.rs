//! Deterministic portable job state machine.
//!
//! The engine decides what must happen next and emits host effects; it never
//! performs I/O, decodes pixels, reads clocks, or writes output. See
//! `docs/job-engine.md` for the behavior table.

#![forbid(unsafe_code)]

pub mod config;
pub mod job;
pub mod state;
pub mod transition;

pub use config::{Config, ConfigError};
pub use job::Job;
pub use state::State;
pub use transition::{JobError, JobResponse, Outcome};
