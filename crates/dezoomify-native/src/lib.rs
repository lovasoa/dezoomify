//! Native effect runtime: HTTP acquisition, cache/resume, output encoding.
//! Both the CLI and the desktop app call this crate; neither duplicates
//! download logic. Synchronous and deterministic; no clock access.

pub mod auth;
pub mod cache;
pub mod client;
pub mod download;
pub mod error;
pub mod output;
pub mod progress;
pub mod runtime;

pub use runtime::{JobEvent, JobHandle, JobRequest, JobResult, NativeRuntime};
