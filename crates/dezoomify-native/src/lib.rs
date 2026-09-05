//! Native effect helpers: header/auth scope, bounded scheduler bookkeeping,
//! cache helpers, output validation, progress counters.
//!
//! Scaffold scope (honest): no HTTP client, TLS, redirect fetch, image
//! decoding, or output encoding lives here yet — `Cargo.toml` carries only
//! `core/protocol/job` plus `serde`. Both the CLI and the desktop app call
//! this crate for policy bookkeeping; neither gets network bytes from it.
//! The CLI fails closed until the pipeline lands (see `apps/cli/src/main.rs`).

pub mod auth;
pub mod cache;
pub mod client;
pub mod download;
pub mod error;
pub mod output;
pub mod progress;
pub mod runtime;

pub use runtime::{JobEvent, JobHandle, JobRequest, JobResult, NativeRuntime};
